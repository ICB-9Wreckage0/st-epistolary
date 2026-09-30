// 书信簿 · 往来书信：收信反应、回信
// 纯函数，拼提示词、算日期。实际调用 AI 的部分在 index.js。

import { findPerson, sameName, segmentPosition, normalizeDate } from './model.js';

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
export function deliveryEvents(letter, arrivalDate, existing = []) {
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
    const { replyDate = '', length = 'natural', historyCount = 3 } = opts;
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
export function buildReactionGuidance(archive, letter, reader, arrival) {
    const person = findPerson(archive, reader);
    const lines = [];
    lines.push(`【收信】${arrival ? `${arrival}，` : ''}${reader} 收到了 ${letter.author || '某人'} 寄来的信（信的全文就是上一条消息）。`);
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
    return lines.join('\n');
}

// 发到聊天里的“寄出的信”那条消息
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
