// 书信簿 · 演示页用的“假酒馆”
// 只在 demo.html 里加载，酒馆里不会用到。
// 模拟插件用到的那部分酒馆接口：聊天、角色名、扩展设置、注入提示词、生成回复；
// 档案保存在这个浏览器的 localStorage 里；AI 回复是写死的演示文字，不会调用任何 API。

const LS_ARCHIVE = 'epistolary-demo-archive';
const LS_STATE = 'epistolary-demo-state';

function loadState() {
    try { return JSON.parse(localStorage.getItem(LS_STATE)) || {}; } catch { return {}; }
}
function saveState() {
    try {
        localStorage.setItem(LS_STATE, JSON.stringify({
            chat: ctx.chat, chatMetadata: ctx.chatMetadata, extensionSettings: ctx.extensionSettings, name2: ctx.name2,
        }));
    } catch { /* 隐私模式下存不了，就只在本页有效 */ }
}

const listeners = {};
const eventSource = {
    on(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    async emit(type, ...args) { for (const fn of listeners[type] || []) await fn(...args); },
};

const state = loadState();

const ctx = {
    name1: 'E.',
    name2: state.name2 || '文森特',
    characterId: 0,
    groupId: null,
    chat: state.chat || [],
    chatMetadata: state.chatMetadata || { epistolary: { storyDate: '1889-06-08' } },
    extensionSettings: state.extensionSettings || {},
    extensionPrompts: {},
    eventSource,
    eventTypes: { CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SENT: 'message_sent' },
    get characters() { return [{ name: ctx.name2, description: `${ctx.name2}（演示用的角色卡）`, personality: '', scenario: '' }]; },
    getCurrentChatId: () => 'demo-chat',
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    saveSettingsDebounced: () => saveState(),
    saveMetadata: async () => saveState(),
    saveMetadataDebounced: () => saveState(),
    saveChat: async () => saveState(),
    setExtensionPrompt(key, value, position, depth, scan = false, role = 0) {
        this.extensionPrompts[key] = { value: String(value || ''), position, depth, scan, role };
    },
    addOneMessage(msg) { renderMessage(msg); },
    async generate() {
        // 真酒馆会在这里调用插件的拦截器，再把提示词发给 AI
        await globalThis.epistolaryInterceptor(ctx.chat, 8000, () => {}, 'normal');
        showInjection();
        const typing = renderMessage({ name: ctx.name2, is_user: false, mes: '……' });
        await new Promise(r => setTimeout(r, 700));
        typing.remove();
        const msg = { name: ctx.name2, is_user: false, is_system: false, mes: demoReply(), send_date: new Date().toLocaleString() };
        ctx.chat.push(msg);
        renderMessage(msg);
        saveState();
        await eventSource.emit('message_received', ctx.chat.length - 1);
    },
    generateRaw: async () => '',
    generateQuietPrompt: async () => '',
};

globalThis.SillyTavern = { getContext: () => ctx };

// ---------- 档案存储：把酒馆的文件接口换成 localStorage ----------
const realFetch = window.fetch.bind(window);
window.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/user/files/epistolary_archive.json')) {
        const text = localStorage.getItem(LS_ARCHIVE);
        return text ? new Response(text, { status: 200 }) : new Response('', { status: 404 });
    }
    if (u.includes('/api/files/upload')) {
        const body = JSON.parse(opts.body || '{}');
        if (body.name === 'epistolary_archive.json') {
            const bin = atob(body.data);
            const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
            localStorage.setItem(LS_ARCHIVE, new TextDecoder().decode(bytes));
        }
        return new Response('{}', { status: 200 });
    }
    return realFetch(url, opts);
};

// ---------- 演示用的 AI 回复 ----------
function lastUserText() {
    for (let i = ctx.chat.length - 1; i >= 0; i--) if (ctx.chat[i].is_user) return ctx.chat[i];
    return null;
}

function demoReply() {
    const last = lastUserText();
    const inj = ctx.extensionPrompts.epistolary_letters?.value || '';
    const reaction = ctx.extensionPrompts.epistolary_reaction?.value || '';
    // 书信簿直接注入的信（原文不在聊天里）
    const peekM = reaction.match(/【(.+?) 拆开的这封信/);
    if (peekM) {
        const v = peekM[1];
        return `*（演示回复：${v}读这封不是写给他的信。信的原文是书信簿直接交给 AI 的，没有发进聊天。）*\n\n${v}读完，沉默了一会儿，用一点胶水把封口重新粘好，决定明天一早把信送过去。`;
    }
    const readM = reaction.match(/【(.+?) 收到的信/);
    if (readM) {
        return `*（演示回复：${readM[1]}读信的反应。信的原文是书信簿直接交给 AI 的，没有发进聊天；提醒原文见“本轮注入给 AI 的内容”。）*`;
    }
    if (last?.extra?.epistolary?.kind === 'via') {
        const v = last.extra.epistolary.via;
        return `*（演示回复：真实使用时，这里是 AI 扮演的${v}拿到信以后怎么做，全由他自己决定。）*\n\n${v}把信封翻过来看了看，犹豫了很久，终于还是用裁纸刀轻轻挑开了封口。`;
    }
    if (last?.extra?.epistolary?.kind === 'letter' && last.extra.epistolary.peek) {
        const v = last.extra.epistolary.reader;
        return `*（演示回复：${v}读这封不是写给他的信。）*\n\n${v}读完，沉默了一会儿，用一点胶水把封口重新粘好，决定明天一早把信送过去。`;
    }
    if (last?.extra?.epistolary?.kind === 'letter') {
        return `*（演示回复：真实使用时，这里是 AI 扮演的${ctx.name2}读信的反应。插件这一轮额外提醒了 AI：描写收信时的情境、对信里具体的句子做出反应、不要复述整封信。提醒原文见“本轮注入给 AI 的内容”一栏。）*`;
    }
    if (inj) {
        const quoted = (inj.split('\n').find(l => l && !l.startsWith('【') && !l.startsWith('〔') && !l.startsWith('以下') && !l.startsWith('信中')) || '').slice(0, 40);
        return `*（演示回复：${ctx.name2}想起了信里的内容。插件把相关段落的原文注入给了 AI，比如：“${quoted}……”）*`;
    }
    return `*（演示回复：这一轮没有注入任何信件内容。可能是聊天里没提到相关关键词，或者 ${ctx.name2} 不知道那封信。）*${reaction ? '' : ''}`;
}

// 关键词分析和写回信的假 AI
function segmentWords(text) {
    const out = [];
    try {
        const seg = new Intl.Segmenter('zh', { granularity: 'word' });
        for (const s of seg.segment(text)) if (s.isWordLike && s.segment.length >= 2) out.push(s.segment);
    } catch {
        out.push(...(text.match(/[一-龥]{2,4}|[A-Za-zÀ-ÿ]{4,}/g) || []));
    }
    return [...new Set(out)].slice(0, 5);
}

const MOCK_REPLY = {
    zh: (to, quote, date) => `Saint-Rémy，${date}

亲爱的 ${to}：

你信里说“${quote}”，这句话我读了好几遍。这里的天空这几天也蓝得出奇，我正在画一片麦田，用铬黄和一点翡翠绿，风一吹，整片麦子都在动。

至于别的事，你不必替我担心，提奥照顾得很好。倒是你一个人在那么远的地方，要多保重。

紧握你的手，
文森特

又及：这是演示页写死的回信。在真的酒馆里，这封信会由 AI 按照文森特的文风档案来写。`,
};

globalThis.__epistolaryDemoMock = async ({ prompt, kind, target }) => {
    await new Promise(r => setTimeout(r, 500));
    if (kind === 'translate') {
        const body = (prompt.split('【原文】\n')[1] || '').trim();
        const paras = body.split(/\n\s*\n/);
        const t = target || '外语';
        return paras.map((p, i) => i === 0 ? (t === '法语' ? 'Mon cher ami,' : t === '中文' ? '（演示译文）亲爱的朋友：' : `[${t}] ${p.split('\n')[0]}`)
            : `[${t}·演示译文] ${p.replace(/\n/g, ' ')}`).join('\n\n');
    }
    if (kind === 'date') {
        const cur = (prompt.match(/上一次记录的剧情日期是 (\d{4}-\d{2}-\d{2})/) || [])[1];
        if (!cur) return '1889-06-10';
        const d = new Date(cur + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() + 2);
        return d.toISOString().slice(0, 10);
    }
    if (kind === 'import') {
        const { detectInMessage } = await import('../src/importer.js');
        const out = [];
        for (const m of prompt.matchAll(/<<消息 #(\d+)｜[^>]*>>\n([\s\S]*?)(?=\n\n<<消息 #|$)/g)) {
            for (const c of detectInMessage(m[2])) {
                const flat = c.text.replace(/\s+/g, '');
                out.push({ message: Number(m[1]), start: flat.slice(0, 14), end: flat.slice(-8), author: c.signoff.replace(/[，,。.]$/, ''), recipient: '', date: '', place: '' });
            }
        }
        return JSON.stringify(out);
    }
    if (kind === 'fill') {
        const date = (prompt.match(/【当前剧情日期】(\d{4}-\d{2}-\d{2})/) || [])[1] || '1889-06-10';
        const to = (prompt.match(/【当前聊天的角色】(.+)/) || [])[1] || '文森特';
        const where = { 文森特: '圣雷米', 提奥: '巴黎', 高更: '阿旺桥' }[to] || '';
        return JSON.stringify({ author: 'E.', recipients: [to], writtenAt: date, placeFrom: to === '提奥' ? '巴黎（另一区）' : '巴黎', placeTo: where, language: '法语（中文显示）', travelDays: to === '提奥' ? 1 : 3, note: `演示：E. 在巴黎，${to} 在${where}；1889 年铁路邮政大约要 ${to === '提奥' ? 1 : 3} 天` });
    }
    if (kind === 'via') {
        globalThis.__viaJudgeCalls = (globalThis.__viaJudgeCalls || 0) + 1;
        const story = prompt.split('【剧情】')[1] || '';
        const was = prompt.includes('之前已经拆开读过');
        if (/送过去|重新封好|重新粘好|火漆/.test(story) && was) return JSON.stringify({ opened: true, resealed: !/火漆/.test(story), openly: /火漆|拆阅/.test(story), action: 'forward', envelopeNote: /拆阅核验/.test(story) ? '已由 T. v. G. 拆阅核验。未见恶兆。请宽心阅读。' : '', note: '读完封好，准备转交' });
        if (/挑开了封口|割开/.test(story) && !was) return '{"opened": true, "action": "unclear", "note": "拆开了信"}';
        if (/放回抽屉|推了回去/.test(story)) return JSON.stringify({ opened: was, action: 'later', note: '先放着' });
        if (/照常转交/.test(story)) return '{"opened": false, "action": "forward", "note": "照常转交"}';
        return JSON.stringify({ opened: was, action: 'unclear', note: '还看不出来' });
    }
    if (kind === 'reply') {
        const m = prompt.match(/§\d+ ([^\n]{4,40})/g) || [];
        const quote = (m[1] || m[0] || '§1 你的来信').replace(/^§\d+ /, '').replace(/[。？！,，]$/, '');
        const to = (prompt.match(/收到了 (.+?) 的来信/) || [])[1] || '朋友';
        const date = (prompt.match(/（(\d{4}-\d{2}-\d{2})）要写回信/) || [])[1] || '';
        return MOCK_REPLY.zh(to, quote, date.replace(/^(\d+)-0?(\d+)-0?(\d+)$/, '$1年$2月$3日'));
    }
    const segs = [...prompt.matchAll(/§(\d+)\n([\s\S]*?)(?=\n\n§\d+\n|$)/g)];
    return segs.map(([, n, t]) => `§${n} | ${segmentWords(t).join(', ') || '信件'} | ${t.replace(/\s+/g, ' ').slice(0, 24)}`).join('\n');
};

// ---------- 聊天面板 ----------
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderMessage(msg) {
    const box = document.getElementById('demo-chat');
    const el = document.createElement('div');
    el.className = `demo-msg ${msg.is_user ? 'user' : 'char'}`;
    const tag = msg.extra?.epistolary?.kind === 'letter' ? '<span class="demo-tag">✉ 寄出的信</span>'
        : msg.extra?.epistolary?.kind === 'reply' ? '<span class="demo-tag">✉ 回信</span>'
        : msg.extra?.epistolary?.kind === 'via' ? '<span class="demo-tag">🤝 托人转交</span>' : '';
    el.innerHTML = `<div class="demo-name">${esc(msg.name)} ${tag}</div><div class="demo-text">${esc(msg.mes).replace(/\*(.+?)\*/gs, '<i>$1</i>')}</div>`;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
}

export function showInjection() {
    const el = document.getElementById('demo-injection');
    const letters = ctx.extensionPrompts.epistolary_letters?.value || '';
    const reaction = ctx.extensionPrompts.epistolary_reaction?.value || '';
    const pending = ctx.extensionPrompts.epistolary_pending?.value || '';
    el.textContent = [letters, pending, reaction].filter(Boolean).join('\n\n') || '（这一轮没有注入任何内容）';
}

export function rerenderChat() {
    document.getElementById('demo-chat').innerHTML = '';
    ctx.chat.forEach(renderMessage);
}

export { ctx, saveState, LS_ARCHIVE, LS_STATE };
