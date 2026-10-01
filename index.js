// 书信簿 Epistolary · SillyTavern 扩展入口
// 负责：设置、扩展面板入口、魔法棒菜单入口、生成前注入信件内容、
// 寄送（在途信件、按剧情日期或楼层送达、镜头切到收信人那边）、让角色写回信。

import { Store } from './src/store.js';
import { UI } from './src/ui.js';
import { retrieve, DEFAULT_RETRIEVAL } from './src/retrieval.js';
import { sameName, normalizeDate, findPerson } from './src/model.js';
import {
    buildReactionGuidance, replyChatMessage, sceneSwitchMessage, sceneReturnMessage,
    deliveryEvents, buildDatePrompt, parseStoryDate, addDays,
    viaSceneMessage, viaPeekMessage, buildViaGuidance, buildViaDecisionPrompt, parseViaDecision,
    viaReceivedEvents, nextEventId, VIA_ACTIONS,
    mentionsReceipt, mentionsDate, mentionsName, buildPendingHints, inlineLetterBlock,
} from './src/correspondence.js';
import { playSeal, playOpen } from './src/envelope.js';
import { callAI, DEFAULT_API } from './src/api.js';

const MODULE = 'epistolary';
const PROMPT_KEY = 'epistolary_letters';
const REACTION_KEY = 'epistolary_reaction';
const PENDING_KEY = 'epistolary_pending';

const DEFAULT_SETTINGS = {
    enabled: true,
    mode: 'simple',          // simple 简单模式 | expert 专家模式
    autoKeywords: true,      // 简单模式下，保存时自动让 AI 生成关键词
    autoFill: true,          // 写新信时让 AI 根据剧情填信头
    describeLook: true,
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
        viaAuto: true,       // 托人转交：转交人在剧情里做的决定（拆不拆、交不交）自动生效
    },
};

const ctx = () => SillyTavern.getContext();

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
    };
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

function reactionGuidance() {
    const info = pendingReaction();
    if (!info) return '';
    const letter = store.archive.letters[info.letterId];
    if (!letter) return '';
    const look = settings().describeLook !== false;
    if (info.kind === 'via') return buildViaGuidance(store.archive, letter, info.via, info.arrival, { look });
    const g = buildReactionGuidance(store.archive, letter, info.reader, info.arrival, { peek: !!info.peek, look });
    // 剧情里自己写到收信的：信不在聊天里，原文直接放进上下文
    if (info.inline) return `${inlineLetterBlock(letter, info.reader, info.arrival)}\n\n${g.replace('（信的全文就是上一条消息）', '（原文见上）').replace('，信的全文就是上一条消息', '，原文见上')}`;
    return g;
}

function runRetrieval() {
    const s = settings();
    const viewer = getViewer();
    const storyDate = getStoryDate();
    // 用原始聊天记录（带消息附加信息），而不是拦截器拿到的副本
    const msgs = recentMessages(ctx().chat, s.scanDepth);
    const texts = msgs.map(m => m.mes).reverse();
    const exclude = new Set(msgs.map(m => m.extra?.epistolary?.letterId).filter(Boolean));
    const result = retrieve(store.archive, { texts, viewer, storyDate, settings: s, exclude });
    return { viewer, storyDate, texts, result, enabled: s.enabled, reaction: reactionGuidance() };
}

function ai(system, prompt, meta) {
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
    if (settings().animations) await playOpen(letter, { render: ui.renderOpts(letter) });
    dv.awaitingDecision = true;
    dv.decisionFrom = floor();
    store.save();
    await pushMessage({
        name: ctx().name1, is_user: true, is_system: false, send_date: nowStamp(),
        mes: viaPeekMessage(letter, via),
        extra: { epistolary: { kind: 'letter', letterId: letter.id, reader: via, arrival: date, peek: true } },
    }, { generate: true });
    ui.renderPostbox();
}

// 转交人把信交出去：开始第二段路程
function forwardLetter(letter, { mode, arrival, floors } = {}, { resealed = false } = {}) {
    const dv = letter.delivery;
    const via = viaOf(letter);
    const today = getStoryDate() || dv.viaArrivedAt || '';
    const leg = dv.leg2 || {};
    // 第一段是立即送达的，第二段按“再过几天”走剧情日期（没有剧情日期或填了 0 天就直接送到）
    mode = mode || (dv.mode === 'instant' ? (today && normalizeDate(today) && leg.days > 0 ? 'date' : 'instant') : dv.mode);
    if (mode === 'date' && !arrival) arrival = addDays(today, leg.days ?? 1) || today;
    if (mode === 'floors' && !floors) floors = leg.floors || 2;
    letter.events.push({ id: nextEventId(letter.events), type: 'forwarded', who: via, date: today, segments: null, to: letter.recipients.join('、'), note: dv.opened ? (resealed ? '拆看后重新封好' : '拆看过') : '' });
    Object.assign(dv, {
        stage: 'toRecipient',
        status: 'transit',
        mode,
        eta: mode === 'date' ? arrival : '',
        floors: mode === 'floors' ? floors : 0,
        sentFloor: floor(),
        tampered: !!dv.opened && !resealed,
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

// 转交人那段剧情写完以后，让 AI 判断他拆没拆、打算怎么办
async function judgeViaDecision(letter, onlyText = '') {
    const dv = letter.delivery;
    const via = viaOf(letter);
    const chat = ctx().chat || [];
    const text = onlyText || chat.slice(Math.max(0, dv.decisionFrom ?? chat.length - 2))
        .filter(m => m && !m.is_system && typeof m.mes === 'string')
        .map(m => `${m.name}：${String(m.mes).slice(0, 1500)}`).join('\n\n');
    if (!text) return null;
    const { system, prompt } = buildViaDecisionPrompt(via, letter.recipients.join('、'), text);
    try {
        const out = await ai(system, prompt, { kind: 'via', via, opened: !!dv.opened });
        return parseViaDecision(out);
    } catch (e) {
        console.warn('[书信簿] 判断转交人的决定失败', e);
        return null;
    }
}

// 按转交人的决定办
async function applyViaDecision(letter, guess, { fromCharacter = false } = {}) {
    const dv = letter.delivery;
    if (!guess) return;
    // 刚拆开：先把信的原文给他看，读完以后再判断他打算怎么办
    if (guess.opened && !dv.opened) {
        if (fromCharacter) setTimeout(() => letViaRead(letter), 500);
        else await letViaRead(letter);
        return;
    }
    if (guess.action === 'forward') forwardLetter(letter, {}, { resealed: !!guess.resealed });
    else if (guess.action === 'later' || guess.action === 'withhold') {
        setViaAction(letter, guess.action);
        toastr.info(`${viaOf(letter)}：${VIA_ACTIONS[guess.action]}${guess.note ? `（${guess.note}）` : ''}`, '📮 转交');
    }
}

async function checkViaDecisions({ fromCharacter = false } = {}) {
    const handled = new Set();
    if (!fromCharacter) return handled;
    const cid = chatId();
    const waiting = Object.values(store.archive.letters).filter(l => l.delivery?.status === 'atVia' && l.delivery.awaitingDecision && (!l.delivery.chatId || l.delivery.chatId === cid));
    for (const l of waiting) {
        const dv = l.delivery;
        if (floor() <= (dv.decisionFrom || 0) + 1) continue; // 转交人还没开口
        handled.add(l.id);
        dv.awaitingDecision = false;
        const guess = await judgeViaDecision(l);
        if (!guess) { store.save(); ui.renderPostbox(); continue; }
        const opening = guess.opened && !dv.opened;
        if (settings().delivery.viaAuto && (opening || guess.action !== 'unclear')) {
            await applyViaDecision(l, guess, { fromCharacter });
        } else {
            dv.viaGuess = guess;
        }
        store.save();
        ui.renderPostbox();
    }
    return handled;
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
    await pushMessage({
        name: ctx().name1,
        is_user: true,
        is_system: false,
        send_date: nowStamp(),
        mes: sceneSwitchMessage(letter, reader, arrival),
        extra: { epistolary: { kind: 'letter', letterId: letter.id, reader, arrival } },
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

function namesOf(name) {
    const p = findPerson(store.archive, name);
    return p ? [p.name, ...(p.aliases || [])].filter(Boolean) : [name].filter(Boolean);
}

function mailInChat() {
    const cid = chatId();
    return Object.values(store.archive.letters).filter(l => l.delivery && (!l.delivery.chatId || l.delivery.chatId === cid));
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
    toastr.info(`剧情里 ${reader} 收到了 ${letter.author} 的信，已经把原文交给 AI`, '📬 信到了');
    return arrival;
}

// 角色（AI）刚写完一条：正文或思考里写到收信人收到信 → 把原文发进聊天，让角色读
async function deliverDetected(hit) {
    const arrival = markReceived(hit);
    if (settings().animations) await playOpen(hit.letter, { render: ui.renderOpts(hit.letter) });
    await pushMessage({
        name: ctx().name1, is_user: true, is_system: false, send_date: nowStamp(),
        mes: `*（${hit.reader}收到的信，原文如下。）*\n\n${hit.letter.body}`,
        extra: { epistolary: { kind: 'letter', letterId: hit.letter.id, reader: hit.reader, arrival } },
    }, { generate: true });
    ui.renderPostbox();
}

// 转交人在剧情里动了信：让 AI 判断 TA 拆没拆、交不交
async function viaFromText(text, { fromCharacter, skip = new Set() }) {
    for (const l of mailInChat()) {
        const dv = l.delivery;
        if (!['atVia', 'held'].includes(dv.status) || ui.isMe(dv.via) || skip.has(l.id) || dv.awaitingDecision) continue;
        if (!mentionsName(text, namesOf(dv.via)) || !VIA_LETTER_RE.test(text)) continue;
        const guess = await judgeViaDecision(l, `${dv.via}：${text.slice(0, 3000)}`);
        if (!guess) continue;
        const opening = guess.opened && !dv.opened;
        if (!opening && guess.action === 'unclear') continue;
        if (dv.status === 'held' && !opening && guess.action === 'later') continue;
        if (settings().delivery.viaAuto) {
            if (opening && !fromCharacter) {
                // 用户自己写了转交人拆信：这一轮生成直接带上原文
                await letViaRead(l, { post: false });
                return { letter: l, peek: true };
            }
            await applyViaDecision(l, guess, { fromCharacter });
        } else {
            dv.viaGuess = guess;
            store.save();
            toastr.info(`${dv.via} 好像${guess.opened ? '拆开了信，' : ''}${VIA_ACTIONS[guess.action] || ''}。在右下角信箱里确认`, '🤝 转交');
        }
        ui.renderPostbox();
        return null;
    }
    return null;
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

// 每有一条新消息就检查一次：要不要推算日期，有没有信该送到了
async function checkMail({ fromCharacter = false } = {}) {
    if (busy || !hasChat() || store.mode === 'unloaded') return;
    const s = settings();
    const cid = chatId();
    const transit = Object.values(store.archive.letters).filter(l => l.delivery?.status === 'transit' && (!l.delivery.chatId || l.delivery.chatId === cid));
    const pending = mailInChat().some(l => ['arrived', 'atVia', 'held'].includes(l.delivery.status));
    if (!transit.length && !pending) { ui.renderPostbox(); return; }
    busy = true;
    let detected = null;
    try {
        const handled = await checkViaDecisions({ fromCharacter });
        // 角色刚写完的那条（包括思考过程）里，有没有写到信的动静
        const last = (ctx().chat || []).at(-1);
        const lastText = last && !last.is_user && !last.is_system && !last.extra?.epistolary && fromCharacter && s.detectArrival !== false
            ? `${last.mes || ''}\n${last.extra?.reasoning || ''}` : '';
        if (lastText) {
            detected = findReceipt(lastText);
            if (!detected) await viaFromText(lastText, { fromCharacter: true, skip: handled });
        }
        if (!transit.length) { remindVia(); ui.renderPostbox(); return; }
        const meta = chatMeta();
        const f = floor();
        if (s.delivery.autoDate && transit.some(l => l.delivery.mode === 'date') && f - (meta.lastDateCheck || 0) >= Math.max(1, s.delivery.dateEvery)) {
            meta.lastDateCheck = f;
            saveMeta();
            await inferStoryDate();
        }
        const today = normalizeDate(getStoryDate());
        const arrivedNow = [];
        for (const l of transit) {
            const dv = l.delivery;
            const due = dv.mode === 'floors'
                ? f - (dv.sentFloor || 0) >= (dv.floors || 1)
                : !!(today && normalizeDate(dv.eta) && normalizeDate(dv.eta) <= today);
            if (due) { arrive(l, getStoryDate()); arrivedNow.push(l); }
        }
        if (arrivedNow.length) {
            ui.renderPostbox();
            ui.refresh();
            for (const l of arrivedNow) {
                if (l.delivery.status === 'atVia') {
                    const via = l.delivery.via;
                    toastr.success(ui.isMe(via) ? `${l.author} 托你转交给 ${l.recipients.join('、')} 的信到了` : `${l.author} 托 ${via} 转交的信到了 ${via} 手里`, '📬 信到了');
                    continue;
                }
                const reader = l.delivery.reader || l.recipients[0];
                const toMe = ui.isMe(reader);
                toastr.success(toMe ? `你收到了 ${l.author} 的信` : `${reader} 收到了 ${l.author} 的信`, '📬 信到了');
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
        }
        // 刚到的信，角色这条里已经写到收信了
        if (!detected && lastText) detected = findReceipt(lastText);
        remindVia();
        ui.renderPostbox();
    } finally {
        busy = false;
        if (detected) setTimeout(() => deliverDetected(detected), 500);
    }
}

// 用户自己写到收信 / 转交人拆信：这一轮生成直接带上原文（在拦截器里调用）
async function detectFromUser() {
    if (settings().detectArrival === false || !hasChat()) return;
    const chat = ctx().chat || [];
    const m = chat.at(-1);
    if (!m || !m.is_user || m.extra?.epistolary || m.extra?.epistolaryInline) return;
    const hit = findReceipt(m.mes || '');
    if (hit) {
        const arrival = markReceived(hit);
        m.extra = { ...(m.extra || {}), epistolaryInline: { letterId: hit.letter.id, reader: hit.reader, arrival } };
        await ctx().saveChat();
        return;
    }
    const peek = await viaFromText(m.mes || '', { fromCharacter: false });
    if (peek) {
        const dv = peek.letter.delivery;
        m.extra = { ...(m.extra || {}), epistolaryInline: { letterId: peek.letter.id, reader: dv.via, arrival: getStoryDate(), peek: true } };
        await ctx().saveChat();
    }
}

// 每次生成前提醒 AI：哪些信已经到了还没读、哪些信压在转交人手里
function pendingHints() {
    if (settings().detectArrival === false) return '';
    const current = pendingReaction()?.letterId;
    const mail = mailInChat().filter(l => l.id !== current);
    return buildPendingHints({
        arrived: mail.filter(l => l.delivery.status === 'arrived' && !ui.isMe(l.delivery.reader || l.recipients[0])),
        atVia: mail.filter(l => ['atVia', 'held'].includes(l.delivery.status) && !ui.isMe(l.delivery.via)),
        storyDate: getStoryDate(),
    });
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
            return;
        }
        if (type !== 'swipe' && type !== 'regenerate') await detectFromUser();
        const { result, reaction } = runRetrieval();
        const hints = pendingHints();
        lastInjection = [result.text, hints, reaction].filter(Boolean).join('\n\n');
        c.setExtensionPrompt(PROMPT_KEY, result.text, s.position, s.depth, false, 0);
        c.setExtensionPrompt(PENDING_KEY, hints, 1, 1, false, 0);
        // 收信反应引导放在最新消息之后，影响最直接
        c.setExtensionPrompt(REACTION_KEY, reaction, 1, 0, false, 0);
    } catch (e) {
        console.error('[书信簿] 注入失败', e);
        c.setExtensionPrompt(PROMPT_KEY, '', s.position, s.depth);
        c.setExtensionPrompt(REACTION_KEY, '', 1, 0);
        c.setExtensionPrompt(PENDING_KEY, '', 1, 1);
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
    $('#epi-enabled').addEventListener('change', e => { s.enabled = e.target.checked; saveSettings(); });
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
        setMode: mode => { settings().mode = mode; saveSettings(); },
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
        letViaRead,
        forwardLetter,
        setViaAction,
        applyViaDecision,
        postSceneReturn,
        postReplyToChat,
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
    refreshChatFields();
    refreshStatus();
    ui.renderPostbox();

    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        refreshChatFields();
        ui.refresh();
        ui.renderPostbox();
    });
    if (eventTypes.MESSAGE_RECEIVED) eventSource.on(eventTypes.MESSAGE_RECEIVED, () => setTimeout(() => checkMail({ fromCharacter: true }), 300));
    if (eventTypes.MESSAGE_SENT) eventSource.on(eventTypes.MESSAGE_SENT, () => setTimeout(() => checkMail(), 300));

    // 调试入口：控制台里输入 epistolary.last() 查看上一次注入的内容
    globalThis.epistolary = { ...(globalThis.epistolary || {}), store, ui, last: () => lastInjection, envelope: { playSeal, playOpen }, checkMail, inferStoryDate };
    console.log('[书信簿] 已加载');
});
