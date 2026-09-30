// 书信簿 · 信件排版
// 把正文渲染成有段落的 HTML：识别日期行（右对齐）、称呼、结尾署名（右对齐），
// 可选把称呼和署名换成花体。阅读视图和信封动画共用。

import { splitBody } from './model.js';

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
    ].filter(Boolean).join(' ');
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
    const paras = splitBody(body).map(p => ({ role: 'body', lines: p.split('\n').map(text => ({ text, role: 'body' })) }));
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

export function renderBody(body) {
    return analyze(body).map(p => {
        const lines = p.lines.map(l => {
            const cls = l.role !== 'body' ? ` class="epi-l-${l.role}"` : '';
            return `<div${cls}>${esc(l.text) || '&nbsp;'}</div>`;
        }).join('');
        return `<div class="epi-p epi-p-${p.role}">${lines}</div>`;
    }).join('');
}
