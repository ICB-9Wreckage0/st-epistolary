// 书信簿 · 数据模型
// 纯函数，不依赖酒馆，也不碰 DOM —— 所以可以在 Node 里单独测试。
import { normalizeEnclosures } from './enclosures.js';

export const SCHEMA_VERSION = 1;

export const KINDS = {
    letter: '信件',
    postcard: '明信片',
    telegram: '电报',
    note: '便条',
    invitation: '请柬',
};

export const STATUSES = {
    draft: '草稿',
    sealed: '已封口',
    sent: '已寄出',
    unsent: '写了未寄',
    lost: '遗失',
};

export const AUTHENTICITY = {
    original: '原件',
    copy: '抄本',
    transcript: '誊录',
    translation: '译本',
    forged: '伪造',
    fragment: '残片',
};

// 知情程度，从低到高
export const LEVELS = ['none', 'exists', 'summary', 'full'];
export const LEVEL_LABELS = {
    none: '不知道',
    exists: '只知道存在',
    summary: '听人转述',
    full: '读过/听过原文',
};

// 每种事件会让当事人获得什么程度的知情。null = 这个事件本身不带来知情
export const EVENT_TYPES = {
    sent: { label: '寄出', level: null },
    received: { label: '收到', level: 'exists' },
    read: { label: '阅读', level: 'full' },
    heard: { label: '听人念过', level: 'full' },
    told: { label: '听人转述', level: 'summary' },
    aware: { label: '知道存在', level: 'exists' },
    copied: { label: '抄录', level: 'full' },
    forwarded: { label: '转寄', level: null },
    returned: { label: '退回', level: null },
    lost: { label: '遗失', level: null },
};

// ---------- 小工具 ----------

export function levelRank(level) {
    const i = LEVELS.indexOf(level);
    return i < 0 ? 0 : i;
}

export function maxLevel(a, b) {
    return levelRank(a) >= levelRank(b) ? a : b;
}

export function parseTags(input) {
    if (Array.isArray(input)) return input.map(s => String(s).trim()).filter(Boolean);
    return String(input || '')
        .split(/[,，、;；#\n]+/)
        .map(s => s.trim())
        .filter(Boolean);
}

export function parseNames(input) {
    if (Array.isArray(input)) return input.map(s => String(s).trim()).filter(Boolean);
    return String(input || '')
        .split(/[,，、;；\n]+/)
        .map(s => s.trim())
        .filter(Boolean);
}

// 日期：支持 1890、1890-11、1890-11-14（也接受 / 和 . 分隔）。
// 解析不了的（比如“某年秋”）返回 null，视为“时间未知”，不参与时间过滤。
export function normalizeDate(input) {
    if (!input) return null;
    const m = String(input).trim().match(/^(\d{1,4})年?(?:[-/.]?(\d{1,2})月?)?(?:[-/.]?(\d{1,2})日?)?$/);
    if (!m) return null;
    const y = m[1].padStart(4, '0');
    const mo = m[2] ? m[2].padStart(2, '0') : '00';
    const d = m[3] ? m[3].padStart(2, '0') : '00';
    return `${y}-${mo}-${d}`;
}

// 事件日期是否在剧情日期当天或之前。任何一方未知 → 当作已经发生（宽松）。
export function isOnOrBefore(eventDate, storyDate) {
    const a = normalizeDate(eventDate);
    const b = normalizeDate(storyDate);
    if (!a || !b) return true;
    return a <= b;
}

function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

// ---------- 档案 ----------

export function createArchive() {
    return {
        schema: SCHEMA_VERSION,
        counters: { letter: 0, attachment: 0 },
        people: [],
        letters: {},
        attachments: {},
        presets: [],
        styles: [],   // 用户自己存的款式包
    };
}

// 读入旧档案时补齐缺失字段。以后数据结构升级，也在这里做迁移。
export function migrateArchive(raw) {
    const a = raw && typeof raw === 'object' ? raw : {};
    const base = createArchive();
    const out = { ...base, ...a };
    out.counters = { ...base.counters, ...(a.counters || {}) };
    out.people = Array.isArray(a.people) ? a.people.map(normalizePerson) : [];
    out.letters = a.letters && typeof a.letters === 'object' ? a.letters : {};
    out.attachments = a.attachments && typeof a.attachments === 'object' ? a.attachments : {};
    out.presets = Array.isArray(a.presets) ? a.presets : [];
    out.styles = Array.isArray(a.styles) ? a.styles : [];
    for (const id of Object.keys(out.letters)) {
        out.letters[id] = normalizeLetter(out.letters[id], id);
    }
    out.schema = SCHEMA_VERSION;
    return out;
}

export function nextId(archive, kind) {
    archive.counters[kind] = (archive.counters[kind] || 0) + 1;
    const n = String(archive.counters[kind]).padStart(4, '0');
    return kind === 'attachment' ? `ATT-${n}` : `LETTER-${n}`;
}

const HAND_KEYS = ['formal', 'personal', 'elegant', 'casual', 'typewriter'];
const LEGACY_FONTS = { serif: 'formal', kai: 'personal', hand: 'personal', mono: 'typewriter' };

export function normalizeHandKey(font) {
    if (HAND_KEYS.includes(font)) return font;
    return LEGACY_FONTS[font] || '';
}

function normalizeLevel(v, allowEmpty) {
    if (allowEmpty && (v === '' || v == null)) return '';
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(3, Math.round(n))) : (allowEmpty ? '' : 0);
}

function normalizeAppearance(a = {}) {
    return {
        paper: 'cream', ink: 'blueblack', envelope: 'ivory', wax: 'crimson',
        ...a,
        font: normalizeHandKey(a.font) || 'personal',        // 字迹：formal 端正 | personal 自然 | elegant 优雅 | casual 随意 | typewriter 打字机
        orientation: a.orientation === 'landscape' ? 'landscape' : 'portrait', // 竖版对折 | 横版平放
        flourish: !!a.flourish,                               // 称呼和署名用花体
        wobble: normalizeLevel(a.wobble, true),               // 笔迹抖动 0-3；'' = 跟随写信人档案
        wear: normalizeLevel(a.wear, false) || 0,             // 纸张磨损 0 崭新 | 1 轻微 | 2 旧信 | 3 破损
        inkColor: /^#[0-9a-f]{6}$/i.test(a.inkColor || '') ? a.inkColor : '', // 墨水选“自定义颜色”时用
        size: ['sm', 'md', 'lg', 'xl'].includes(a.size) ? a.size : 'md',      // 字号：sm 小 | md 标准 | lg 大 | xl 特大
    };
}

export function normalizeLetter(l, id) {
    const now = new Date().toISOString();
    return {
        id: l.id || id,
        kind: KINDS[l.kind] ? l.kind : 'letter',
        status: STATUSES[l.status] ? l.status : 'draft',
        authenticity: AUTHENTICITY[l.authenticity] ? l.authenticity : 'original',
        title: l.title || '',
        author: l.author || '',
        signature: l.signature || '',
        recipients: parseNames(l.recipients),
        writtenAt: l.writtenAt || '',
        placeFrom: l.placeFrom || '',
        placeTo: l.placeTo || '',
        language: l.language || '',
        tags: parseTags(l.tags),
        body: typeof l.body === 'string' ? l.body : '',
        shell: !!l.shell && !String(l.body || '').trim(),          // 空壳信：剧情里已经有了，正文还没写
        code: normalizeCode(l.code),                              // 暗号：用户消息里出现它，这一轮就把信交给 AI
        segments: Array.isArray(l.segments) ? l.segments.map(normalizeSegment) : [],
        events: Array.isArray(l.events) ? l.events.map(normalizeEvent) : [],
        attachments: Array.isArray(l.attachments) ? l.attachments : [],
        enclosures: normalizeEnclosures(l.enclosures, l.attachments), // 随信附上的东西：钱、礼物、速写……
        appearance: normalizeAppearance(l.appearance),
        links: { works: [], ...(l.links || {}) },
        inReplyTo: l.inReplyTo || '',   // 回复的是哪封信
        aiDraft: !!l.aiDraft,           // 是否是 AI 代写的回信（用户确认前）
        openedAt: l.openedAt || '',     // 收信人第一次拆开的时间（用于只播放一次拆信动画）
        delivery: l.delivery && typeof l.delivery === 'object' ? l.delivery : null, // 在途信件的送达信息
        source: l.source && typeof l.source === 'object' ? l.source : null,         // 从聊天记录导入时的出处
        translations: l.translations && typeof l.translations === 'object' ? l.translations : {}, // 阅读用的译文缓存
        notes: l.notes || '',
        createdAt: l.createdAt || now,
        updatedAt: l.updatedAt || now,
    };
}

function normalizeSegment(s) {
    return {
        id: s.id,
        text: s.text || '',
        tags: parseTags(s.tags),
        aiTags: parseTags(s.aiTags),
        summary: s.summary || '',
        references: Array.isArray(s.references) ? s.references : [],
    };
}

function normalizeEvent(e) {
    return {
        id: e.id,
        type: EVENT_TYPES[e.type] ? e.type : 'read',
        who: e.who || '',
        date: e.date || '',
        segments: Array.isArray(e.segments) && e.segments.length ? e.segments : null, // null = 整封
        to: e.to || '',
        note: e.note || '',
    };
}

// ---------- 暗号 ----------

// 没写括号的，自动加上【】：“信1” → “【信1】”
export function normalizeCode(code) {
    const c = String(code || '').trim();
    if (!c) return '';
    return /^[【\[〔「『《<（({]/.test(c) ? c : `【${c}】`;
}

// 下一个没被用过的暗号：【信1】【信2】……
export function nextCode(archive) {
    const used = new Set(Object.values(archive.letters).map(l => l.code));
    for (let n = 1; ; n++) if (!used.has(`【信${n}】`)) return `【信${n}】`;
}

// 一段文字里出现了哪些信的暗号
export function lettersByCode(archive, text) {
    const t = String(text || '');
    if (!t) return [];
    return Object.values(archive.letters).filter(l => l.code && t.includes(l.code));
}

// 旧档案里没有暗号的信，按编号顺序补上
export function ensureCodes(archive) {
    let changed = false;
    for (const l of Object.values(archive.letters).sort((a, b) => a.id.localeCompare(b.id))) {
        if (!l.code) { l.code = nextCode(archive); changed = true; }
    }
    return changed;
}

export function createLetter(archive, partial = {}) {
    const id = nextId(archive, 'letter');
    const letter = normalizeLetter({ ...partial, id, code: partial.code || nextCode(archive) }, id);
    resegment(letter);
    archive.letters[id] = letter;
    return letter;
}

// ---------- 分段 ----------

// 空行分段。段内的单个换行保留。原文 body 永远是唯一的事实来源，段落由它推出。
export function splitBody(body) {
    return String(body || '')
        .replace(/\r\n?/g, '\n')
        .split(/\n[ \t　]*\n/)
        .map(s => s.replace(/^\n+|\n+$/g, ''))
        .filter(s => s.trim().length > 0);
}

// 重新分段，同时尽量保住旧段落的 ID、关键词、大意和引用：
// 1) 文字完全相同的段落直接继承；2) 剩下的按位置继承（改了错别字的段落仍然保住关键词）。
export function resegment(letter) {
    const texts = splitBody(letter.body);
    const old = letter.segments || [];
    const used = new Set();
    const result = new Array(texts.length).fill(null);

    texts.forEach((t, i) => {
        const j = old.findIndex((s, k) => !used.has(k) && s.text === t);
        if (j >= 0) {
            used.add(j);
            result[i] = { ...old[j], text: t };
        }
    });
    texts.forEach((t, i) => {
        if (result[i]) return;
        if (i < old.length && !used.has(i)) {
            used.add(i);
            result[i] = { ...old[i], text: t };
        }
    });

    let maxN = 0;
    for (const s of old) {
        const n = parseInt(String(s.id || '').replace(/\D/g, ''), 10);
        if (n > maxN) maxN = n;
    }
    texts.forEach((t, i) => {
        if (!result[i]) {
            maxN += 1;
            result[i] = normalizeSegment({ id: `S${maxN}`, text: t });
        }
    });

    letter.segments = result;
    // 事件里引用了已经不存在的段落 → 去掉这些引用
    const ids = new Set(result.map(s => s.id));
    for (const e of letter.events) {
        if (e.segments) {
            e.segments = e.segments.filter(id => ids.has(id));
            if (!e.segments.length) e.segments = null;
        }
    }
    return letter;
}

export function segmentPosition(letter, segId) {
    const i = letter.segments.findIndex(s => s.id === segId);
    return i < 0 ? null : i + 1;
}

// ---------- 人物与别名 ----------

// 人物档案：除了名字和别名，还有“文风档案”，用于生成更像本人的回信
export function normalizePerson(p = {}) {
    return {
        name: p.name || '',
        aliases: parseNames(p.aliases),
        historical: !!p.historical,        // 是否真实历史人物
        styleSource: p.styleSource || '',  // 参考的书信集，如《梵高书信》
        styleNotes: p.styleNotes || '',    // 文风描述
        styleSamples: Array.isArray(p.styleSamples) ? p.styleSamples.filter(s => String(s).trim()) : splitSamples(p.styleSamples),
        language: p.language || '',
        hand: normalizeHandKey(p.hand),     // 此人的字迹，新信件默认用它
        wobble: normalizeLevel(p.wobble, true), // 此人笔迹的抖动程度 0-3；'' = 按字迹默认
    };
}

// 文风样本：多段之间用单独一行 --- 隔开
export function splitSamples(text) {
    return String(text || '').split(/\n\s*-{3,}\s*\n/).map(s => s.trim()).filter(Boolean);
}

export function findPerson(archive, name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    return (archive.people || []).find(p => [p.name, ...(p.aliases || [])].some(n => String(n || '').trim().toLowerCase() === key)) || null;
}

export function sameName(archive, a, b) {
    return nameSet(archive, a).has(String(b || '').trim().toLowerCase());
}

// 把一个名字扩展成“这个人所有的叫法”，统一小写，用来比对。
export function nameSet(archive, name) {
    const set = new Set();
    const key = String(name || '').trim().toLowerCase();
    if (!key) return set;
    set.add(key);
    for (const p of archive.people || []) {
        const all = [p.name, ...(p.aliases || [])].map(s => String(s || '').trim().toLowerCase()).filter(Boolean);
        if (all.includes(key)) all.forEach(n => set.add(n));
    }
    return set;
}

export function isPerson(set, name) {
    return set.has(String(name || '').trim().toLowerCase());
}

// ---------- 知情推算 ----------

// 某人在某个剧情日期，对这封信知道多少。
// 返回 { letterLevel, segLevels: {segId: level}, exists: bool }
// exists=false 表示信在那个日期还没写成。
export function knowledgeOf(letter, who, storyDate) {
    const segLevels = {};
    letter.segments.forEach(s => { segLevels[s.id] = 'none'; });
    const result = { letterLevel: 'none', segLevels, exists: true };

    if (!isOnOrBefore(letter.writtenAt, storyDate)) {
        result.exists = false;
        return result;
    }

    const grant = (level, segIds) => {
        if (!level) return;
        if (level === 'exists') {
            result.letterLevel = maxLevel(result.letterLevel, 'exists');
            return;
        }
        const targets = segIds && segIds.length ? segIds : letter.segments.map(s => s.id);
        for (const id of targets) {
            if (id in segLevels) segLevels[id] = maxLevel(segLevels[id], level);
        }
        result.letterLevel = maxLevel(result.letterLevel, level);
    };

    if (isPerson(who, letter.author)) grant('full', null);

    for (const e of letter.events) {
        if (!isPerson(who, e.who)) continue;
        if (!isOnOrBefore(e.date, storyDate)) continue;
        grant(EVENT_TYPES[e.type]?.level, e.segments);
    }
    return result;
}

// 列出所有“和这封信有关系”的人，以及他们现在的知情程度（给编辑器里的一览表用）
export function knowledgeTable(archive, letter, storyDate) {
    const names = new Map();
    const add = n => { const k = String(n || '').trim(); if (k && !names.has(k.toLowerCase())) names.set(k.toLowerCase(), k); };
    add(letter.author);
    letter.recipients.forEach(add);
    letter.events.forEach(e => add(e.who));
    return [...names.values()].map(name => {
        const k = knowledgeOf(letter, nameSet(archive, name), storyDate);
        return { name, ...k };
    });
}

export { clone };
