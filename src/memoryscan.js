// 书信簿 · 从过去的楼层里找“谁读过这封信”
// 记忆功能是后来才有的；以前读过的信，要回头到聊天记录里找读信的那几层，再整理成记忆。
// 这里只在本地找候选楼层，不调用 AI。

import { memoryKeys } from './correspondence.js';

export const SCENE_REASONS = {
    code: { label: '用暗号把信交给了 AI', strong: true },
    source: { label: '信的原文就在这一层', strong: true },
    quote: { label: '引用了信里的原句', strong: true },
    mention: { label: '提到了这封信', strong: false },
};

const flat = s => String(s || '').replace(/[\s"'“”‘’「」『』《》（）()\[\]—…-]+/g, '');
const PUNCT = /[，。！？；：、,.!?;:]+/;

// 信里有辨识度的句子片段：按分句切开，取够长的分句的前一截（去掉称呼、日期、落款）
export function quoteSamples(body, { len = 9, max = 60 } = {}) {
    const paras = String(body || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
        .filter(p => !/^(亲爱的|敬爱的|尊敬的|dear|my dear|cher|chère|mon cher|ma chère|lieber|liebe)\b/i.test(p) || p.length > 30)
        .filter(p => !/^[^\n]{0,40}\d{3,4}\s*$/.test(p));
    const out = [];
    for (const p of paras) {
        for (const clause of p.split(PUNCT).map(flat)) {
            if (clause.length < len) continue;
            const s = clause.slice(0, Math.max(len, Math.min(clause.length, 12)));
            if (!out.includes(s)) out.push(s);
            if (out.length >= max) return out;
        }
    }
    return out;
}

function keyRegexes(letter, names) {
    return memoryKeys(letter, names).map(k => {
        const m = String(k).match(/^\/([\s\S]+)\/([a-z]*)$/);
        if (m) { try { return new RegExp(m[1], m[2]); } catch { return null; } }
        return k.length >= 2 ? new RegExp(k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'i') : null;
    }).filter(Boolean);
}

const BLOCK_RE = /【信件 [\s\S]*?【信件完】/g;

// 返回候选的读信片段：[{ from, to, reasons: ['code', ...], strong, snippet }]，按楼层排序
export function findReadingScenes(chat, letter, { names = [], chatId = '' } = {}) {
    const hits = [];
    const samples = quoteSamples(letter.body);
    const keys = keyRegexes(letter, names);
    const blockStart = letter.code ? `【信件 ${letter.code}｜` : null;
    const nextReply = i => { for (let j = i + 1; j < chat.length && j <= i + 3; j++) if (chat[j] && !chat[j].is_user && !chat[j].is_system) return j; return i; };
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        const raw = String(m.mes || '');
        if (m.is_user && blockStart && raw.includes(blockStart)) { hits.push({ from: i, to: nextReply(i), reason: 'code' }); continue; }
        if (letter.source && letter.source.mes === i && (!chatId || !letter.source.chatId || letter.source.chatId === chatId)) {
            hits.push({ from: i, to: Math.min(chat.length - 1, nextReply(i) + 1), reason: 'source' });
            continue;
        }
        const text = raw.replace(BLOCK_RE, '');
        const both = `${text}\n${m.extra?.reasoning || ''}`;
        const f = flat(both).replace(new RegExp(PUNCT.source, 'g'), '');
        if (samples.length && samples.some(q => f.includes(q))) { hits.push({ from: Math.max(0, i - 1), to: Math.min(chat.length - 1, i + 1), reason: 'quote' }); continue; }
        if (keys.some(r => r.test(both))) hits.push({ from: Math.max(0, i - 1), to: Math.min(chat.length - 1, i + 1), reason: 'mention' });
    }
    // 挨着的合并成一段
    hits.sort((a, b) => a.from - b.from);
    const scenes = [];
    for (const h of hits) {
        const last = scenes.at(-1);
        if (last && h.from <= last.to + 1 && last.to - last.from < 8) {
            last.to = Math.max(last.to, h.to);
            if (!last.reasons.includes(h.reason)) last.reasons.push(h.reason);
        } else scenes.push({ from: h.from, to: h.to, reasons: [h.reason] });
    }
    for (const s of scenes) {
        s.strong = s.reasons.some(r => SCENE_REASONS[r]?.strong);
        const pick = chat.slice(s.from, s.to + 1).find(m => m && !m.is_user && !m.is_system) || chat[s.from];
        s.snippet = String(pick?.mes || '').replace(BLOCK_RE, '').replace(/\s+/g, ' ').trim().slice(0, 90);
    }
    return scenes;
}

// 把几层拼成一段剧情交给 AI（信件块换成一句话，免得重复整封原文）
export function sceneText(chat, from, to) {
    const parts = [];
    for (let i = Math.max(0, from); i <= Math.min(chat.length - 1, to); i++) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        const text = String(m.mes || '').replace(BLOCK_RE, '（附信原文略）').trim();
        const r = m.extra?.reasoning ? `\n（${m.name} 这一段的思考：${String(m.extra.reasoning).slice(0, 2500)}）` : '';
        if (text || r) parts.push(`[第 ${i} 层] ${m.name}：${text.slice(0, 6000)}${r}`);
    }
    return parts.join('\n\n');
}
