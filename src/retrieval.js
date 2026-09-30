// 书信簿 · 检索与注入
// 流程：聊天文字 → 找候选段落 → 检查信是否已写成 → 检查视角角色的知情程度 → 按预算挑选 → 拼成注入文本
// 纯函数，可在 Node 里测试。

import { knowledgeOf, nameSet, segmentPosition, isOnOrBefore, LEVEL_LABELS } from './model.js';

export const DEFAULT_RETRIEVAL = {
    maxSegments: 4,     // 最多注入几段原文/大意
    maxChars: 2400,     // 注入正文总字数上限
    maxPerLetter: 2,    // 每封信最多几段
    maxExistsOnly: 3,   // “只知道存在”的信最多提几封
};

// 越新的消息权重越高
const RECENCY = [1, 0.6, 0.4, 0.3, 0.25];

function recencyWeight(i) {
    return RECENCY[i] ?? 0.2;
}

// 在最近的聊天文字里找关键词。texts[0] 是最新一条。
// 返回 { score, hits: [关键词] }
export function scoreSegment(letter, seg, texts) {
    const lowered = texts.map(t => String(t || '').toLowerCase());
    let score = 0;
    const hits = [];

    const check = (kw, factor) => {
        const k = String(kw || '').trim().toLowerCase();
        if (!k) return;
        const i = lowered.findIndex(t => t.includes(k));
        if (i < 0) return;
        score += recencyWeight(i) * factor;
        hits.push(kw);
    };

    const segKws = new Set([...seg.tags, ...seg.aiTags]);
    segKws.forEach(kw => check(kw, 1));
    letter.tags.forEach(kw => { if (!segKws.has(kw)) check(kw, 0.5); });

    // 聊天里直接写了信件编号（例如 LETTER-0042）→ 强制命中
    const idLower = letter.id.toLowerCase();
    const idIndex = lowered.findIndex(t => t.includes(idLower));
    if (idIndex >= 0) {
        score += 3 * recencyWeight(idIndex);
        hits.push(letter.id);
    }
    return { score, hits };
}

// 解释一段为什么被挡：用于注入预览
function blockReason(letter, seg, who, storyDate, k) {
    if (!k.exists) return `信在剧情日期时还没写成（写于 ${letter.writtenAt}）`;
    const noTime = knowledgeOf(letter, who, null);
    const lvlNoTime = noTime.segLevels[seg.id];
    if (lvlNoTime !== 'none' || noTime.letterLevel !== 'none') {
        const future = letter.events
            .filter(e => who.has(String(e.who).trim().toLowerCase()) && !isOnOrBefore(e.date, storyDate))
            .map(e => e.date);
        return `剧情日期还没到（相关事件在 ${future.join('、') || '之后'}）`;
    }
    return '这个角色不知道这封信';
}

/**
 * @param {object} archive
 * @param {object} opts
 * @param {string[]} opts.texts      最近几条聊天文字，最新的在前
 * @param {string|null} opts.viewer  视角角色名；null = 全知模式，不做权限过滤
 * @param {string} opts.storyDate    当前剧情日期，可为空
 * @param {object} opts.settings     预算设置
 * @param {Set<string>} [opts.exclude] 不参与检索的信件 ID
 */
export function retrieve(archive, { texts, viewer, storyDate, settings, exclude }) {
    const cfg = { ...DEFAULT_RETRIEVAL, ...(settings || {}) };
    const who = viewer ? nameSet(archive, viewer) : null;

    const candidates = [];   // 可以注入正文或大意的
    const existsOnly = new Map(); // letterId → 最高分
    const blocked = [];

    for (const letter of Object.values(archive.letters)) {
        // 正在聊天里被读的那封信，全文已经在聊天里了，不重复注入
        if (exclude && exclude.has(letter.id)) continue;
        const k = who ? knowledgeOf(letter, who, storyDate) : null;
        const written = isOnOrBefore(letter.writtenAt, storyDate);

        for (const seg of letter.segments) {
            const { score, hits } = scoreSegment(letter, seg, texts);
            if (score <= 0) continue;
            const base = { letterId: letter.id, segId: seg.id, score, hits };

            if (!written) {
                blocked.push({ ...base, reason: `信在剧情日期时还没写成（写于 ${letter.writtenAt}）` });
                continue;
            }
            if (!who) {
                candidates.push({ ...base, level: 'full' });
                continue;
            }

            let level = k.segLevels[seg.id];
            if (level === 'summary' && !seg.summary.trim()) {
                level = 'exists'; // 没写大意，只能降级成“知道有这封信”
            }
            if (level === 'full' || level === 'summary') {
                candidates.push({ ...base, level });
            } else if (level === 'exists' || k.letterLevel !== 'none') {
                existsOnly.set(letter.id, Math.max(existsOnly.get(letter.id) || 0, score));
                blocked.push({ ...base, reason: '只知道信存在，没读过这一段' });
            } else {
                blocked.push({ ...base, reason: blockReason(letter, seg, who, storyDate, k) });
            }
        }
    }

    // 按预算挑选
    candidates.sort((a, b) => b.score - a.score);
    const selected = [];
    const perLetter = {};
    let chars = 0;
    for (const c of candidates) {
        const letter = archive.letters[c.letterId];
        const seg = letter.segments.find(s => s.id === c.segId);
        const content = c.level === 'full' ? seg.text : seg.summary;
        if (selected.length >= cfg.maxSegments) { c.dropped = '超过段数上限'; continue; }
        if ((perLetter[c.letterId] || 0) >= cfg.maxPerLetter) { c.dropped = '超过每封信段数上限'; continue; }
        let text = content;
        let truncated = false;
        if (chars + content.length > cfg.maxChars) {
            if (selected.length > 0) { c.dropped = '超过字数预算'; continue; }
            text = content.slice(0, cfg.maxChars);
            truncated = true;
        }
        chars += text.length;
        perLetter[c.letterId] = (perLetter[c.letterId] || 0) + 1;
        selected.push({ ...c, text, truncated });
    }

    // 已经注入了正文的信，就不用再说“知道存在”了
    const selectedLetters = new Set(selected.map(s => s.letterId));
    const existsList = [...existsOnly.entries()]
        .filter(([id]) => !selectedLetters.has(id))
        .sort((a, b) => b[1] - a[1])
        .slice(0, cfg.maxExistsOnly)
        .map(([id]) => id);

    // 输出时按信件日期、段落顺序排，读起来顺
    selected.sort((a, b) => {
        const la = archive.letters[a.letterId], lb = archive.letters[b.letterId];
        const da = la.writtenAt || '', db = lb.writtenAt || '';
        if (da !== db) return da < db ? -1 : 1;
        if (a.letterId !== b.letterId) return a.letterId < b.letterId ? -1 : 1;
        return segmentPosition(la, a.segId) - segmentPosition(la, b.segId);
    });

    const dropped = candidates.filter(c => c.dropped);
    const text = formatInjection(archive, selected, existsList, viewer);
    return { selected, existsOnly: existsList, blocked, dropped, text, chars };
}

function letterHeader(letter) {
    const to = letter.recipients.join('、') || '（收件人未填）';
    const from = letter.author || '（写信人未填）';
    const date = letter.writtenAt || '日期不详';
    return { from, to, date };
}

export function formatInjection(archive, selected, existsList, viewer) {
    if (!selected.length && !existsList.length) return '';
    const lines = [];
    if (viewer) {
        lines.push(`【书信记忆 · ${viewer} 所知】`);
        lines.push(`以下只包含 ${viewer} 读过、听过或听说过的信件内容，${viewer} 不知道这些以外的信件内容。信中所写是写信人当时的说法，不一定是事实。`);
    } else {
        lines.push('【相关历史信件】');
        lines.push('信中所写是写信人当时的说法，不一定是事实。');
    }

    for (const s of selected) {
        const letter = archive.letters[s.letterId];
        const { from, to, date } = letterHeader(letter);
        const pos = segmentPosition(letter, s.segId);
        const how = !viewer ? '' : s.level === 'full' ? `｜${viewer}读过原文` : `｜${viewer}只听人转述过大意`;
        lines.push('');
        lines.push(`〔${letter.id} §${pos}｜${date}｜${from} → ${to}${how}〕`);
        if (s.level === 'summary') {
            lines.push(`（大意）${s.text}`);
        } else {
            lines.push(s.text + (s.truncated ? '……（后略）' : ''));
        }
    }

    if (existsList.length && viewer) {
        lines.push('');
        const items = existsList.map(id => {
            const l = archive.letters[id];
            const { from, to, date } = letterHeader(l);
            return `${id}（${from} 写给 ${to}，${date}）`;
        });
        lines.push(`〔${viewer} 知道以下信件存在，但不知道内容：${items.join('；')}〕`);
    }
    return lines.join('\n');
}

export { LEVEL_LABELS };
