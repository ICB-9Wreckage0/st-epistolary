// 书信簿 · 字数和换页
// 估一封信写了多少字（中文按字、外文按词，只算这封信的主要语言），要用几张信纸、单面还是正反面，
// 以及每一面从哪一行开始（阅读页用来画“第 2 张 · 背面”这样的分页线）。
// 按“行”来排：一行能写几个字、一面能写几行；称呼、署名这种短行也占一整行，段落之间空一行。

import { stripMarks, SHEETS } from './model.js';
import { analyze, SIZES } from './render.js';

const CJK = /[㐀-鿿豈-﫿　-〿＀-￯“”‘’…—·]/g;
const WORD = /[A-Za-zÀ-ɏЀ-ӿ]+(?:['’-][A-Za-zÀ-ɏЀ-ӿ]+)*/g;

// 一面纸的格局：每行几个字（中文）/ 几个词（外文），一面几行
const LAYOUT = {
    // 默认信纸：差不多一张手写的 A4（中文一面约 400 字、外文约 260 词）
    letter: { portrait: { zh: [20, 20], lat: [11, 24] }, landscape: { zh: [27, 15], lat: [14, 18] } },
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
    return script === 'zh' ? zh + Math.ceil(words * 2) + digits : words + digits; // 外文信里夹的中文是译文 / 注释，不占纸
}

// 这封信用的纸：每行几格、一面几行
// 这封信的主要语言：信上填了外语就按外文；没填就看括号外面的字（括号里多是译文）
export function letterScript(letter) {
    const lang = String(letter.language || '').toLowerCase();
    const foreign = /法|fr|英|en|德|de|意|ital|西班牙|esp|spa|俄|rus|拉丁|latin/.test(lang);
    if (lang && foreign && !/中文显示|拟译|中文|汉/.test(lang)) return 'lat';
    // “法语（中文显示）”：正文里真有一段段外文（原文 + 中文译文），纸上写的是外文；只有中文就按中文算
    if (foreign && countUnits(letter.body, 'lat') >= 20) return 'lat';
    const outside = String(letter.body || '').replace(/[（(][^（）()\n]{1,4000}[）)]/g, '');
    return mainScript(outside.trim() ? outside : letter.body);
}

// 按纸的实际大小排：中文一个字约 7.5 毫米宽、一行约 10 毫米高；外文一个词约 16 毫米宽、一行约 8.5 毫米；四边留白
const CELL = { zh: [7.5, 10], lat: [16, 8.5] };
const MARGIN = [18, 20]; // 左右各 18 毫米，上下各 20 毫米
function sheetBase(sheet, landscape, script) {
    let { w, h } = sheet;
    if (landscape) [w, h] = [h, w];
    const [cw, ch] = CELL[script];
    return [Math.floor((w - MARGIN[0] * 2) / cw), Math.floor((h - MARGIN[1] * 2) / ch)];
}

export function pageLayout(letter, { capZh = 0, capLat = 0 } = {}) {
    const a = letter.appearance || {};
    const script = letterScript(letter);
    const sheet = SHEETS[a.sheet] || SHEETS[''];
    let base;
    if (sheet.w) {
        // 选了纸张大小（A4、八开……）：按纸的尺寸算，信和纸条都一样
        base = sheetBase(sheet, a.orientation === 'landscape', script);
    } else if (letter.kind === 'note') {
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
    // 这封信自己填了“一面写多少字”（比如 400 字一张的稿纸）优先；没有再看设置里的通用值（只对默认信纸）
    const own = a.sheet === 'custom' ? Number(a.sheetCap) || 0 : 0;
    const cap = own || (!sheet.w ? Number(script === 'zh' ? capZh : capLat) || 0 : 0);
    if (cap > 0) lines = Math.max(1, Math.round(cap / perLine));
    return { script, perLine, lines, perSide: perLine * lines, ownCap: own || cap || 0, sheet: a.sheet || '', sheetLabel: a.sheet === 'custom' && own ? `${own} ${script === 'zh' ? '字' : '词'}一面的纸` : sheet.w ? sheet.label : '' };
}

// 一行是不是“译文 / 注释”：去掉括号里的另一种语言后，剩下的主要是另一种语言（或者什么都不剩）
function isGloss(raw, script) {
    const kept = dropGlosses(raw, script);
    const t = stripMarks(kept).trim();
    if (!t) return !!stripMarks(String(raw || '')).trim(); // 整行就是括号里的译文
    return mainScript(t) !== script && countUnits(t, mainScript(t)) > 0;
}

// 排一遍：返回字数、几面、几张，以及每一面从哪一行开始
// 按“格”连续往下排：主要语言的一行写满就换行；
// 中间夹着译文（“法文一句 / 中文译文一句”交替这种），译文不占纸，前后两句外文接着写在同一行，不另起一行、也不算新段落。
export function paginate(letter, opts = {}) {
    const layout = pageLayout(letter, opts);
    const { perLine, lines: rowsPerSide, script } = layout;
    const cap = perLine * rowsPerSide;
    const duplex = !!letter.appearance?.duplex;
    const paras = analyze(letter.body || ''); // 用原文分段，分页线才对得上阅读页
    const breaks = []; // [{ p, l, side }]：第 side 面从第 p 段第 l 行开始
    let pos = 0, side = 1, sideStart = 0; // pos：从第一面开头算起写到第几格
    let soft = false;     // 上一句外文后面跟的是译文：下一句接着写
    let lastPara = null;  // 上一行外文在第几段
    let any = false;
    const rowUp = () => { const r = pos - sideStart; if (r % perLine) pos += perLine - (r % perLine); };
    paras.forEach((para, pi) => {
        para.lines.forEach((line, li) => {
            const raw = line.raw ?? line.text;
            if (!stripMarks(String(raw || '')).trim()) return; // 空行
            if (isGloss(raw, script)) { if (any) soft = true; return; }
            const units = Math.max(1, lineUnits(dropGlosses(raw, script), script));
            if (any && !soft) {
                rowUp(); // 换行
                if (pi !== lastPara && pos > sideStart) pos += perLine; // 新段落前空一行（一面的开头不空）
            }
            // 到了这一面的底：下一面
            if (pos >= sideStart + cap) {
                side++; sideStart += cap; pos = sideStart;
                breaks.push({ p: pi, l: li, side });
            } else if (!soft || !any) {
                // 新起的一行写不下、换到下一面又写得下：整行挪过去
                const used = (pos - sideStart) / perLine;
                const need = Math.ceil(units / perLine);
                if (used > 0 && used + need > rowsPerSide && need <= rowsPerSide) {
                    side++; sideStart += cap; pos = sideStart;
                    breaks.push({ p: pi, l: li, side });
                }
            }
            pos += units;
            // 一段长到写过了这一面：接着写到下一面（分页线没法画在一行中间，只算面数）
            while (pos > sideStart + cap) { side++; sideStart += cap; }
            soft = false;
            lastPara = pi;
            any = true;
        });
    });
    const counts = countByScript(letter.body);
    const units = counts[script];
    const sides = units && any ? side : 0;
    const sheets = duplex ? Math.ceil(sides / 2) : sides;
    return { ...layout, duplex, units, counts, latName: latName(letter.language), sides, sheets, breaks, unitName: script === 'zh' ? '字' : '词' };
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
    // 选了纸张大小就说“张 A4 / 张八开”；自定义字数说“张纸”，括号里写一面约多少字
    const custom = pg.sheet === 'custom' && pg.sheetLabel;
    const paper = custom ? '张纸' : pg.sheetLabel ? `张 ${pg.sheetLabel}` : note ? '张' : '张信纸';
    const notes = custom ? [`一面约 ${pg.ownCap || pg.perSide} ${pg.unitName}`] : [];
    const count = countText(pg);
    const tail = extra => { const all = [...notes, ...extra]; return all.length ? `（${all.join('，')}）` : ''; };
    if (pg.sides <= 1) return `${count} · 一${paper}${tail(pg.duplex ? ['只写了正面'] : [])}`;
    if (pg.duplex) return `${count} · ${pg.sheets} ${paper}，正反面写了 ${pg.sides} 面${tail([])}`;
    return `${count} · ${pg.sheets} ${paper}${tail(['只写正面'])}`;
}
