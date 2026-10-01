// 书信簿 · 信现在在谁手里
// 寄出、送到、转交时按寄送状态推算；剧情里写到“放进抽屉”“烧了”“随身带着”，读信记忆整理时顺便记下；也可以手动改。
// 信还在身边的人，想起来时可以拿出来重读；信不在了，就只能凭记忆。

export const WHERE_STATES = {
    kept: { icon: '🗄', label: '收着' },          // 放在抽屉、信匣、书里……
    carried: { icon: '👜', label: '随身带着' },
    transit: { icon: '📮', label: '在路上' },
    given: { icon: '🤝', label: '交给了别人' },
    burned: { icon: '🔥', label: '烧了 / 毁了' },
    lost: { icon: '❓', label: '丢了' },
    draft: { icon: '✎', label: '还没寄出' },
    unknown: { icon: '·', label: '不清楚' },
};

// 还能拿出来重读的状态
export const REREADABLE = new Set(['kept', 'carried', 'draft']);

export function normalizeWhere(w) {
    if (!w || typeof w !== 'object') return null;
    const state = WHERE_STATES[w.state] ? w.state : 'unknown';
    const out = {
        holder: String(w.holder || '').trim().slice(0, 60),
        place: String(w.place || '').trim().slice(0, 120),
        state,
        note: String(w.note || '').trim().slice(0, 200),
        date: String(w.date || '').trim(),
        mes: Number.isInteger(w.mes) ? w.mes : null,
        by: ['ai', 'user', 'delivery'].includes(w.by) ? w.by : 'user',
        stamp: String(w.stamp || ''),
    };
    return out.holder || out.place || out.state !== 'unknown' ? out : null;
}

export function normalizeWhereabouts(x) {
    const cur = normalizeWhere(x?.current);
    const history = Array.isArray(x?.history) ? x.history.map(normalizeWhere).filter(Boolean).slice(-30) : [];
    return { current: cur, history };
}

// 寄送状态的指纹：寄送状态变了，之前记下的位置就过时了
export function deliveryStamp(letter) {
    const d = letter.delivery;
    if (!d) return `${letter.status}`;
    return `${letter.status}|${d.status || ''}|${d.stage || ''}`;
}

// 只看寄送状态推出来的位置
export function derivedWhere(letter) {
    const d = letter.delivery;
    const to = letter.recipients?.[0] || '';
    if (letter.status === 'draft') return { holder: letter.author, state: 'draft', place: '', note: '' };
    if (letter.status === 'unsent') return { holder: letter.author, state: 'kept', place: '', note: '写好了没寄' };
    if (letter.status === 'sealed') return { holder: letter.author, state: 'kept', place: '', note: '封好了，还没寄' };
    if (letter.status === 'lost') return { holder: '', state: 'lost', place: '', note: '' };
    if (d) {
        const via = d.via || '';
        if (d.status === 'transit') return { holder: '', state: 'transit', place: '', note: d.stage === 'toVia' ? `寄往 ${via}` : `寄往 ${to}` };
        if (d.status === 'atVia' || d.status === 'held') return { holder: via, state: 'kept', place: '', note: `等着转交给 ${to}` };
        if (d.status === 'arrived' || d.status === 'viewed') return { holder: d.reader || to, state: 'kept', place: '', note: '' };
    }
    if (letter.status === 'sent') return { holder: to, state: 'kept', place: '', note: '（推测：已经送到）', guess: true };
    return { holder: '', state: 'unknown', place: '', note: '' };
}

// 现在在哪：手动 / 剧情里记下的优先；寄送状态变了以后，以寄送状态为准
export function whereNow(letter) {
    const cur = letter.whereabouts?.current;
    if (cur && (!cur.stamp || cur.stamp === deliveryStamp(letter))) return { ...cur, derived: false };
    return { ...derivedWhere(letter), derived: true };
}

// 记下新位置（旧的进历史）
export function setWhere(letter, w, { by = 'user', date = '', mes = null } = {}) {
    const next = normalizeWhere({ ...w, by, date, mes, stamp: deliveryStamp(letter) });
    if (!next) return false;
    letter.whereabouts = normalizeWhereabouts(letter.whereabouts);
    const cur = letter.whereabouts.current;
    if (cur && cur.holder === next.holder && cur.place === next.place && cur.state === next.state) return false;
    if (cur) letter.whereabouts.history.push(cur);
    letter.whereabouts.history = letter.whereabouts.history.slice(-30);
    letter.whereabouts.current = next;
    return true;
}

// 撤回某一层记下的位置（换了回复 / 删了消息）
export function revokeWhere(letter, mesFrom) {
    const w = letter.whereabouts;
    if (!w?.current || w.current.by !== 'ai' || w.current.mes == null || w.current.mes < mesFrom) return false;
    w.current = w.history.pop() || null;
    return true;
}

export function whereText(w) {
    if (!w) return '不清楚';
    const s = WHERE_STATES[w.state] || WHERE_STATES.unknown;
    const note = w.note && !w.guess ? ` — ${w.note}` : '';
    if (w.state === 'transit') return `${s.icon} 在路上${w.note ? `（${w.note}）` : ''}`;
    if (w.state === 'burned' || w.state === 'lost') return `${s.icon} ${s.label}${w.holder ? `（${w.holder}）` : ''}${note}`;
    if (w.state === 'given') return `${s.icon} 交给了 ${w.holder || '别人'}${w.place ? ` · ${w.place}` : ''}${note}`;
    if (w.state === 'draft') return `${s.icon} 还在 ${w.holder || '写信人'} 手里，没寄出${note}`;
    if (!w.holder) return `${s.icon} ${s.label}${w.place ? ` · ${w.place}` : ''}${note}`;
    return `${s.icon} 在 ${w.holder} 手里${w.place ? ` · ${w.place}` : ''}${w.state === 'carried' ? '（随身带着）' : ''}${note}`;
}

// 给世界书 / AI 的一句话：这个人现在还能不能拿出这封信
export function whereForPerson(letter, person, sameName = (a, b) => a === b) {
    const w = whereNow(letter);
    if (w.state === 'transit') return '这封信现在不在任何人手里，正在路上。';
    if (w.state === 'burned') return `这封信已经${w.holder ? `被 ${w.holder} ` : ''}烧掉 / 毁掉了，只剩记忆。`;
    if (w.state === 'lost') return '这封信已经丢了，只剩记忆。';
    if (w.holder && sameName(w.holder, person)) {
        if (REREADABLE.has(w.state)) return `这封信还在 ${person} 手里${w.place ? `（${w.place}）` : ''}，想逐字确认时可以拿出来重读。`;
        return `这封信在 ${person} 这里${w.place ? `（${w.place}）` : ''}。`;
    }
    if (w.holder) return `这封信现在在 ${w.holder} 手里${w.place ? `（${w.place}）` : ''}，${person} 手边没有，只能凭记忆。`;
    return '';
}
