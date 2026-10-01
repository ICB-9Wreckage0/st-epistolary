// 书信簿 · 信的两件事，分开记：
//   ① 寄送：草稿 / 没寄 / 在路上 / 在转交人那里 / 已送到 —— 看 letter.status 和 letter.delivery
//   ② 信在谁手里：收着 / 随身带着 / 交给了别人 / 烧了 / 丢了 —— 只记你自己填的
// AI 不直接改“信在谁手里”，只给建议（whereabouts.suggest），你点“采用”才算数。

export const WHERE_STATES = {
    kept: { icon: '🗄', label: '收着' },          // 放在抽屉、信匣、书里……
    carried: { icon: '👜', label: '随身带着' },
    given: { icon: '🤝', label: '交给了别人' },
    burned: { icon: '🔥', label: '烧了 / 毁了' },
    lost: { icon: '❓', label: '丢了' },
    unknown: { icon: '·', label: '不清楚' },
};

// 还能拿出来重读的状态
export const REREADABLE = new Set(['kept', 'carried']);

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
        by: ['ai', 'user'].includes(w.by) ? w.by : 'user',
        chatId: String(w.chatId || ''),
        swipe: Number.isInteger(w.swipe) ? w.swipe : null,
    };
    return out.holder || out.place || out.state !== 'unknown' ? out : null;
}

export function normalizeWhereabouts(x) {
    let cur = normalizeWhere(x?.current);
    // 旧版本里 AI 直接写进去的位置，改成建议，等你确认
    let suggest = normalizeWhere(x?.suggest);
    if (cur && x?.current?.by === 'ai') { suggest = suggest || cur; cur = null; }
    const history = Array.isArray(x?.history) ? x.history.map(normalizeWhere).filter(Boolean).filter(h => h.by !== 'ai').slice(-30) : [];
    return { current: cur, suggest, history };
}

// 信在谁手里：只有你填过的才算；没填就是 null
export function whereNow(letter) {
    return letter.whereabouts?.current || null;
}

// 你自己记下新位置（旧的进历史）
export function setWhere(letter, w, { date = '' } = {}) {
    const next = normalizeWhere({ ...w, by: 'user', date });
    letter.whereabouts = normalizeWhereabouts(letter.whereabouts);
    const cur = letter.whereabouts.current;
    if (!next && !cur) return false;
    if (cur && next && cur.holder === next.holder && cur.place === next.place && cur.state === next.state && cur.note === next.note) return false;
    if (cur) letter.whereabouts.history.push(cur);
    letter.whereabouts.history = letter.whereabouts.history.slice(-30);
    letter.whereabouts.current = next;
    letter.whereabouts.suggest = null;
    return true;
}

// AI 从剧情里看出来的位置：只当建议
export function suggestWhere(letter, w, { date = '', mes = null, chatId = '', swipe = null } = {}) {
    const next = normalizeWhere({ ...w, by: 'ai', date, mes, chatId, swipe });
    if (!next) return false;
    letter.whereabouts = normalizeWhereabouts(letter.whereabouts);
    const cur = letter.whereabouts.current;
    if (cur && cur.holder === next.holder && cur.place === next.place && cur.state === next.state) return false;
    const old = letter.whereabouts.suggest;
    if (old && old.holder === next.holder && old.place === next.place && old.state === next.state) return false;
    letter.whereabouts.suggest = next;
    return true;
}

export function acceptSuggestion(letter) {
    const s = letter.whereabouts?.suggest;
    if (!s) return false;
    return setWhere(letter, s, { date: s.date });
}

export function dismissSuggestion(letter) {
    if (!letter.whereabouts?.suggest) return false;
    letter.whereabouts.suggest = null;
    return true;
}

// 换了回复 / 删了消息：那一层来的建议作废
export function revokeWhere(letter, mesFrom, chatId = '') {
    const s = letter.whereabouts?.suggest;
    if (!s || s.mes == null || s.mes < mesFrom || (s.chatId && chatId && s.chatId !== chatId)) return null;
    letter.whereabouts.suggest = null;
    return s;
}

export function whereText(w) {
    if (!w) return '没记';
    const s = WHERE_STATES[w.state] || WHERE_STATES.unknown;
    const note = w.note ? ` — ${w.note}` : '';
    if (w.state === 'burned' || w.state === 'lost') return `${s.icon} ${s.label}${w.holder ? `（${w.holder}）` : ''}${note}`;
    if (w.state === 'given') return `${s.icon} 交给了 ${w.holder || '别人'}${w.place ? ` · ${w.place}` : ''}${note}`;
    if (!w.holder) return `${s.icon} ${s.label}${w.place ? ` · ${w.place}` : ''}${note}`;
    return `${s.icon} 在 ${w.holder} 手里${w.place ? ` · ${w.place}` : ''}${w.state === 'carried' ? '（随身带着）' : ''}${note}`;
}

// ---------- 寄送状态（和“在谁手里”分开） ----------

export const DELIVERY_STATES = {
    draft: '草稿',
    unsent: '写好了，没寄',
    transit: '已寄出，在路上',
    atVia: '在转交人那里，还没转交',
    delivered: '已送到',
    lost: '寄丢了',
};

// 这封信现在处在哪一步
export function deliveryState(letter) {
    if (letter.status === 'draft') return 'draft';
    if (letter.status === 'unsent' || letter.status === 'sealed') return 'unsent';
    if (letter.status === 'lost') return 'lost';
    const d = letter.delivery;
    if (d?.status === 'transit') return 'transit';
    if (['atVia', 'held', 'withheld'].includes(d?.status)) return 'atVia';
    return 'delivered';
}

// 一句话：寄送到哪一步了
export function deliveryText(letter) {
    const st = deliveryState(letter);
    const d = letter.delivery || {};
    const to = d.reader || letter.recipients?.[0] || '收信人';
    const via = d.via || '';
    switch (st) {
        case 'draft': return '✎ 草稿';
        case 'unsent': return letter.status === 'sealed' ? '✉ 封好了，没寄' : '✉ 写好了，没寄';
        case 'lost': return '❓ 寄丢了';
        case 'transit': return `📮 已寄出，在路上${via && d.stage === 'toVia' ? `（先寄给转交人 ${via}）` : ''}${d.eta ? ` · 预计 ${d.eta} 到` : ''}`;
        case 'atVia': return `🤝 在转交人 ${via || '？'} 那里，还没转交${d.status === 'withheld' ? '（扣下了）' : ''}`;
        default: {
            const rec = (letter.events || []).find(e => e.type === 'received');
            const known = !!(d.arrivedAt || d.status || rec);
            if (!known) return `📬 已寄出（没记送到）`;
            const when = d.arrivedAt || rec?.date || '';
            return `📬 已送到 ${d.reader || rec?.who || to}${when ? ` · ${when}` : ''}${letter.placeTo ? ` · ${letter.placeTo}` : ''}${via ? `（经 ${via} 转交）` : ''}`;
        }
    }
}

// 给世界书 / AI 的一句话：这个人现在还能不能拿出这封信（只看你填的位置）
export function whereForPerson(letter, person, sameName = (a, b) => a === b) {
    if (deliveryState(letter) === 'transit') return '这封信现在正在路上。';
    const w = whereNow(letter);
    if (!w) return '';
    if (w.state === 'burned') return `这封信已经${w.holder ? `被 ${w.holder} ` : ''}烧掉 / 毁掉了，只剩记忆。`;
    if (w.state === 'lost') return '这封信已经丢了，只剩记忆。';
    if (w.holder && sameName(w.holder, person)) {
        if (REREADABLE.has(w.state)) return `这封信还在 ${person} 手里${w.place ? `（${w.place}）` : ''}，想逐字确认时可以拿出来重读。`;
        return `这封信在 ${person} 这里${w.place ? `（${w.place}）` : ''}。`;
    }
    if (w.holder) return `这封信现在在 ${w.holder} 手里${w.place ? `（${w.place}）` : ''}，${person} 手边没有，只能凭记忆。`;
    return '';
}
