// 书信簿 Epistolary · SillyTavern 扩展入口
// 负责：设置、扩展面板入口、魔法棒菜单入口、生成前注入信件内容、
// 寄送（在途信件、按剧情日期或楼层送达、镜头切到收信人那边）、让角色写回信。

import { Store } from './src/store.js';
import { UI } from './src/ui.js';
import { retrieve, DEFAULT_RETRIEVAL } from './src/retrieval.js';
import { sameName, normalizeDate, findPerson, lettersByCode, unknownCodes, ensureCodes, createLetter } from './src/model.js';
import {
    buildReactionGuidance, replyChatMessage, sceneSwitchMessage, sceneReturnMessage,
    deliveryEvents, buildDatePrompt, parseStoryDate, addDays,
    viaSceneMessage, viaPeekMessage, buildViaGuidance, buildViaDecisionPrompt, parseViaDecisions,
    viaReceivedEvents, nextEventId, VIA_ACTIONS,
    mentionsReceipt, mentionsDate, mentionsName, buildPendingHints, inlineLetterBlock, inlineGuidance, buildCodeBlock,
    buildMemoryPrompt, parseMemoryResult, checkQuotes, memoryEntryContent, memoryKeys,
    authorKey, summaryEntryContent, rereadKey, rereadEntryContent, buildStatusPrompt, parseStatusResponse,
} from './src/correspondence.js';
import { whereNow, setWhere, suggestWhere, acceptSuggestion, dismissSuggestion, revokeWhere, whereText, whereForPerson, REREADABLE, deliveryText, deliveryState } from './src/whereabouts.js';
import { playSeal, playOpen } from './src/envelope.js';
import { detectInMessage, guessRecipient, guessAuthor, findDuplicate, isSalutation } from './src/importer.js';
import { extractEnclosures } from './src/enclosures.js';
import { findReadingScenes, sceneText } from './src/memoryscan.js';
import { callAI, DEFAULT_API } from './src/api.js';

const MODULE = 'epistolary';
const PROMPT_KEY = 'epistolary_letters';
const REACTION_KEY = 'epistolary_reaction';
const PENDING_KEY = 'epistolary_pending';
const CODE_KEY = 'epistolary_code';

const DEFAULT_SETTINGS = {
    enabled: true,           // 给 AI 注入内容（暗号接信、自动注入、世界书记忆）
    useAI: true,             // 调用 AI 接口（整理记忆、记录剧情、填信头、更新状态……）；关掉就只当记录本
    mode: 'simple',          // simple 简单模式：存档 + 暗号 | expert 高级模式：寄送、转交、知情过滤、自动注入
    autoKeywords: true,      // 简单模式下，保存时自动让 AI 生成关键词
    autoFill: true,          // 写新信时让 AI 根据剧情填信头
    editZoom: 0.9,           // 写信页信纸上的字看起来多大（不改信本身的字号）
    describeLook: true,
    codeMode: 'embed',       // 暗号：embed 把信的全文放进你的消息里（折叠显示，最稳）| inject 只在生成时注入
    sealIncoming: true,      // 角色回复里出现寄给你的信：先封起来，拆信动画以后才显示
    detectArrival: true,     // 剧情里（包括 AI 的思考）写到收信人收到信、转交人动了信，就自动处理      // 收信反应时，把信纸、墨水、字迹、字号、信封、封口告诉 AI
    animations: true,        // 寄信封缄、收信拆信动画
    jitter: true,            // 手写随机感
    onlineFonts: true,       // 在线加载中文书信字体（霞鹜文楷、思源宋体、马善政楷书）
    viewpointMode: 'auto',   // auto 跟随当前发言角色 | manual 手动指定 | omniscient 全知不过滤
    manualViewpoint: '',
    scanDepth: 3,            // 扫描最近几条消息
    position: 1,             // 0 系统提示词之后 | 1 聊天记录中（按深度）| 2 系统提示词之前
    depth: 3,
    ...DEFAULT_RETRIEVAL,
    api: { ...DEFAULT_API },
    delivery: {
        mode: 'date',        // 寄信时默认的送达方式：date 按剧情日期 | floors 按楼层 | instant 立即
        floors: 8,           // 按楼层送达时，默认再过几层
        autoSwitch: false,   // 信到了自动切过去看收信反应
        autoDate: true,      // 有在途的信时，自动推算剧情日期
        dateEvery: 6,        // 每隔几层推算一次
    },
    backup: {
        keep: 7,             // 每天第一次打开时自动备份档案，保留最近几份（0 = 不自动备份）
    },
    memory: {
        when: 'first',       // 什么时候自动整理：first 有人第一次读这封信时 | every 每次读都整理 | off 不自动
        worldbook: true,     // 记忆写进这个聊天绑定的世界书，角色以后提起这封信时会想起来
        depth: 4,            // 世界书条目插入的深度
        rereadText: true,    // 信还在某人手里：TA 说要拿出来重读时，世界书给出原文
        trackEvents: true,   // 用暗号读到信的那一轮：让 AI 记下剧情里这封信发生了什么（写好、寄出、收到、读、转交），记进时间线
    },
};

const ctx = () => SillyTavern.getContext();
const isSimple = () => settings().mode !== 'expert';

// 中文字体很大，不随插件附带，按需从 jsDelivr 加载：字体被切成很多小片，
// 信里用到哪些字才下载哪些片，下载过的会被浏览器缓存。
const CJK_FONT_CSS = [
    'https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/lxgwwenkai-regular.css', // 霞鹜文楷
    'https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5.3.0/400.css',            // 思源宋体（Noto Serif SC）
    'https://cdn.jsdelivr.net/npm/@fontsource/ma-shan-zheng@5.3.1/400.css',            // 马善政楷书
];

function loadCjkFonts() {
    for (const href of CJK_FONT_CSS) {
        if (document.querySelector(`link[data-epi-font="${href}"]`)) continue;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.dataset.epiFont = href;
        document.head.appendChild(link);
    }
}

function settings() {
    const all = ctx().extensionSettings;
    const cur = all[MODULE] || {};
    all[MODULE] = {
        ...DEFAULT_SETTINGS,
        ...cur,
        api: { ...DEFAULT_SETTINGS.api, ...(cur.api || {}) },
        delivery: { ...DEFAULT_SETTINGS.delivery, ...(cur.delivery || {}) },
        memory: { ...DEFAULT_SETTINGS.memory, ...(cur.memory || {}) },
        backup: { ...DEFAULT_SETTINGS.backup, ...(cur.backup || {}) },
    };
    const mem = all[MODULE].memory;
    if (!['first', 'every', 'off'].includes(mem.when)) mem.when = mem.auto === false ? 'off' : 'first';
    return all[MODULE];
}

const saveSettings = () => ctx().saveSettingsDebounced();

function hasChat() {
    const c = ctx();
    return !!(c.getCurrentChatId?.() && (c.characterId !== undefined || c.groupId));
}

function chatId() {
    return hasChat() ? String(ctx().getCurrentChatId() || '') : '';
}

function floor() {
    return (ctx().chat || []).length;
}

function chatMeta() {
    const md = ctx().chatMetadata;
    if (!md) return {};
    md[MODULE] = md[MODULE] || {};
    return md[MODULE];
}

function saveMeta() {
    const c = ctx();
    if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced(); else c.saveMetadata();
}

function getStoryDate() {
    return chatMeta().storyDate || '';
}

function setStoryDate(date) {
    if (!hasChat()) return;
    chatMeta().storyDate = String(date || '').trim();
    saveMeta();
    const el = document.querySelector('#epi-storydate');
    if (el && el !== document.activeElement) el.value = chatMeta().storyDate;
}

// 当前视角角色。群聊时酒馆会在每个成员生成前把 name2 切换成该成员，所以直接读 name2 即可。
function getViewer() {
    const s = settings();
    if (s.viewpointMode === 'omniscient') return null;
    if (s.viewpointMode === 'manual' && s.manualViewpoint.trim()) return s.manualViewpoint.trim();
    return ctx().name2 || null;
}

function isCurrentCharacter(name) {
    const c = ctx();
    if (!hasChat() || c.groupId) return false;
    return sameName(store.archive, c.name2, name);
}

function recentMessages(chat, depth) {
    return (chat || [])
        .filter(m => m && !m.is_system && typeof m.mes === 'string')
        .slice(-Math.max(1, depth));
}

// 最近一条用户消息如果是“寄到的信”，返回它的信息（用于收信反应）
function pendingReaction() {
    const chat = ctx().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        if (m.is_user) {
            const info = m.extra?.epistolary;
            if (info && (info.kind === 'letter' || info.kind === 'via')) return info;
            const inline = m.extra?.epistolaryInline;
            return inline ? { ...inline, kind: 'letter', inline: true } : null;
        }
    }
    return null;
}

// ---------- 要直接交给 AI 的信（原文不进聊天，只在生成时注入） ----------

function inbox() {
    const meta = chatMeta();
    meta.inbox = Array.isArray(meta.inbox) ? meta.inbox : [];
    return meta.inbox;
}

// 排队：下一次生成时把这封信的原文交给 AI
function queueLetter(letter, { reader, arrival = '', peek = false }) {
    if (letter.shell) toastr.warning(`${letter.author} 的这封信还是空壳，正文还没写。写好以前，AI 只会写到拆开为止。`, '📄 空壳信', { timeOut: 8000 });
    const box = inbox();
    if (box.some(i => i.letterId === letter.id && i.reader === reader && !i.answeredAt)) return;
    box.push({ letterId: letter.id, reader, arrival, peek, queuedAt: floor(), answeredAt: 0 });
    // 只留最近的几条
    while (box.length > 12) box.shift();
    saveMeta();
    ui?.renderPostbox();
}

// 这一次生成要带上的：还没被回应过的；或者重新生成/换一个回复时，刚才回应过的那几封
function activeInbox() {
    const f = floor();
    return inbox().filter(i => !i.answeredAt || f <= i.answeredAt);
}

// 角色回复了：排队的信算是读过了
function markInboxAnswered() {
    const f = floor();
    let changed = false;
    for (const i of inbox()) {
        if (i.answeredAt || f <= i.queuedAt) continue;
        if (store.archive.letters[i.letterId]?.shell) continue; // 空壳信：等正文写好再算读过
        i.answeredAt = f;
        changed = true;
    }
    if (changed) saveMeta();
}

function reactionGuidance() {
    const look = settings().describeLook !== false;
    const parts = [];
    for (const i of activeInbox()) {
        const letter = store.archive.letters[i.letterId];
        if (!letter) continue;
        if (letter.shell) {
            // 空壳信：正文还没写，不能让 AI 自己编
            parts.push(`【${i.reader} ${i.peek ? '拆开的' : '收到的'}这封信（${letter.author} 写的${letter.title ? `，信封上写着「${letter.title}」` : ''}），正文还没有定下来】\n描写 ${i.reader} 拆信、展开信纸为止，或者写 TA 拿着信的样子。**不要编造信里写了什么**，原文会之后给出。`);
            continue;
        }
        const g = buildReactionGuidance(store.archive, letter, i.reader, i.arrival, { peek: i.peek, look });
        parts.push(`${inlineLetterBlock(letter, i.reader, i.arrival, { peek: i.peek })}\n\n${inlineGuidance(g)}`);
    }
    // 旧版本：信的原文在聊天消息里
    const info = pendingReaction();
    const letter = info && store.archive.letters[info.letterId];
    if (letter && !activeInbox().some(i => i.letterId === letter.id)) {
        if (info.kind === 'via') parts.push(buildViaGuidance(store.archive, letter, info.via, info.arrival, { look }));
        else if (info.kind === 'letter') parts.push(buildReactionGuidance(store.archive, letter, info.reader, info.arrival, { peek: !!info.peek, look }));
        else if (info.inline) parts.push(`${inlineLetterBlock(letter, info.reader, info.arrival)}\n\n${inlineGuidance(buildReactionGuidance(store.archive, letter, info.reader, info.arrival, { peek: !!info.peek, look }))}`);
    }
    return parts.join('\n\n');
}

// 最近一条用户消息里写了哪些信的暗号
function lastUserMessage() {
    const chat = ctx().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        if (m.is_user) return m;
    }
    return null;
}

function codeLetters() {
    const m = lastUserMessage();
    // 已经把全文放进消息里的，不用再注入一遍
    return m ? lettersByCode(store.archive, m.mes).filter(l => !String(m.mes).includes(blockStart(l))) : [];
}

// ---------- 暗号 → 把信的全文放进你的消息里（折叠显示） ----------
// AI 读的是你这条消息本身，所以一定看得到；聊天里折叠成“✉ 勒鲁写给文森特的信”，不占地方。

const blockStart = l => `【信件 ${l.code}｜`;
const BLOCK_END = '【信件完】';

function letterBlock(l) {
    const head = [`${l.author || '？'} 写给 ${l.recipients.join('、') || '？'}`, l.writtenAt].filter(Boolean).join('｜');
    const enc = l.enclosures?.length ? `\n\n（随信附上：${l.enclosures.map(e => e.name + (e.value && !e.name.includes(e.value) ? `，${e.value}` : '')).join('；')}）` : '';
    // 和“剧情推进”一样：直接写进用户这一楼，并且明确告诉 AI 这是既定内容
    const rule = '（以下是这封信的原文，已经写好。剧情里有人读它时，读到的就是这些字句：可以引用，不要另编一封，不要改写或增删。）';
    return `${blockStart(l)}${head}】\n\n${rule}\n\n${String(l.body || '').trim()}${enc}\n\n${BLOCK_END}`;
}

// 一段文字里有暗号：把对应的信接在后面。返回 { text, letters }（没有要加的就原样返回）
function withLetterBlocks(text) {
    const t = String(text || '');
    const s = settings();
    if (!s.enabled || s.codeMode === 'inject' || store.mode === 'unloaded' || !t) return { text: t, letters: [] };
    const letters = lettersByCode(store.archive, t).filter(l => !t.includes(blockStart(l)));
    const ready = letters.filter(l => !l.shell && String(l.body || '').trim());
    for (const l of letters.filter(x => !ready.includes(x))) toastr.warning(`${l.code} 那封信还没写正文`, '书信簿');
    if (!ready.length) return { text: t, letters: [] };
    return { text: `${t.replace(/\s+$/, '')}\n\n${ready.map(letterBlock).join('\n\n')}`, letters: ready };
}

function toastEmbedded(letters, where = '') {
    if (!letters.length) return;
    console.info(`[书信簿] 暗号 ${letters.map(l => l.code).join(' ')} → 信已接在消息后面（${where}）`);
    toastr.success(letters.map(l => `${l.code} ${l.author} → ${l.recipients.join('、')}`).join('<br>'), '✉ 信已放进你的消息（折叠显示）', { timeOut: 4000, escapeHtml: false });
}

// ① 最早的时机：酒馆处理完斜杠命令、还没读输入框（GENERATION_AFTER_COMMANDS）——直接改输入框里的文字
async function onAfterCommands(type, params, dryRun) {
    try {
        if (dryRun || type === 'quiet' || type === 'impersonate' || params?.quiet_prompt) return;
        const ta = document.getElementById('send_textarea');
        const boxText = ta ? String(ta.value || '') : '';
        if (boxText.trim()) {
            const r = withLetterBlocks(boxText);
            if (r.letters.length) {
                ta.value = r.text;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                toastEmbedded(r.letters, '发送前·输入框');
            }
            return;
        }
        // 输入框是空的：消息可能已经在聊天里了（比如别的插件先把它发了出去）
        const chat = ctx().chat || [];
        const last = chat.length - 1;
        if (chat[last]?.is_user && await embedCodes(last)) {
            if (params && typeof params.prompt === 'string') params.prompt = chat[last].mes;
            await ctx().eventSource.emit(ctx().eventTypes.MESSAGE_UPDATED, last);
        }
    } catch (e) {
        console.error('[书信簿] 暗号处理失败（发送前）', e);
    }
}

// ② 酒馆助手（TavernHelper.generate）直接带着 user_input 生成时
function hookTavernHelper() {
    const th = globalThis.TavernHelper;
    if (!th || typeof th.generate !== 'function' || th.generate.__epistolary) return !!th;
    const orig = th.generate;
    const wrapped = async function (...args) {
        try {
            const o = args[0];
            if (o && typeof o === 'object') {
                for (const key of ['user_input', 'prompt']) {
                    if (typeof o[key] === 'string' && o[key]) {
                        const r = withLetterBlocks(o[key]);
                        if (r.letters.length) { args[0] = { ...o, [key]: r.text }; toastEmbedded(r.letters, '酒馆助手'); break; }
                    }
                }
            }
        } catch (e) { console.error('[书信簿] 暗号处理失败（酒馆助手）', e); }
        return orig.apply(this, args);
    };
    wrapped.__epistolary = true;
    th.generate = wrapped;
    return true;
}

// ③ 兜底：消息已经进了聊天（MESSAGE_SENT），AI 还没开始写
async function embedCodes(mesId) {
    const c = ctx();
    const m = c.chat?.[mesId];
    if (!m || !m.is_user || m.extra?.epistolary) return false;
    const r = withLetterBlocks(m.mes);
    if (!r.letters.length) return false;
    const ready = r.letters;
    m.mes = r.text;
    m.extra = { ...(m.extra || {}), epistolaryEmbedded: ready.map(l => l.id) };
    // 酒馆在这之前已经存过一次聊天了；这里再存一次，免得生成失败时改动丢掉
    try { await c.saveChat(); } catch (e) { console.warn('[书信簿] 保存聊天失败', e); }
    toastEmbedded(ready, '消息已进聊天');
    return true;
}

// 聊天里把【信件 …】……【信件完】折叠起来
function foldLetters(mesId) {
    const el = document.querySelector(`.mes[mesid="${mesId}"] .mes_text`);
    if (!el || !el.textContent.includes('【信件 ')) return;
    const nodes = [...el.children];
    for (let i = 0; i < nodes.length; i++) {
        const start = nodes[i];
        if (start.closest('details.epi-fold')) continue;
        const m = start.textContent.match(/【信件 (\S+?)｜([^】]*)】/);
        if (!m) continue;
        let j = i;
        while (j < nodes.length && !nodes[j].textContent.includes(BLOCK_END)) j++;
        if (j >= nodes.length) continue;
        const details = document.createElement('details');
        details.className = 'epi-fold';
        const parts = m[2].split('｜');
        details.innerHTML = `<summary>✉ ${esc(parts[0].replace(' 写给 ', '写给'))} 的信${parts[1] ? ` · ${esc(parts[1])}` : ''} <span class="epi-fold-code">${esc(m[1])}</span><span class="epi-fold-hint">点开看全文 · AI 读得到</span></summary>`;
        start.before(details);
        for (let k = i + 1; k < j; k++) details.appendChild(nodes[k]);
        start.remove();
        nodes[j].remove();
        i = j;
    }
}

function foldAll() {
    document.querySelectorAll('.mes[mesid]').forEach(el => foldLetters(el.getAttribute('mesid')));
}

// 告诉用户这一轮交给 AI 的是哪几封；写了像暗号的东西却对不上，也提醒一下
let lastCodeToast = '';
function codeFeedback(type) {
    const m = lastUserMessage();
    if (!m) return;
    const hit = lettersByCode(store.archive, m.mes);
    const miss = unknownCodes(store.archive, m.mes);
    const key = `${ctx().chat.length}|${type}|${hit.map(l => l.id).join(',')}|${miss.join(',')}`;
    if (key === lastCodeToast) return;
    lastCodeToast = key;
    if (hit.length && settings().codeMode === 'inject') toastr.success(hit.map(l => `${l.code} ${l.author} → ${l.recipients.join('、')}`).join('<br>'), '✉ 这一轮把信交给了 AI', { timeOut: 4000, escapeHtml: false });
    if (!hit.length && !miss.length) {
        // 写了“信1”却没带括号
        const bare = Object.values(store.archive.letters).find(l => l.code && new RegExp(`(^|[^【\\[])${l.code.replace(/^【|】$/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d】\\]])`).test(m.mes || ''));
        if (bare && /^【信\d+】$/.test(bare.code)) toastr.info(`如果你是想用 ${bare.code} 那封信，暗号要连括号一起写：${bare.code}`, '书信簿', { timeOut: 6000 });
    }
    if (miss.length) toastr.warning(`档案里没有 ${miss.join('、')} 这个暗号。打开书信簿看看那封信的暗号是什么（信件列表里每封信前面那个）。`, '书信簿', { timeOut: 8000 });
}

function codeInjection() {
    const look = settings().describeLook !== false;
    return codeLetters().map(l => buildCodeBlock(store.archive, l, { look })).join('\n\n');
}

function runRetrieval() {
    const s = settings();
    const viewer = getViewer();
    const storyDate = getStoryDate();
    // 用原始聊天记录（带消息附加信息），而不是拦截器拿到的副本
    const msgs = recentMessages(ctx().chat, s.scanDepth);
    const texts = msgs.map(m => m.mes).reverse();
    const exclude = new Set([...msgs.map(m => m.extra?.epistolary?.letterId), ...activeInbox().map(i => i.letterId), ...codeLetters().map(l => l.id)].filter(Boolean));
    const result = retrieve(store.archive, { texts, viewer, storyDate, settings: s, exclude });
    return { viewer, storyDate, texts, result, enabled: s.enabled, reaction: reactionGuidance() };
}

// 设置里关掉了 AI 接口：插件只当记录本用，不调用任何 AI
const aiOn = () => settings().useAI !== false;
const injectOn = () => settings().enabled !== false;
function ai(system, prompt, meta) {
    if (!aiOn()) {
        const e = new Error('AI 接口已在设置里关闭（设置 → 总开关）');
        e.aiOff = true;
        return Promise.reject(e);
    }
    return callAI(settings().api, system, prompt, meta);
}

// 回信人就是当前聊天的角色时，把角色卡和最近的剧情一起交给 AI
function getCharacterContext(name) {
    if (!isCurrentCharacter(name)) return null;
    const c = ctx();
    const ch = c.characters?.[c.characterId];
    if (!ch) return null;
    const card = [ch.description, ch.personality ? `性格：${ch.personality}` : '', ch.scenario ? `情境：${ch.scenario}` : '']
        .filter(Boolean).join('\n').replace(/\{\{char\}\}/gi, ch.name).replace(/\{\{user\}\}/gi, c.name1).slice(0, 3500);
    const recentChat = recentMessages(c.chat, 6)
        .filter(m => !m.extra?.epistolary)
        .map(m => `${m.name}：${String(m.mes).slice(0, 500)}`).join('\n');
    return { card, recentChat };
}

function nowStamp() {
    try { return new Date().toLocaleString(); } catch { return ''; }
}

async function pushMessage(msg, { generate = false } = {}) {
    const c = ctx();
    c.chat.push(msg);
    c.addOneMessage(msg);
    await c.saveChat();
    if (generate) {
        try { await c.generate('normal'); } catch (e) { console.error('[书信簿] 生成失败', e); }
    }
}

// ---------- 读信以后的记忆 → 世界书 ----------
// 角色读完一封信：让 AI 把“谁读了、记得哪几句原话、想到什么、做了什么”整理成记忆，
// 写进这个聊天绑定的世界书。以后剧情里提到写信人的信、暗号、标题，世界书就把这段记忆带上。
// 全文还是靠暗号；世界书里只放记忆，不放原文。

let turnLetters = { floor: -1, ids: [] }; // 这一轮生成时交给 AI 的信
let memoryQueue = Promise.resolve();

function embeddedLetters(text) {
    const out = [];
    for (const m of String(text || '').matchAll(/【信件 (.+?)｜/g)) {
        const l = Object.values(store.archive.letters).find(x => x.code && x.code === m[1]);
        if (l && !out.includes(l)) out.push(l);
    }
    return out;
}

function stripBlocks(text) {
    return String(text || '').replace(/【信件 [\s\S]*?【信件完】/g, '（附信原文略）').trim();
}

function rememberTurnLetters() {
    const ids = new Set([...codeLetters().map(l => l.id), ...embeddedLetters(lastUserMessage()?.mes).map(l => l.id)]);
    if (!isSimple()) for (const i of activeInbox()) if (!store.archive.letters[i.letterId]?.shell) ids.add(i.letterId);
    turnLetters = { floor: floor(), ids: [...ids] };
}

// 这条回复读的是哪几封信
function lettersReadAt(mesId) {
    const chat = ctx().chat || [];
    const ids = new Set(turnLetters.floor === mesId || turnLetters.floor === mesId + 1 ? turnLetters.ids : []);
    for (let i = mesId - 1; i >= 0 && i >= mesId - 3; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        if (m.is_user) { for (const l of embeddedLetters(m.mes)) ids.add(l.id); break; }
    }
    return [...ids].map(id => store.archive.letters[id]).filter(l => l && !l.shell && String(l.body || '').trim());
}

function sceneAround(mesId, { before = 2 } = {}) {
    return sceneText(ctx().chat || [], Math.max(0, mesId - before), mesId);
}

function safeBookName(text) {
    return String(text || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// 这个聊天绑定的世界书；没有就建一本
async function memoryBook({ create = true } = {}) {
    const c = ctx();
    if (!hasChat() || typeof c.loadWorldInfo !== 'function' || typeof c.saveWorldInfo !== 'function') return null;
    let name = c.chatMetadata?.world_info;
    if (!name && create) {
        name = safeBookName(`书信簿记忆-${chatId()}`);
        await c.saveWorldInfo(name, { entries: {} }, true);
        try { await c.updateWorldInfoList?.(); } catch { /* 旧版本 */ }
        c.chatMetadata.world_info = name;
        try { await c.saveMetadata(); } catch { saveMeta(); }
        toastr.info(`建了一本世界书「${name}」绑定到这个聊天，用来放角色读信的记忆。`, '🧠 书信簿', { timeOut: 7000 });
    }
    if (!name) return null;
    const data = await c.loadWorldInfo(name);
    if (!data) return null;
    data.entries = data.entries || {};
    return { name, data };
}

function freeUid(data) {
    const used = new Set(Object.keys(data.entries).map(Number));
    let i = 0;
    while (used.has(i)) i++;
    return i;
}

const EPI_TAG = /⟨epi:([^⟩]+)⟩\s*$/;

function wiEntry(uid, { key, comment, content, tag, order = 100 }, old = null) {
    const depth = Number(settings().memory.depth) || 4;
    const e = {
        uid,
        key,
        keysecondary: [],
        comment: `${comment} ⟨epi:${tag}⟩`,
        content,
        constant: false,
        vectorized: false,
        selective: false,
        selectiveLogic: 0,
        addMemo: true,
        order,
        position: 4,            // 按深度插入
        disable: false,
        ignoreBudget: false,
        excludeRecursion: true,
        preventRecursion: true,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        depth,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: false,
        useGroupScoring: null,
        automationId: '',
        role: 0,
        sticky: null,
        cooldown: null,
        delay: null,
        triggers: [],
        displayIndex: uid,
    };
    if (old) {
        // 用户在世界书里自己改过的开关、顺序、位置，保留
        Object.assign(e, { disable: !!old.disable && !old.epiOff, order: old.order ?? order, position: old.position ?? 4, depth: old.depth ?? depth, probability: old.probability ?? 100, displayIndex: old.displayIndex ?? uid });
        if (old.characterFilter) e.characterFilter = old.characterFilter;
        if (old.sticky != null) e.sticky = old.sticky;
        if (old.cooldown != null) e.cooldown = old.cooldown;
    }
    return e;
}

const isMine = m => {
    const id = chatId();
    if (m.chatId) return m.chatId === id;
    return !!m.wiBook && m.wiBook === ctx().chatMetadata?.world_info; // v0.21 的旧记忆：没记聊天，按世界书认
};
const same = (a, b) => sameName(store.archive, a, b) || namesOf(a).some(n => sameName(store.archive, n, b));

// 这个聊天里应该有哪些世界书条目：每人每封信的记忆；同一个人读过同一写信人好几封时加一份“来信一览”；
// 信在谁手里、那人还留着它时，加一条“拿出来重读”的原文
function desiredEntries() {
    const out = [];
    const letters = Object.values(store.archive.letters).filter(l => (l.memories || []).some(isMine));
    const groups = new Map(); // author|person → [{letter, memory}]
    for (const l of letters) {
        for (const m of l.memories.filter(isMine)) {
            const gk = [...groups.keys()].find(k => { const [au, pe] = k.split('\u0001'); return au === l.author && same(pe, m.person); }) || `${l.author}\u0001${m.person}`;
            if (!groups.has(gk)) groups.set(gk, []);
            groups.get(gk).push({ letter: l, memory: m });
        }
    }
    for (const [gk, items] of groups) {
        const [author, person] = gk.split('\u0001');
        const aliases = namesOf(author).filter(n => n !== author);
        items.sort((x, y) => String(x.letter.writtenAt).localeCompare(String(y.letter.writtenAt)));
        const many = items.length > 1;
        if (many) {
            const k = authorKey(author, aliases);
            out.push({
                tag: `sum:${author}:${person}`,
                key: k ? [k] : [author],
                comment: `书信簿｜${person}读过的${author}来信一览`,
                content: summaryEntryContent(person, author, items.map(i => ({ ...i, where: shortWhere(i.letter, i.memory.person) }))),
                order: 99,
                memories: [],
            });
        }
        for (const { letter, memory } of items) {
            out.push({
                tag: `mem:${letter.id}:${memory.person}`,
                key: memoryKeys(letter, aliases, { withAuthor: !many }),
                comment: `书信簿｜${memory.person}读${author || '？'}来信的记忆（${letter.code || letter.id}）`,
                content: memoryEntryContent(letter, memory, whereForPerson(letter, memory.person, same)),
                memories: [memory],
            });
        }
    }
    if (settings().memory.rereadText !== false) {
        const user = ctx().name1 || '';
        for (const l of letters) {
            const w = whereNow(l);
            if (!w || !REREADABLE.has(w.state) || !w.holder || (user && same(w.holder, user)) || !String(l.body || '').trim()) continue;
            const read = l.memories.filter(isMine).some(m => same(m.person, w.holder)) || l.recipients.some(r => same(r, w.holder));
            if (!read) continue;
            const aliases = namesOf(l.author).filter(n => n !== l.author);
            out.push({
                tag: `txt:${l.id}`,
                key: [rereadKey(l, aliases)].filter(Boolean),
                comment: `书信簿｜${l.author}来信原文（${l.code || l.id}，在${w.holder}手里，重读时用）`,
                content: rereadEntryContent(l, w.holder, w.place),
                order: 101,
                memories: [],
            });
        }
    }
    return out;
}

function shortWhere(letter, person) {
    if (deliveryState(letter) === 'transit') return '信在路上';
    const w = whereNow(letter);
    if (!w) return '';
    if (w.state === 'burned') return '信已经烧了';
    if (w.state === 'lost') return '信丢了';
    if (w.holder && same(w.holder, person) && REREADABLE.has(w.state)) return `信还在${person}手里${w.place ? `，${w.place}` : ''}`;
    if (w.holder) return `信在${w.holder}那里`;
    return '';
}

// 把这个聊天的世界书和书信簿对齐：新增、更新、删掉过时的（只动书信簿自己写的条目）
let syncing = Promise.resolve();
function syncWorldBook() {
    syncing = syncing.then(syncWorldBookNow).catch(e => { console.warn('[书信簿] 写世界书失败', e); return false; });
    return syncing;
}

async function syncWorldBookNow() {
    if (!hasChat() || !settings().memory.worldbook) return false;
    if (!injectOn()) {
        // 关掉了注入：书信簿写的条目先停用（打开以后恢复）
        const c = ctx();
        const name = c.chatMetadata?.world_info;
        const data = name ? await c.loadWorldInfo(name) : null;
        if (!data?.entries) return false;
        let changed = false;
        for (const e of Object.values(data.entries)) {
            if (typeof e.comment === 'string' && EPI_TAG.test(e.comment) && !e.disable) { e.disable = true; e.epiOff = true; changed = true; }
        }
        if (changed) { await c.saveWorldInfo(name, data, true); try { c.reloadWorldInfoEditor?.(name); } catch { /* */ } }
        return false;
    }
    const want = desiredEntries();
    const book = await memoryBook({ create: want.length > 0 });
    if (!book) return false;
    const { name, data } = book;
    const existing = new Map();
    let changed = false;
    for (const e of Object.values(data.entries)) {
        const m = typeof e.comment === 'string' && e.comment.match(EPI_TAG);
        if (m) existing.set(m[1], e);
        else if (typeof e.comment === 'string' && e.comment.startsWith('书信簿｜')) { delete data.entries[e.uid]; changed = true; } // v0.21 的旧格式
    }
    const keep = new Set();
    for (const w of want) {
        keep.add(w.tag);
        const old = existing.get(w.tag) || null;
        const uid = old ? old.uid : freeUid(data);
        const e = wiEntry(uid, w, old);
        if (!old || JSON.stringify(old) !== JSON.stringify(e)) { data.entries[uid] = e; changed = true; }
        for (const m of w.memories) { if (m.wiUid !== uid || m.wiBook !== name) { m.wiUid = uid; m.wiBook = name; store.save(); } }
    }
    for (const [tag, e] of existing) if (!keep.has(tag)) { delete data.entries[e.uid]; changed = true; }
    if (changed) {
        await ctx().saveWorldInfo(name, data, true);
        try { ctx().reloadWorldInfoEditor?.(name); } catch { /* 编辑器没开 */ }
    }
    return name;
}

// 那一层现在显示的是第几个回复
const swipeOf = mes => (Number.isInteger(mes) ? (ctx().chat?.[mes]?.swipe_id ?? 0) : null);

function upsertMemories(letter, found, { auto = true, fromMes = null } = {}) {
    letter.memories = Array.isArray(letter.memories) ? letter.memories : [];
    const changed = [];
    const now = new Date().toISOString();
    for (const f of found) {
        const text = checkQuotes(f.text, letter.body);
        const old = letter.memories.find(m => isMine(m) && same(m.person, f.person));
        if (old) {
            if (auto && old.auto === false) continue; // 用户改过的，不覆盖
            if (fromMes == null || old.fromMes !== fromMes) old.prev = { text: old.text, gist: old.gist || '', fromMes: old.fromMes ?? null, fromSwipe: old.fromSwipe ?? null };
            Object.assign(old, { text, gist: f.gist || '', updatedAt: now, auto, fromMes, fromSwipe: swipeOf(fromMes), chatId: chatId() });
            changed.push(old);
        } else {
            const m = { person: f.person, text, gist: f.gist || '', updatedAt: now, wiUid: null, wiBook: '', auto, fromMes, fromSwipe: swipeOf(fromMes), prev: null, chatId: chatId() };
            letter.memories.push(m);
            changed.push(m);
        }
    }
    return changed;
}

// 剧情里这封信发生了什么：记进流转记录（时间线里显示），寄出 / 收到顺便改寄送状态
function applyStoryEvents(letter, events, { fromMes = null, past = false, manual = false } = {}) {
    const added = [];
    const f = floor();
    for (const e of events || []) {
        const mes = e.mes != null && e.mes >= 0 && e.mes < f ? e.mes : fromMes;
        const date = e.date || (past ? '' : getStoryDate());
        if (!manual && (letter.events || []).some(x => x.type === e.type && same(x.who || '？', e.who || '？') && ((mes != null && x.mes === mes) || (date && x.date === date)))) continue;
        const ev = { id: nextEventId(letter.events), type: e.type, who: e.who, date, segments: null, to: e.to || '', note: e.note || '', place: e.place || '', mes: manual ? null : mes, auto: !manual, chatId: chatId(), src: manual ? null : (fromMes ?? mes), swipe: manual ? null : swipeOf(fromMes ?? mes) };
        letter.events.push(ev);
        added.push(ev);
        const st = deliveryState(letter);
        const d = letter.delivery || {};
        const snap = () => !manual && letter.autoDelivery.push({ mes: fromMes ?? mes ?? f, swipe: swipeOf(fromMes ?? mes ?? f), chatId: chatId(), status: letter.status, delivery: letter.delivery ? JSON.parse(JSON.stringify(letter.delivery)) : null, placeTo: letter.placeTo });
        const isRecipient = !e.who || letter.recipients.some(r => same(r, e.who));
        if (e.type === 'sent' && (st === 'draft' || st === 'unsent')) {
            snap();
            letter.status = 'sent';
            letter.delivery = { ...d, mode: d.mode || 'instant', status: 'transit', eta: d.eta || '', sentAt: date, reader: d.reader || letter.recipients[0] || '' };
        } else if (e.type === 'received' && isRecipient && !(st === 'delivered' && d.arrivedAt)) {
            snap();
            letter.status = 'sent';
            letter.delivery = { ...d, mode: d.mode || 'instant', status: 'viewed', stage: d.via ? 'done' : (d.stage || ''), arrivedAt: date, reader: e.who || d.reader || letter.recipients[0] || '' };
            if (e.place && !letter.placeTo) letter.placeTo = e.place;
        } else if ((e.type === 'received' && !isRecipient && st !== 'delivered') || (e.type === 'forwarded' && e.who && !isRecipient && !d.via)) {
            // 先到了转交人手里 / 由谁转交
            snap();
            letter.status = 'sent';
            letter.delivery = { ...d, mode: d.mode || 'instant', via: e.who, ...(e.type === 'received' ? { status: 'atVia', stage: 'atVia', viaArrivedAt: date } : {}) };
        }
    }
    return added;
}

// 让 AI 从一段剧情里整理某封信：谁读了记得什么、这封信发生了什么、信最后放哪（建议）
// memMode：first 只给还没有记忆的人写 | every 都更新 | off 不写记忆
async function extractMemories(letter, scene, { quiet = false, past = false, fromMes = null, memMode = 'every' } = {}) {
    const { system, prompt } = buildMemoryPrompt(letter, scene, {
        existing: (letter.memories || []).filter(isMine),
        storyDate: past ? '' : getStoryDate(),
        userName: ctx().name1 || '',
    });
    const raw = await ai(system, prompt, { kind: 'memory' });
    const user = ctx().name1 || '';
    const res = parseMemoryResult(raw);
    let found = memMode === 'off' ? [] : res.memories.filter(f => !user || !sameName(store.archive, f.person, user));
    if (memMode === 'first') found = found.filter(f => !(letter.memories || []).some(m => isMine(m) && same(m.person, f.person)));
    const changed = upsertMemories(letter, found, { fromMes });
    const happened = settings().memory.trackEvents !== false ? applyStoryEvents(letter, res.events, { fromMes, past }) : [];
    // 剧情日期往前走了
    if (!past && res.storyDate && (!normalizeDate(getStoryDate()) || res.storyDate > normalizeDate(getStoryDate()))) setStoryDate(res.storyDate);
    // 信最后放哪：只当建议，等你在阅读页确认
    let moved = false;
    if (res.where) moved = suggestWhere(letter, res.where, { date: past ? '' : getStoryDate(), mes: fromMes, chatId: chatId(), swipe: swipeOf(fromMes) });
    if (!changed.length && !moved && !happened.length) return [];
    letter.updatedAt = new Date().toISOString();
    store.save();
    const book = await syncWorldBook();
    if (!quiet && happened.length) toastr.info(happened.map(e => `${e.who || '？'} ${EVENT_ZH[e.type] || e.type}${e.date ? `（${e.date}）` : ''}`).join('；'), `🕰 ${letter.author} 的信 · 记进时间线`, { timeOut: 5000 });
    if (!quiet && changed.length) toastr.success(`${changed.map(m => m.person).join('、')} 记住了 ${letter.author} 的这封信${book ? `（已写进世界书「${book}」）` : ''}`, '🧠 读信的记忆', { timeOut: 5000 });
    if (!quiet && moved) toastr.info(`AI 觉得 ${letter.author} 的信现在：${whereText(letter.whereabouts.suggest)}。打开这封信，在最上面点“采用”才会记下。`, '📍 信在谁手里（待你确认）', { timeOut: 6000 });
    ui?.refresh?.();
    return changed;
}
const EVENT_ZH = { written: '写好了信', sent: '寄出', received: '收到', read: '读了', forwarded: '转交', kept: '收起来', mentioned: '提到' };

// “只在第一次读时整理”：这封信在这次回复里有没有新的读者
function hasNewReader(letter, mesId) {
    const mine = (letter.memories || []).filter(isMine);
    if (!mine.length) return true;
    const m = ctx().chat?.[mesId];
    const text = `${m?.mes || ''}\n${m?.extra?.reasoning || ''}`;
    const user = ctx().name1 || '';
    const cands = new Set([ctx().name2, ...letter.recipients, letter.delivery?.via, ...store.archive.people.map(p => p.name)].filter(Boolean));
    for (const c of cands) {
        if ((user && same(c, user)) || mine.some(x => same(x.person, c))) continue;
        // 名字挨着“读 / 拆 / 念 / 看……信”才算这个人读了
        const who = namesOf(c).filter(Boolean).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        if (who && new RegExp(`(${who})[^。！？\\n]{0,20}(读|拆|念|看|展开|信纸)|(念给|读给|递给)[^。！？\\n]{0,4}(${who})`).test(text)) return true;
    }
    return false;
}

function memoriesAfterReply(mesId) {
    const s = settings();
    const when = s.memory.when;
    if (!aiOn() || store.mode === 'unloaded') return;
    if (when === 'off' && s.memory.trackEvents === false) return;
    const m = ctx().chat?.[mesId];
    if (!m || m.is_user || m.is_system || m.extra?.epistolary) return;
    let letters = lettersReadAt(mesId);
    // 只整理记忆、不记剧情时，“第一次读”模式下没有新读者就不调用
    if (when === 'first' && s.memory.trackEvents === false) letters = letters.filter(l => hasNewReader(l, mesId));
    if (!letters.length) return;
    const scene = sceneAround(mesId);
    memoryQueue = memoryQueue.then(async () => {
        for (const l of letters) {
            try { await extractMemories(l, scene, { fromMes: mesId, memMode: when }); } catch (e) { console.warn('[书信簿] 整理记忆失败', e); }
        }
    });
}

// 换了回复、删了消息：从这一层起（这个聊天里）AI 记下的记忆、经过、寄送改动、位置建议都撤回。
// 换回复时撤下来的东西按“第几层第几个回复”收起来；划回那个旧回复时再放回去。
function revokeStash() {
    const meta = chatMeta();
    meta.revoked = meta.revoked && typeof meta.revoked === 'object' ? meta.revoked : {};
    return meta.revoked;
}

async function revokeFrom(mesFrom, { stash = false, quiet = false } = {}) {
    if (!hasChat() || store.mode === 'unloaded') return 0;
    const cid = chatId();
    let n = 0, any = false;
    const box = stash ? revokeStash() : null;
    const keep = (mes, swipe, item) => {
        if (!box || mes == null) return;
        const k = `${mes}:${swipe ?? 0}`;
        (box[k] = box[k] || []).push({ ...item, at: Date.now() });
    };
    for (const l of Object.values(store.archive.letters)) {
        let touched = false;
        const sug = revokeWhere(l, mesFrom, cid);
        if (sug) { touched = true; keep(sug.mes, sug.swipe, { letterId: l.id, kind: 'sug', data: sug }); }
        const gone = (l.events || []).filter(e => e.auto && (e.src ?? e.mes) != null && (e.src ?? e.mes) >= mesFrom && e.chatId === cid);
        if (gone.length) {
            l.events = l.events.filter(e => !gone.includes(e));
            for (const e of gone) keep(e.src ?? e.mes, e.swipe, { letterId: l.id, kind: 'ev', data: e });
            touched = true; n += gone.length;
        }
        while (l.autoDelivery?.length && l.autoDelivery.at(-1).mes >= mesFrom && l.autoDelivery.at(-1).chatId === cid) {
            const p = l.autoDelivery.pop();
            keep(p.mes, p.swipe, { letterId: l.id, kind: 'dv', data: { snap: p, now: { status: l.status, delivery: l.delivery, placeTo: l.placeTo } } });
            l.status = p.status; l.delivery = p.delivery; l.placeTo = p.placeTo ?? l.placeTo;
            touched = true;
        }
        for (const m of [...(l.memories || [])]) {
            if (!isMine(m) || m.auto === false || m.fromMes == null || m.fromMes < mesFrom) continue;
            keep(m.fromMes, m.fromSwipe, { letterId: l.id, kind: 'mem', data: JSON.parse(JSON.stringify(m)) });
            if (m.prev && (m.prev.fromMes == null || m.prev.fromMes < mesFrom)) Object.assign(m, { text: m.prev.text, gist: m.prev.gist, fromMes: m.prev.fromMes, fromSwipe: m.prev.fromSwipe ?? null, prev: null });
            else l.memories.splice(l.memories.indexOf(m), 1);
            touched = true;
            n++;
        }
        if (touched) { l.updatedAt = new Date().toISOString(); any = true; }
    }
    if (box) {
        // 只留最近 30 个回复的
        const keys = Object.keys(box);
        for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete box[k];
        saveMeta();
    }
    if (!any) return 0;
    store.save();
    await syncWorldBook();
    if (!quiet && n) toastr.info(`那一层记下的 ${n} 条读信记忆 / 经过已撤回`, '🧠 书信簿', { timeOut: 3500 });
    ui?.refresh?.();
    return n;
}

// 划回之前的某个回复：把当时撤下来的放回去
async function restoreStash(mes, swipe) {
    const box = revokeStash();
    const k = `${mes}:${swipe ?? 0}`;
    const cleared = settings().memory.clearedAt || 0;
    const items = (box[k] || []).filter(it => (it.at || 0) >= cleared);
    delete box[k];
    saveMeta();
    if (!items.length) return 0;
    // 寄送快照是从新到旧撤下来的：倒过来放回去，状态用最新的那一个
    const dvs = items.filter(it => it.kind === 'dv');
    const dvDone = new Set();
    for (const it of [...dvs].reverse()) {
        const l = store.archive.letters[it.letterId];
        if (!l) continue;
        l.autoDelivery.push(it.data.snap);
    }
    for (const it of dvs) {
        if (dvDone.has(it.letterId)) continue;
        dvDone.add(it.letterId);
        const l = store.archive.letters[it.letterId];
        if (!l) continue;
        l.status = it.data.now.status; l.delivery = it.data.now.delivery; l.placeTo = it.data.now.placeTo;
    }
    for (const it of items) {
        const l = store.archive.letters[it.letterId];
        if (!l) continue;
        if (it.kind === 'ev' && !(l.events || []).some(e => e.id === it.data.id && e.auto && e.mes === it.data.mes && e.type === it.data.type)) {
            const ev = { ...it.data };
            if ((l.events || []).some(e => e.id === ev.id)) ev.id = nextEventId(l.events); // 编号被你后来记的占了
            l.events.push(ev);
        }
        if (it.kind === 'sug') { l.whereabouts = l.whereabouts || { current: null, suggest: null, history: [] }; l.whereabouts.suggest = it.data; }
        if (it.kind === 'mem') {
            const i = l.memories.findIndex(m => isMine(m) && same(m.person, it.data.person));
            if (i >= 0) { if (l.memories[i].auto !== false) l.memories[i] = it.data; } else l.memories.push(it.data);
        }
        l.updatedAt = new Date().toISOString();
    }
    store.save();
    await syncWorldBook();
    toastr.info('划回了之前的回复，当时记下的读信记忆和经过也放回来了', '🧠 书信簿', { timeOut: 3500 });
    ui?.refresh?.();
    return items.length;
}

// 你手动改了寄送：换回复时不再拿旧快照覆盖
function dropStashedDelivery(letterId) {
    if (!hasChat()) return;
    const box = revokeStash();
    let changed = false;
    for (const k of Object.keys(box)) {
        const keep = box[k].filter(it => !(it.kind === 'dv' && it.letterId === letterId));
        if (keep.length !== box[k].length) { box[k] = keep; changed = true; }
    }
    if (changed) saveMeta();
}

// 阅读页的按钮：从最近几层剧情里整理这封信的记忆
async function memoriesFromRecent(letterId, depth = 6) {
    const letter = store.archive.letters[letterId];
    if (!letter || !hasChat()) return [];
    const chat = ctx().chat || [];
    return extractMemories(letter, sceneAround(chat.length - 1, { before: depth - 1 }), { fromMes: chat.length - 1 });
}

// 过去的楼层：哪些地方可能有人读过这封信
function findPastScenes(letterId) {
    const letter = store.archive.letters[letterId];
    if (!letter || !hasChat()) return [];
    const aliases = namesOf(letter.author).filter(n => n !== letter.author);
    return findReadingScenes(ctx().chat || [], letter, { names: aliases, chatId: chatId() });
}

// 按选好的楼层范围，一段一段整理（从早到晚，后面的会补进前面的记忆）
async function memoriesFromFloors(letterId, ranges, { onProgress, quiet = false } = {}) {
    const letter = store.archive.letters[letterId];
    if (!letter || !hasChat()) return [];
    const chat = ctx().chat || [];
    const sorted = [...ranges].filter(r => Number.isInteger(r.from) && Number.isInteger(r.to)).sort((a, b) => a.from - b.from);
    const people = new Set();
    for (let k = 0; k < sorted.length; k++) {
        onProgress?.(k + 1, sorted.length);
        const r = sorted[k];
        const from = Math.min(r.from, r.to), to = Math.max(r.from, r.to);
        const text = sceneText(chat, from, to);
        if (!text.trim()) continue;
        try {
            const got = await extractMemories(letter, text, { quiet: true, past: true, fromMes: to });
            got.forEach(m => people.add(m.person));
        } catch (e) { console.warn('[书信簿] 整理记忆失败', e); toastr.error(String(e?.message || e), `第 ${r.from}–${r.to} 层整理失败`); }
    }
    const book = letter.memories.find(m => m.wiBook)?.wiBook;
    if (people.size && !quiet) toastr.success(`${[...people].join('、')} 记住了 ${letter.author} 的这封信${book ? `（已写进世界书「${book}」）` : ''}`, '🧠 从过去的楼层整理好了', { timeOut: 6000 });
    return [...people];
}

// 整个聊天里用暗号读过的信，还没有记忆的：列出来
function codeReadsInChat() {
    if (!hasChat()) return [];
    const out = [];
    for (const l of Object.values(store.archive.letters)) {
        if (!l.code || (l.memories || []).some(isMine) || l.shell) continue;
        const scenes = findPastScenes(l.id).filter(s => s.reasons.includes('code') || s.reasons.includes('source'));
        if (scenes.length) out.push({ letterId: l.id, scenes });
    }
    return out;
}

async function saveMemoryEdit(letterId, person, text) {
    const letter = store.archive.letters[letterId];
    if (!letter) return;
    letter.memories = letter.memories || [];
    const i = letter.memories.findIndex(m => m.person === person && isMine(m));
    const t = String(text || '').trim();
    if (i >= 0 && !t) letter.memories.splice(i, 1);
    else if (i >= 0) Object.assign(letter.memories[i], { text: t, gist: '', auto: false, prev: null, updatedAt: new Date().toISOString() });
    else if (person && t) letter.memories.push({ person, text: t, gist: '', auto: false, updatedAt: new Date().toISOString(), wiUid: null, wiBook: '', fromMes: null, prev: null, chatId: chatId() });
    letter.updatedAt = new Date().toISOString();
    store.save();
    await syncWorldBook();
}

// 清除记忆：读后记忆 / AI 记下的经过 / 位置建议；scope = chat 只清这个聊天 | all 所有聊天
async function clearMemories({ memories = true, events = false, suggestions = false, scope = 'chat' } = {}) {
    const cid = chatId();
    const inScope = x => scope === 'all' || (x && x.chatId === cid) || (x && !x.chatId && x.wiBook && x.wiBook === ctx().chatMetadata?.world_info);
    try { await store.backupNow({ note: '清除记忆前' }); } catch (e) { console.warn('[书信簿] 清除前备份失败', e); }
    let n = 0;
    for (const l of Object.values(store.archive.letters)) {
        let touched = false;
        if (memories && l.memories?.length) {
            const keep = l.memories.filter(m => !inScope(m));
            n += l.memories.length - keep.length;
            if (keep.length !== l.memories.length) { l.memories = keep; touched = true; }
        }
        if (events && l.events?.length) {
            const keep = l.events.filter(e => !(e.auto && (scope === 'all' || e.chatId === cid)));
            n += l.events.length - keep.length;
            if (keep.length !== l.events.length) { l.events = keep; touched = true; }
            const ad = (l.autoDelivery || []).filter(x => !(scope === 'all' || x.chatId === cid));
            if (ad.length !== (l.autoDelivery || []).length) { l.autoDelivery = ad; touched = true; }
        }
        if (suggestions && l.whereabouts?.suggest && (scope === 'all' || !l.whereabouts.suggest.chatId || l.whereabouts.suggest.chatId === cid)) {
            l.whereabouts.suggest = null; n++; touched = true;
        }
        if (touched) l.updatedAt = new Date().toISOString();
    }
    // 换回复时收起来的旧记录也作废，免得划回旧回复时又放回来
    if (hasChat()) { const meta = chatMeta(); if (meta.revoked) { meta.revoked = {}; saveMeta(); } }
    if (scope === 'all') { settings().memory.clearedAt = Date.now(); saveSettings(); }
    store.save();
    if (hasChat()) await syncWorldBook();
    ui?.refresh?.();
    return n;
}

async function saveRecallKeys(letterId, keys) {
    const letter = store.archive.letters[letterId];
    if (!letter) return;
    letter.recallKeys = keys;
    store.save();
    await syncWorldBook();
}

// 手动改寄送状态（和“在谁手里”分开）
async function saveDelivery(letterId, o) {
    const l = store.archive.letters[letterId];
    if (!l) return false;
    const d = { ...(l.delivery || {}) };
    const via = String(o.via || '').trim();
    const reader = String(o.reader || '').trim() || l.recipients[0] || '';
    switch (o.state) {
        case 'draft': l.status = 'draft'; l.delivery = null; break;
        case 'unsent': l.status = 'unsent'; l.delivery = null; break;
        case 'lost': l.status = 'lost'; if (l.delivery) l.delivery = { ...d, status: 'lost' }; break;
        case 'transit':
            l.status = 'sent';
            l.delivery = { ...d, mode: d.mode === 'floors' ? 'floors' : 'date', status: 'transit', eta: o.eta || d.eta || '', via, stage: via ? (d.stage === 'toRecipient' ? 'toRecipient' : 'toVia') : '', reader, sentFloor: d.sentFloor ?? floor(), floors: d.floors || 0 };
            break;
        case 'atVia':
            l.status = 'sent';
            l.delivery = { ...d, mode: d.mode || 'instant', status: 'atVia', stage: 'atVia', via: via || d.via || '', reader, viaArrivedAt: o.arrivedAt || d.viaArrivedAt || getStoryDate() };
            break;
        case 'delivered': {
            l.status = 'sent';
            const when = o.arrivedAt || d.arrivedAt || '';
            l.delivery = { ...d, mode: d.mode || 'instant', status: 'viewed', stage: via ? 'done' : (d.stage || ''), via, reader, arrivedAt: when };
            if (!(l.events || []).some(e => e.type === 'received')) l.events.push(...deliveryEvents(l, when, l.events));
            if (via && !(l.events || []).some(e => e.type === 'forwarded')) l.events.push({ id: nextEventId(l.events), type: 'forwarded', who: via, date: o.forwardedAt || when, segments: null, to: l.recipients.join('、'), note: '' });
            break;
        }
        default: return false;
    }
    if (o.placeTo !== undefined) l.placeTo = String(o.placeTo).trim();
    l.autoDelivery = []; // 你手动改过：之后换回复不会把它退回去
    dropStashedDelivery(letterId);
    l.updatedAt = new Date().toISOString();
    store.save();
    ui.renderPostbox();
    await syncWorldBook();
    return true;
}

async function addEvent(letterId, e) {
    const l = store.archive.letters[letterId];
    if (!l) return false;
    applyStoryEvents(l, [{ ...e, date: normalizeDate(e.date) ? e.date : '' }], { manual: true, past: true });
    if (['sent', 'received', 'forwarded'].includes(e.type)) { l.autoDelivery = []; dropStashedDelivery(letterId); }
    l.updatedAt = new Date().toISOString();
    store.save();
    ui.renderPostbox();
    await syncWorldBook();
    return true;
}

async function deleteEvent(letterId, eventId) {
    const l = store.archive.letters[letterId];
    if (!l) return false;
    l.events = (l.events || []).filter(e => e.id !== eventId);
    l.updatedAt = new Date().toISOString();
    store.save();
    return true;
}

async function whereSuggestion(letterId, accept) {
    const l = store.archive.letters[letterId];
    if (!l) return false;
    const ok = accept ? acceptSuggestion(l) : dismissSuggestion(l);
    if (!ok) return false;
    l.updatedAt = new Date().toISOString();
    store.save();
    await syncWorldBook();
    return true;
}

// 手动改信的位置
async function saveWhereabouts(letterId, w) {
    const letter = store.archive.letters[letterId];
    if (!letter) return false;
    const ok = setWhere(letter, w, { date: getStoryDate() });
    if (!ok) return false;
    letter.updatedAt = new Date().toISOString();
    store.save();
    await syncWorldBook();
    return true;
}

// ---------- 时间线「更新」：不等自动，马上把各封信的状态对一遍 ----------

function statusLine(l) {
    const parts = [deliveryText(l).replace(/^\S+\s/, '')];
    const readers = [...new Set([...(l.events || []).filter(e => ['read', 'heard'].includes(e.type)).map(e => e.who), ...(l.memories || []).map(m => m.person)].filter(Boolean))];
    if (readers.length) parts.push(`${readers.join('、')} 读过`);
    const w = whereNow(l);
    if (w) parts.push(`信在：${whereText(w).replace(/^\S+\s/, '')}`);
    return parts.join('；');
}
const STATUS_ZH = { draft: '草稿', sealed: '封好了没寄', unsent: '写了没寄', lost: '遗失' };

// 和这个聊天有关的信：名字、暗号出现在这段剧情里，或者还在路上
function lettersForStatus(text) {
    const out = [];
    for (const l of Object.values(store.archive.letters)) {
        if (l.status === 'draft' && !isSimple()) continue;
        const dv = l.delivery;
        const pending = dv && ['transit', 'atVia', 'held', 'arrived'].includes(dv.status);
        const names = [l.author, ...l.recipients, dv?.via].filter(Boolean).flatMap(n => namesOf(n));
        const mentioned = (l.code && text.includes(l.code)) || (l.title && text.includes(l.title)) || names.some(n => n.length >= 2 && text.includes(n));
        if (pending || mentioned) out.push(l);
    }
    return out.sort((a, b) => String(b.writtenAt).localeCompare(String(a.writtenAt))).slice(0, 20);
}

// 让 AI 看一段剧情，更新这几封信：收到了没有、谁读了、信放哪（建议）
async function statusPass(letters, story, end, changes, onStep, rng = null) {
        const items = letters.map((letter, i) => ({ n: i + 1, letter, now: statusLine(letter) }));
        const { system, prompt } = buildStatusPrompt(items, story, { storyDate: getStoryDate(), userName: ctx().name1 || '' });
        const res = parseStatusResponse(await ai(system, prompt, { kind: 'status' }));
        const user = ctx().name1 || '';
        const toRemember = [];
        const lo = rng?.from ?? 0, hi = rng?.to ?? end;
        for (const r of res) {
            // AI 给的楼层号不在这一段里，就当没给，用这一段的最后一层
            if (!(Number.isInteger(r.mes) && r.mes >= lo && r.mes <= hi)) r.mes = null;
            const l = items.find(x => x.n === r.n)?.letter;
            if (!l) continue;
            const label = `${l.author} → ${l.recipients.join('、')}${l.code ? ` ${l.code}` : ''}`;
            const when = normalizeDate(r.receivedDate) ? r.receivedDate : getStoryDate();
            const readBefore = new Set((l.events || []).filter(e => ['read', 'heard'].includes(e.type)).map(e => e.who));
            // 收到了
            if (r.received === true && !(l.delivery && ['viewed', 'arrived'].includes(l.delivery.status) && l.delivery.arrivedAt)) {
                const reader = r.receivedBy || l.recipients[0] || '';
                const at = r.mes ?? hi;
                l.autoDelivery.push({ mes: at, swipe: swipeOf(at), chatId: chatId(), status: l.status, delivery: l.delivery ? JSON.parse(JSON.stringify(l.delivery)) : null, placeTo: l.placeTo });
                const d = l.delivery || {};
                l.status = 'sent';
                l.delivery = { ...d, mode: d.mode || 'instant', status: 'viewed', stage: d.via ? 'done' : (d.stage || ''), arrivedAt: when, reader, detected: true };
                if (r.receivedPlace && !l.placeTo) l.placeTo = r.receivedPlace;
                l.events.push({ id: nextEventId(l.events), type: 'received', who: reader, date: when, segments: null, to: '', note: '', place: r.receivedPlace || '', mes: at, auto: true, chatId: chatId(), swipe: swipeOf(at) });
                changes.push(`${label}：${reader} ${when ? `${when} ` : ''}收到了${r.receivedPlace ? `（${r.receivedPlace}）` : ''}`);
            }
            // 谁读了
            const newReaders = [];
            for (const who of r.readers) {
                if (user && sameName(store.archive, who, user)) continue;
                const hasMemory = (l.memories || []).some(m => isMine(m) && same(m.person, who));
                if ([...readBefore].some(x => same(x, who)) && hasMemory) continue;
                if (!(l.events || []).some(e => ['read', 'heard'].includes(e.type) && same(e.who, who))) l.events.push({ id: nextEventId(l.events), type: 'read', who, date: getStoryDate(), segments: null, to: '', note: '', place: '', mes: r.mes ?? hi, auto: true, chatId: chatId(), swipe: swipeOf(r.mes ?? hi) });
                if (hasMemory) continue;
                newReaders.push(who);
            }
            if (newReaders.length) {
                changes.push(`${label}：${newReaders.join('、')} 读了`);
                if (r.mes != null) toRemember.push({ letter: l, mes: r.mes });
            }
            // 在哪
            if (r.where && suggestWhere(l, r.where, { date: getStoryDate(), mes: r.mes ?? hi, chatId: chatId(), swipe: swipeOf(r.mes ?? hi) })) changes.push(`${label}：AI 觉得信${whereText(l.whereabouts.suggest).replace(/^\S+\s/, '')}（只是建议，到这封信上面点“采用”才记下）`);
            l.updatedAt = new Date().toISOString();
        }
        store.save();
        // 新读者：顺便整理读后的反应
        if (settings().memory.when !== 'off') {
            for (const { letter, mes } of toRemember) {
                if (letter.shell || !String(letter.body || '').trim()) continue;
                onStep?.(`整理 ${letter.author} 那封信的读后反应`);
                const got = await memoriesFromFloors(letter.id, [{ from: Math.max(0, mes - 1), to: Math.min(end, mes + 1) }], { quiet: true });
                if (got.length) changes.push(`${letter.author} → ${letter.recipients.join('、')}${letter.code ? ` ${letter.code}` : ''}：记下了 ${got.join('、')} 读后的反应`);
            }
        }
        await syncWorldBook();
    
}

// 暗号在这个聊天的哪几层出现过（扫一遍聊天，顺便记到信上）
function scanCodeFloors() {
    const chat = ctx().chat || [];
    const cid = chatId();
    const map = new Map();
    chat.forEach((m, i) => {
        // 只看你写的消息（角色的回复里不会写暗号）
        if (!m || !m.is_user || m.is_system || typeof m.mes !== 'string' || !m.mes.includes('【') && !/[\[〖〔［（(「『《<]/.test(m.mes)) return;
        for (const l of lettersByCode(store.archive, m.mes)) {
            if (!map.has(l.id)) map.set(l.id, []);
            map.get(l.id).push(i);
        }
    });
    let changed = false;
    for (const l of Object.values(store.archive.letters)) {
        const found = map.get(l.id) || [];
        const others = (l.codeFloors || []).filter(x => x.chatId !== cid);
        const mine = found.map(mes => ({ chatId: cid, mes }));
        const next = [...others, ...mine].slice(-50);
        if (JSON.stringify(l.codeFloors || []) !== JSON.stringify(next)) { l.codeFloors = next; changed = true; }
    }
    if (changed) store.save();
    return map;
}

function recordCodeFloor(mesId) {
    const m = ctx().chat?.[mesId];
    if (!m || !m.is_user || typeof m.mes !== 'string') return;
    const cid = chatId();
    let changed = false;
    for (const l of lettersByCode(store.archive, m.mes)) {
        l.codeFloors = l.codeFloors || [];
        if (!l.codeFloors.some(x => x.chatId === cid && x.mes === mesId)) { l.codeFloors.push({ chatId: cid, mes: mesId }); changed = true; }
    }
    if (changed) store.save();
}

function codeFloorsHere(letter) {
    const cid = chatId();
    return (letter.codeFloors || []).filter(x => x.chatId === cid).map(x => x.mes).sort((a, b) => a - b);
}

// 这封信要看的楼层：暗号出现的那几层；没写过暗号的，用剧情里引用原句 / 原文所在的那几层
// 一次更新（或对话框开着的这段时间）里只扫一遍聊天
let floorCache = { key: '', floors: new Map() };
function floorKey() { return `${chatId()}|${(ctx().chat || []).length}|${Object.keys(store.archive.letters).length}`; }
function freshFloors() {
    const key = floorKey();
    if (floorCache.key !== key) { scanCodeFloors(); floorCache = { key, floors: new Map() }; }
}
function letterFloors(l) {
    freshFloors();
    if (floorCache.floors.has(l.id)) return floorCache.floors.get(l.id);
    let out = codeFloorsHere(l);
    if (!out.length) {
        const aliases = namesOf(l.author).filter(n => n !== l.author);
        out = findReadingScenes(ctx().chat || [], l, { names: aliases, chatId: chatId() }).filter(x => x.strong).map(x => x.from);
    }
    floorCache.floors.set(l.id, out);
    return out;
}

const mergeRanges = ranges => {
    const out = [];
    for (const r of [...ranges].sort((x, y) => x.from - y.from)) {
        const last = out.at(-1);
        if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to); else out.push({ ...r });
    }
    return out;
};

// 把几段楼层切成每批不超过 maxChars 字的几份
function storyChunks(chat, ranges, maxChars = 40000) {
    const chunks = [];
    let cur = [], size = 0;
    for (const r of ranges) {
        for (let i = r.from; i <= r.to; i++) {
            const m = chat[i];
            const len = m && typeof m.mes === 'string' ? Math.min(m.mes.length, 6000) + 40 : 0;
            if (cur.length && size + len > maxChars) { chunks.push(cur); cur = []; size = 0; }
            const last = cur.at(-1);
            if (last && last.to === i - 1) last.to = i; else cur.push({ from: i, to: i });
            size += len;
        }
    }
    if (cur.length) chunks.push(cur);
    return chunks;
}

// 更新状态的范围设置。mode：code 暗号出现的那层和之后几层 | recent 最近几层 | range 第几层到第几层 | since 上次更新以后
const DEFAULT_STATUS_SCOPE = { mode: 'code', after: 3, recent: 20, from: null, to: null };

// 按范围设置算出：要看的信、每封信要看的楼层（不调用 AI，对话框里预估用）
function planStatus({ letterIds = null, scope = {} } = {}) {
    const chat = ctx().chat || [];
    const end = chat.length - 1;
    const sc = { ...DEFAULT_STATUS_SCOPE, ...(settings().statusScope || {}), ...scope };
    const after = Math.max(0, Math.min(30, Number(sc.after) || 0));
    freshFloors();
    let letters, ranges = [];
    if (sc.mode === 'code') {
        letters = (letterIds ? letterIds.map(id => store.archive.letters[id]) : Object.values(store.archive.letters)).filter(l => l && (letterIds ? letterFloors(l) : codeFloorsHere(l)).length);
        for (const l of letters) for (const f of letterFloors(l)) ranges.push({ from: f, to: Math.min(end, f + after) });
    } else {
        let from, to = end;
        if (sc.mode === 'recent') from = Math.max(0, end - Math.max(1, Number(sc.recent) || 20) + 1);
        else if (sc.mode === 'range') { from = Math.max(0, Math.min(end, Number(sc.from) || 0)); to = Math.max(from, Math.min(end, Number.isInteger(Number(sc.to)) && sc.to !== '' && sc.to != null ? Number(sc.to) : end)); }
        else from = Math.max(0, Math.min(end - 9, Math.max(chatMeta().lastStatusFloor ?? 0, end - 39)));
        ranges = [{ from, to }];
        const text = sceneText(chat, from, to);
        letters = letterIds ? letterIds.map(id => store.archive.letters[id]).filter(Boolean) : lettersForStatus(text);
    }
    letters = letters.filter(l => String(l.body || '').trim() || l.shell);
    return { letters, ranges: mergeRanges(ranges), end, scope: sc };
}

function estimateStatus(opts) {
    const chat = ctx().chat || [];
    const p = planStatus(opts);
    if (!p.letters.length || !p.ranges.length) return { letters: 0, floors: 0, calls: 0 };
    const floors = p.ranges.reduce((x, r) => x + r.to - r.from + 1, 0);
    let calls;
    if (p.scope.mode === 'code') {
        calls = 0;
        for (let k = 0; k < p.letters.length; k += 12) {
            const batch = p.letters.slice(k, k + 12);
            const rs = mergeRanges(batch.flatMap(l => letterFloors(l).map(f => ({ from: f, to: Math.min(p.end, f + (Number(p.scope.after) || 0)) }))));
            calls += storyChunks(chat, rs).length;
        }
    } else calls = Math.ceil(p.letters.length / 12) * storyChunks(chat, p.ranges).length;
    return { letters: p.letters.length, floors, calls, ranges: p.ranges };
}

async function refreshStatuses({ onStep, letterIds = null, scope = null } = {}) {
    if (!hasChat() || store.mode === 'unloaded') return { changes: [], none: true };
    const changes = [];
    const chat = ctx().chat || [];
    const meta = chatMeta();
    if (scope) { settings().statusScope = { ...DEFAULT_STATUS_SCOPE, ...scope }; saveSettings(); }
    // ① 高级模式：推算剧情日期、到日子的信送到
    if (!isSimple() && mailInChat().length && aiOn()) {
        onStep?.('推算剧情日期');
        const before = getStoryDate();
        await inferStoryDate({ force: true });
        if (getStoryDate() !== before) changes.push(`剧情日期：${before || '（没有）'} → ${getStoryDate()}`);
        meta.lastDateCheck = 0;
        const transitBefore = mailInChat().filter(l => l.delivery.status === 'transit').map(l => l.id);
        await checkMail({});
        for (const id of transitBefore) {
            const l = store.archive.letters[id];
            if (l?.delivery?.status !== 'transit') changes.push(`${l.author} → ${l.recipients.join('、')}：${l.delivery.status === 'atVia' ? `到了 ${l.delivery.via} 手里` : '送到了'}`);
        }
    }
    // ② 按范围设置，一批最多 12 封信、每份剧情最多约 4 万字
    const p = planStatus({ letterIds, scope: scope || {} });
    const { letters, end } = p;
    let n = 0;
    for (let k = 0; k < letters.length; k += 12) {
        const batch = letters.slice(k, k + 12);
        const rs = p.scope.mode === 'code'
            ? mergeRanges(batch.flatMap(l => letterFloors(l).map(f => ({ from: f, to: Math.min(end, f + (Number(p.scope.after) || 0)) }))))
            : p.ranges;
        const chunks = storyChunks(chat, rs);
        for (const ch of chunks) {
            n++;
            const story = ch.map(r => sceneText(chat, r.from, r.to)).join('\n\n……\n\n');
            if (!story.trim()) continue;
            onStep?.(`AI 查看第 ${ch[0].from}–${ch.at(-1).to} 层（${batch.length} 封信）`);
            await statusPass(batch, story, end, changes, onStep, { from: ch[0].from, to: ch.at(-1).to });
        }
    }
    if (letters.length) await syncWorldBook();
    meta.lastStatusFloor = chat.length;
    saveMeta();
    ui?.renderPostbox?.();
    const from = p.ranges[0]?.from ?? 0, to = p.ranges.at(-1)?.to ?? end;
    return { changes, from, end: to, checked: letters.length, calls: n, scope: p.scope };
}

// ---------- 寄送 ----------

const store = new Store();
let ui = null;
let lastInjection = '';
let busy = false;

// 信送到了：记录收到、读过，进信箱等你决定要不要切过去看。
// 托人转交的信分两段：先送到转交人手里（只知道有这封信），转交人决定转交以后才走第二段。
function arrive(letter, date) {
    const dv = letter.delivery;
    const when = dv.mode === 'date' ? (dv.eta || date) : (date || getStoryDate());
    if (dv.via && dv.stage === 'toVia') {
        letter.events.push(...viaReceivedEvents(letter, dv.via, when, letter.events));
        dv.stage = 'atVia';
        dv.status = 'atVia';
        dv.viaArrivedAt = when;
        dv.viaArrivedFloor = floor();
        store.save();
        return;
    }
    letter.events.push(...deliveryEvents(letter, when, letter.events));
    if (dv.via) dv.stage = 'done';
    dv.status = 'arrived';
    dv.arrivedAt = when;
    store.save();
}

// ---------- 托人转交 ----------

const viaOf = letter => letter.delivery?.via || '';

// 镜头切到转交人那边：只给信封，由转交人自己决定拆不拆、交不交
async function switchToVia(letter) {
    if (!hasChat()) { toastr.warning('先打开一个聊天'); return; }
    const dv = letter.delivery;
    const via = viaOf(letter);
    const arrival = dv.viaArrivedAt || getStoryDate();
    if (arrival && normalizeDate(arrival) && (!getStoryDate() || normalizeDate(arrival) > normalizeDate(getStoryDate()))) setStoryDate(arrival);
    dv.viaViewed = true;
    dv.viaFollowup = true;
    dv.awaitingDecision = !ui.isMe(via);
    dv.decisionFrom = floor();
    dv.viaGuess = null;
    store.save();
    ui.renderPostbox();
    await pushMessage({
        name: ctx().name1, is_user: true, is_system: false, send_date: nowStamp(),
        mes: viaSceneMessage(letter, via, arrival),
        extra: { epistolary: { kind: 'via', letterId: letter.id, via, arrival } },
    }, { generate: true });
    ui.renderPostbox();
}

// 转交人拆开了信：记录他读过，把全文发进聊天，让他读
async function letViaRead(letter, { post = true } = {}) {
    const dv = letter.delivery;
    const via = viaOf(letter);
    const date = getStoryDate() || dv.viaArrivedAt || '';
    if (!letter.events.some(e => e.type === 'read' && e.who === via)) {
        letter.events.push({ id: nextEventId(letter.events), type: 'read', who: via, date, segments: null, to: '', note: '转交前私自拆看' });
    }
    dv.opened = true;
    dv.awaitingDecision = false;
    dv.viaGuess = null;
    store.save();
    ui.renderPostbox();
    ui.refresh();
    if (!post || !hasChat() || ui.isMe(via)) return;
    // 原文不发进聊天：下一次生成时直接交给 AI，TA 读完以后再判断怎么处理
    dv.awaitingDecision = true;
    dv.decisionFrom = floor();
    store.save();
    queueLetter(letter, { reader: via, arrival: date, peek: true });
    toastr.info(`${via} 拆开了信。下一次生成时，信的原文会直接交给 AI（不发进聊天）`, '✉ 拆信');
    ui.renderPostbox();
}

// 转交人把信交出去：开始第二段路程
function forwardLetter(letter, { mode, arrival, floors } = {}, { resealed = false, openly = false, note = '' } = {}) {
    const dv = letter.delivery;
    const via = viaOf(letter);
    const today = getStoryDate() || dv.viaArrivedAt || '';
    const leg = dv.leg2 || {};
    // 第一段是立即送达的，第二段按“再过几天”走剧情日期（没有剧情日期或填了 0 天就直接送到）
    mode = mode || (dv.mode === 'instant' ? (today && normalizeDate(today) && leg.days > 0 ? 'date' : 'instant') : dv.mode);
    if (mode === 'date' && !arrival) arrival = addDays(today, leg.days ?? 1) || today;
    if (mode === 'floors' && !floors) floors = leg.floors || 2;
    letter.events.push({ id: nextEventId(letter.events), type: 'forwarded', who: via, date: today, segments: null, to: letter.recipients.join('、'), note: dv.opened ? (openly ? `公开拆阅${note ? `，信封上写着：${note}` : ''}` : resealed ? '拆看后重新封好' : '拆看过') : '' });
    Object.assign(dv, {
        stage: 'toRecipient',
        status: 'transit',
        mode,
        eta: mode === 'date' ? arrival : '',
        floors: mode === 'floors' ? floors : 0,
        sentFloor: floor(),
        tampered: !!dv.opened && !resealed && !openly,
        openly: !!dv.opened && !!openly,
        viaNote: note || '',
        awaitingDecision: false,
        viaGuess: null,
        reader: letter.recipients[0] || '',
    });
    if (mode === 'instant') arrive(letter, today);
    store.save();
    ui.renderPostbox();
    ui.refresh();
    const reader = letter.recipients[0] || '收信人';
    toastr.success(mode === 'instant' ? `${via} 把信交给了 ${reader}` : `${via} 把信转交出去了，${ui.etaText(letter)}`, '📮 转交');
}

// 先留着 / 不转交
function setViaAction(letter, action) {
    const dv = letter.delivery;
    dv.status = action === 'withhold' ? 'withheld' : 'held';
    dv.awaitingDecision = false;
    dv.viaGuess = null;
    if (action === 'withhold' && !letter.events.some(e => e.type === 'lost' && e.who === viaOf(letter))) {
        letter.events.push({ id: nextEventId(letter.events), type: 'lost', who: viaOf(letter), date: getStoryDate() || '', segments: null, to: '', note: '转交人扣下没有转交' });
    }
    if (action !== 'withhold') letter.events = letter.events.filter(e => !(e.type === 'lost' && e.note === '转交人扣下没有转交'));
    store.save();
    ui.renderPostbox();
    ui.refresh();
}

// 最近几条剧情（包括 AI 的思考），给“判断转交人的决定”用。信的原文略去，免得干扰判断。
function storyWindow(fromIdx) {
    const chat = ctx().chat || [];
    const start = Math.max(0, fromIdx ?? 0, chat.length - 4);
    return chat.slice(start)
        .filter(m => m && !m.is_system && typeof m.mes === 'string')
        .map(m => {
            const info = m.extra?.epistolary;
            const body = info?.kind === 'letter' ? String(m.mes).split('\n')[0] + '（后面是信的原文，略）' : String(m.mes).slice(0, 2500);
            const think = m.extra?.reasoning ? `\n（${m.name} 的思考：${String(m.extra.reasoning).slice(0, 1500)}）` : '';
            return `${m.name}：${body}${think}`;
        }).join('\n\n');
}

// 让 AI 读最近的剧情，判断转交人对手里的每封信做了什么。返回 Map(信 → 判断)
async function judgeVia(letters, text = '') {
    if (!letters.length) return new Map();
    const via = viaOf(letters[0]);
    const froms = letters.map(l => l.delivery.decisionFrom).filter(n => Number.isFinite(n));
    text = text || storyWindow(froms.length ? Math.min(...froms) : undefined);
    if (!text) return new Map();
    const list = letters.map((l, i) => ({ n: i + 1, recipient: l.recipients.join('、'), label: l.title || '', target: l.delivery.target || '', opened: !!l.delivery.opened, held: l.delivery.status === 'held' }));
    const { system, prompt } = buildViaDecisionPrompt(via, list, text);
    try {
        const out = parseViaDecisions(await ai(system, prompt, { kind: 'via', via, letters: list }));
        const map = new Map();
        for (const d of out) if (letters[d.n - 1]) map.set(letters[d.n - 1], d);
        return map;
    } catch (e) {
        console.warn('[书信簿] 判断转交人的决定失败', e);
        return new Map();
    }
}

// 按转交人在剧情里的决定办（没有“手动决定”：角色怎么做，信就怎么走）
async function applyViaDecision(letter, guess, { fromCharacter = false } = {}) {
    const dv = letter.delivery;
    if (!guess) return;
    // 刚拆开：先把信的原文给 TA 看，读完以后再判断 TA 打算怎么办
    if (guess.opened && !dv.opened) {
        if (fromCharacter) setTimeout(() => letViaRead(letter), 500);
        else await letViaRead(letter);
        return;
    }
    dv.viaGuess = null;
    if (guess.action === 'forward') {
        forwardLetter(letter, {}, { resealed: !!guess.resealed, openly: !!guess.openly, note: guess.envelopeNote || '' });
    } else if (guess.action === 'withhold' || (guess.action === 'later' && dv.status !== 'held')) {
        setViaAction(letter, guess.action);
        toastr.info(`${viaOf(letter)}：${VIA_ACTIONS[guess.action]}${guess.note ? `（${guess.note}）` : ''}`, '📮 转交');
    } else if (guess.action === 'unclear') {
        dv.viaGuess = guess; // 还没决定：只在信箱里显示一句，下一层接着看
        store.save();
    }
}

// 这一层要不要看转交人的决定
function viaActive(l, lastText) {
    const dv = l.delivery;
    const f = floor();
    if (dv.awaitingDecision && f <= (dv.decisionFrom || 0) + 1) return false; // 刚切过去，转交人还没开口
    if (dv.awaitingDecision) return true;
    const today = normalizeDate(getStoryDate());
    if (dv.viaDeadline && today && today >= normalizeDate(addDays(dv.viaDeadline, -1))) return true; // 转交倒数：一层一看
    if (dv.opened && dv.status === 'atVia') return true; // 拆开以后还没决定：一层一看
    if (!lastText || !VIA_LETTER_RE.test(lastText)) return false;
    return isCurrentCharacter(dv.via) || mentionsName(lastText, namesOf(dv.via));
}

async function processVia(lastText, { fromCharacter = true } = {}) {
    // 同一个转交人手里的几封信一起判断，免得拆了一封、几封都算拆了
    const groups = new Map();
    for (const l of mailInChat()) {
        const dv = l.delivery;
        if (!['atVia', 'held'].includes(dv.status) || ui.isMe(dv.via)) continue;
        if (!groups.has(dv.via)) groups.set(dv.via, []);
        groups.get(dv.via).push(l);
    }
    for (const [, letters] of groups) {
        if (!letters.some(l => viaActive(l, lastText))) continue;
        if (letters.every(l => l.delivery.lastJudged === floor())) continue;
        for (const l of letters) { l.delivery.lastJudged = floor(); l.delivery.awaitingDecision = false; }
        store.save();
        const decisions = await judgeVia(letters);
        for (const [l, d] of decisions) await applyViaDecision(l, d, { fromCharacter });
        ui.renderPostbox();
    }
}

// 镜头切到收信人那边：（拆信动画）→ 一段旁白 + 信的全文 → 角色写收信反应
async function switchToRecipient(letter) {
    if (!hasChat()) { toastr.warning('先打开一个聊天'); return; }
    const dv = letter.delivery || {};
    const reader = dv.reader || letter.recipients[0];
    const arrival = dv.arrivedAt || dv.eta || getStoryDate();
    if (arrival && normalizeDate(arrival) && (!getStoryDate() || normalizeDate(arrival) > normalizeDate(getStoryDate()))) setStoryDate(arrival);
    letter.delivery = { ...dv, status: 'viewed', followup: true };
    store.save();
    ui.renderPostbox();
    if (settings().animations) await playOpen(letter, { render: ui.renderOpts(letter) });
    // 聊天里只有一句旁白；信的原文直接交给 AI
    queueLetter(letter, { reader, arrival });
    await pushMessage({
        name: ctx().name1,
        is_user: true,
        is_system: false,
        send_date: nowStamp(),
        mes: sceneSwitchMessage(letter, reader, arrival, { body: false }),
        extra: { epistolary: { kind: 'scene', letterId: letter.id, reader, arrival } },
    }, { generate: true });
    ui.renderPostbox();
}

async function postSceneReturn(letter) {
    if (!hasChat()) return;
    await pushMessage({
        name: ctx().name1,
        is_user: true,
        is_system: false,
        send_date: nowStamp(),
        mes: sceneReturnMessage(letter),
        extra: { epistolary: { kind: 'return', letterId: letter.id } },
    });
    toastr.info('镜头回来了，接着写你这边的剧情吧');
}

// 把角色的回信作为角色消息发到聊天
async function postReplyToChat(letter) {
    if (!hasChat()) { toastr.warning('先打开一个聊天'); return; }
    await pushMessage({
        name: letter.author,
        is_user: false,
        is_system: false,
        send_date: nowStamp(),
        mes: replyChatMessage(letter),
        extra: { epistolary: { kind: 'reply', letterId: letter.id } },
    });
}

function deliverNow(id) {
    const l = store.archive.letters[id];
    if (!l?.delivery || l.delivery.status !== 'transit') return;
    const toVia = l.delivery.via && l.delivery.stage === 'toVia';
    arrive(l, getStoryDate() || l.delivery.eta);
    toastr.success(toVia ? `信送到了转交人 ${l.delivery.via} 手里` : '信送到了');
    ui.renderPostbox();
    ui.refresh();
}

// 让 AI 根据最近的对话推算剧情日期
async function inferStoryDate({ force = false } = {}) {
    if (!hasChat()) return null;
    const current = getStoryDate();
    const text = recentMessages(ctx().chat, 10).map(m => `${m.name}：${String(m.mes).slice(0, 800)}`).join('\n\n');
    if (!text) return null;
    try {
        const { system, prompt } = buildDatePrompt(text, current);
        const out = await ai(system, prompt, { kind: 'date', current });
        const d = parseStoryDate(out, current);
        if (d && d !== current) {
            setStoryDate(d);
            if (!force) toastr.info(`剧情日期推进到 ${d}`, '书信簿');
        }
        return d || current;
    } catch (e) {
        console.warn('[书信簿] 推算剧情日期失败', e);
        if (force) toastr.error('推算失败：' + (e.message || e));
        return null;
    }
}

// ---------- 从剧情里发现信的动静 ----------

// 一个人在剧情里可能的叫法：档案里的名字和别名，再加上名（“文森特·梵高”→“文森特”，“提奥梵高”→“提奥”）
function namesOf(name) {
    const p = findPerson(store.archive, name);
    const out = new Set();
    for (const n of (p ? [p.name, ...(p.aliases || [])] : [name]).filter(Boolean)) {
        out.add(n);
        const parts = String(n).split(/[·・.\s]+/).filter(x => x.length >= 2);
        if (parts.length > 1) out.add(parts[0]);
        else if (/^[\u4e00-\u9fff]{4,}$/.test(n)) out.add(n.slice(0, 2));
    }
    return [...out];
}

function mailInChat() {
    const cid = chatId();
    return Object.values(store.archive.letters).filter(l => l.status === 'sent' && l.delivery && (!l.delivery.chatId || l.delivery.chatId === cid));
}

// 转交人在动这封信的说法（比单个“信”字严格，免得“相信”“信任”也算）
const VIA_LETTER_RE = /(?:那|这|一)封信|信封|拆.{0,4}信|看.{0,3}信|读.{0,3}信|转交|托.{0,8}信|把信|信纸|火漆|封口|letter|lettre|envelope|enveloppe/i;

// 这条文字里，有没有哪封信的收信人收到了信
function findReceipt(text) {
    const today = normalizeDate(getStoryDate());
    const f = floor();
    for (const l of mailInChat()) {
        const dv = l.delivery;
        const reader = dv.reader || l.recipients[0];
        if (ui.isMe(reader)) continue;
        const arrived = dv.status === 'arrived';
        const inTransit = dv.status === 'transit' && dv.stage !== 'toVia';
        if (!arrived && !inTransit) continue;
        if (!mentionsReceipt(text, namesOf(reader))) continue;
        const saysDate = !!dv.eta && mentionsDate(text, dv.eta);
        const due = arrived || saysDate
            || (dv.mode === 'date' && today && normalizeDate(dv.eta) && normalizeDate(dv.eta) <= today)
            || (dv.mode === 'floors' && f - (dv.sentFloor || 0) >= (dv.floors || 1));
        if (!due) continue;
        return { letter: l, reader, saysDate };
    }
    return null;
}

function markReceived(hit) {
    const { letter, reader, saysDate } = hit;
    const dv = letter.delivery;
    if (saysDate && normalizeDate(dv.eta) && (!getStoryDate() || normalizeDate(dv.eta) > normalizeDate(getStoryDate()))) setStoryDate(dv.eta);
    if (dv.status === 'transit') arrive(letter, saysDate ? dv.eta : getStoryDate());
    const arrival = letter.delivery.arrivedAt || getStoryDate();
    letter.delivery = { ...letter.delivery, status: 'viewed', followup: true, detected: true };
    store.save();
    ui.renderPostbox();
    ui.refresh();
    toastr.info(`剧情里 ${reader} 收到了 ${letter.author} 的信。下一次生成时，原文会直接交给 AI（不发进聊天）`, '📬 信到了');
    return arrival;
}

// 角色（AI）刚写完一条：正文或思考里写到收信人收到信 → 把原文发进聊天，让角色读
async function deliverDetected(hit) {
    const arrival = markReceived(hit);
    queueLetter(hit.letter, { reader: hit.reader, arrival });
    ui.renderPostbox();
}

// 你自己的消息里写到转交人动了信（在拦截器里调用，这一轮生成之前）
async function viaFromUser(text) {
    if (!VIA_LETTER_RE.test(text)) return null;
    const groups = new Map();
    for (const l of mailInChat()) {
        const dv = l.delivery;
        if (!['atVia', 'held'].includes(dv.status) || ui.isMe(dv.via)) continue;
        if (!(mentionsName(text, namesOf(dv.via)) || isCurrentCharacter(dv.via))) continue;
        if (!groups.has(dv.via)) groups.set(dv.via, []);
        groups.get(dv.via).push(l);
    }
    let peek = null;
    for (const [, letters] of groups) {
        const decisions = await judgeVia(letters, storyWindow());
        for (const [l, d] of decisions) {
            if (d.opened && !l.delivery.opened) {
                await letViaRead(l, { post: false });
                peek = peek || [];
                peek.push(l);
            } else {
                await applyViaDecision(l, d);
            }
        }
        ui.renderPostbox();
    }
    return peek;
}

// 转交人拿着信太久：提醒
function remindVia() {
    const today = getStoryDate();
    const f = floor();
    for (const l of mailInChat()) {
        const dv = l.delivery;
        if (!['atVia', 'held'].includes(dv.status)) continue;
        const who = ui.isMe(dv.via) ? '你' : dv.via;
        const to = l.recipients.join('、');
        if (dv.viaDeadline && today && normalizeDate(today) && normalizeDate(today) >= normalizeDate(addDays(dv.viaDeadline, -1))) {
            if (dv.remindedOn === today) continue;
            dv.remindedOn = today;
            const late = normalizeDate(today) > normalizeDate(dv.viaDeadline);
            toastr.warning(late
                ? `已经过了最晚转交日 ${dv.viaDeadline}，${who} 还没把 ${l.author} 的信交出去，${to} 会晚收到`
                : `${who} 最晚 ${dv.viaDeadline} 要把 ${l.author} 的信转交出去${dv.opened ? '' : '（要不要先看一眼，也得在这之前）'}，否则 ${to} 赶不上 ${dv.target} 收到`, '⏰ 转交提醒', { timeOut: 8000 });
            store.save();
        } else if (!dv.viaDeadline && f - (dv.viaArrivedFloor ?? f) >= 4 && f - (dv.remindedFloor ?? 0) >= 8) {
            dv.remindedFloor = f;
            toastr.warning(`${who} 拿着 ${l.author} 给 ${to} 的信已经 ${f - dv.viaArrivedFloor} 层了，还没${dv.status === 'held' ? '交出去' : '处理'}`, '⏰ 转交提醒', { timeOut: 8000 });
            store.save();
        }
    }
}

// 快到日子了吗：信明天就送到 / 转交人明天就到最晚转交日 → 一层推算一次日期
function urgentMail(mail) {
    const today = normalizeDate(getStoryDate());
    if (!today) return false;
    const soon = d => normalizeDate(d) && normalizeDate(addDays(d, -1)) <= today;
    return mail.some(l => {
        const dv = l.delivery;
        if (dv.status === 'transit' && dv.mode === 'date') return soon(dv.eta);
        if (['atVia', 'held'].includes(dv.status) && dv.viaDeadline) return soon(dv.viaDeadline);
        return false;
    });
}

// 每有一条新消息就检查一次：要不要推算日期，有没有信该送到了，转交人做了什么
let checkAgain = null;
async function checkMail({ fromCharacter = false } = {}) {
    if (!hasChat() || store.mode === 'unloaded') return;
    if (isSimple()) { ui.renderPostbox(); return; } // 简单模式没有寄送
    if (fromCharacter) markInboxAnswered();
    if (busy) {
        // 上一次检查还没做完（比如正在等 AI 推算日期）：做完以后再补一次，不漏掉这条消息
        checkAgain = { fromCharacter: fromCharacter || !!checkAgain?.fromCharacter };
        return;
    }
    const s = settings();
    const mail = mailInChat();
    const transit = mail.filter(l => l.delivery.status === 'transit');
    const pending = mail.some(l => ['arrived', 'atVia', 'held'].includes(l.delivery.status));
    if (!transit.length && !pending) { ui.renderPostbox(); return; }
    busy = true;
    let detected = null;
    try {
        const meta = chatMeta();
        const f = floor();
        // 推算剧情日期：平时每隔几层一次；快到日子时一层一次
        const dated = mail.some(l => (l.delivery.status === 'transit' && l.delivery.mode === 'date') || (['atVia', 'held'].includes(l.delivery.status) && l.delivery.viaDeadline));
        const every = urgentMail(mail) ? 1 : Math.max(1, s.delivery.dateEvery);
        if (aiOn() && s.delivery.autoDate && dated && f - (meta.lastDateCheck || 0) >= every) {
            meta.lastDateCheck = f;
            saveMeta();
            await inferStoryDate();
        }
        // 角色刚写完的那条（包括思考过程）
        const last = (ctx().chat || []).at(-1);
        const lastText = last && !last.is_user && !last.is_system && !last.extra?.epistolary && fromCharacter && s.detectArrival !== false
            ? `${last.mes || ''}\n${last.extra?.reasoning || ''}` : '';
        if (lastText) detected = findReceipt(lastText);
        // 转交人：拆没拆、交不交，照剧情办
        if (aiOn() && fromCharacter && s.detectArrival !== false && !detected) await processVia(lastText);

        const today = normalizeDate(getStoryDate());
        const arrivedNow = [];
        for (const l of mail.filter(x => x.delivery.status === 'transit')) {
            const dv = l.delivery;
            const due = dv.mode === 'floors'
                ? f - (dv.sentFloor || 0) >= (dv.floors || 1)
                : !!(today && normalizeDate(dv.eta) && normalizeDate(dv.eta) <= today);
            if (due) { arrive(l, getStoryDate()); arrivedNow.push(l); }
        }
        if (arrivedNow.length) {
            ui.refresh();
            for (const l of arrivedNow) {
                if (l.delivery.status === 'atVia') {
                    const via = l.delivery.via;
                    toastr.success(ui.isMe(via) ? `${l.author} 托你转交给 ${l.recipients.join('、')} 的信到了` : `${l.author} 托 ${via} 转交的信到了 ${via} 手里`, '📬 信到了');
                    continue;
                }
                const reader = l.delivery.reader || l.recipients[0];
                toastr.success(ui.isMe(reader) ? `你收到了 ${l.author} 的信` : `${reader} 收到了 ${l.author} 的信`, '📬 信到了');
            }
            // 自动切过去：只在角色刚说完话的时候，免得打断正在进行的生成
            const auto = arrivedNow.find(l => l.delivery.auto || s.delivery.autoSwitch);
            if (auto && fromCharacter && !detected) {
                if (auto.delivery.status === 'atVia') {
                    if (!ui.isMe(auto.delivery.via)) setTimeout(() => switchToVia(auto), 600);
                } else if (!ui.isMe(auto.delivery.reader || auto.recipients[0])) {
                    setTimeout(() => switchToRecipient(auto), 600);
                }
            }
            // 刚到的信，角色这条里已经写到收信了
            if (!detected && lastText) detected = findReceipt(lastText);
        }
        remindVia();
        ui.renderPostbox();
    } finally {
        busy = false;
        if (detected) setTimeout(() => deliverDetected(detected), 500);
        if (checkAgain) { const o = checkAgain; checkAgain = null; setTimeout(() => checkMail(o), 200); }
    }
}

// 用户自己写到收信 / 转交人拆信：这一轮生成直接带上原文（在拦截器里调用）
async function detectFromUser() {
    if (settings().detectArrival === false || !hasChat()) return;
    const chat = ctx().chat || [];
    const m = chat.at(-1);
    if (!m || !m.is_user || m.extra?.epistolary || m.extra?.epistolaryInline) return;
    if (m.extra?.epistolaryChecked) return;
    m.extra = { ...(m.extra || {}), epistolaryChecked: true };
    const hit = findReceipt(m.mes || '');
    if (hit) {
        const arrival = markReceived(hit);
        queueLetter(hit.letter, { reader: hit.reader, arrival });
        return;
    }
    const peeked = await viaFromUser(m.mes || '');
    for (const l of peeked || []) {
        const dv = l.delivery;
        dv.awaitingDecision = true;
        dv.decisionFrom = floor();
        store.save();
        queueLetter(l, { reader: dv.via, arrival: getStoryDate(), peek: true });
    }
}

// 每次生成前提醒 AI：哪些信已经到了还没读、哪些信压在转交人手里
function pendingHints() {
    if (settings().detectArrival === false) return '';
    const current = new Set([pendingReaction()?.letterId, ...activeInbox().map(i => i.letterId)]);
    const mail = mailInChat().filter(l => !current.has(l.id));
    return buildPendingHints({
        arrived: mail.filter(l => l.delivery.status === 'arrived' && !ui.isMe(l.delivery.reader || l.recipients[0])),
        atVia: mail.filter(l => ['atVia', 'held'].includes(l.delivery.status) && !ui.isMe(l.delivery.via)),
        storyDate: getStoryDate(),
    });
}

// ---------- 写给你的信：写的时候先藏起来，剧情里“收到”了才拆 ----------
// 角色在回复里写了一封给你的信 → 存进档案，聊天里只把信的那几段藏起来（旁白照常显示）。
// 之后剧情里写到你收到了（“邮差送来一封信”“你收到了文森特的信”，或者你自己写“我收到了信”）
// → 右下角提示“📬 拆开” → 拆信动画 → 打开信纸 → 聊天里藏起来的那几段才露出来。

// 这段文字里有没有寄给“我”的信
function lettersToMe(text) {
    return detectInMessage(text).filter(c => ui.isMe(guessRecipient(c.salutation)));
}

// 正在生成的文字里，是不是已经开始写一封给“我”的信了（流式输出时先模糊掉）
function startsLetterToMe(text) {
    return String(text || '').split('\n').some(line => {
        const l = line.replace(/^[>\s*_「『【“"]+/, '').trim();
        return l.length <= 40 && isSalutation(l) && ui.isMe(guessRecipient(l));
    });
}

function mesEl(mesId) {
    return document.querySelector(`.mes[mesid="${mesId}"]`);
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const flat = t => String(t || '').replace(/[\s>*_“”"「」『』]/g, '');

// 只藏信的那几段：按段落文字比对；一段都对不上时，整条消息藏起来
function hideLetterNodes(el, letters) {
    const box = el.querySelector('.mes_text');
    if (!box) return null;
    const bodies = letters.map(l => flat(l.body)).filter(Boolean);
    const hidden = [];
    for (const node of box.querySelectorAll('p, li, pre, h1, h2, h3, h4, h5, h6')) {
        if (node.closest('.epi-letter-hidden')) continue;
        const t = flat(node.textContent);
        if (t.length < 2) continue;
        if (bodies.some(b => b.includes(t) || (t.length > 40 && t.includes(b.slice(0, 30))))) {
            node.classList.add('epi-letter-hidden');
            hidden.push(node);
        }
    }
    // 引用块里的段落全藏了，引用块本身也藏起来
    for (const q of box.querySelectorAll('blockquote')) {
        const inner = q.querySelectorAll('p, li');
        if (inner.length && [...inner].every(n => n.classList.contains('epi-letter-hidden'))) q.classList.add('epi-letter-hidden');
    }
    if (!hidden.length) { box.classList.add('epi-letter-hidden'); return box; }
    return hidden[0].closest('blockquote.epi-letter-hidden') || hidden[0];
}

// 在聊天里藏起信的内容，放一张小卡片
function applySeal(mesId) {
    const m = ctx().chat?.[mesId];
    const seal = m?.extra?.epistolarySeal;
    const el = mesEl(mesId);
    if (!el || !seal || seal.opened) return;
    const letters = seal.letterIds.map(id => store.archive.letters[id]).filter(Boolean);
    if (!letters.length) return;
    el.classList.remove('epi-sealing');
    el.classList.add('epi-sealed-mes');
    el.querySelector('.epi-sealed-card')?.remove();
    const first = hideLetterNodes(el, letters);
    const card = document.createElement('div');
    card.className = 'epi-sealed-card';
    const author = letters[0].author || m.name;
    card.innerHTML = seal.received
        ? `<div class="epi-sealed-env">📬</div><div class="epi-sealed-info"><b>你收到了 ${esc(author)} 的信</b><div class="epi-muted">拆开以后，这里藏着的信也会显示出来。</div></div>
           <button class="menu_button" data-epi-unseal="${mesId}">拆开</button>`
        : `<div class="epi-sealed-env">✉</div><div class="epi-sealed-info"><b>${esc(author)} 写了一封给你的信</b><div class="epi-muted">信还没到你手里，内容先藏起来。剧情里写到你收到了，就可以拆。</div></div>
           <button class="menu_button epi-mini" data-epi-receive="${mesId}" title="剧情里其实已经收到了，现在就拆">已经收到了</button>`;
    card.addEventListener('click', ev => {
        if (ev.target.closest('[data-epi-unseal]')) unseal(mesId);
        else if (ev.target.closest('[data-epi-receive]')) { markSealReceived(mesId, { quiet: true }); unseal(mesId); }
    });
    if (first && first.parentNode) first.parentNode.insertBefore(card, first);
    else (el.querySelector('.mes_text') || el).after(card);
}

function removeSeal(mesId) {
    const el = mesEl(mesId);
    if (!el) return;
    el.classList.remove('epi-sealed-mes', 'epi-sealing');
    el.querySelectorAll('.epi-letter-hidden').forEach(n => n.classList.remove('epi-letter-hidden'));
    el.querySelector('.epi-sealed-card')?.remove();
}

// 角色刚写完一条：里面有写给我的信，就存进档案、把信的内容藏起来
async function sealIncoming(mesId) {
    if (settings().sealIncoming === false || !hasChat() || store.mode === 'unloaded') return false;
    const c = ctx();
    const m = c.chat?.[mesId];
    if (!m || m.is_user || m.is_system || m.extra?.epistolary || m.extra?.epistolarySeal) return false;
    const found = lettersToMe(m.mes || '');
    if (!found.length) { removeSeal(mesId); return false; }
    const ids = [];
    for (const f of found) {
        const dup = findDuplicate(store.archive, f.text);
        if (dup) {
            if (!store.archive.letters[dup]?.openedAt) ids.push(dup);
            continue;
        }
        const letter = createLetter(store.archive, {
            author: guessAuthor(f.signoff) || m.name,
            recipients: [c.name1],
            writtenAt: isSimple() ? '' : getStoryDate(),
            body: f.text,
            status: 'sent',
            appearance: { font: findPerson(store.archive, m.name)?.hand || 'personal' },
            enclosures: extractEnclosures(f.text),
            source: { chatId: chatId(), mes: mesId },
        });
        letter.events.push({ id: nextEventId(letter.events), type: 'written', who: letter.author, date: getStoryDate(), segments: null, to: letter.recipients.join('、'), note: '角色在回复里写的', place: '', mes: mesId, auto: false });
        letter.events.push(...deliveryEvents(letter, '', letter.events, { sentOnly: true }));
        ids.push(letter.id);
    }
    if (!ids.length) { removeSeal(mesId); return false; }
    store.save();
    m.extra = { ...(m.extra || {}), epistolarySeal: { letterIds: ids, received: false, opened: false } };
    await c.saveChat();
    applySeal(mesId);
    ui.refresh();
    ui.renderPostbox();
    return true;
}

// 剧情里“收到”了
async function markSealReceived(mesId, { quiet = false } = {}) {
    const m = ctx().chat?.[mesId];
    const seal = m?.extra?.epistolarySeal;
    if (!seal || seal.received) return;
    seal.received = true;
    const letters = seal.letterIds.map(id => store.archive.letters[id]).filter(Boolean);
    for (const l of letters) {
        if (!l.events.some(e => e.type === 'received' && ui.isMe(e.who))) {
            l.events.push(...deliveryEvents(l, getStoryDate(), l.events));
        }
    }
    store.save();
    await ctx().saveChat();
    applySeal(mesId);
    ui.renderPostbox();
    if (!quiet && letters[0]) toastr.success(`你收到了 ${letters[0].author} 的信，在右下角或聊天里点「拆开」`, '📬 信到了');
}

// 这条文字里，有没有写到“我”收到了某封还没收到的信
function myNames() {
    const me = ctx().name1 || '';
    const p = findPerson(store.archive, me);
    return [me, ...(p ? [p.name, ...(p.aliases || [])] : [])].filter(Boolean);
}

// “我”是收信的那个人：你收到了信 / 把信递给你 / 邮差送来一封信……（“他收到了你的来信”不算）
function saysIReceived(text, names) {
    const t = String(text || '');
    const alt = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    if (!alt) return false;
    const pats = [
        new RegExp(`(${alt})[^。！？.!?\\n]{0,10}(收到|接到|拿到|接过|拆开|打开|展开)[^。！？.!?\\n]{0,14}(信|信封|来信|letter|lettre)`, 'i'),
        new RegExp(`(递给|交给|送给|塞给|带给|交到|送到|塞进)(${alt})[^。！？.!?\\n]{0,10}(信|信封|letter|lettre)`, 'i'),
        new RegExp(`(信|信封|letter|lettre)[^。！？.!?\\n]{0,10}(递给|交给|送到|交到|到了)(${alt})`, 'i'),
        new RegExp(`\\b(${alt})\\b[^.!?\\n]{0,20}\\b(receive[sd]?|open(s|ed)?|get|got)\\b[^.!?\\n]{0,20}\\bletter`, 'i'),
        /(邮差|信差|送信的|信使|邮递员|postman|mailman|messenger|facteur)[^。！？.!?\n]{0,20}(送来|递来|带来|塞进|投进|delivered|brought|handed)/i,
    ];
    return pats.some(p => p.test(t));
}

async function detectMyReceipt(text, { fromUser = false, skipMes = -1 } = {}) {
    if (settings().sealIncoming === false || !text) return;
    const pending = sealedInChat().filter(s => !s.received && s.mesId !== skipMes);
    if (!pending.length) return;
    // 去掉信本身的文字（信里写“你收到我的上一封信了吗”不算）
    let t = String(text);
    for (const s of pending) for (const id of s.letterIds) t = t.split(store.archive.letters[id]?.body || '\u0000').join('');
    const names = [...myNames(), fromUser ? '我' : '你'];
    if (!saysIReceived(t, names)) return;
    // 提到了写信人的，优先算那几封；都没提就算最早那封
    const named = pending.filter(s => mentionsName(t, namesOf(s.author)));
    // 一次只算收到一封：最早写的那封先到
    const hit = (named.length ? named : pending)[0];
    if (hit) await markSealReceived(hit.mesId);
}

// 拆开：先播动画，再打开信纸，最后才露出聊天里藏着的信
async function unseal(mesId) {
    const m = ctx().chat?.[mesId];
    const seal = m?.extra?.epistolarySeal;
    if (!seal || seal.opened) return;
    if (!seal.received) await markSealReceived(mesId, { quiet: true });
    const letters = seal.letterIds.map(id => store.archive.letters[id]).filter(Boolean);
    seal.opened = true;
    await ctx().saveChat();
    ui.renderPostbox();
    if (letters[0] && settings().animations !== false) await playOpen(letters[0], { render: ui.renderOpts(letters[0]) });
    for (const l of letters) if (!l.openedAt) l.openedAt = new Date().toISOString();
    store.save();
    removeSeal(mesId);
    if (letters[0]) { ui.open('list'); ui.openReader(letters[0].id); }
}

function sealedInChat() {
    if (!hasChat()) return [];
    const out = [];
    (ctx().chat || []).forEach((m, i) => {
        const seal = m?.extra?.epistolarySeal;
        if (seal && !seal.opened) out.push({ mesId: i, letterIds: seal.letterIds, received: !!seal.received, author: store.archive.letters[seal.letterIds[0]]?.author || m.name });
    });
    return out;
}

function reapplySeals() {
    for (const s of sealedInChat()) applySeal(s.mesId);
}

// 流式输出时：一看到写给我的称呼，就先把正在生成的这条模糊掉
let streamCheck = 0;
function onStreamToken(text) {
    if (settings().sealIncoming === false) return;
    const now = Date.now();
    if (now - streamCheck < 250) return;
    streamCheck = now;
    const t = typeof text === 'string' ? text : (ctx().chat?.at(-1)?.mes || '');
    if (startsLetterToMe(t)) document.querySelector('.last_mes')?.classList.add('epi-sealing');
}

// ---------- 生成前拦截：在这里计算要注入的信件内容 ----------
globalThis.epistolaryInterceptor = async function (_chat, _contextSize, _abort, type) {
    const c = ctx();
    const s = settings();
    try {
        if (!s.enabled || type === 'quiet' || store.mode === 'unloaded') {
            c.setExtensionPrompt(PROMPT_KEY, '', s.position, s.depth);
            c.setExtensionPrompt(REACTION_KEY, '', 1, 0);
            c.setExtensionPrompt(PENDING_KEY, '', 1, 1);
            c.setExtensionPrompt(CODE_KEY, '', 1, 0);
            return;
        }
        rememberTurnLetters();
        // 暗号：两种模式都有。放在最新那条消息之后，AI 最先看到
        const code = codeInjection();
        c.setExtensionPrompt(CODE_KEY, code, 1, 0, false, 0);
        codeFeedback(type);
        if (isSimple()) {
            // 简单模式：只认暗号，不做别的
            lastInjection = code;
            c.setExtensionPrompt(PROMPT_KEY, '', s.position, s.depth);
            c.setExtensionPrompt(REACTION_KEY, '', 1, 0);
            c.setExtensionPrompt(PENDING_KEY, '', 1, 1);
            return;
        }
        if (type !== 'swipe' && type !== 'regenerate') await detectFromUser();
        const { result, reaction } = runRetrieval();
        const hints = pendingHints();
        lastInjection = [result.text, hints, code, reaction].filter(Boolean).join('\n\n');
        c.setExtensionPrompt(PROMPT_KEY, result.text, s.position, s.depth, false, 0);
        c.setExtensionPrompt(PENDING_KEY, hints, 1, 1, false, 0);
        // 收信反应引导放在最新消息之后，影响最直接
        c.setExtensionPrompt(REACTION_KEY, reaction, 1, 0, false, 0);
    } catch (e) {
        console.error('[书信簿] 注入失败', e);
        c.setExtensionPrompt(PROMPT_KEY, '', s.position, s.depth);
        c.setExtensionPrompt(REACTION_KEY, '', 1, 0);
        c.setExtensionPrompt(PENDING_KEY, '', 1, 1);
        c.setExtensionPrompt(CODE_KEY, '', 1, 0);
    }
};

// ---------- 扩展面板里的小设置区（详细设置在书信簿面板的「设置」页） ----------
function settingsHtml() {
    return `
    <div class="epistolary-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>✉ 书信簿</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="flex-container">
                    <button class="menu_button" id="epi-open">打开书信簿</button>
                    <button class="menu_button" id="epi-open-settings">设置</button>
                </div>
                <label class="checkbox_label"><input type="checkbox" id="epi-enabled"> 生成时注入相关信件</label>
                <label>当前剧情日期（仅本聊天）</label>
                <input class="text_pole" id="epi-storydate" placeholder="如 1890-11-20；留空则不按日期过滤">
                <small id="epi-status" class="epi-muted"></small>
            </div>
        </div>
    </div>`;
}

function exportArchive() {
    const blob = new Blob([store.exportJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `书信簿备份_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importFile(input) {
    const file = input.files?.[0];
    if (!file) return;
    if (!confirm('导入会用这个文件替换当前整个档案（当前档案在本次会话开始时已自动备份）。继续？')) { input.value = ''; return; }
    try {
        store.importJson(await file.text());
        toastr.success('已导入');
        ui.refresh();
        ui.renderPostbox();
    } catch (err) {
        toastr.error('导入失败：' + (err.message || err));
    }
    input.value = '';
}

function bindSettings() {
    const s = settings();
    const $ = sel => document.querySelector(sel);
    $('#epi-enabled').checked = s.enabled;
    $('#epi-enabled').addEventListener('change', e => { settings().enabled = e.target.checked; saveSettings(); syncWorldBook(); ui?.refresh?.(); });
    $('#epi-storydate').addEventListener('input', e => { if (hasChat()) setStoryDate(e.target.value); });
    $('#epi-open').addEventListener('click', () => ui.open('list'));
    $('#epi-open-settings').addEventListener('click', () => ui.open('settings'));
}

function refreshChatFields() {
    const el = document.querySelector('#epi-storydate');
    if (el) el.value = getStoryDate();
}

function refreshStatus() {
    const el = document.querySelector('#epi-status');
    if (el) el.textContent = store.statusText();
}

function addWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const btn = document.createElement('div');
    btn.id = 'epi-wand';
    btn.className = 'list-group-item flex-container flexGap5';
    btn.innerHTML = '<div class="fa-solid fa-envelope-open-text extensionsMenuExtensionButton"></div><span>书信簿</span>';
    btn.addEventListener('click', () => ui.open());
    menu.appendChild(btn);
}

// ---------- 启动 ----------
jQuery(async () => {
    if (settings().onlineFonts) loadCjkFonts();
    document.getElementById('extensions_settings2')?.insertAdjacentHTML('beforeend', settingsHtml());

    ui = new UI(store, {
        getMode: () => settings().mode,
        aiOn,
        injectOn,
        setMode: mode => { settings().mode = mode; saveSettings(); ui?.renderPostbox(); },
        getSettings: settings,
        saveSettings,
        getViewer,
        getStoryDate,
        setStoryDate,
        hasChat,
        getChatId: chatId,
        getFloor: floor,
        getChat: () => (hasChat() ? ctx().chat || [] : []),
        isCurrentCharacter,
        getCharacterContext,
        getUserName: () => ctx().name1 || '',
        getCharName: () => (hasChat() && !ctx().groupId ? ctx().name2 : '') || '',
        callAI: ai,
        generateRaw: (prompt, system) => ai(system, prompt, { kind: 'raw' }),
        switchToRecipient,
        switchToVia,
        getSealed: sealedInChat,
        unseal,
        markSealReceived,
        getInbox: () => (hasChat() ? activeInbox().filter(i => !i.answeredAt) : []),
        letViaRead,
        forwardLetter,
        setViaAction,
        applyViaDecision,
        postSceneReturn,
        postReplyToChat,
        memoriesFromRecent,
        findPastScenes,
        memoriesFromFloors,
        codeReadsInChat,
        saveMemoryEdit,
        saveRecallKeys,
        clearMemories,
        saveWhereabouts,
        saveDelivery,
        addEvent,
        deleteEvent,
        whereSuggestion,
        refreshStatuses,
        estimateStatus,
        getStatusScope: () => ({ ...DEFAULT_STATUS_SCOPE, ...(settings().statusScope || {}) }),
        getCodeFloors: id => (store.archive.letters[id] ? codeFloorsHere(store.archive.letters[id]) : []),
        getBackups: () => store.backups || [],
        loadBackups: () => store.loadBackupIndex(),
        backupNow: () => store.backupNow(),
        removeBackup: name => store.removeBackup(name),
        readBackup: name => store.readBackup(name),
        restoreBackup: async name => {
            await store.restoreBackup(name);
            ensureCodes(store.archive);
            store.save();
            ui.refresh();
            ui.renderPostbox();
            await syncWorldBook();
        },
        getLastStatusFloor: () => (hasChat() ? chatMeta().lastStatusFloor ?? null : null),
        syncWorldBook,
        getMemoryBook: () => (hasChat() ? ctx().chatMetadata?.world_info || '' : ''),
        deliverNow,
        inferStoryDate,
        exportArchive,
        importFile,
        loadFonts: loadCjkFonts,
        runPreview: runRetrieval,
    });
    ui.mount();
    bindSettings();
    addWandButton();

    store.onChange(refreshStatus);
    await store.load();
    if (store.mode !== 'unloaded' && ensureCodes(store.archive)) store.save();
    if (store.mode !== 'unloaded' && hasChat()) setTimeout(() => { try { scanCodeFloors(); } catch { /* */ } }, 1500);
    // 每天第一次打开：自动备份一份档案
    store.autoBackup(Number(settings().backup.keep) || 0)
        .then(made => { if (made) console.info(`[书信簿] 已自动备份档案：${made}`); ui?.refresh?.(); })
        .catch(e => console.warn('[书信簿] 自动备份失败', e));
    refreshChatFields();
    refreshStatus();
    ui.renderPostbox();

    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        refreshChatFields();
        ui.refresh();
        ui.renderPostbox();
        setTimeout(reapplySeals, 300);
        setTimeout(foldAll, 300);
        // 删掉的信、换了位置的信：世界书里对应的条目对齐一下
        setTimeout(() => { if (store.mode !== 'unloaded' && hasChat() && ctx().chatMetadata?.world_info) syncWorldBook(); }, 1200);
        // 暗号在这个聊天的哪几层出现过
        setTimeout(() => { if (store.mode !== 'unloaded' && hasChat()) try { scanCodeFloors(); } catch (e) { console.warn('[书信簿] 扫描暗号楼层失败', e); } }, 1500);
    });
    if (eventTypes.MESSAGE_RECEIVED) eventSource.on(eventTypes.MESSAGE_RECEIVED, mesId => {
        setTimeout(async () => {
            const id = Number.isInteger(mesId) ? mesId : (ctx().chat || []).length - 1;
            await sealIncoming(id);
            // 这条（包括 AI 的思考）里写到你收到了之前那封信 / 刚写的这封
            const m = ctx().chat?.[id];
            if (m && !m.is_user) await detectMyReceipt(`${m.mes || ''}\n${m.extra?.reasoning || ''}`);
            memoriesAfterReply(id);
            checkMail({ fromCharacter: true });
        }, 300);
    });
    if (eventTypes.CHARACTER_MESSAGE_RENDERED) eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, mesId => setTimeout(() => applySeal(mesId), 50));
    if (eventTypes.MORE_MESSAGES_LOADED) eventSource.on(eventTypes.MORE_MESSAGES_LOADED, () => setTimeout(() => { reapplySeals(); foldAll(); }, 100));
    if (eventTypes.STREAM_TOKEN_RECEIVED) eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, onStreamToken);
    if (eventTypes.GENERATION_ENDED) eventSource.on(eventTypes.GENERATION_ENDED, () => setTimeout(() => {
        // 生成结束了却没认出信：取消模糊
        const last = document.querySelector(".last_mes");
        if (last && !last.classList.contains('epi-sealed-mes')) setTimeout(() => last.classList.remove('epi-sealing'), 1500);
    }, 100));
    if (eventTypes.MESSAGE_SWIPED) eventSource.on(eventTypes.MESSAGE_SWIPED, mesId => {
        // 换了一个回复：旧的封条作废，重新看这一条
        const m = ctx().chat?.[mesId];
        if (m?.extra?.epistolarySeal && !m.extra.epistolarySeal.opened) delete m.extra.epistolarySeal;
        removeSeal(mesId);
        // 撤下这一层旧回复记下的东西（收起来）；如果划到的是之前已经有的回复，把它当时记下的放回去
        (async () => {
            const id = Number(mesId);
            await revokeFrom(id, { stash: true, quiet: true });
            const msg = ctx().chat?.[id];
            const sw = msg?.swipe_id ?? 0;
            const existing = Array.isArray(msg?.swipes) && sw < msg.swipes.length && String(msg.swipes[sw] || '').trim();
            if (existing) await restoreStash(id, sw);
        })();
    });
    if (eventTypes.MESSAGE_DELETED) eventSource.on(eventTypes.MESSAGE_DELETED, len => {
        // 删了消息：酒馆传来的是删完以后聊天还剩几层
        const n = Number.isInteger(len) ? len : (ctx().chat || []).length;
        revokeFrom(n);
        const box = revokeStash();
        for (const k of Object.keys(box)) if (parseInt(k, 10) >= n) delete box[k];
        saveMeta();
    });
    // 暗号：发送前改输入框（最早）→ 酒馆助手直接生成 → 消息进了聊天以后（兜底）
    if (eventTypes.GENERATION_AFTER_COMMANDS) {
        // 排在最前面：别的插件（比如剧情推进）改写输入之前，信就已经接上了；之后的 MESSAGE_SENT 还会再检查一次
        if (typeof eventSource.makeFirst === 'function') eventSource.makeFirst(eventTypes.GENERATION_AFTER_COMMANDS, onAfterCommands);
        else eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, onAfterCommands);
    }
    if (!hookTavernHelper()) {
        // 酒馆助手可能比书信簿晚加载
        let tries = 0;
        const timer = setInterval(() => { if (hookTavernHelper() || ++tries > 20) clearInterval(timer); }, 1500);
    }
    if (eventTypes.MESSAGE_SENT) {
        const embed = async mesId => { try { await embedCodes(Number.isInteger(mesId) ? mesId : (ctx().chat || []).length - 1); } catch (e) { console.error('[书信簿] 暗号处理失败', e); } };
        if (typeof eventSource.makeFirst === 'function') eventSource.makeFirst(eventTypes.MESSAGE_SENT, embed);
        else eventSource.on(eventTypes.MESSAGE_SENT, embed);
    }
    if (eventTypes.USER_MESSAGE_RENDERED) eventSource.on(eventTypes.USER_MESSAGE_RENDERED, mesId => setTimeout(() => foldLetters(mesId), 0));
    if (eventTypes.MESSAGE_UPDATED) eventSource.on(eventTypes.MESSAGE_UPDATED, mesId => setTimeout(() => foldLetters(mesId), 50));
    if (eventTypes.MESSAGE_SENT) eventSource.on(eventTypes.MESSAGE_SENT, mesId => setTimeout(async () => {
        const id = Number.isInteger(mesId) ? mesId : (ctx().chat || []).length - 1;
        const m = ctx().chat?.[id];
        recordCodeFloor(id);
        if (m?.is_user && !m.extra?.epistolary) await detectMyReceipt(m.mes || '', { fromUser: true });
        checkMail();
    }, 300));

    // 调试入口：控制台里输入 epistolary.last() 查看上一次注入的内容
    globalThis.epistolary = { ...(globalThis.epistolary || {}), store, ui, last: () => lastInjection, envelope: { playSeal, playOpen }, checkMail, inferStoryDate };
    console.log('[书信簿] 已加载');
});
