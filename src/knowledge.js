// 书信簿 · 谁知道什么
// 按人看：TA 读过哪些信、从信里知道了别人的什么事；TA 写的信谁读过、别人从中知道了 TA 的什么事。
// 只在本地整理，不调用 AI。数据来自每封信的读后记忆（memories）和里面的“新知道的事”（learned）。

import { sameName, normalizeLearned, isNote, noteWord } from './model.js';

// 有记录的人：写过信、收过信、读过信的，按“读过 + 写过”的多少排
export function knowledgePeople(archive) {
    const map = new Map();
    const add = (name, k) => {
        const n = String(name || '').trim();
        if (!n) return;
        const key = [...map.keys()].find(x => sameName(archive, x, n)) || n;
        const v = map.get(key) || { name: key, read: 0, wrote: 0, facts: 0 };
        v[k]++;
        map.set(key, v);
    };
    for (const l of Object.values(archive.letters || {})) {
        if (l.status === 'draft') continue;
        add(l.author, 'wrote');
        // 同一个人在好几个聊天里读过同一封信：算一次；“新知道的事”去重
        const seen = [];
        for (const m of l.memories || []) {
            const prev = seen.find(x => sameName(archive, x.person, m.person));
            if (!prev) { add(m.person, 'read'); seen.push({ person: m.person, facts: new Set() }); }
            const facts = (prev || seen[seen.length - 1]).facts;
            for (const f of normalizeLearned(m.learned)) if (!facts.has(f.fact)) { facts.add(f.fact); add(m.person, 'facts'); }
        }
    }
    return [...map.values()].sort((a, b) => (b.read + b.wrote + b.facts) - (a.read + a.wrote + a.facts) || a.name.localeCompare(b.name, 'zh'));
}

// 一个人知道什么
export function knowledgeOf(archive, person) {
    const same = (a, b) => sameName(archive, a, b);
    const letters = Object.values(archive.letters || {}).filter(l => l.status !== 'draft');
    const read = [];     // [{ letter, memory }]
    const learned = [];  // [{ about, kind, fact, letter, person, i }]  这个人从信里知道的
    const wrote = [];    // [{ letter, readers: [{ person, weight, gist }] }]
    const aboutMe = [];  // [{ who, kind, fact, letter, i }]  别人从信里知道的关于这个人的事
    for (const l of letters) {
        (l.memories || []).forEach((m, mi) => {
            const facts = normalizeLearned(m.learned);
            if (same(m.person, person)) {
                read.push({ letter: l, memory: m });
                facts.forEach((f, i) => learned.push({ ...f, about: f.about || l.author || '', letter: l, person: m.person, mi, i }));
            } else {
                facts.forEach((f, i) => { if (same(f.about || l.author, person)) aboutMe.push({ who: m.person, kind: f.kind, fact: f.fact, letter: l, mi, i }); });
            }
        });
        if (same(l.author, person)) {
            wrote.push({ letter: l, readers: (l.memories || []).filter(m => !same(m.person, person)).map(m => ({ person: m.person, weight: m.weight || null, gist: m.gist || '' })) });
        }
    }
    const byDate = (a, b) => String(a.letter.writtenAt || a.letter.createdAt || '').localeCompare(String(b.letter.writtenAt || b.letter.createdAt || ''));
    read.sort(byDate);
    wrote.sort(byDate);
    // 新知道的事按“关于谁”分组，组内按信的先后
    const groups = new Map();
    for (const f of learned.sort(byDate)) {
        const key = [...groups.keys()].find(k => same(k, f.about)) || f.about || '（没写关于谁）';
        if (!groups.has(key)) groups.set(key, []);
        if (!groups.get(key).some(x => x.fact === f.fact)) groups.get(key).push(f);
    }
    return { person, read, wrote, learnedBy: [...groups.entries()].map(([about, facts]) => ({ about, facts })), aboutMe: aboutMe.sort(byDate) };
}

// 一句话说清是哪封信 / 哪张纸条（界面上用）
export function letterLabel(l) {
    const w = isNote(l) ? noteWord(l) : '信';
    return l.blurb || `${l.author || '？'}${l.writtenAt ? ` ${l.writtenAt}` : ''} 写给 ${(l.recipients || []).join('、') || '？'} 的${w}`;
}
