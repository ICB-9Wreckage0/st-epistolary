// 书信簿 · 信件排版
// 把正文渲染成有段落的 HTML：识别日期行（右对齐）、称呼、结尾署名（右对齐），
// 可选把称呼和署名换成花体。阅读视图和信封动画共用。

import { splitBody, MARKS, MARK_RE, stripMarks } from './model.js';

// 字迹：用户选的是“这个人的字是什么样”，后台按文字自动选字体。
// 每种字迹的 CSS 字体栈里，拉丁字体排在前面、中文字体排在后面：
// 英文和法文字母用前者，汉字自动落到后者，一封信里中外文混排也不用分开设置。
export const HANDS = {
    formal: { label: '端正', desc: 'EB Garamond / 思源宋体：正式通信、档案、公函' },
    personal: { label: '自然', desc: 'Allura / 霞鹜文楷：普通私人信件的默认手写' },
    elegant: { label: '优雅', desc: 'Great Vibes / 马善政楷书：贺信、请柬；长信不宜' },
    casual: { label: '随意', desc: 'Caveat / 霞鹜文楷：便条、草稿、匆匆写就的短信' },
    typewriter: { label: '打字机', desc: 'Courier / 仿宋：打字机、电报' },
};

// 旧版本的字体选项 → 新的字迹
const LEGACY_FONTS = { serif: 'formal', kai: 'personal', hand: 'personal', mono: 'typewriter' };

export function normalizeHand(font) {
    if (HANDS[font]) return font;
    return LEGACY_FONTS[font] || 'personal';
}

export const ORIENTATIONS = {
    portrait: '竖版（对折入封）',
    landscape: '横版（平放入封）',
};

// 信纸上实际写的是什么文字：决定手写体要不要放大。
// “法语（中文显示）”这种，纸上写的其实是中文。
export function scriptLang(language) {
    const s = String(language || '').toLowerCase();
    if (!s || /中文显示|拟译|译文|中文/.test(s)) return 'zh';
    if (/法|fr|英|en|德|de|意|it|西|es|拉丁|latin/.test(s)) return 'lat';
    return 'zh';
}

// 给信纸元素用的 class：纸、墨、字迹、版式、文字
export function paperClasses(letter) {
    const a = letter.appearance || {};
    return [
        'epi-paper',
        `paper-${a.paper || 'cream'}`,
        `ink-${a.ink || 'blueblack'}`,
        `font-${normalizeHand(a.font)}`,
        `orient-${a.orientation === 'landscape' ? 'landscape' : 'portrait'}`,
        `script-${scriptLang(letter.language)}`,
        a.flourish ? 'flourish' : '',
        Number(a.wear) > 0 ? `worn worn-${Number(a.wear)}` : '',
    ].filter(Boolean).join(' ');
}

// ================= 墨水 =================
export const INKS = {
    black: { label: '墨黑', color: '#1a1a1a' },
    blueblack: { label: '蓝黑', color: '#1c2640' },
    navy: { label: '深蓝', color: '#17306b' },
    brown: { label: '深褐', color: '#3f2716' },
    crimson: { label: '酒红', color: '#6e1620' },
    green: { label: '墨绿', color: '#173d2c' },
    faded: { label: '褪色铁胆', color: '#4f3e2d' },
    custom: { label: '自定义颜色…', color: '' },
};

export const PAPER_BASE = { plain: '#fdfdfb', cream: '#f7f0de', aged: '#e6d2a4', lined: '#fbf9f3', redline: '#fbf6ea', blue: '#e7eef6' };

export function inkColor(appearance = {}) {
    if (appearance.mode?.ink === 'custom' && /^#[0-9a-f]{6}$/i.test(appearance.customColor?.ink || '')) return appearance.customColor.ink;
    if (appearance.ink === 'custom' && /^#[0-9a-f]{6}$/i.test(appearance.inkColor || '')) return appearance.inkColor;
    return (INKS[appearance.ink] || INKS.blueblack).color || INKS.blueblack.color;
}

// 自定义墨色写在元素的 style 上
// 字号：整张纸一起放大缩小（横格信笺的格线也跟着变）
export const SIZES = {
    sm: { label: '小（字小而密）', scale: 0.88 },
    md: { label: '标准', scale: 1 },
    lg: { label: '大', scale: 1.15 },
    xl: { label: '特大', scale: 1.3 },
};
export const SIZE_LABELS = Object.fromEntries(Object.entries(SIZES).map(([k, v]) => [k, v.label]));

// 外文信里夹着的中文（比如括号里的翻译）单独的字号：相对正常中文的大小
export const CJK_SIZES = {
    xs: { label: '很小（像旁注）', scale: 0.7 },
    sm: { label: '小', scale: 0.85 },
    md: { label: '和正文中文一样', scale: 1 },
    lg: { label: '大', scale: 1.15 },
};
export const CJK_SIZE_LABELS = Object.fromEntries(Object.entries(CJK_SIZES).map(([k, v]) => [k, v.label]));

export function paperStyle(letter) {
    const a = letter.appearance || {};
    const out = [];
    if (a.ink === 'custom' && /^#[0-9a-f]{6}$/i.test(a.inkColor || '')) out.push(`--ink:${a.inkColor}`);
    if (a.mode?.ink === 'custom' && a.customColor?.ink) out.push(`--ink:${a.customColor.ink}`);
    if (a.mode?.paper === 'custom' && a.customColor?.paper) out.push(`--paper:${a.customColor.paper}`);
    const sc = SIZES[a.size]?.scale;
    if (sc && sc !== 1) out.push(`--fs:${sc}`);
    const cj = CJK_SIZES[a.cjkSize]?.scale;
    if (cj && cj !== 1) out.push(`--cjk:${cj}`);
    return out.join(';');
}

function luminance(hex) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

// 墨色和纸色的对比度（WCAG），低于 4.5 读起来吃力
export function inkContrast(appearance = {}) {
    const a = luminance(inkColor(appearance));
    const b = luminance(PAPER_BASE[appearance.paper] || PAPER_BASE.cream);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// 只要字迹、墨水、文字的 class（信封上写地址用，不要纸张背景）
export function handClasses(letter) {
    const a = letter.appearance || {};
    return `ink-${a.ink || 'blueblack'} font-${normalizeHand(a.font)} script-${scriptLang(letter.language)}`;
}

// ================= 纸张磨损 =================
// 思路和 TornPaper 一样：用 SVG 滤镜实时生成撕边和污渍，不用图片。
// 只处理纸张的背景层：边缘是把纸的轮廓用噪声“咬”掉一圈，纸面和格线本身不扭曲，字也不会糊。

export const WEAR_LABELS = { 0: '崭新', 1: '轻微', 2: '旧信', 3: '破损' };

const WEAR = [
    null,
    { edge: 5, freq: 0.045, stain: 0.3, speck: 0, shadow: 0.38 },
    { edge: 10, freq: 0.035, stain: 0.55, speck: 0.35, shadow: 0.34 },
    { edge: 18, freq: 0.022, stain: 0.95, speck: 0.6, shadow: 0.3 },
];

function wearFilter(level, variant) {
    const w = WEAR[level];
    const seed = level * 17 + variant * 101 + 3;
    // 污渍：取噪声的红色通道，只有偏亮的地方显出淡褐色
    const sk = w.stain;
    const speck = w.speck ? `
        <feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="1" seed="${seed + 7}" result="sn"/>
        <feColorMatrix in="sn" type="matrix" values="0 0 0 0 0.42  0 0 0 0 0.27  0 0 0 0 0.12  ${(w.speck * 9).toFixed(2)} 0 0 0 ${(-w.speck * 9 * 0.74).toFixed(2)}" result="specks"/>
        <feComposite in="specks" in2="stained" operator="atop" result="stained2"/>` : '';
    return `
    <filter id="epi-wear-${level}-${variant}" x="-6%" y="-6%" width="112%" height="112%" color-interpolation-filters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="${w.freq}" numOctaves="4" seed="${seed}" result="edgeNoise"/>
        <feDisplacementMap in="SourceAlpha" in2="edgeNoise" scale="${w.edge}" xChannelSelector="R" yChannelSelector="G" result="mask"/>
        <feComposite in="SourceGraphic" in2="mask" operator="in" result="torn"/>
        <feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves="4" seed="${seed + 1}" result="stainNoise"/>
        <feColorMatrix in="stainNoise" type="matrix" values="0 0 0 0 0.58  0 0 0 0 0.43  0 0 0 0 0.22  ${sk.toFixed(2)} 0 0 0 ${(-sk * 0.55).toFixed(2)}" result="stains"/>
        <feComposite in="stains" in2="torn" operator="atop" result="stained"/>${speck}
        <feDropShadow dx="0" dy="5" stdDeviation="9" flood-color="#000" flood-opacity="${w.shadow}"/>
    </filter>`;
}

// 把滤镜定义放进页面（只放一次）
export function ensureWearFilters(doc = typeof document !== 'undefined' ? document : null) {
    if (!doc || doc.getElementById('epi-wear-filters')) return;
    const filters = [];
    for (let l = 1; l <= 3; l++) for (let v = 0; v < 3; v++) filters.push(wearFilter(l, v));
    const wrap = doc.createElement('div');
    wrap.innerHTML = `<svg id="epi-wear-filters" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true"><defs>${filters.join('')}</defs></svg>`;
    doc.body.appendChild(wrap.firstChild);
}

// 纸张背景层：放在信纸元素里的第一个位置。磨损为 0 时不需要
export function paperLayer(letter, seed = 0) {
    const a = letter.appearance || {};
    const level = Number(a.wear) || 0;
    if (!level) return '';
    const v = (seed >>> 0) % 3;
    return `<div class="epi-wear-layer paper-${a.paper || 'cream'}" style="filter:url(#epi-wear-${level}-${v})" aria-hidden="true"></div>`;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const DATE_LINE = /(\d{3,4}\s*年|\b1[5-9]\d\d\b|\b20\d\d\b)/;
const SALUTATION_END = /[,，:：!！]\s*$/;
const PS_START = /^(P\.?\s*-?\s*S\.?|PS|又及|附言|再启|再者)/i;

// 分析段落结构。返回 [{ lines: [{text, role}] , role }]
// role: dateline 日期行 | salutation 称呼 | signoff 结尾署名 | ps 附言 | body 正文
export function analyze(body) {
    // text：去掉格式标记后的字（判断称呼、署名用）；raw：原样（显示时按标记加格式）
    const paras = splitBody(body).map(p => ({ role: 'body', lines: p.split('\n').map(raw => ({ text: stripMarks(raw), raw, role: 'body' })) }));
    if (!paras.length) return paras;

    // 日期行：第一段的第一行，短，而且含年份
    const first = paras[0].lines[0];
    if (first && first.text.length <= 48 && DATE_LINE.test(first.text)) first.role = 'dateline';

    // 称呼：前三段里第一个“短、以逗号/冒号结尾”的行
    outer: for (const p of paras.slice(0, 3)) {
        for (const line of p.lines) {
            if (line.role !== 'body') continue;
            const t = line.text.trim();
            if (t && t.length <= 40 && SALUTATION_END.test(t)) { line.role = 'salutation'; break outer; }
            if (t.length > 40) break outer;
        }
    }

    // 附言
    for (const p of paras) if (PS_START.test(p.lines[0]?.text.trim() || '')) p.role = 'ps';

    // 结尾署名：跳过末尾的附言，最后一段如果很短，就是署名
    let i = paras.length - 1;
    while (i > 0 && paras[i].role === 'ps') i--;
    const last = paras[i];
    const total = last ? last.lines.reduce((n, l) => n + l.text.trim().length, 0) : 0;
    if (last && i > 0 && last.role === 'body' && total <= 40 && last.lines.every(l => l.role === 'body')) {
        last.role = 'signoff';
    }
    return paras;
}

// ================= 手写随机感 =================
// 电脑字体最大的破绽是每个字都一模一样。这里给每个字（中文）或每个词（英法文，手写体字母是连笔的，
// 按字母抖会把连笔拆断）加一点点旋转、上下浮动和墨色深浅。
// 用信件编号当种子：同一封信每次打开都一样，不会一刷新就变。

// 抖动程度：0 无 | 1 轻 | 2 中 | 3 重
export const WOBBLE_LABELS = { 0: '无', 1: '轻', 2: '中', 3: '重' };
// 各字迹没有单独设置时的默认程度
export const HAND_WOBBLE = { formal: 1, personal: 2, elegant: 1, casual: 3, typewriter: 2 };

const LEVELS = [
    { rot: 0, y: 0, sc: 0, ink: 0 },
    { rot: 0.7, y: 0.025, sc: 0.012, ink: 0.08 },
    { rot: 1.4, y: 0.045, sc: 0.022, ink: 0.13 },
    { rot: 2.4, y: 0.075, sc: 0.035, ink: 0.2 },
];

// 字符串 → 32 位整数种子
export function hashSeed(str) {
    let h = 2166136261 >>> 0;
    for (const ch of String(str)) {
        h ^= ch.codePointAt(0);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

// 可复现的随机数（mulberry32）
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯]/;
// 不能出现在行首的标点：跟着前一个字走；不能出现在行尾的：跟着后一个字走
const CLOSE_PUNCT = /[，。、；：？！”’）》」』】〕…—,.;:?!)\]]/;
const OPEN_PUNCT = /[“‘（《「『【〔(\[]/;
const FULLWIDTH = /[\u3000-\u303f\uff00-\uffef]/;

// 把一行文字切成“抖动单位”：中文一个字（连同紧挨的标点），外文一个词；空白原样保留
export function tokenize(text) {
    const out = [];
    const chars = Array.from(text);
    let i = 0;
    while (i < chars.length) {
        const c = chars[i];
        if (/\s/.test(c)) {
            let j = i;
            while (j < chars.length && /\s/.test(chars[j])) j++;
            out.push({ space: true, text: chars.slice(i, j).join('') });
            i = j;
            continue;
        }
        let tok = '';
        while (i < chars.length && OPEN_PUNCT.test(chars[i])) tok += chars[i++];
        if (i < chars.length && CJK.test(chars[i])) {
            tok += chars[i++];
        } else {
            while (i < chars.length && !/\s/.test(chars[i]) && !CJK.test(chars[i]) && !OPEN_PUNCT.test(chars[i]) && !FULLWIDTH.test(chars[i])) tok += chars[i++];
        }
        while (i < chars.length && CLOSE_PUNCT.test(chars[i])) tok += chars[i++];
        if (!tok) tok = chars[i++];
        out.push({ space: false, text: tok });
    }
    return out;
}

function wobbleLine(text, rand, level, hand, state) {
    const L = LEVELS[level] || LEVELS[0];
    const typewriter = hand === 'typewriter';
    const pen = !typewriter && hand !== 'casual';
    return tokenize(text).map(t => {
        if (t.space) return esc(t.text);
        const r = () => rand() * 2 - 1;
        let rot = typewriter ? r() * 0.25 : r() * L.rot;
        const y = r() * L.y;
        const sc = typewriter ? 0 : r() * L.sc;
        let ink = 1 - rand() * (typewriter ? L.ink * 2.6 : L.ink);
        // 蘸水笔：墨水越写越淡，过十来个字重新蘸一次
        if (pen) {
            state.n = (state.n || 0) + 1;
            if (!state.len || state.n > state.len) { state.n = 1; state.len = 9 + Math.floor(rand() * 10); }
            ink *= 1 - 0.16 * (state.n / state.len) * (level / 3 + 0.34);
        }
        ink = Math.max(0.45, Math.min(1, ink));
        const zh = CJK.test(t.text) ? ' zh' : '';
        return `<span class="j${zh}" style="--r:${rot.toFixed(2)}deg;--y:${y.toFixed(3)}em;--s:${(1 + sc).toFixed(3)};--o:${ink.toFixed(2)}">${esc(t.text)}</span>`;
    }).join('');
}

// 把连续的中日韩文字（连同中文标点）包进 <span class="zh">：外文信里夹着中文时，中文单独定字号
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef“”‘’]+/g;
// 一行字按格式标记切成几段：[{ text, flags: ['bold', 'strike'] }]，可以套着用
function inlineSegments(text, flags = []) {
    const t = String(text ?? '');
    const m = MARK_RE.exec(t);
    if (!m) return t ? [{ text: t, flags }] : [];
    const kind = MARKS[m[1]];
    return [
        ...(m.index ? [{ text: t.slice(0, m.index), flags }] : []),
        ...inlineSegments(m[2], flags.includes(kind) ? flags : [...flags, kind]),
        ...inlineSegments(t.slice(m.index + m[0].length), flags),
    ];
}

function markCjk(text) {
    let out = '';
    let last = 0;
    for (const m of String(text).matchAll(CJK_RUN)) {
        if (!CJK.test(m[0])) continue; // 只有标点没有字的，不算
        out += esc(text.slice(last, m.index)) + `<span class="zh">${esc(m[0])}</span>`;
        last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
}

/**
 * 正文 → HTML
 * @param {string} body
 * @param {object} [opts] { seed, wobble: 0..3, hand }
 */
export function renderBody(body, opts = {}) {
    const level = Math.max(0, Math.min(3, Number(opts.wobble) || 0));
    const rand = level ? rng(opts.seed ?? hashSeed(body)) : null;
    const state = {};
    return analyze(body).map(p => {
        const lines = p.lines.map(l => {
            const cls = l.role !== 'body' ? ` class="epi-l-${l.role}"` : '';
            const draw = t => (level ? wobbleLine(t, rand, level, opts.hand, state) : markCjk(t));
            const inner = inlineSegments(l.raw ?? l.text).map(seg => {
                const h = draw(seg.text);
                return seg.flags.length ? `<span class="epi-m ${seg.flags.map(f => `m-${f}`).join(' ')}">${h}</span>` : h;
            }).join('');
            return `<div${cls}>${inner || '&nbsp;'}</div>`;
        }).join('');
        return `<div class="epi-p epi-p-${p.role}">${lines}</div>`;
    }).join('');
}

// 这封信实际的抖动程度：信件自己设了就用信件的，否则用写信人档案的，再否则用字迹的默认值
export function effectiveWobble(letter, person) {
    const a = letter.appearance || {};
    if (a.wobble !== '' && a.wobble != null && !Number.isNaN(Number(a.wobble))) return Number(a.wobble);
    if (person && person.wobble !== '' && person.wobble != null) return Number(person.wobble);
    return HAND_WOBBLE[normalizeHand(a.font)] ?? 1;
}

export function renderOptions(letter, person, enabled = true) {
    return {
        seed: hashSeed(`${letter.id || ''}|${letter.author || ''}|${letter.writtenAt || ''}`),
        wobble: enabled ? effectiveWobble(letter, person) : 0,
        hand: normalizeHand((letter.appearance || {}).font),
    };
}
