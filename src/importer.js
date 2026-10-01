// 书信簿 · 从聊天记录里找出历史信件
// 两种方法：
//   format 按格式识别：找“称呼 …… 结尾/署名”这样的段落，不调用 AI
//   ai     让 AI 指出每封信从哪句开始、到哪句结束；正文一律从聊天原文里逐字截取，AI 改写过的不会进档案

// 明确的称呼
const SALUTATION = /^(亲爱的|敬爱的|尊敬的|最亲爱的|致|吾)|^(Dear|My dear|Dearest|Mon cher|Ma chère|Ma chere|Cher|Chère|Lieber|Liebe|Caro|Cara|Querido|Querida)\b|[^\n]{1,24}(膝下|台鉴|钧鉴|惠鉴|如晤|见字如面|大鉴)[：:，,]?\s*$/i;
// 只有一个名字加冒号，如“提奥：”——但不能是“她写下：”这样的叙述
const NAME_SALUTATION = /^[^\s，,。.!！?？]{1,12}[：:,，]\s*$/;
const NARRATION = /(写下|写道|写着|写了|信中|信上|信里|说|道|écrivit|écrit|wrote|writes|schrieb|said|says)/i;

export function isSalutation(line) {
    const l = String(line || '').trim();
    if (!l || l.length > 40) return false;
    if (SALUTATION.test(l)) return true;
    return NAME_SALUTATION.test(l) && !NARRATION.test(l);
}

const CLOSING = /(此致|敬礼|顺颂|即颂|敬请|祝好|祝安|安好|敬上|谨上|手书|手启|再拜|顿首|紧握你的手|吻你|爱你的|你的朋友|你忠实的|Yours|Sincerely|Faithfully|Affectionately|With love|Love,|Ever yours|Je te serre|Bien à (vous|toi)|Amitiés|Je t'embrasse|Tout à (toi|vous)|Mit (herzlichen|freundlichen) Grüßen|Dein|Ihr)/i;
const DATE_LINE = /(\d{3,4}\s*年|\b1[5-9]\d\d\b|\b20\d\d\b)/;

// 聊天消息里常见的包装：引用符号、斜体星号、代码块
function clean(text) {
    return String(text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/^```[a-z]*\n?|```$/gim, '')
        .split('\n').map(l => l.replace(/^\s*>\s?/, '')).join('\n')
        .replace(/\*\*/g, '')
        .replace(/^\*(.+)\*$/gm, '$1');
}

function paragraphs(text) {
    return clean(text).split(/\n[ \t　]*\n/).map(p => p.replace(/^\n+|\n+$/g, '')).filter(p => p.trim());
}

// 像署名的一行：很短、不是完整的句子
function isSignature(line) {
    const l = String(line || '').trim();
    if (!l || NARRATION.test(l)) return false;
    if (/[\u3400-\u9fff]/.test(l)) return l.length <= 10 && !/[，。！？；]/.test(l.replace(/[。.]$/, ''));
    const words = l.split(/\s+/);
    return l.length <= 24 && words.length <= 3 && !/[,;!?]/.test(l) && !/[a-z]\.$/.test(l.replace(/^\S{1,3}\.$/, ''));
}

function firstLine(p) { return p.split('\n')[0].trim(); }
function lastLine(p) { const ls = p.trim().split('\n'); return ls[ls.length - 1].trim(); }

// 从称呼里猜收信人
export function guessRecipient(salutation) {
    let s = String(salutation || '').trim().replace(/[：:，,!！。\s]+$/, '');
    s = s.replace(/^(亲爱的|敬爱的|尊敬的|致|给|Dear|My dear|Dearest|Mon cher|Ma chère|Ma chere|Cher|Chère|Lieber|Liebe|Caro|Cara|Querido|Querida)\s*/i, '');
    s = s.replace(/(膝下|台鉴|钧鉴|惠鉴|大鉴|如晤|见字如面|大人|先生|女士|小姐)+$/, '');
    return s.trim().slice(0, 20);
}

// 从署名里猜写信人
export function guessAuthor(signoff) {
    const s = String(signoff || '').trim()
        .replace(/^(你的|您的|your|yours|ton|ta|votre|dein|deine)\s*/i, '')
        .replace(/\s*(敬上|谨上|手书|手启|再拜|顿首|上|书)$/, '')
        .replace(/[，,。.!！]+$/, '')
        .trim();
    return s.length && s.length <= 16 ? s : '';
}

function guessDate(text) {
    const first = firstLine(text);
    if (first.length <= 48 && DATE_LINE.test(first)) {
        const m = first.match(/(\d{3,4})[-/.年\s](\d{1,2})[-/.月\s]?(\d{1,2})?/);
        if (m) return [m[1], m[2]?.padStart(2, '0'), m[3]?.padStart(2, '0')].filter(Boolean).join('-');
    }
    return '';
}

/**
 * 按格式识别一条消息里的信
 * @returns {Array<{text, salutation, signoff}>}
 */
// 信中间夹着的旁白：整段包在 *星号* 或（括号）里，或者是第三人称的写信动作（“他停下笔，想了想”）
const NARR_BREAK = /(停下笔|停了笔|搁下笔|放下笔|顿了顿|想了想|写到这里|写到这儿|抬起头|抬头看|叹了口气|蘸了蘸墨|蘸墨|又写道|继续写|接着写|笔尖|划掉|涂掉|揉掉|paused|stopped writing|set down (?:the|his|her) pen|dipped (?:the|his|her) pen|crossed out|went on writing)/i;

function rawParagraphs(text) {
    return String(text || '').replace(/\r\n?/g, '\n').split(/\n[ \t　]*\n/).filter(p => p.trim()).map(raw => {
        const lines = raw.split('\n').filter(l => l.trim());
        const t = raw.trim();
        return {
            text: clean(raw).replace(/^\n+|\n+$/g, ''),
            quoted: lines.length > 0 && lines.every(l => /^\s*>/.test(l)),
            wrapped: /^\*[^*][\s\S]*\*$/.test(t) || /^_[^_][\s\S]*_$/.test(t) || /^[（(][\s\S]*[）)]$/.test(t),
        };
    }).filter(p => p.text.trim());
}

function looksLikeNarration(p) {
    const t = p.text.trim();
    return t.length <= 160 && NARR_BREAK.test(t) && !/我/.test(t) && !/\b(I|my|je|mon|ma)\b/i.test(t);
}

export function detectInMessage(text) {
    const raws = rawParagraphs(text);
    const ps = raws.map(p => p.text);
    const out = [];
    let i = 0;
    while (i < ps.length) {
        // 找称呼：本段第一行（或日期行后的第二行）像称呼
        let startIdx = -1, salutation = '';
        const lines = ps[i].split('\n').map(l => l.trim());
        for (let k = 0; k < Math.min(2, lines.length); k++) {
            const l = lines[k];
            if (k === 1 && !DATE_LINE.test(lines[0])) break;
            if (isSalutation(l)) { startIdx = i; salutation = l; break; }
        }
        // 称呼单独一段，前面一段是日期行
        if (startIdx < 0) { i++; continue; }
        let begin = startIdx;
        if (begin > 0 && firstLine(ps[begin - 1]).length <= 48 && DATE_LINE.test(ps[begin - 1]) && ps[begin - 1].split('\n').length <= 2) begin--;

        // 找结尾：之后 40 段以内，第一个含结尾套语的段落；之后再带上最多两段很短的署名/附言
        let end = -1;
        for (let j = startIdx; j < Math.min(ps.length, startIdx + 40); j++) {
            if (j > startIdx && CLOSING.test(ps[j]) && ps[j].length <= 120) { end = j; break; }
        }
        if (end < 0) {
            // 没有套语，就看最后一段是不是很短的署名
            const last = Math.min(ps.length, startIdx + 40) - 1;
            if (last > startIdx && ps[last].trim().length <= 20) end = last;
        }
        if (end < 0) { i = startIdx + 1; continue; }
        // 结尾段之后：附言照收；署名只在结尾段里还没有署名时才收一段
        let stop = end;
        let hasSignature = ps[end].trim().split('\n').length >= 2 && isSignature(lastLine(ps[end]));
        for (let k = 1; k <= 3 && end + k < ps.length; k++) {
            const p = ps[end + k].trim();
            if (/^(P\.?\s*-?\s*S|PS|又及|附言|再者)/i.test(p)) { stop = end + k; continue; }
            if (!hasSignature && p.split('\n').every(l => isSignature(l) || (DATE_LINE.test(l) && l.length <= 30))) {
                stop = end + k;
                hasSignature = true;
                continue;
            }
            break;
        }
        // 去掉夹在信中间的旁白：信是引用格式（>）时，不在引用里的段落都是旁白
        const quotedMode = raws[startIdx].quoted;
        const parts = [];
        for (let k = begin; k <= stop; k++) {
            const r = raws[k];
            if (k !== startIdx && (r.wrapped || (quotedMode && !r.quoted) || looksLikeNarration(r))) continue;
            parts.push(r.text);
        }
        const body = parts.join('\n\n');
        if (body.replace(/\s/g, '').length >= 30) {
            out.push({ text: body, salutation, signoff: lastLine(parts[parts.length - 1] || ps[stop]), parts });
        }
        i = stop + 1;
    }
    return out;
}

/**
 * 按格式扫描整段聊天
 * @param {Array} chat 酒馆聊天记录
 * @param {object} names { user, char }
 */
export function detectInChat(chat, { from = 0 } = {}) {
    const found = [];
    chat.forEach((m, idx) => {
        if (idx < from || !m || m.is_system || typeof m.mes !== 'string') return;
        if (m.extra?.epistolary) return; // 本插件发进聊天的信，档案里已经有了
        for (const c of detectInMessage(m.mes)) {
            found.push({
                mesIndex: idx,
                speaker: m.name,
                isUser: !!m.is_user,
                text: c.text,
                author: guessAuthor(c.signoff) || m.name || '',
                recipient: guessRecipient(c.salutation),
                date: guessDate(c.text),
            });
        }
    });
    return found;
}

// ---------- AI 识别 ----------

// 把聊天切成几块，每块不超过 maxChars
export function chunkChat(chat, { from = 0, maxChars = 9000 } = {}) {
    const chunks = [];
    let cur = [], size = 0;
    chat.forEach((m, idx) => {
        if (idx < from || !m || m.is_system || typeof m.mes !== 'string' || m.extra?.epistolary) return;
        const t = clean(m.mes);
        if (size + t.length > maxChars && cur.length) { chunks.push(cur); cur = []; size = 0; }
        cur.push({ idx, name: m.name, text: t.length > maxChars ? t.slice(0, maxChars) : t });
        size += t.length;
    });
    if (cur.length) chunks.push(cur);
    return chunks;
}

export function buildImportPrompt(chunk) {
    const system = '你是书信档案整理员。你只负责指出聊天记录里哪些文字是一封信，不改写任何内容。只输出 JSON。';
    const body = chunk.map(m => `<<消息 #${m.idx}｜${m.name}>>\n${m.text}`).join('\n\n');
    const prompt = `下面是一段角色扮演的聊天记录，每条消息前标有编号。请找出其中**完整写出来的信件**（包括便条、明信片、电报），也就是有人提笔写给另一个人的文字，通常有称呼、正文、结尾或署名。只是提到“写了一封信”、但没有写出内容的，不算。

对每封信，输出：
- message：所在消息的编号（数字）
- start：信的第一句话，**从原文逐字复制**前 12 到 20 个字
- end：信的最后一句话（通常是署名），**从原文逐字复制**最后 6 到 16 个字
- skip：如果信写到一半夹着旁白或动作描写（比如“他停下笔，望着窗外想了很久。”），把这些旁白段落的开头 8 到 15 个字**逐字复制**列出来（数组），没有就空数组
- author：写信人
- recipient：收信人
- date：信上写的日期或剧情里的日期，格式 YYYY-MM-DD，不知道就留空字符串
- place：写信地点，不知道就留空字符串

只输出一个 JSON 数组，例如：
[{"message": 12, "start": "亲爱的提奥：近来可好", "end": "紧握你的手，文森特", "skip": ["他停下笔，望着窗外"], "author": "文森特", "recipient": "提奥", "date": "1889-06-05", "place": "圣雷米"}]
没有找到任何信，就输出 []。

【聊天记录】
${body}`;
    return { system, prompt };
}

function normalizeSpace(s) {
    return String(s || '').replace(/\s+/g, '');
}

// 在原文里找 AI 给出的起止片段，返回逐字截取的正文；找不到返回 null
export function sliceVerbatim(text, start, end) {
    const src = clean(text);
    const flat = [];
    const map = [];
    Array.from(src).forEach((ch, i) => { if (!/\s/.test(ch)) { flat.push(ch); map.push(i); } });
    const flatStr = flat.join('');
    const chars = Array.from(src);
    const s = normalizeSpace(start), e = normalizeSpace(end);
    if (!s || !e) return null;
    const si = flatStr.indexOf(s);
    if (si < 0) return null;
    const ei = flatStr.indexOf(e, si);
    if (ei < 0) return null;
    const from = map[si];
    const to = map[ei + e.length - 1];
    // 起点往前退到这一行的开头，终点往后延到这一行的结尾，避免截掉半句
    let a = from; while (a > 0 && chars[a - 1] !== '\n') a--;
    let b = to; while (b < chars.length - 1 && chars[b + 1] !== '\n') b++;
    return chars.slice(a, b + 1).join('').replace(/^\n+|\n+$/g, '').trim();
}

export function parseImportResponse(text) {
    const m = String(text || '').match(/\[[\s\S]*\]/);
    if (!m) return [];
    try {
        const arr = JSON.parse(m[0]);
        return Array.isArray(arr) ? arr.filter(x => x && typeof x === 'object') : [];
    } catch {
        return [];
    }
}

// 档案里是否已经有这封信（去掉空白后相同，或一方包含另一方的大部分）
export function findDuplicate(archive, text) {
    const t = normalizeSpace(text);
    if (!t) return null;
    for (const l of Object.values(archive.letters)) {
        const b = normalizeSpace(l.body);
        if (!b) continue;
        if (b === t) return l.id;
        const shorter = b.length < t.length ? b : t;
        const longer = b.length < t.length ? t : b;
        if (shorter.length > 40 && longer.includes(shorter.slice(0, Math.min(60, shorter.length))) && shorter.length / longer.length > 0.8) return l.id;
    }
    return null;
}

// ---------- 空壳信：剧情里已经有了、但正文还没写出来的信 ----------

export const SHELL_STATES = {
    sealed: '写好封好了，还没寄',
    transit: '在路上',
    withVia: '在转交人 / 保管人手里',
    delivered: '送到了，还没拆',
    read: '已经拆开读过',
};

export function buildShellPrompt(chunk, { userName = '', storyDate = '' } = {}) {
    const system = '你是书信档案整理员。你只负责从剧情里找出“提到了、但正文没有写出来”的信，不替任何人写信的内容。只输出 JSON。';
    const body = chunk.map(m => `<<消息 #${m.idx}｜${m.name}>>\n${m.text}`).join('\n\n');
    const prompt = `下面是一段角色扮演的聊天记录，每条消息前标有编号。${userName ? `用户扮演的角色是 ${userName}。` : ''}${storyDate ? `当前剧情日期是 ${storyDate}。` : ''}
请找出剧情里**已经存在、但正文没有写出来**的信：比如“他写了五封信封好交给提奥”“信使带来了一封信”“抽屉里还压着三封没寄的信”。
不要列出正文已经完整写在聊天里的信，也不要列出只是“打算写”、还没写的信。
如果一次提到好几封（比如五封），**每封单独列一项**，用信封上的字或顺序区分。

每封信输出：
- message：最早提到它的消息编号（数字）
- author：写信人
- recipients：收信人（数组）
- writtenAt：写信日期，YYYY-MM-DD，不知道就空字符串
- label：信封上写的字（照原文，比如“1er juillet”“请先拆这个”），没有就空字符串
- holder：这封信现在在谁手里、由谁转交或保管（不是收信人本人时才填），没有就空字符串
- target：应该在哪天送到收信人手里，YYYY-MM-DD，不知道就空字符串
- legDays：从保管人那里寄到收信人手里大约要走几天（整数），不知道就 1
- state：sealed（写好封好、还没寄）| transit（在路上）| withVia（在转交人 / 保管人手里）| delivered（送到了还没拆）| read（已经拆开读过）
- readers：已经读过这封信的人（数组，没有就空数组）
- wax：封口的样子，按剧情选一个：crimson（红火漆）| navy | forest | black（黑火漆）| gold | chop（中式印章）| none（胶封或没写）
- note：一句话说明依据

只输出 JSON 数组，例如：
[{"message": 649, "author": "勒鲁", "recipients": ["文森特"], "writtenAt": "1890-06-27", "label": "1er juillet", "holder": "提奥", "target": "1890-07-01", "legDays": 1, "state": "withVia", "readers": [], "wax": "crimson", "note": "托提奥每月月底寄出的五封信之一"}]
没有就输出 []。

【聊天记录】
${body}`;
    return { system, prompt };
}

export function parseShellResponse(text) {
    const m = String(text || '').match(/\[[\s\S]*\]/);
    if (!m) return [];
    let arr;
    try { arr = JSON.parse(m[0]); } catch { return []; }
    if (!Array.isArray(arr)) return [];
    const str = v => (typeof v === 'string' ? v.trim() : '');
    const date = v => (/^\d{1,4}-\d{1,2}-\d{1,2}$/.test(str(v)) ? str(v) : '');
    return arr.filter(x => x && typeof x === 'object').map(x => ({
        message: Number(x.message) || 0,
        author: str(x.author),
        recipients: (Array.isArray(x.recipients) ? x.recipients : String(x.recipients || '').split(/[,，、]/)).map(s => String(s).trim()).filter(Boolean),
        writtenAt: date(x.writtenAt),
        label: str(x.label),
        holder: str(x.holder),
        target: date(x.target),
        legDays: Math.max(0, Math.min(60, parseInt(x.legDays, 10) || 1)),
        state: SHELL_STATES[x.state] ? x.state : (str(x.holder) ? 'withVia' : 'sealed'),
        readers: (Array.isArray(x.readers) ? x.readers : []).map(s => String(s).trim()).filter(Boolean),
        wax: ['crimson', 'navy', 'forest', 'black', 'gold', 'chop', 'none'].includes(x.wax) ? x.wax : '',
        note: str(x.note).slice(0, 120),
    })).filter(x => x.author || x.recipients.length);
}

// 档案里是不是已经有这封空壳信了（同一个写信人、收信人、信封上的字）
export function findShellDuplicate(archive, s) {
    const key = l => [l.author, (l.recipients || []).join('、'), l.title || ''].join('|');
    const k = key({ author: s.author, recipients: s.recipients, title: s.label });
    return Object.values(archive.letters).find(l => key(l) === k && (l.shell || !!s.label))?.id || '';
}

// 去掉 AI 指出的旁白段落（按段落开头逐字比对）
export function dropParagraphs(text, skips) {
    const list = (Array.isArray(skips) ? skips : []).map(normalizeSpace).filter(x => x.length >= 4);
    if (!list.length) return text;
    return String(text || '').split(/\n[ \t　]*\n/).filter(p => {
        const flat = normalizeSpace(p).replace(/^[*_（(]+/, '');
        return !list.some(sk => flat.startsWith(sk.replace(/^[*_（(]+/, '')));
    }).join('\n\n');
}
