// 书信簿 · 通信时间线
// 按日期排出两个人（或一个人和所有人）之间的信：谁写给谁、哪封回了哪封、哪封还在路上、谁读过、信现在在哪。

import { findPerson, sameName, normalizeDate } from './model.js';
import { whereNow } from './whereabouts.js';

const canon = (archive, name) => findPerson(archive, name)?.name || String(name || '').trim();

// 这封信在故事里的时间：信上的日期；没写日期就用剧情里第一次出现（写好 / 寄出 / 收到……）的日期
function dateOf(l) {
    const own = normalizeDate(l.writtenAt);
    if (own) return own;
    const ds = (l.events || []).map(e => normalizeDate(e.date)).filter(Boolean).sort();
    return ds[0] || '';
}

// 在第几层第一次出现
function floorOf(l) {
    const ms = (l.events || []).map(e => e.mes).filter(Number.isInteger);
    if (Number.isInteger(l.source?.mes)) ms.push(l.source.mes);
    return ms.length ? Math.min(...ms) : null;
}

const EVENT_LABELS = { written: '写好了信', sent: '寄出', received: '收到', read: '读了', heard: '听人念了', told: '听人转述', aware: '知道有这封信', copied: '抄了一份', forwarded: '转交', returned: '退回', lost: '弄丢了', kept: '收起来', mentioned: '提到' };

// 这封信的经过（按楼层、日期排）
export function letterStory(l) {
    return (l.events || [])
        .filter(e => EVENT_LABELS[e.type])
        .map(e => ({ ...e, label: EVENT_LABELS[e.type] }))
        .sort((a, b) => (a.mes ?? 1e9) - (b.mes ?? 1e9) || String(a.date).localeCompare(String(b.date)));
}

function daysBetween(a, b) {
    const x = Date.parse(`${a}T00:00:00Z`), y = Date.parse(`${b}T00:00:00Z`);
    return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 86400000) : null;
}

// 所有通信的两个人：[{ key, a, b, count, last }]，按信的数量排
export function correspondentPairs(archive) {
    const map = new Map();
    for (const l of Object.values(archive.letters || {})) {
        const au = canon(archive, l.author);
        if (!au) continue;
        for (const r of l.recipients || []) {
            const re = canon(archive, r);
            if (!re || re === au) continue;
            const [a, b] = [au, re].sort((x, y) => x.localeCompare(y, 'zh'));
            const key = `${a}\u0001${b}`;
            const p = map.get(key) || { key, a, b, count: 0, last: '' };
            p.count++;
            const d = dateOf(l);
            if (d > p.last) p.last = d;
            map.set(key, p);
        }
    }
    return [...map.values()].sort((x, y) => y.count - x.count || y.last.localeCompare(x.last));
}

// 这封信属不属于这一对 / 这个人
function involves(archive, l, a, b) {
    const isA = n => sameName(archive, a, n);
    const isB = n => sameName(archive, b, n);
    if (!b) return isA(l.author) || (l.recipients || []).some(isA);
    return (isA(l.author) && (l.recipients || []).some(isB)) || (isB(l.author) && (l.recipients || []).some(isA));
}

const READ_TYPES = new Set(['read', 'heard', 'told', 'copied']);

// 时间线条目（从早到晚）
export function buildTimeline(archive, { a = '', b = '' } = {}) {
    const letters = Object.values(archive.letters || {})
        .filter(l => !a || involves(archive, l, a, b))
        .sort((x, y) => (dateOf(x) || '9999').localeCompare(dateOf(y) || '9999') || (floorOf(x) ?? 1e9) - (floorOf(y) ?? 1e9) || String(x.createdAt).localeCompare(String(y.createdAt)));
    const items = [];
    let prevDate = '';
    for (const l of letters) {
        const d = dateOf(l);
        const dv = l.delivery || null;
        const readers = [];
        for (const e of l.events || []) {
            if (!READ_TYPES.has(e.type) || !e.who) continue;
            if (!readers.some(r => sameName(archive, r.who, e.who))) readers.push({ who: e.who, date: e.date || '', type: e.type });
        }
        for (const m of l.memories || []) if (!readers.some(r => sameName(archive, r.who, m.person))) readers.push({ who: m.person, date: '', type: 'memory' });
        const forwarded = (l.events || []).find(e => e.type === 'forwarded');
        const arrivedAt = dv?.arrivedAt || (l.events || []).find(e => e.type === 'received' && (l.recipients || []).some(r => sameName(archive, r, e.who)))?.date || '';
        const replies = Object.values(archive.letters || {}).filter(x => x.inReplyTo === l.id);
        // 寄出以后，收信人有没有回过信（不一定标了“回复”）
        const answered = replies.length > 0 || Object.values(archive.letters || {}).some(x =>
            x.id !== l.id && (l.recipients || []).some(r => sameName(archive, r, x.author)) && (x.recipients || []).some(r => sameName(archive, r, l.author)) && dateOf(x) && d && dateOf(x) > d);
        items.push({
            letter: l,
            date: d,
            floor: floorOf(l),
            story: letterStory(l),
            month: d ? d.slice(0, 7) : '',
            gap: prevDate && d ? daysBetween(prevDate, d) : null,
            from: l.author,
            to: (l.recipients || []).join('、'),
            via: dv?.via || '',
            transit: dv?.status === 'transit' || dv?.status === 'atVia' || dv?.status === 'held',
            stage: dv?.status || '',
            eta: dv?.eta || '',
            arrivedAt,
            forwarded: forwarded ? { who: forwarded.who, date: forwarded.date } : null,
            readers,
            where: whereNow(l),
            inReplyTo: l.inReplyTo && archive.letters[l.inReplyTo] ? archive.letters[l.inReplyTo] : null,
            replies,
            answered,
        });
        if (d) prevDate = d;
    }
    return items;
}

// 一对人之间的小结：各写了几封、最近一封、谁欠谁一封回信
export function pairSummary(archive, a, b) {
    const items = buildTimeline(archive, { a, b }).filter(i => i.letter.status !== 'draft');
    const fromA = items.filter(i => sameName(archive, a, i.from)).length;
    const fromB = items.length - fromA;
    const last = items.filter(i => i.date).at(-1) || items.at(-1) || null;
    let owes = '';
    const inTransit = items.filter(i => i.transit);
    if (last && last.transit) return { total: items.length, fromA, fromB, last, owes: '', inTransit };
    if (last && last.letter.status === 'sent' && !last.answered) {
        const lastFromA = sameName(archive, a, last.from);
        owes = lastFromA ? b : a;
    }
    return { total: items.length, fromA, fromB, last, owes, inTransit };
}
