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
        return lines.join('\n');
    }
    lines.push(`【收信】${arrival ? `${arrival}，` : ''}${reader} 收到了 ${letter.author || '某人'} 寄来的信（信的全文就是上一条消息）。`);
    if (dv.via) lines.push(`这封信是托 ${dv.via} 转交的。${dv.tampered ? `信封的封口有被拆开过、又粘回去的痕迹，${reader} 可能注意到，也可能没注意到。` : ''}`);
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
// 镜头切到收信人那边：作为一段旁白发进聊天，后面跟着信的全文
export function sceneSwitchMessage(letter, reader, arrival) {
    const where = letter.placeTo ? `${letter.placeTo}，` : '';
    const when = arrival ? `${arrival}。` : '';
    const via = letter.delivery?.via ? `经 ${letter.delivery.via} 转交，` : '';
    return `*（镜头切到${where}${when}${via}${reader || '收信人'}收到了${letter.author ? ` ${letter.author} 的` : '一封'}来信。）*\n\n${letter.body}`;
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

export function buildViaGuidance(archive, letter, via, arrival) {
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
    return lines.join('\n');
}

export const VIA_ACTIONS = { forward: '转交', later: '先留着', withhold: '不转交' };

// 让 AI 从转交人那一段剧情里判断：拆没拆、打算怎么办
export function buildViaDecisionPrompt(via, recipient, text) {
    const system = '你是剧情记录员，只输出 JSON。';
    const prompt = `下面是一段角色扮演的剧情。${via} 收到一封托${via}转交给 ${recipient} 的信。请判断：
1. ${via} 有没有拆开这封信（偷看也算）？
2. ${via} 打算怎么处理：forward（转交，现在或稍后去送都算）、later（先压着，还没决定或者暂时不交）、withhold（不交了、扣下、烧掉、退回）、unclear（看不出来）。
3. 如果拆开过，${via} 有没有把封口弄回原样、让人看不出被拆过（resealed）？

只输出一行 JSON，例如：{"opened": false, "resealed": false, "action": "forward", "note": "他决定明天一早送过去"}
note 用一句中文概括。

【剧情】
${text}`;
    return { system, prompt };
}

export function parseViaDecision(text) {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
        const j = JSON.parse(m[0]);
        const action = ['forward', 'later', 'withhold'].includes(j.action) ? j.action : 'unclear';
        return { opened: !!j.opened, resealed: !!j.resealed, action, note: String(j.note || '').slice(0, 80) };
    } catch {
        return null;
    }
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
