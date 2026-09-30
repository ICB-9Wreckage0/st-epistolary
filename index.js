// 书信簿 Epistolary · SillyTavern 扩展入口
// 负责：读写设置、扩展面板里的设置区、魔法棒菜单入口、生成前注入信件内容、
// 把信发到聊天里（收信反应）、让角色写回信。

import { Store } from './src/store.js';
import { UI } from './src/ui.js';
import { retrieve, DEFAULT_RETRIEVAL } from './src/retrieval.js';
import { sameName } from './src/model.js';
import { buildReactionGuidance, letterChatMessage, replyChatMessage } from './src/correspondence.js';
import { playSeal, playOpen } from './src/envelope.js';

const MODULE = 'epistolary';
const PROMPT_KEY = 'epistolary_letters';
const REACTION_KEY = 'epistolary_reaction';

const DEFAULT_SETTINGS = {
    enabled: true,
    mode: 'simple',          // simple 简单模式 | expert 专家模式
    autoKeywords: true,      // 简单模式下，保存时自动让 AI 生成关键词
    animations: true,        // 寄信封缄、收信拆信动画
    onlineFonts: true,       // 在线加载中文书信字体（霞鹜文楷、思源宋体、马善政楷书）
    viewpointMode: 'auto',   // auto 跟随当前发言角色 | manual 手动指定 | omniscient 全知不过滤
    manualViewpoint: '',
    scanDepth: 3,            // 扫描最近几条消息
    position: 1,             // 0 系统提示词之后 | 1 聊天记录中（按深度）| 2 系统提示词之前
    depth: 3,
    ...DEFAULT_RETRIEVAL,
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
    all[MODULE] = { ...DEFAULT_SETTINGS, ...(all[MODULE] || {}) };
    return all[MODULE];
}

function hasChat() {
    const c = ctx();
    return !!(c.getCurrentChatId?.() && (c.characterId !== undefined || c.groupId));
}

function chatMeta() {
    const md = ctx().chatMetadata;
    if (!md) return {};
    md[MODULE] = md[MODULE] || {};
    return md[MODULE];
}

function getStoryDate() {
    return chatMeta().storyDate || '';
}

function setStoryDate(date) {
    if (!hasChat()) return;
    chatMeta().storyDate = String(date || '').trim();
    const c = ctx();
    if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced(); else c.saveMetadata();
    const el = document.querySelector('#epi-storydate');
    if (el) el.value = chatMeta().storyDate;
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

// 最近一条用户消息如果是“寄出的信”，返回它的信息（用于收信反应）
function pendingReaction() {
    const chat = ctx().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        if (m.is_user) {
            const info = m.extra?.epistolary;
            return info && info.kind === 'letter' ? info : null;
        }
    }
    return null;
}

function reactionGuidance() {
    const info = pendingReaction();
    if (!info) return '';
    const letter = store.archive.letters[info.letterId];
    if (!letter) return '';
    return buildReactionGuidance(store.archive, letter, info.reader, info.arrival);
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

async function generateRaw(prompt, systemPrompt) {
    if (globalThis.epistolary?.mockGenerate) return globalThis.epistolary.mockGenerate({ prompt, systemPrompt, kind: 'raw' });
    const fn = ctx().generateRaw;
    if (typeof fn !== 'function') throw new Error('当前酒馆版本不支持 generateRaw');
    // 新版（1.13+）是对象参数；旧版是位置参数
    if (fn.length >= 2) return fn(prompt, null, false, false, systemPrompt);
    return fn({ prompt, systemPrompt });
}

// 写回信：回信人就是当前角色时，走 generateQuietPrompt，带上角色卡和聊天上下文；否则只用信件和文风档案
async function generateReply({ system, prompt, replier }) {
    if (globalThis.epistolary?.mockGenerate) return globalThis.epistolary.mockGenerate({ prompt, systemPrompt: system, kind: 'reply', replier });
    const c = ctx();
    if (isCurrentCharacter(replier) && typeof c.generateQuietPrompt === 'function') {
        return c.generateQuietPrompt({ quietPrompt: `${system}\n\n${prompt}`, removeReasoning: true });
    }
    return generateRaw(prompt, system);
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

// 把寄出的信作为用户消息发到聊天，然后让角色回复（此时会注入收信反应引导）
async function postLetterToChat(letter, reader, arrival) {
    if (!hasChat()) { toastr.warning('先打开一个聊天'); return; }
    const c = ctx();
    await pushMessage({
        name: c.name1,
        is_user: true,
        is_system: false,
        send_date: nowStamp(),
        mes: letterChatMessage(letter, reader, arrival),
        extra: { epistolary: { kind: 'letter', letterId: letter.id, reader, arrival } },
    }, { generate: true });
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

const store = new Store();
let ui = null;
let lastInjection = '';

// ---------- 生成前拦截：在这里计算要注入的信件内容 ----------
globalThis.epistolaryInterceptor = async function (_chat, _contextSize, _abort, type) {
    const c = ctx();
    const s = settings();
    try {
        if (!s.enabled || type === 'quiet' || store.mode === 'unloaded') {
            c.setExtensionPrompt(PROMPT_KEY, '', s.position, s.depth);
            c.setExtensionPrompt(REACTION_KEY, '', 1, 0);
            return;
        }
        const { result, reaction } = runRetrieval();
        lastInjection = [result.text, reaction].filter(Boolean).join('\n\n');
        c.setExtensionPrompt(PROMPT_KEY, result.text, s.position, s.depth, false, 0);
        // 收信反应引导放在最新消息之后，影响最直接
        c.setExtensionPrompt(REACTION_KEY, reaction, 1, 0, false, 0);
    } catch (e) {
        console.error('[书信簿] 注入失败', e);
        c.setExtensionPrompt(PROMPT_KEY, '', s.position, s.depth);
        c.setExtensionPrompt(REACTION_KEY, '', 1, 0);
    }
};

// ---------- 扩展设置面板 ----------
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
                    <button class="menu_button" id="epi-open-preview">注入预览</button>
                </div>
                <label class="checkbox_label"><input type="checkbox" id="epi-enabled"> 生成时注入相关信件</label>
                <label>界面模式</label>
                <select class="text_pole" id="epi-mode">
                    <option value="simple">简单模式：只显示写信需要的东西</option>
                    <option value="expert">专家模式：段落、流转、注入预览全部显示</option>
                </select>
                <label class="checkbox_label"><input type="checkbox" id="epi-autokw"> 简单模式下保存信件时，自动用 AI 生成检索关键词</label>
                <label class="checkbox_label"><input type="checkbox" id="epi-anim"> 寄信时的封缄动画、收信时的拆信动画</label>
                <label class="checkbox_label" title="英文和法文字体已随插件附带；中文字体体积大，从 jsDelivr 按需加载（只下载信里用到的字）。关闭后使用电脑自带的楷体和宋体。"><input type="checkbox" id="epi-cjkfonts"> 在线加载中文书信字体（霞鹜文楷、思源宋体、马善政楷书）</label>

                <label>视角角色（决定 AI 能知道哪些信）</label>
                <select class="text_pole" id="epi-vmode">
                    <option value="auto">跟随当前发言的角色</option>
                    <option value="manual">手动指定</option>
                    <option value="omniscient">全知（不过滤，调试用）</option>
                </select>
                <input class="text_pole" id="epi-vmanual" placeholder="手动指定的角色名">

                <label>当前剧情日期（仅本聊天）</label>
                <input class="text_pole" id="epi-storydate" placeholder="如 1890-11-20；留空则不按日期过滤">

                <div class="epi-set-grid">
                    <label>扫描最近几条消息<input type="number" min="1" max="20" class="text_pole" id="epi-scan"></label>
                    <label>最多注入几段<input type="number" min="1" max="20" class="text_pole" id="epi-maxseg"></label>
                    <label>每封信最多几段<input type="number" min="1" max="20" class="text_pole" id="epi-perletter"></label>
                    <label>注入字数上限<input type="number" min="200" max="20000" step="100" class="text_pole" id="epi-maxchars"></label>
                </div>

                <label>注入位置</label>
                <div class="flex-container">
                    <select class="text_pole flex1" id="epi-position">
                        <option value="1">聊天记录中（按深度）</option>
                        <option value="0">系统提示词之后</option>
                        <option value="2">系统提示词之前</option>
                    </select>
                    <input type="number" min="0" max="100" class="text_pole" id="epi-depth" title="深度：0 = 最新消息之后" style="max-width:5em">
                </div>

                <div class="flex-container">
                    <button class="menu_button" id="epi-export">导出档案</button>
                    <button class="menu_button" id="epi-import">导入档案</button>
                    <input type="file" id="epi-import-file" accept=".json,application/json" hidden>
                </div>
                <small id="epi-status" class="epi-muted"></small>
            </div>
        </div>
    </div>`;
}

function bindSettings() {
    const s = settings();
    const $ = sel => document.querySelector(sel);
    const save = () => ctx().saveSettingsDebounced();

    $('#epi-enabled').checked = s.enabled;
    $('#epi-vmode').value = s.viewpointMode;
    $('#epi-vmanual').value = s.manualViewpoint;
    $('#epi-scan').value = s.scanDepth;
    $('#epi-maxseg').value = s.maxSegments;
    $('#epi-perletter').value = s.maxPerLetter;
    $('#epi-maxchars').value = s.maxChars;
    $('#epi-position').value = String(s.position);
    $('#epi-depth').value = s.depth;
    $('#epi-vmanual').style.display = s.viewpointMode === 'manual' ? '' : 'none';

    $('#epi-enabled').addEventListener('change', e => { s.enabled = e.target.checked; save(); });
    $('#epi-mode').value = s.mode;
    $('#epi-autokw').checked = s.autoKeywords;
    $('#epi-mode').addEventListener('change', e => { s.mode = e.target.value; save(); ui.refresh(); });
    $('#epi-autokw').addEventListener('change', e => { s.autoKeywords = e.target.checked; save(); });
    $('#epi-anim').checked = s.animations;
    $('#epi-anim').addEventListener('change', e => { s.animations = e.target.checked; save(); });
    $('#epi-cjkfonts').checked = s.onlineFonts;
    $('#epi-cjkfonts').addEventListener('change', e => {
        s.onlineFonts = e.target.checked;
        save();
        if (s.onlineFonts) loadCjkFonts();
        else toastr.info('刷新页面后生效');
    });
    $('#epi-vmode').addEventListener('change', e => {
        s.viewpointMode = e.target.value;
        $('#epi-vmanual').style.display = s.viewpointMode === 'manual' ? '' : 'none';
        save();
    });
    $('#epi-vmanual').addEventListener('input', e => { s.manualViewpoint = e.target.value; save(); });
    const num = (id, key) => $(id).addEventListener('input', e => {
        const v = parseInt(e.target.value, 10);
        if (!Number.isNaN(v)) { s[key] = v; save(); }
    });
    num('#epi-scan', 'scanDepth');
    num('#epi-maxseg', 'maxSegments');
    num('#epi-perletter', 'maxPerLetter');
    num('#epi-maxchars', 'maxChars');
    num('#epi-depth', 'depth');
    $('#epi-position').addEventListener('change', e => { s.position = parseInt(e.target.value, 10); save(); });

    $('#epi-storydate').addEventListener('input', e => {
        if (!hasChat()) return;
        chatMeta().storyDate = e.target.value.trim();
        const c = ctx();
        if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced(); else c.saveMetadata();
    });

    $('#epi-open').addEventListener('click', () => ui.open('list'));
    $('#epi-open-preview').addEventListener('click', () => ui.open('preview'));

    $('#epi-export').addEventListener('click', () => {
        const blob = new Blob([store.exportJson()], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `书信簿备份_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('#epi-import').addEventListener('click', () => $('#epi-import-file').click());
    $('#epi-import-file').addEventListener('change', async e => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!confirm('导入会用这个文件替换当前整个档案（当前档案在本次会话开始时已自动备份）。继续？')) return;
        try {
            store.importJson(await file.text());
            toastr.success('已导入');
            ui.refresh();
        } catch (err) {
            toastr.error('导入失败：' + (err.message || err));
        }
        e.target.value = '';
    });
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
        setMode: mode => {
            settings().mode = mode;
            ctx().saveSettingsDebounced();
            const el = document.querySelector('#epi-mode');
            if (el) el.value = mode;
        },
        getSettings: settings,
        getViewer,
        getStoryDate,
        setStoryDate,
        hasChat,
        isCurrentCharacter,
        getUserName: () => ctx().name1 || '',
        getCharName: () => (hasChat() && !ctx().groupId ? ctx().name2 : '') || '',
        generateRaw,
        generateReply,
        postLetterToChat,
        postReplyToChat,
        runPreview: runRetrieval,
    });
    ui.mount();
    bindSettings();
    addWandButton();

    store.onChange(refreshStatus);
    await store.load();
    refreshChatFields();
    refreshStatus();

    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        refreshChatFields();
        ui.refresh();
    });

    // 调试入口：控制台里输入 epistolary.last() 查看上一次注入的内容
    globalThis.epistolary = { ...(globalThis.epistolary || {}), store, ui, last: () => lastInjection, envelope: { playSeal, playOpen } };
    console.log('[书信簿] 已加载');
});
