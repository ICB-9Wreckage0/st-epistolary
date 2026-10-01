// 书信簿 · 随信附上的东西
// 信里夹带的钱、礼物、速写、照片、压花、剪报、另一封信……
// 每件东西单独记下：是什么、多少钱、什么样子。AI 读信时会知道信封里还有这些。

export const ENCLOSURE_KINDS = {
    money: { icon: '💰', label: '钱' },
    sketch: { icon: '✏️', label: '速写 / 画' },
    photo: { icon: '📷', label: '照片' },
    flower: { icon: '🌸', label: '压花 / 树叶' },
    gift: { icon: '🎁', label: '礼物 / 小物件' },
    document: { icon: '📄', label: '附页 / 剪报 / 票据' },
    letter: { icon: '✉️', label: '另一封信' },
    other: { icon: '📎', label: '其他' },
};

export function normalizeEnclosure(e = {}, i = 0) {
    if (typeof e === 'string') e = { name: e };
    return {
        id: String(e.id || `ENC${i + 1}`),
        kind: ENCLOSURE_KINDS[e.kind] ? e.kind : guessKind(e.name || ''),
        name: String(e.name || '').trim(),        // 是什么：五枚二十法郎金币
        value: String(e.value || '').trim(),      // 钱的数目：100 法郎（可选）
        desc: String(e.desc || '').trim(),        // 样子 / 细节：用亚麻布包着，压着信纸
        letterRef: String(e.letterRef || '').trim(), // 夹着的另一封信：信的编号或暗号
    };
}

// 新字段 enclosures；旧版本的 attachments（只有名字的字符串）也认
export function normalizeEnclosures(list, legacy) {
    const src = Array.isArray(list) && list.length ? list : (Array.isArray(legacy) ? legacy : []);
    return src.map(normalizeEnclosure).filter(e => e.name || e.letterRef);
}

const MONEY = /(\d[\d,.]*|[一二两三四五六七八九十百千万]+)\s*(法郎|francs?|英镑|镑|先令|便士|£|\$|美元|元|块|马克|盾|florins?|guilders?|卢布|lire|里拉|银元|大洋|铜板)|金币|银币|钞票|纸币|支票|汇票|cheque|check|banknote|billet|\b(francs?|pounds?|shillings?|pence|dollars?|marks?|guilders?|florins?|roubles?)\b/i;

export function guessKind(text) {
    const t = String(text || '');
    if (MONEY.test(t)) return 'money';
    if (/速写|素描|草图|画稿|小画|插画|sketch|croquis|dessin|drawing/i.test(t)) return 'sketch';
    if (/照片|相片|photo|photograph/i.test(t)) return 'photo';
    if (/压花|干花|花瓣|花|叶|标本|羽毛|flower|fleur|leaf|feuille|feather|plume/i.test(t)) return 'flower';
    if (/附页|清单|剪报|报纸|文章|合同|收据|票|单据|地图|名单|乐谱|clipping|receipt|ticket|map|list/i.test(t)) return 'document';
    if (/(另|一)封信|信件|letter|lettre/i.test(t)) return 'letter';
    if (/礼物|围巾|手帕|手套|书|糖|茶|戒指|项链|胸针|发带|丝带|钥匙|cadeau|gift|present/i.test(t)) return 'gift';
    return 'other';
}

function moneyValue(text) {
    const t = String(text || '');
    const m = t.match(/(\d[\d,.]*|[一二两三四五六七八九十百千万]+)\s*(法郎|francs?|英镑|镑|先令|便士|美元|元|块|马克|盾|florins?|guilders?|卢布|lire|里拉|银元|大洋)/i)
        || t.match(/([a-zà-ÿ-]+\s+)?(francs?|pounds?|shillings?|dollars?|marks?|guilders?|florins?|roubles?)\b/i);
    return m ? m[0].trim().replace(/\s+/g, ' ') : '';
}

// 从正文里找“随信附上……”
const ENCLOSE_RE = /(?:随信(?:附上|寄上|附寄|附去|奉上|夹着|附)|另(?:附|寄)|附上|附寄|附去|夹(?:着|了|上)|我把.{0,8}(?:夹|放)在信里)\s*([^，。；;！!？?\n]{1,40})|(?:I (?:enclose|am enclosing|send you)|enclosed (?:is|are|please find)|please find enclosed|ci-joint|ci-inclus|je (?:joins|vous envoie|t'envoie)|beigelegt|anbei)\s*([^,.;!?\n]{1,60})/gi;

export function extractEnclosures(body) {
    const out = [];
    const seen = new Set();
    const text = String(body || '');
    for (const m of text.matchAll(ENCLOSE_RE)) {
        let name = (m[1] || m[2] || '').trim().replace(/^了/, '').replace(/[，,、]$/, '');
        if (!name || name.length < 1) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        const kind = guessKind(name);
        out.push(normalizeEnclosure({ name, kind, value: kind === 'money' ? moneyValue(name) : '' }, out.length));
    }
    // 只提到“附页”这个词
    if (/附页/.test(text) && !out.some(e => /附页/.test(e.name))) out.push(normalizeEnclosure({ name: '附页', kind: 'document' }, out.length));
    return out;
}

export function enclosureText(e, { archive = null } = {}) {
    const k = ENCLOSURE_KINDS[e.kind] || ENCLOSURE_KINDS.other;
    let ref = '';
    if (e.kind === 'letter' && e.letterRef && archive) {
        const l = archive.letters[e.letterRef] || Object.values(archive.letters).find(x => x.code === e.letterRef);
        if (l) ref = `（${l.author} 写给 ${l.recipients.join('、')} 的信${l.code ? `，暗号 ${l.code}` : ''}）`;
    }
    const value = e.value && !e.name.includes(e.value) ? `，${e.value}` : '';
    return `${k.icon} ${e.name || k.label}${value}${ref}${e.desc ? `：${e.desc}` : ''}`;
}

// 给 AI 看的一行：信封里除了信纸还有什么
export function enclosuresForAI(letter, archive) {
    const list = letter.enclosures || [];
    if (!list.length) return '';
    return `随信附上的东西（拆信时会一起拿出来）：${list.map(e => enclosureText(e, { archive }).replace(/^\S+\s/, '')).join('；')}。`;
}

// 转交人隔着信封能感觉到什么
export function enclosureFeel(letter) {
    const list = letter.enclosures || [];
    if (!list.length) return '';
    if (list.some(e => e.kind === 'money' && /金币|银币|硬币|coin|pièce/i.test(e.name + e.desc))) return '信封沉甸甸的，捏得出里面有硬币一类的东西';
    if (list.some(e => e.kind === 'gift')) return '信封鼓鼓的，里面夹着信纸以外的东西';
    return '信封比一般的信厚一些，里面似乎还夹着别的东西';
}
