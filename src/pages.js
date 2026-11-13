// 书信簿 · 字数和换页
// 估一封信写了多少字（中文按字、外文按词，只算这封信的主要语言），要用几张信纸、单面还是正反面，
// 以及每一面从哪一行开始（阅读页用来画“第 2 张 · 背面”这样的分页线）。
// 按“行”来排：一行能写几个字、一面能写几行；称呼、署名这种短行也占一整行，段落之间空一行。

import { stripMarks } from './model.js';
import { analyze, SIZES } from './render.js';

const CJK = /[㐀-鿿豈-﫿　-〿＀-￯“”‘’…—·]/g;
const WORD = /[A-Za-zÀ-ɏЀ-ӿ]+(?:['’-][A-Za-zÀ-ɏЀ-ӿ]+)*/g;

// 一面纸的格局：每行几个字（中文）/ 几个词（外文），一面几行
const LAYOUT = {
    letter: { portrait: { zh: [20, 15], lat: [10, 22] }, landscape: { zh: [26, 11], lat: [13, 16] } },
    scrap: { zh: [16, 4], lat: [8, 4] },
    sticky: { zh: [8, 8], lat: [4, 8] },
    card: { zh: [12, 7], lat: [6, 8] },
    folded: { zh: [16, 12], lat: [8, 16] },
    grid: { zh: [22, 16], lat: [11, 16] }, // 横线稿纸
};

// 主要语言：汉字多就算中文，否则按外文的词
export function mainScript(text) {
    const t = stripMarks(String(text || ''));
    const zh = (t.match(/[㐀-鿿豈-﫿]/g) || []).length;
    const words = (t.match(WORD) || []).length;
    return zh >= words ? 'zh' : 'lat';
}

// 只算一种语言：中文算字（含中文标点），外文算词
export function countUnits(text, script = mainScript(text)) {
    const t = stripMarks(String(text || ''));
    return script === 'zh' ? (t.match(CJK) || []).length : (t.match(WORD) || []).length;
}

// 两种语言分开算：{ zh: 中文字数, lat: 外文词数 }
export function countByScript(text) {
    return { zh: countUnits(text, 'zh'), lat: countUnits(text, 'lat') };
}

// 外文叫什么：看信上填的语言
export function latName(language) {
    const s = String(language || '').toLowerCase();
    if (/法|fr/.test(s)) return '法语';
    if (/英|en/.test(s)) return '英语';
    if (/德|de/.test(s)) return '德语';
    if (/意|ital/.test(s)) return '意大利语';
    if (/西班牙|esp|spa/.test(s)) return '西班牙语';
    if (/俄|rus/.test(s)) return '俄语';
    if (/拉丁|latin/.test(s)) return '拉丁语';
    return '外文';
}

// 括号里的另一种语言（法文信里的“（中文译文）”）是给读的人看的注释，不算写在纸上的字
function dropGlosses(text, script) {
    return String(text || '').replace(/[（(]([^（）()\n]{1,4000})[）)]/g, (all, inner) => (mainScript(inner) !== script && countUnits(inner, mainScript(inner)) > 0 ? '' : all));
}

// 一行字在这张纸上占多少“格”：主要语言按格算，夹着的另一种语言大概折算一下
function lineUnits(text, script) {
    const t = stripMarks(String(text || ''));
    const zh = (t.match(CJK) || []).length;
    const words = (t.match(WORD) || []).length;
    const digits = (t.match(/[0-9]+/g) || []).length;
    return script === 'zh' ? zh + Math.ceil(words * 2) + digits : words + digits + Math.ceil(zh / 2);
}

// 这封信用的纸：每行几格、一面几行
// 这封信的主要语言：信上填了外语就按外文；没填就看括号外面的字（括号里多是译文）
export function letterScript(letter) {
    const lang = String(letter.language || '').toLowerCase();
    if (lang && !/中文显示|拟译|中文|汉/.test(lang) && /法|fr|英|en|德|de|意|ital|西班牙|esp|spa|俄|rus|拉丁|latin/.test(lang)) return 'lat';
    const outside = String(letter.body || '').replace(/[（(][^（）()\n]{1,4000}[）)]/g, '');
    return mainScript(outside.trim() ? outside : letter.body);
}

export function pageLayout(letter, { capZh = 0, capLat = 0 } = {}) {
    const a = letter.appearance || {};
    const script = letterScript(letter);
    let base;
    if (letter.kind === 'note') {
        const style = a.noteStyle === 'custom' ? a.noteBase || 'card' : a.noteStyle || 'scrap';
        base = (LAYOUT[style] || LAYOUT.scrap)[script];
    } else {
        base = LAYOUT.letter[a.orientation === 'landscape' ? 'landscape' : 'portrait'][script];
    }
    // 字写得大，一行、一面都写得少
    const scale = SIZES[a.size]?.scale || 1;
    const perLine = Math.max(2, Math.round(base[0] / scale));
    let lines = Math.max(2, Math.round(base[1] / scale));
    // 设置里自己填了“一面大约多少字 / 词”：按它算行数
    const cap = Number(script === 'zh' ? capZh : capLat) || 0;
    if (cap > 0) lines = Math.max(1, Math.round(cap / perLine));
    return { script, perLine, lines, perSide: perLine * lines };
}

// 排一遍：返回字数、几面、几张，以及每一面从哪一行开始
export function paginate(letter, opts = {}) {
    const layout = pageLayout(letter, opts);
    const duplex = !!letter.appearance?.duplex;
    const paras = analyze(dropGlosses(letter.body || '', layout.script));
    const breaks = []; // [{ p, l, side }]：第 side 面从第 p 段第 l 行开始
    let row = 0, side = 1;
    paras.forEach((para, pi) => {
        if (pi > 0) row += 1; // 段落之间空一行
        para.lines.forEach((line, li) => {
            let need = Math.max(1, Math.ceil(lineUnits(line.raw ?? line.text, layout.script) / layout.perLine));
            // 这一行在这一面写不下、换到下一面又写得下：整行挪到下一面（分页线画在这一行前面）
            if (row > 0 && row + need > layout.lines && need <= layout.lines) {
                side++;
                breaks.push({ p: pi, l: li, side });
                row = 0;
            }
            // 一段长到一面都写不下：接着写到下一面（分页线没法画在一行中间，只算面数）
            while (row + need > layout.lines) {
                need -= layout.lines - row;
                side++;
                row = 0;
            }
            row += need;
        });
    });
    const counts = countByScript(letter.body);
    const units = counts[layout.script];
    const sides = units ? side : 0;
    const sheets = duplex ? Math.ceil(sides / 2) : sides;
    return { ...layout, duplex, units, counts, latName: latName(letter.language), sides, sheets, breaks, unitName: layout.script === 'zh' ? '字' : '词' };
}

// 第几面 → “第 2 张 · 背面”
export function sideLabel(side, duplex) {
    if (!duplex) return `第 ${side} 张`;
    return `第 ${Math.ceil(side / 2)} 张 · ${side % 2 ? '正面' : '背面'}`;
}

// 一句话：给界面和 AI 用
// 字数：两种语言都有就分开写（主要语言在前），只有中文就照旧写“591 字”
export function countText(pg) {
    // 另一种语言只有零星几个（中文信里提了一个外文名字）就不单独列
    let zh = pg.counts?.zh || 0, lat = pg.counts?.lat || 0;
    if (pg.script === 'zh' && lat < 5) lat = 0;
    if (pg.script === 'lat' && zh < 5) zh = 0;
    const zhT = `${zh} 字`, latT = `${lat} 词`;
    if (zh && lat) return pg.script === 'zh' ? `中文 ${zhT} · ${pg.latName} ${latT}` : `${pg.latName} ${latT} · 中文 ${zhT}`;
    if (lat) return `${pg.latName} ${latT}`;
    return zhT;
}

export function pagesText(pg, { note = false } = {}) {
    if (!pg.units) return '';
    const paper = note ? '张' : '张信纸';
    const count = countText(pg);
    if (pg.sides <= 1) return `${count} · 一${note ? '张' : '张信纸'}${pg.duplex ? '（只写了正面）' : ''}`;
    if (pg.duplex) return `${count} · ${pg.sheets} ${paper}，正反面写了 ${pg.sides} 面`;
    return `${count} · ${pg.sheets} ${paper}（只写正面）`;
}
