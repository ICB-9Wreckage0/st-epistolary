// 书信簿 · 往来书信：收信反应、回信
// 纯函数，拼提示词、算日期。实际调用 AI 的部分在 index.js。

import { findPerson, sameName, segmentPosition, normalizeDate } from './model.js';
import { effectiveWobble, normalizeHand, INKS } from './render.js';
import { enclosuresForAI, enclosureFeel, ENCLOSURE_KINDS } from './enclosures.js';

// ---------- 日期 ----------

export function addDays(date, days) {
    const n = normalizeDate(date);
    if (!n || n.endsWith('-00')) return date || '';
    const [y, m, d] = n.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    const pad = x => String(x).padStart(2, '0');
    return `${String(dt.getUTCFullYear()).padStart(4, '0')}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DE_MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// 信头的“地点，日期”一行，按书信语言的习惯写
export function formatDateLine(lang, place, date) {
    const n = normalizeDate(date);
    let y, m, d;
    if (n) [y, m, d] = n.split('-').map(Number);
    const has = n && m && d;
    switch (lang) {
        case 'fr': return [place, has ? `le ${d === 1 ? '1er' : d} ${FR_MONTHS[m - 1]} ${y}` : date].filter(Boolean).join(', ');
        case 'en': return [place, has ? `${ordinal(d)} ${EN_MONTHS[m - 1]} ${y}` : date].filter(Boolean).join(', ');
        case 'de': return [place, has ? `den ${d}. ${DE_MONTHS[m - 1]} ${y}` : date].filter(Boolean).join(', ');
        default: return [place, has ? `${y}年${m}月${d}日` : date].filter(Boolean).join('，');
    }
}

// 从“语言”这一栏猜套语语言
export function guessLang(language) {
    const s = String(language || '').toLowerCase();
    if (/法|fr/.test(s)) return 'fr';
    if (/英|en/.test(s)) return 'en';
    if (/德|de/.test(s)) return 'de';
    return 'zh';
}

// ---------- 往来 ----------

// 两个人之间的往来信件（任一方向），按日期排序；可限定在某封信之前
export function threadBetween(archive, a, b, beforeId) {
    const before = beforeId ? archive.letters[beforeId] : null;
    return Object.values(archive.letters)
        .filter(l => l.id !== beforeId)
        .filter(l => {
            const aToB = sameName(archive, a, l.author) && l.recipients.some(r => sameName(archive, b, r));
            const bToA = sameName(archive, b, l.author) && l.recipients.some(r => sameName(archive, a, r));
            return aToB || bToA;
        })
        .filter(l => !before || !before.writtenAt || !l.writtenAt || l.writtenAt <= before.writtenAt)
        .sort((x, y) => (x.writtenAt || '').localeCompare(y.writtenAt || '') || x.id.localeCompare(y.id));
}

// 寄出一封信时自动生成的流转记录：写信人寄出，收件人收到并阅读
export function deliveryEvents(letter, arrivalDate, existing = [], { sentOnly = false } = {}) {
    let max = 0;
    for (const e of existing) {
        const n = parseInt(String(e.id).replace(/\D/g, ''), 10);
        if (n > max) max = n;
    }
    const id = () => `E${++max}`;
    const has = (type, who) => existing.some(e => e.type === type && e.who === who);
    const out = [];
    if (letter.author && !has('sent', letter.author)) {
        out.push({ id: id(), type: 'sent', who: letter.author, date: letter.writtenAt, segments: null, to: '', note: '' });
    }
    if (sentOnly) return out;
    for (const r of letter.recipients) {
        if (!has('received', r)) out.push({ id: id(), type: 'received', who: r, date: arrivalDate, segments: null, to: '', note: '' });
        if (!has('read', r)) out.push({ id: id(), type: 'read', who: r, date: arrivalDate, segments: null, to: '', note: '' });
    }
    return out;
}

// 某人收到某封信的日期（取最早的 received / read 事件）
export function arrivalOf(archive, letter, who) {
    const dates = letter.events
        .filter(e => (e.type === 'received' || e.type === 'read') && sameName(archive, who, e.who) && e.date)
        .map(e => e.date)
        .sort();
    return dates[0] || '';
}

// ---------- 文风 ----------

const SAMPLE_MAX = 700;
const SAMPLES_TOTAL = 2000;

function pickSamples(samples) {
    const out = [];
    let total = 0;
    // 打乱，免得每次都照着同一段写
    const pool = [...samples].sort(() => Math.random() - 0.5);
    for (const s of pool) {
        const t = s.length > SAMPLE_MAX ? s.slice(0, SAMPLE_MAX) + '……' : s;
        if (total + t.length > SAMPLES_TOTAL && out.length) break;
        out.push(t);
        total += t.length;
        if (out.length >= 3) break;
    }
    return out;
}

export function styleBlock(person, name) {
    const lines = [];
    if (!person) {
        lines.push(`（没有 ${name} 的文风档案。请根据你对这个人物的了解来写。）`);
        return lines.join('\n');
    }
    if (person.historical) {
        lines.push(`${name} 是真实存在过的历史人物。请参照 ${name} 现存书信${person.styleSource ? `（${person.styleSource}）` : ''}的口吻、句式、常用称呼与结尾、关心的话题和写信习惯来写。`);
        lines.push('如果不确定此人会不会这样说，宁可写得朴素，也不要编造“名言”或冒充真实信件里的原句。');
    }
    if (person.styleNotes.trim()) {
        lines.push('', '【文风要点】', person.styleNotes.trim());
    }
    const samples = pickSamples(person.styleSamples || []);
    if (samples.length) {
        lines.push('', `【${name} 书信片段，只用来模仿口吻和节奏，不要照抄其中的内容】`);
        samples.forEach((s, i) => lines.push(`— 片段 ${i + 1} —`, s));
    }
    return lines.join('\n');
}

// ---------- 语言 ----------

function languageInstruction(language) {
    const s = String(language || '').trim();
    if (!s) return '用和来信相同的语言写。';
    if (/中文显示|拟译|译文/.test(s)) {
        const orig = s.replace(/[（(].*?[)）]/g, '').trim();
        return `这些人实际上用${orig || '外语'}通信，但请用中文写出（相当于译文），保留${orig || '原语言'}书信的格式习惯（称呼、日期写法、结尾祝语），不要用中文特有的套语（如“见字如晤”“此致敬礼”）。`;
    }
    return `用${s}写。`;
}

const LENGTHS = {
    natural: '篇幅按此人平时写信的习惯。',
    short: '写得简短，像匆匆回的一封短信。',
    medium: '中等篇幅。',
    long: '写一封长信，可以分几天写完，带附言。',
};

// ---------- 回信提示词 ----------

function letterForPrompt(archive, l, { numbered = false, maxChars = 0 } = {}) {
    const head = `〔${l.id}｜${l.writtenAt || '日期不详'}｜${l.author || '？'} → ${l.recipients.join('、') || '？'}〕`;
    let body;
    if (numbered && l.segments.length) {
        body = l.segments.map(s => `§${segmentPosition(l, s.id)} ${s.text}`).join('\n\n');
    } else {
        body = l.body;
    }
    if (maxChars && body.length > maxChars) body = body.slice(0, maxChars) + '……（后略）';
    return `${head}\n${body}`;
}

/**
 * 生成回信用的提示词
 * @returns {{ system: string, prompt: string }}
 */
export function buildReplyPrompt(archive, letter, replier, opts = {}) {
    const { replyDate = '', length = 'natural', historyCount = 3, card = '', recentChat = '' } = opts;
    const original = letter.author;
    const person = findPerson(archive, replier);
    const received = arrivalOf(archive, letter, replier);

    // 往来：这封信之前的几封（给出上下文，但篇幅截短）
    const history = threadBetween(archive, replier, original, letter.id).slice(-historyCount);
    // 此人自己写过的其他信，作为“他本人的口吻”的参考（最多两封，截短）
    const ownLetters = Object.values(archive.letters)
        .filter(l => sameName(archive, replier, l.author) && l.id !== letter.id && !history.includes(l) && !l.aiDraft)
        .slice(-2);

    const system = `你是 ${replier}，正在亲笔给 ${original} 写回信。你只输出信件本身。`;

    const parts = [];
    parts.push(`${replier}${received ? `在 ${received}` : ''}收到了 ${original} 的来信，现在${replyDate ? `（${replyDate}）` : ''}要写回信。`);
    parts.push('');
    parts.push('【来信全文】（§编号只是给你看的段落号，回信里不要出现）');
    parts.push(letterForPrompt(archive, letter, { numbered: true }));

    if (history.length) {
        parts.push('', `【此前两人的往来，按时间顺序】`);
        history.forEach(l => parts.push(letterForPrompt(archive, l, { maxChars: 800 }), ''));
    }
    if (ownLetters.length) {
        parts.push('', `【${replier} 以前写给别人的信，可参考口吻】`);
        ownLetters.forEach(l => parts.push(letterForPrompt(archive, l, { maxChars: 600 }), ''));
    }

    if (card) parts.push('', `【${replier} 的角色设定】`, card);
    if (recentChat) parts.push('', '【最近发生的剧情（供参考，不要照抄）】', recentChat);
    parts.push('', '【文风】', styleBlock(person, replier));

    parts.push('', '【怎样写得像真的回信】');
    parts.push(
        '- 真实的人回信，不会逐条答复。先回应最打动自己、最要紧的一两件事，其余的一笔带过，或者干脆忘了回。',
        '- 会写自己这段时间的近况、烦恼和正在做的事，不只围着对方的信转。',
        '- 会提起来信里的具体说法（比如“你说……”“你信里提到……”），也可能误解、追问或反驳。',
        '- 来信里的问题，愿意回答的就回答，不想回答的可以回避或岔开。',
        `- ${replier} 只知道自己经历过的事和信里写到的事，不知道之后会发生什么。`,
        '- 遵守当时的书信格式：地点和日期、称呼、正文、结尾祝语、署名，需要时加附言。',
        `- ${LENGTHS[length] || LENGTHS.natural}`,
        `- ${languageInstruction(letter.language || person?.language)}`,
    );
    if (replyDate) parts.push(`- 信头日期写 ${replyDate}（按书信语言的习惯写法）。`);
    parts.push('', '只输出信件正文，从信头或称呼开始，到署名（及附言）结束。不要写任何说明、标题、引号或代码块。');

    return { system, prompt: parts.join('\n') };
}

// AI 回复里偶尔会带上引号、代码块或“以下是回信：”之类的话，清理掉
export function cleanReply(text) {
    let t = String(text || '').trim();
    t = t.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
    t = t.replace(/^(以下是|这是|好的[，,]?)[^\n]{0,20}(回信|信件|信)[:：]?\s*\n+/, '');
    t = t.replace(/^[“"「]([\s\S]*)[”"」]$/, '$1');
    return t.trim();
}

// ---------- 收信反应 ----------

/**
 * 角色收到信、读信时注入给 AI 的引导
 */
export function buildReactionGuidance(archive, letter, reader, arrival, extra = {}) {
    const person = findPerson(archive, reader);
    const lines = [];
    const dv = letter.delivery || {};
    const intended = (letter.recipients || []).join('、');
    if (extra.peek) {
        // 转交人拆开了托他转交的信
        lines.push(`【拆信】${arrival ? `${arrival}，` : ''}${reader} 拆开了这封本来要转交给 ${intended} 的信（${letter.author || '某人'} 写的，信的全文就是上一条消息）。`);
        lines.push(`请描写 ${reader} 读这封不是写给自己的信的过程和反应：`);
        lines.push(
            `- 为什么拆、拆的时候的心情（好奇、担心、犹豫、心虚、理所当然……），读到具体的句子时的反应。`,
            `- 读完以后打算怎么办：照样转交（要不要把封口弄回原样）、先压着、还是不交了。符合 ${reader} 的性格和与这几个人的关系。`,
            `- ${reader} 只知道信里写到的内容和自己本来就知道的事。不要复述整封信。`,
        );
        if (person?.historical) lines.push(`- ${reader} 是真实历史人物，反应要符合此人在这个时期的真实状况和性格。`);
        if (letter.enclosures?.length) lines.push(enclosuresForAI(letter, archive));
        if (extra.look) lines.push(...lookLines(archive, letter, { envelope: false }));
        return lines.join('\n');
    }
    lines.push(`【收信】${arrival ? `${arrival}，` : ''}${reader} 收到了 ${letter.author || '某人'} 寄来的信（信的全文就是上一条消息）。`);
    if (dv.via) {
        let how = '';
        if (dv.openly) how = `${dv.via} 拆阅过这封信，而且没有隐瞒，信封上看得出来${dv.viaNote ? `，还写着：「${dv.viaNote}」` : ''}。`;
        else if (dv.tampered) how = `信封的封口有被拆开过、又粘回去的痕迹，${reader} 可能注意到，也可能没注意到。`;
        else if (dv.viaNote) how = `${dv.via} 在信封上写着：「${dv.viaNote}」。`;
        lines.push(`这封信是托 ${dv.via} 转交的。${how}`);
    }
    lines.push(`请描写 ${reader} 收信和读信的过程，以及真实的反应：`);
    lines.push(
        `- 收信时的情境：当时在哪里、在做什么，信是怎么到手上的，拆信、读信的样子。`,
        `- 对信里具体的句子和段落有反应，而不是笼统地“很感动”。可以停在某一句上反复看，可以皱眉、失笑、读不下去、或者跳着读。`,
        `- 反应要符合 ${reader} 的性格、当时的处境、心情，以及和写信人的关系。也可能误解信里的意思。`,
        `- ${reader} 只知道信里写到的内容和自己本来就知道的事。`,
        `- 不要复述整封信。不要马上写出完整的回信；可以想到要不要回、想回些什么，或者放下信去做别的事。`,
    );
    if (person?.historical) {
        lines.push(`- ${reader} 是真实历史人物，反应、想法和说话方式要符合此人在这个时期的真实状况和性格。`);
    }
    if (letter.enclosures?.length) lines.push(`${enclosuresForAI(letter, archive)}收信人会注意到它们，可以对它们有反应。`);
    if (extra.look) lines.push(...lookLines(archive, letter));
    return lines.join('\n');
}

// 发到聊天里的“寄出的信”那条消息
// 镜头切到收信人那边：作为一段旁白发进聊天，后面跟着信的全文
export function sceneSwitchMessage(letter, reader, arrival, { body = true } = {}) {
    const where = letter.placeTo ? `${letter.placeTo}，` : '';
    const when = arrival ? `${arrival}。` : '';
    const via = letter.delivery?.via ? `经 ${letter.delivery.via} 转交，` : '';
    const line = `*（镜头切到${where}${when}${via}${reader || '收信人'}收到了${letter.author ? ` ${letter.author} 的` : '一封'}来信。）*`;
    return body ? `${line}\n\n${letter.body}` : line;
}

// ---------- 托人转交 ----------

// 镜头切到转交人那边：只有信封，没有内容
export function viaSceneMessage(letter, via, arrival) {
    const when = arrival ? `${arrival}，` : '';
    const to = (letter.recipients || []).join('、') || '某人';
    return `*（镜头切到${via}那边。${when}${via}收到了一封${letter.author ? ` ${letter.author} ` : ''}托人带来、请${via}转交的信。信封上写着“${to} 收”，封口封得好好的。）*`;
}

// 正文：转交人拆开以后，信的全文
export function viaPeekMessage(letter, via) {
    return `*（${via}拆开了信封。）*\n\n${letter.body}`;
}

export function buildViaGuidance(archive, letter, via, arrival, { look = false } = {}) {
    const person = findPerson(archive, via);
    const to = (letter.recipients || []).join('、') || '收信人';
    const lines = [
        `【转交】${arrival ? `${arrival}，` : ''}${via} 收到一封 ${letter.author || '某人'} 托${via}转交给 ${to} 的信。信是封着的，${via} 不知道里面写了什么。`,
        `请按 ${via} 的性格、处境、和 ${letter.author || '写信人'}、${to} 的关系，描写${via}拿到这封信以后怎么做：`,
        `- 可以照常转交（马上去送，或者等方便的时候）、先压着不急着给、犹豫要不要拆开看、偷偷拆开、或者干脆不交了。由 ${via} 自己决定。`,
        `- 如果 ${via} 决定拆开看，只写到拆开信封、展开信纸为止。**不要编造信的内容**，信的原文会在下一条消息里给出。`,
        `- 不要替 ${to} 写任何反应，${to} 现在还没拿到信。`,
    ];
    if (person?.historical) lines.push(`- ${via} 是真实历史人物，做法要符合此人在这个时期的真实状况和性格。`);
    if (look) lines.push(...lookLines(archive, letter, { paper: false }));
    else if (enclosureFeel(letter)) lines.push(`信封：${enclosureFeel(letter)}。`);
    return lines.join('\n');
}

export const VIA_ACTIONS = { forward: '转交', later: '先留着', withhold: '不转交' };

// 让 AI 从转交人那一段剧情里判断：拆没拆、打算怎么办
// letters：同一个转交人手里的几封信 [{ n, recipient, label, target, opened, held }]
export function buildViaDecisionPrompt(via, letters, text) {
    const system = '你是剧情记录员，只输出 JSON。';
    const list = letters.map(l => `#${l.n}：给 ${l.recipient}${l.label ? `，信封上写着「${l.label}」` : ''}${l.target ? `，该在 ${l.target} 前送到` : ''}${l.opened ? '（之前已经拆开读过）' : ''}${l.held ? '（之前决定先留着）' : ''}`).join('\n');
    const prompt = `下面是一段角色扮演的最近剧情（可能包括角色的思考过程）。${via} 手里有${letters.length > 1 ? ` ${letters.length} 封` : '一封'}别人托 TA 转交的信：
${list}

请根据剧情，**逐封**判断 ${via} 对每封信做了什么。剧情只动了其中一封的话，其他几封照旧（opened 保持原样，action 写 unclear）。分不清剧情说的是哪一封时，按信封上的字、日期、顺序来对。
- opened：有没有拆开这封信（拆开、划开、偷看都算；只是隔着信封对光看、摸厚度不算）
- action：forward（转交：已经寄出、交给送信人、亲手送去，或者已经准备好要送——重新封好、在信封上写了给收信人的话、放进要寄的信里——都算）| later（先压着、放回抽屉、等某个日子再说）| withhold（不交了、扣下、烧掉、退回）| unclear（剧情里看不出来）
- resealed：拆开过的话，有没有把封口弄回原样、让人看不出被拆过
- openly：拆开过的话，是不是光明正大、不打算隐瞒（有写信人授权、在信封上注明拆阅过、换上自己的火漆印）
- envelopeNote：在信封上写的字或附上的字条（照原文抄），没有就空字符串
- note：一句中文概括

只输出 JSON 数组，每封一项，例如：
[{"n": 1, "opened": true, "resealed": false, "openly": true, "action": "forward", "envelopeNote": "已由 T. 拆阅核验。", "note": "拆阅后换上自己的火漆，准备转交"}]

【剧情】
${text}`;
    return { system, prompt };
}

function oneDecision(j) {
    const action = ['forward', 'later', 'withhold'].includes(j.action) ? j.action : 'unclear';
    return {
        n: Number(j.n) || 1,
        opened: !!j.opened, resealed: !!j.resealed, openly: !!j.openly, action,
        envelopeNote: String(j.envelopeNote || '').slice(0, 300),
        note: String(j.note || '').slice(0, 80),
    };
}

// 返回第一封的判断（只有一封信时用）
export function parseViaDecision(text) {
    return parseViaDecisions(text)[0] || null;
}

// 返回每封信的判断
export function parseViaDecisions(text) {
    const t = String(text || '');
    const arr = t.match(/\[[\s\S]*\]/);
    if (arr) {
        try {
            const j = JSON.parse(arr[0]);
            if (Array.isArray(j)) return j.filter(x => x && typeof x === 'object').map(oneDecision);
        } catch { /* 试试单个对象 */ }
    }
    const obj = t.match(/\{[\s\S]*\}/);
    if (!obj) return [];
    try { return [oneDecision(JSON.parse(obj[0]))]; } catch { return []; }
}

// 转交人收到：只知道有这封信
export function viaReceivedEvents(letter, via, date, existing = []) {
    const out = [];
    let max = 0;
    for (const e of existing) { const n = parseInt(String(e.id).replace(/\D/g, ''), 10); if (n > max) max = n; }
    if (!existing.some(e => e.type === 'sent' && e.who === letter.author)) {
        out.push({ id: `E${++max}`, type: 'sent', who: letter.author, date: letter.writtenAt, segments: null, to: via, note: `托 ${via} 转交` });
    }
    out.push({ id: `E${++max}`, type: 'received', who: via, date, segments: null, to: '', note: '代为转交' });
    return out;
}

export function nextEventId(existing) {
    let max = 0;
    for (const e of existing) { const n = parseInt(String(e.id).replace(/\D/g, ''), 10); if (n > max) max = n; }
    return `E${max + 1}`;
}

export function sceneReturnMessage(letter) {
    const where = letter.placeFrom ? `${letter.placeFrom}，` : '';
    return `*（镜头回到${where}${letter.author || '写信人'}这边。）*`;
}

export function letterChatMessage(letter, reader, arrival) {
    const head = `（${arrival ? `${arrival}，` : ''}${reader || '收件人'}收到了${letter.author ? ` ${letter.author} 的` : '一封'}来信。）`;
    return `${head}\n\n${letter.body}`;
}

export function replyChatMessage(letter) {
    return `（${letter.author} 的回信${letter.writtenAt ? `，写于 ${letter.writtenAt}` : ''}）\n\n${letter.body}`;
}

// ---------- 示例文风档案 ----------
// 由本插件作者根据梵高书信的公认特点概括写成，不含书信原文。样本请用户自行添加。

export const EXAMPLE_PROFILES = {
    vangogh: {
        name: '文森特·梵高',
        aliases: ['文森特', '梵高', 'Vincent', 'Vincent van Gogh'],
        historical: true,
        styleSource: '梵高书信（致提奥等人，1872–1890）',
        language: '',
        styleNotes: [
            '- 写给弟弟提奥的信最多，也最亲密直接，开头常是“亲爱的提奥”；结尾常说“紧握你的手”，署名通常只写“文森特”，有时写 t. à t.（tout à toi，全心属于你的）。',
            '- 信往往很长，一封信可能分几次写完，常有附言，还常在信里夹着或画着速写，并解释画的是什么。',
            '- 谈画时非常具体：直接写颜料和颜色的名字（铬黄、普鲁士蓝、翡翠绿、朱红），描述构图、笔触、光线，说自己正在画什么、打算画什么。',
            '- 常谈读过的书（左拉、狄更斯、莫泊桑、《圣经》、雨果）和敬重的画家（米勒、德拉克洛瓦、伦勃朗、蒙蒂塞利、日本版画）。',
            '- 坦率谈钱、颜料开销、房租、吃饭和身体，也谈情绪低落，但往往接着讲工作能让自己站稳；对提奥充满感激，也常关心提奥的健康和生活。',
            '- 对自然、农民和劳动者有很深的感情；语气热切真诚，喜欢长句和连续的比喻，早年宗教经历留下的措辞偶尔出现。',
            '- 写给不同的人口吻不同：给提奥最亲密；给贝尔纳、高更多谈艺术主张；给母亲和妹妹更温和、家常。',
        ].join('\n'),
        styleSamples: [],
    },
};


// ---------- 翻译 ----------

export const TRANSLATE_TARGETS = {
    fr: '法语', en: '英语', de: '德语', it: '意大利语', es: '西班牙语', ru: '俄语', nl: '荷兰语', ja: '日语', zh: '中文',
};

export const TRANSLATE_STYLES = {
    period: '按写信年代的书信体',
    modern: '现代自然的说法',
    keep: '尽量保持原文的语气和句式',
};

export function buildTranslatePrompt(letter, target, style = 'period') {
    const year = String(letter.writtenAt || '').match(/\d{3,4}/)?.[0] || '';
    const system = '你是一位精通多国语言和书信传统的翻译。只输出译文本身。';
    const styleText = {
        period: `译文要像${year ? `${year} 年前后` : '写信那个年代'}的人用${target}亲笔写的信：用当时${target}书信的称呼、日期写法、客套语和结尾祝语，避免现代说法和网络用语。`,
        modern: `译文用现代、自然的${target}。`,
        keep: `尽量保留原文的语气、句式和用词的分寸，不要添加或删减内容。`,
    }[style] || '';
    const prompt = `把下面这封信翻译成${target}。

要求：
- ${styleText}
- 保持原来的分段：原文空一行的地方，译文也空一行；段落数量一致。
- 人名、地名按${target}的习惯写法。原文里的日期行、称呼、署名、附言都要翻译并放在对应位置。
- 写信人：${letter.author || '未知'}；收信人：${(Array.isArray(letter.recipients) ? letter.recipients.join('、') : String(letter.recipients || '')) || '未知'}${letter.writtenAt ? `；写信日期：${letter.writtenAt}` : ''}。
- 只输出译文，不要任何说明、标题、引号或代码块。

【原文】
${letter.body}`;
    return { system, prompt };
}

// ---------- 推算剧情日期 ----------

export function buildDatePrompt(recentText, currentDate) {
    const system = '你是角色扮演的剧情记录员，负责记录故事里的日期。只输出日期。';
    const prompt = `下面是一段角色扮演的最近对话。${currentDate ? `上一次记录的剧情日期是 ${currentDate}。` : ''}
请判断现在故事里是哪一天。

规则：
- 只根据对话里的线索（明确写出的日期、“第二天”“过了一周”“三天后”之类的时间推移、季节变化）来推算。
- 没有时间推移的线索，就原样输出上一次的日期。
- 只输出一个日期，格式 YYYY-MM-DD，不要别的文字。

【最近的对话】
${recentText}`;
    return { system, prompt };
}

// 从 AI 的回答里取出日期；早于上一次的日期（倒叙、回忆）不采用
export function parseStoryDate(text, currentDate) {
    const m = String(text || '').match(/(\d{3,4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if (!m) return null;
    const d = `${m[1].padStart(4, '0')}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    const mo = Number(m[2]), da = Number(m[3]);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    if (currentDate && /^\d{4}-\d{2}-\d{2}$/.test(currentDate) && d < currentDate) return null;
    return d;
}

// ---------- 自动填写信头 ----------

export const HEAD_FIELDS = ['author', 'recipients', 'writtenAt', 'placeFrom', 'placeTo', 'language'];

// 不用 AI 就能猜的：沿用两人之前通信的地点和语言
export function guessHeadFromThread(archive, author, recipient) {
    if (!author || !recipient) return {};
    const t = threadBetween(archive, author, recipient);
    const last = t[t.length - 1];
    if (!last) return {};
    const same = sameName(archive, author, last.author);
    return {
        placeFrom: same ? last.placeFrom : last.placeTo,
        placeTo: same ? last.placeTo : last.placeFrom,
        language: last.language,
    };
}

// 让 AI 根据剧情和信的正文填信头，并估算路上要走几天
export function buildFillPrompt({ draft, userName, charName, storyDate, recentChat, people = [], thread = [] }) {
    const system = '你是书信档案的整理员，根据角色扮演的剧情填写信件的信头。只输出 JSON。';
    const cur = HEAD_FIELDS.map(k => `${k}: ${Array.isArray(draft[k]) ? draft[k].join('、') : (draft[k] || '（空）')}`).join('\n');
    const prompt = `请根据下面的信息，推断这封信的信头。

【用户扮演的角色】${userName || '（未知）'}
【当前聊天的角色】${charName || '（未知）'}
【当前剧情日期】${storyDate || '（未知）'}
【档案里已有的人物】${people.length ? people.join('、') : '（无）'}
${thread.length ? `【两人之前的通信】\n${thread.join('\n')}\n` : ''}
【最近的剧情】
${recentChat || '（无）'}

【信的正文】
${draft.body?.trim() || '（还没写）'}

【现在已填的信头】
${cur}

要求：
- author 写信人、recipients 收信人（数组）。正文里的称呼和署名最可信；没写的话，通常是用户的角色写给当前聊天的角色。
- writtenAt 写信日期，格式 YYYY-MM-DD。正文日期行 > 剧情里提到的日期 > 当前剧情日期。实在不知道就留空字符串。
- placeFrom 寄出地、placeTo 寄往地：写信人和收信人此刻所在的地方，用剧情里的地名，尽量具体到城市或地点。
- language 两人实际用什么语言通信，如“法语”“英语”；如果是用中文写出来、但人物之间其实说外语，写成“法语（中文显示）”；就是中文写空字符串。
- travelDays：按故事的时代、两地距离和交通方式，估计这封信路上要走几天（整数）。同城当天或一两天，跨国一周左右，跨洋两三周以上。
- enclosures：信里或剧情里提到随信附上、夹在信里的东西（钱、礼物、速写、照片、压花、附页、另一封信……），数组，每项 {"kind": "money|sketch|photo|flower|gift|document|letter|other", "name": "是什么", "value": "钱的数目，不是钱就空"}。没有就空数组。
- 推断不出的字段留空字符串，不要编造。

只输出一行 JSON，例如：
{"author":"E.","recipients":["文森特"],"writtenAt":"1889-06-10","placeFrom":"巴黎","placeTo":"圣雷米","language":"法语（中文显示）","travelDays":3,"enclosures":[{"kind":"money","name":"五枚二十法郎金币","value":"100 法郎"}],"note":"一句话说明依据"}`;
    return { system, prompt };
}

export function parseFill(text) {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    let j;
    try { j = JSON.parse(m[0]); } catch { return null; }
    const str = v => (typeof v === 'string' ? v.trim() : '');
    const out = {};
    if (str(j.author)) out.author = str(j.author);
    const rs = Array.isArray(j.recipients) ? j.recipients.map(str).filter(Boolean) : str(j.recipients) ? str(j.recipients).split(/[,，、]/).map(s => s.trim()).filter(Boolean) : [];
    if (rs.length) out.recipients = rs;
    const d = str(j.writtenAt);
    if (d && /^\d{1,4}-\d{1,2}(-\d{1,2})?$/.test(d)) out.writtenAt = d;
    for (const k of ['placeFrom', 'placeTo', 'language']) if (str(j[k])) out[k] = str(j[k]);
    const n = parseInt(j.travelDays, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 365) out.travelDays = n;
    if (str(j.note)) out.note = str(j.note).slice(0, 120);
    if (Array.isArray(j.enclosures)) {
        out.enclosures = j.enclosures.filter(e => e && typeof e === 'object' && str(e.name)).slice(0, 12)
            .map(e => ({ kind: ENCLOSURE_KINDS[e.kind] ? e.kind : 'other', name: str(e.name), value: str(e.value) }));
    }
    return out;
}

// ---------- 信的样子：读信的人看得见、摸得着的东西 ----------

const LOOK_PAPER = { plain: '素白的信纸', cream: '奶油色的棉纸', aged: '泛黄的旧纸', lined: '印着横格的信笺', redline: '红色竖格的信笺', blue: '薄薄的淡蓝航空信纸' };
const LOOK_WEAR = { 1: '纸边有点毛', 2: '纸已经旧了，有折痕和淡淡的污渍', 3: '纸边磨损破损，污渍明显' };
const LOOK_HAND = { formal: '字迹端正工整', personal: '是平常的手写字', elegant: '字写得讲究、优雅', casual: '字写得潦草随意，像是匆匆写就', typewriter: '是用打字机打出来的' };
const LOOK_WOBBLE = { 3: '，笔画发抖、歪歪斜斜' };
const LOOK_SIZE = { sm: '字写得很小、很密', lg: '字写得比较大', xl: '字写得很大，一行只有几个字' };
const LOOK_ENVELOPE = { ivory: '象牙白的信封', kraft: '牛皮纸信封', blue: '淡蓝色的信封', white: '白信封', airmail: '红蓝斜纹边的航空信封' };
const LOOK_WAX = { crimson: '朱红色火漆', navy: '藏青色火漆', forest: '墨绿色火漆', black: '黑色火漆', gold: '金色火漆', chop: '朱红的“缄”字印' };

// 信封（转交人和收信人拆信前都看得到）
export function describeEnvelope(letter) {
    const a = letter.appearance || {};
    const env = LOOK_ENVELOPE[a.envelope] || '信封';
    const seal = a.wax === 'none' ? '用胶水封着口' : `封口压着${LOOK_WAX[a.wax] || '火漆'}`;
    const feel = enclosureFeel(letter);
    const thick = feel ? `，${feel}` : (letter.body || '').length > 1500 ? '，摸上去很厚' : '';
    return `${env}，${seal}${thick}`;
}

// 信纸、墨水、字迹（拆开以后才看得到）
export function describeAppearance(letter, person) {
    const a = letter.appearance || {};
    const parts = [];
    const fold = a.orientation === 'landscape' ? '平放在信封里' : '对折了一次';
    parts.push(`${LOOK_PAPER[a.paper] || '信纸'}，${fold}${LOOK_WEAR[a.wear] ? `，${LOOK_WEAR[a.wear]}` : ''}`);
    const hand = normalizeHand(a.font);
    const ink = a.ink === 'custom' ? '' : a.ink === 'faded' ? '墨色已经褪成了褐色' : INKS[a.ink] ? `用${INKS[a.ink].label}墨水写的` : '';
    const wobble = hand === 'typewriter' ? '' : (LOOK_WOBBLE[effectiveWobble(letter, person)] || '');
    parts.push([hand === 'typewriter' ? '' : ink, LOOK_HAND[hand] + wobble].filter(Boolean).join('，'));
    if (LOOK_SIZE[a.size] && hand !== 'typewriter') parts.push(LOOK_SIZE[a.size]);
    if (a.flourish && hand !== 'typewriter') parts.push('称呼和署名写成了花体');
    return parts.join('；');
}

export function lookLines(archive, letter, { envelope = true, paper = true } = {}) {
    const lines = [];
    if (envelope) lines.push(`信封：${describeEnvelope(letter)}。`);
    if (paper) lines.push(`信纸：${describeAppearance(letter, findPerson(archive, letter.author))}。`);
    if (lines.length) lines.push('这些是读信的人看得见、摸得着的东西，可以自然地带到一两处（比如字迹透露出写信人的状态），不用逐条描写。');
    return lines;
}

// ---------- 从剧情（包括 AI 的思考过程）里发现“信到了” ----------

const CN_DIGITS = '〇一二三四五六七八九';

function cnNumber(n) {
    if (n < 10) return CN_DIGITS[n];
    if (n < 20) return '十' + (n % 10 ? CN_DIGITS[n % 10] : '');
    return CN_DIGITS[Math.floor(n / 10)] + '十' + (n % 10 ? CN_DIGITS[n % 10] : '');
}

// 一个日期在文字里可能的写法
export function dateMentions(date) {
    const n = normalizeDate(date);
    if (!n || n.endsWith('-00')) return [];
    const [y, m, d] = n.split('-').map(Number);
    return [
        n, `${y}/${m}/${d}`, `${y}.${m}.${d}`,
        `${m}月${d}日`, `${m}月${d}号`, `${String(m).padStart(2, '0')}月${String(d).padStart(2, '0')}日`,
        `${cnNumber(m)}月${cnNumber(d)}日`, `${cnNumber(m)}月${cnNumber(d)}号`,
        `${d} ${EN_MONTHS[m - 1]}`, `${EN_MONTHS[m - 1]} ${d}`, `${d} ${FR_MONTHS[m - 1]}`, `${d}er ${FR_MONTHS[m - 1]}`,
    ];
}

export function mentionsDate(text, date) {
    const t = String(text || '').toLowerCase();
    return dateMentions(date).some(s => {
        const i = t.indexOf(s.toLowerCase());
        if (i < 0) return false;
        // “6月1日”不能匹配进“6月13日”里：后面紧跟的不能是数字
        const next = t[i + s.length];
        const prev = t[i - 1];
        return !(next && /\d/.test(next)) && !(prev && /\d/.test(prev) && /^\d/.test(s));
    });
}

export function mentionsName(text, names) {
    const t = String(text || '').toLowerCase();
    return names.some(n => n && t.includes(String(n).toLowerCase()));
}

// “收到信”的说法
export const RECEIPT_RE = /收到.{0,12}信|来信|信(?:送)?到了|信送到|送来.{0,6}信|拆(?:开)?.{0,8}信|读.{0,4}信|信封|收信|信件|(?:received?|opens?|opened|reads?)\b.{0,30}\bletter|\bletter\b.{0,20}\b(?:arrived?|came)|lettre/i;
// 转交人有没有在动这封信
export const LETTER_RE = /信|letter|lettre|envelope|enveloppe/i;

export function mentionsReceipt(text, names) {
    return mentionsName(text, names) && RECEIPT_RE.test(String(text || ''));
}

// 每次生成前提醒 AI：哪些信已经送到但还没读、哪些信压在转交人手里。防止 AI 自己编信的内容。
export function buildPendingHints({ arrived = [], atVia = [], storyDate = '' }) {
    const lines = [];
    for (const l of arrived) {
        const dv = l.delivery || {};
        lines.push(`- ${dv.reader || l.recipients[0]} 已经收到 ${l.author} 的来信${dv.arrivedAt ? `（${dv.arrivedAt} 送到）` : ''}，还没在剧情里拆开读。`);
    }
    for (const l of atVia) {
        const dv = l.delivery || {};
        const late = dv.viaDeadline && storyDate && normalizeDate(storyDate) > normalizeDate(dv.viaDeadline);
        const state = dv.status === 'held' ? '先压着没交' : dv.opened ? '已经拆开看过' : '信是封着的，不知道内容';
        lines.push(`- ${dv.via} 手里有一封 ${l.author} 托 TA 转交给 ${l.recipients.join('、')} 的信（${state}）。${dv.viaDeadline ? (late ? `本该在 ${dv.viaDeadline} 前转交出去，已经耽搁了。` : `要在 ${dv.viaDeadline} 前转交出去，收信人才能按时收到。`) : ''}`);
    }
    if (!lines.length) return '';
    return ['【未读的信】', ...lines, '如果剧情写到有人拆开、阅读这些信，只写到拆开信封、展开信纸为止，不要编造信的内容，信的原文会另外给出。'].join('\n');
}

// 收信人在剧情里收到信时，直接把原文放进上下文
export function inlineLetterBlock(letter, reader, arrival, { peek = false } = {}) {
    const head = peek ? `【${reader} 拆开的这封信（本来要转交给 ${(letter.recipients || []).join('、')}），原文如下】` : `【${reader} 收到的信${arrival ? `（${arrival}）` : ''}，原文如下】`;
    return `${head}\n${letter.body}\n【原文完】\n这封信的原文没有出现在聊天记录里，是直接给你的。描写读信时可以引用其中的句子，但不要整封复述。`;
}

// 收信 / 拆信引导里，“信的全文就是上一条消息”改成“原文见上”
export function inlineGuidance(text) {
    return String(text || '').replace('（信的全文就是上一条消息）', '（原文见上）').replace('，信的全文就是上一条消息', '，原文见上');
}

// 托人转交：转交人最晚哪天要转交出去，收信人才能在希望的日子收到
export function viaDeadline(target, legDays) {
    if (!normalizeDate(target)) return '';
    return addDays(target, -Math.max(0, legDays || 0));
}

// ---------- 暗号：用户消息里写了某封信的暗号，这一轮把整封信交给 AI ----------

export function buildCodeBlock(archive, letter, { look = false } = {}) {
    const head = [
        letter.author && `写信人：${letter.author}`,
        letter.recipients?.length && `收信人：${letter.recipients.join('、')}`,
        letter.writtenAt && `写信日期：${letter.writtenAt}`,
        (letter.placeFrom || letter.placeTo) && `${letter.placeFrom || '?'} → ${letter.placeTo || '?'}`,
        letter.language && `语言：${letter.language}`,
    ].filter(Boolean).join('；');
    const lines = [`【暗号 ${letter.code} 指的是下面这封信】`, head];
    if (look) lines.push(...lookLines(archive, letter).slice(0, 2));
    if (letter.shell || !String(letter.body || '').trim()) {
        lines.push('这封信的正文还没写好。剧情里如果有人读它，只写到拆开为止，不要编造内容。');
    } else {
        lines.push('原文：', letter.body, '【原文完】');
    }
    if (letter.enclosures?.length) lines.push(enclosuresForAI(letter, archive));
    lines.push(`用户在消息里写了 ${letter.code}，指的就是上面这封信，这一轮剧情要用到它（比如有人拆开读它、提起它、拿着它）。`);
    lines.push(`**这封信已经写好了，内容以上面的原文为准。** 剧情里有人读这封信时，读到的就是这些字句——可以直接引用原文里的句子，不要另编一封信，不要改写、增删信的内容，也不要替写信人补写信里没有的话。`);
    lines.push(`回复里不要写出“${letter.code}”这个暗号本身。`);
    return lines.filter(Boolean).join('\n');
}

// ---------- 读信以后的记忆：谁读了、记得什么、想到什么、做了什么 ----------

export function buildMemoryPrompt(letter, scene, { existing = [], storyDate = '', userName = '' } = {}) {
    const system = '你是剧情记录员，负责把角色读信的经过整理成这个角色日后会记得的东西。只输出 JSON。';
    const prev = existing.length ? `\n【之前已经记下的】（这些人以前读过这封信。如果这次又读了或者想起了它，在原来的基础上把这次的新内容补进去，合成一段，不超过 400 字；这次没读的人不用输出）\n${existing.map(m => `${m.person}：${m.text}`).join('\n')}\n` : '';
    const prompt = `下面是一封信的原文，以及剧情里有人读这封信的那一段。请为剧情里**读了这封信（或听人念过、被告知内容）的每个人**，各写一段这个人日后会记得的东西。${userName ? `${userName} 是用户扮演的角色，不用替 TA 写。` : ''}

每段写成第三人称、像这个人的记忆一样（比如“提奥记得……”），150 到 300 字，包含：
1. 什么时候、在什么情况下读的（${storyDate ? `当前剧情日期是 ${storyDate}，` : ''}剧情里写了就照写）；
2. 信里说了什么：只挑这个人在剧情里在意、停下来细看、有反应的部分；其余一句带过；
3. 这个人记得的原话：1 到 3 句，必须是**从信的原文里逐字摘出来的**，用「」括起来，可以是外文原句加括号里的中文；
4. 读的时候想到了什么（剧情里写到的联想、回忆、判断）；
5. 读完以后做了什么、打算怎么办。
另外每人写一句 gist：不超过 40 字，这个人会怎么一句话概括这封信（比如“勒鲁说每月寄一封信，托我按时转交”）。
只写剧情和信里确实有的，不要补充、不要编。剧情里没读这封信的人不要写；写信人自己不算读者，除非剧情里 TA 重读了这封信。

再看**这封信本身**在这段剧情里发生了什么（events，按先后）：type 是 written 写好 | sent 寄出 / 交给信差 / 托人带走 | received 收到 | read 读了 | forwarded 转交给别人 | kept 收起来 | mentioned 只是提到；who 是谁做的；to 是寄给 / 交给谁（sent、forwarded 时写）；date 是剧情里的日期（YYYY-MM-DD，看得出来才写）；place 是在哪（城市或地方，看得出来才写）；mes 是第几层（剧情前面标着楼层号就写）。分清楚：**写信人寄出**是 sent，**收信人拿到**是 received，拿到以后打开看是 read。剧情里没发生的不要写。
storyDate：这段剧情发生在哪天（YYYY-MM-DD），看不出来就写空字符串。

最后看这段剧情结束时，**这封信本身**在哪里：在谁手里（holder）、放在什么地方（place，比如“书桌左边的抽屉”）、状态（state）：kept 收着 | carried 随身带着 | given 交给了别人 | burned 烧了或毁了 | lost 丢了。剧情里没写到信最后放哪，letter 就写 null，不要猜。
${prev}
【信】${letter.author || '？'} 写给 ${(letter.recipients || []).join('、') || '？'}${letter.writtenAt ? `，${letter.writtenAt}` : ''}${letter.code ? `，暗号 ${letter.code}` : ''}
${String(letter.body || '').slice(0, 12000)}

【读信的那段剧情】
${String(scene || '').slice(0, 12000)}

只输出一个 JSON 对象，例如：
{"memories": [{"person": "提奥", "memory": "提奥记得，1890 年 7 月 1 日早上……他记得信里写着「（信里的原句）」……读完以后……", "gist": "……"}], "events": [{"type": "received", "who": "提奥", "date": "1890-07-01", "place": "巴黎", "mes": 120}, {"type": "read", "who": "提奥", "date": "1890-07-01", "place": "巴黎", "mes": 120}], "storyDate": "1890-07-01", "letter": {"holder": "提奥", "place": "画廊办公室的抽屉", "state": "kept"}}
没有人读这封信，memories 就是 []。`;
    return { system, prompt };
}

function cleanMemories(arr) {
    return (Array.isArray(arr) ? arr : [])
        .filter(x => x && typeof x === 'object' && String(x.person || '').trim() && String(x.memory || '').trim())
        .map(x => ({ person: String(x.person).trim().slice(0, 40), text: String(x.memory).trim().slice(0, 1500), gist: String(x.gist || '').trim().slice(0, 120) }));
}

const STORY_EVENT_TYPES = new Set(['written', 'sent', 'received', 'read', 'forwarded', 'kept', 'mentioned']);
function cleanEvents(arr) {
    return (Array.isArray(arr) ? arr : [])
        .filter(x => x && STORY_EVENT_TYPES.has(String(x.type)))
        .map(x => ({
            type: String(x.type),
            who: String(x.who || '').trim().slice(0, 40),
            to: String(x.to || '').trim().slice(0, 60),
            date: normalizeDate(x.date) ? String(x.date).trim() : '',
            place: String(x.place || '').trim().slice(0, 60),
            mes: Number.isInteger(Number(x.mes)) && x.mes !== '' && x.mes != null ? Number(x.mes) : null,
            note: String(x.note || '').trim().slice(0, 120),
        }));
}

// { memories: [{person, text, gist}], where: {holder, place, state} | null, events: [...], storyDate }
export function parseMemoryResult(text) {
    const t = String(text || '');
    const obj = t.match(/\{[\s\S]*\}/);
    if (obj && /"memories"/.test(obj[0])) {
        try {
            const o = JSON.parse(obj[0]);
            const w = o.letter && typeof o.letter === 'object' ? o.letter : null;
            const where = w && (w.holder || w.place || w.state) ? { holder: String(w.holder || ''), place: String(w.place || ''), state: String(w.state || 'kept'), note: String(w.note || '') } : null;
            return { memories: cleanMemories(o.memories), where, events: cleanEvents(o.events), storyDate: normalizeDate(o.storyDate) ? String(o.storyDate).trim() : '' };
        } catch { /* 往下试数组 */ }
    }
    const arr = t.match(/\[[\s\S]*\]/);
    if (!arr) return { memories: [], where: null, events: [], storyDate: '' };
    try { return { memories: cleanMemories(JSON.parse(arr[0])), where: null, events: [], storyDate: '' }; } catch { return { memories: [], where: null, events: [], storyDate: '' }; }
}

export function parseMemories(text) {
    return parseMemoryResult(text).memories.map(({ person, text: t }) => ({ person, text: t }));
}

// 记忆里「」括起来的原话，有没有真的出现在信里（不在的标出来，免得 AI 把编的当原文）
export function checkQuotes(memory, body) {
    const flat = s => String(s || '').replace(/[\s「」“”"'‘’（）()]/g, '');
    const src = flat(body);
    return String(memory || '').replace(/「([^」]{2,200})」/g, (all, q) => (src.includes(flat(q)) ? all : `“${q}”（大意）`));
}

// 没有 gist 时，从记忆里截一句
export function gistOf(m) {
    if (m.gist) return m.gist;
    const t = String(m.text || '').replace(/^[^，,]{0,12}记得[，,]?/, '');
    const first = t.split(/[。！？\n]/).find(x => x.trim().length > 4) || t;
    return first.trim().slice(0, 50) + (first.trim().length > 50 ? '…' : '');
}

const letterLabel = l => `${l.author || '？'} 写给 ${(l.recipients || []).join('、') || '？'} 的信${l.writtenAt ? `（${l.writtenAt}）` : ''}`;

// 世界书条目：这个人对这封信的记忆
export function memoryEntryContent(letter, m, whereLine = '') {
    return `【${m.person}的记忆｜${letterLabel(letter)}】\n${m.text}\n${whereLine ? `${whereLine}\n` : ''}（这是 ${m.person} 读过这封信以后记得的东西；没读过的人不知道这些。需要逐字读信时以原文为准，暗号 ${letter.code || '无'}。）`;
}

// 一个人读过同一个写信人的好几封信：平时只放这份一览，点到具体哪封才放那封的详细记忆
export function summaryEntryContent(person, author, items) {
    const lines = items.map(({ letter, memory, where }) => `- ${letter.writtenAt || '日期不详'}${letter.title ? `「${letter.title}」` : ''}${letter.code ? ` ${letter.code}` : ''}：${gistOf(memory)}${where ? `（${where}）` : ''}`);
    return `【${person}读过的 ${author} 来信】\n${person} 一共读过 ${items.length} 封 ${author} 写的信：\n${lines.join('\n')}\n（说起具体哪一封——日期、月份、标题——${person} 会想起那封信更多的细节。没读过的人不知道这些。）`;
}

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const XIN = '(?<![相自确迷威诚])信(?![任心仰赖号用息])';

// 写信人的名字（含别名）挨着“信”
export function authorKey(author, names = []) {
    const who = [...new Set([author, ...names].filter(Boolean))].map(esc).join('|');
    if (!who) return '';
    return `/(${who})[^。！？.!?\\n]{0,10}(${XIN}|letter|lettre)|(${XIN}|letter|lettre)[^。！？.!?\\n]{0,10}(${who})/i`;
}

const ZH_MONTHS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
const EN_MONTH_NAMES = EN_MONTHS.map(x => x.toLowerCase());

// 这封信自己的关键词：暗号、标题、月份（“七月那封信”）、自定义
export function letterOwnKeys(letter) {
    const keys = [];
    if (letter.code) keys.push(letter.code);
    if (letter.title) keys.push(letter.title);
    const mo = parseInt(String(letter.writtenAt || '').slice(5, 7), 10);
    if (mo >= 1 && mo <= 12) {
        const m = `(${ZH_MONTHS[mo - 1]}月|${mo}月|${FR_MONTHS[mo - 1]}|${EN_MONTH_NAMES[mo - 1]})`;
        keys.push(`/${m}[^。！？.!?\\n]{0,8}(${XIN}|letter|lettre)|(${XIN}|letter|lettre)[^。！？.!?\\n]{0,8}${m}/i`);
    }
    for (const k of letter.recallKeys || []) if (k) keys.push(k);
    return keys;
}

// 什么时候想起来：提到写信人和“信”，或者暗号、标题、自定义的想起关键词
export function memoryKeys(letter, names = [], { withAuthor = true } = {}) {
    const keys = [];
    const a = withAuthor ? authorKey(letter.author, names) : '';
    if (a) keys.push(a);
    for (const k of letterOwnKeys(letter)) if (!keys.includes(k)) keys.push(k);
    return keys;
}

// “拿出来重读”的说法挨着写信人 / 暗号 / 标题
export function rereadKey(letter, names = []) {
    const who = [...new Set([letter.author, ...names, letter.code, letter.title].filter(Boolean))].map(esc).join('|');
    if (!who) return '';
    const act = '(重读|再读|又读|重新读|翻出|拿出|找出|取出|展开|摊开|又看了|再看|reread|read again|relire|relut)';
    return `/${act}[^。！？.!?\\n]{0,15}(${who})|(${who})[^。！？.!?\\n]{0,15}${act}/i`;
}

export function rereadEntryContent(letter, holder, place = '') {
    return `【信件原文｜${letterLabel(letter)}｜现在在 ${holder} 手里${place ? `（${place}）` : ''}】\n${String(letter.body || '').trim()}\n【信件完】\n（${holder} 把这封信拿出来重读时，读到的就是上面的原文。没有这封信的人读不到。）`;
}

// ---------- 时间线「更新」：一次看完最近的剧情，各封信的状态有没有变 ----------

export function buildStatusPrompt(items, story, { storyDate = '', userName = '' } = {}) {
    const system = '你是剧情记录员，负责根据剧情更新信件的状态。只写剧情里确实发生了的事，不猜。只输出 JSON。';
    const list = items.map(({ n, letter, now }) => `#${n}：${letter.author || '？'} 写给 ${(letter.recipients || []).join('、') || '？'}${letter.writtenAt ? `，${letter.writtenAt} 写的` : ''}${letter.code ? `，暗号 ${letter.code}` : ''}${letter.title ? `，信封上写着「${letter.title}」` : ''}。开头：${String(letter.body || '').replace(/\s+/g, ' ').slice(0, 40) || '（正文还没写）'}。目前记录：${now}`).join('\n');
    const prompt = `下面是一些信，以及最近的一段剧情（每段前标着楼层号）。请看剧情里这些信**有没有发生新的事**：

- received：收信人是不是在这段剧情里收到了这封信（true / false；没写到就 null）；receivedBy 谁收到的；receivedDate 哪天收到（YYYY-MM-DD，剧情里看得出来才写）；receivedPlace 在哪收到（城市、住处，看得出来才写）
- readers：这段剧情里读了这封信（或听人念过）的人${userName ? `（不算 ${userName}）` : ''}，没有就 []
- where：这段剧情结束时信在哪：holder 在谁手里，place 放在哪，state 是 kept 收着 | carried 随身带着 | given 交给了别人 | burned 烧了 | lost 丢了；剧情里没写到就 null
- mes：这些事发生在第几层（楼层号）
${storyDate ? `当前剧情日期：${storyDate}。` : ''}
剧情里没提到的信不要输出。只写剧情里确实写到的。

【信】
${list}

【最近的剧情】
${String(story || '').slice(-40000)}

只输出一个 JSON 数组，例如：
[{"n": 1, "received": true, "receivedBy": "文森特", "receivedDate": "1890-07-02", "receivedPlace": "奥维尔", "readers": ["文森特"], "where": {"holder": "文森特", "place": "上衣口袋", "state": "carried"}, "mes": 312}]
都没有变化就输出 []。`;
    return { system, prompt };
}

export function parseStatusResponse(text) {
    const m = String(text || '').match(/\[[\s\S]*\]/);
    if (!m) return [];
    try {
        const arr = JSON.parse(m[0]);
        return (Array.isArray(arr) ? arr : []).filter(x => x && Number.isInteger(Number(x.n))).map(x => ({
            n: Number(x.n),
            received: x.received === true ? true : x.received === false ? false : null,
            receivedBy: String(x.receivedBy || '').trim(),
            receivedDate: String(x.receivedDate || '').trim(),
            receivedPlace: String(x.receivedPlace || '').trim(),
            readers: Array.isArray(x.readers) ? x.readers.map(r => String(r).trim()).filter(Boolean) : [],
            where: x.where && typeof x.where === 'object' && (x.where.holder || x.where.place || x.where.state) ? { holder: String(x.where.holder || ''), place: String(x.where.place || ''), state: String(x.where.state || 'kept') } : null,
            mes: Number.isInteger(Number(x.mes)) ? Number(x.mes) : null,
        }));
    } catch {
        return [];
    }
}
