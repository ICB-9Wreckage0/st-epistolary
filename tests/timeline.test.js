import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchive, createLetter, normalizePerson } from '../src/model.js';
import { correspondentPairs, buildTimeline, pairSummary } from '../src/timeline.js';
import { whereNow, setWhere, suggestWhere, acceptSuggestion, revokeWhere, whereText, whereForPerson, deliveryText, deliveryState, normalizeWhereabouts } from '../src/whereabouts.js';

function setup() {
    const a = createArchive();
    a.people.push(normalizePerson({ name: '文森特', aliases: ['Vincent'] }));
    const l1 = createLetter(a, { author: '勒鲁', recipients: ['文森特'], writtenAt: '1890-06-27', body: '一', status: 'sent' });
    const l2 = createLetter(a, { author: 'Vincent', recipients: ['勒鲁'], writtenAt: '1890-07-05', body: '二', status: 'sent', inReplyTo: l1.id });
    const l3 = createLetter(a, { author: '勒鲁', recipients: ['文森特'], writtenAt: '1890-08-01', body: '三', status: 'sent' });
    createLetter(a, { author: '提奥', recipients: ['文森特'], writtenAt: '1890-07-01', body: '四', status: 'sent' });
    return { a, l1, l2, l3 };
}

test('通信的两个人（别名算同一个人）', () => {
    const { a } = setup();
    const p = correspondentPairs(a);
    assert.equal(p[0].count, 3);
    assert.deepEqual([p[0].a, p[0].b].sort(), ['勒鲁', '文森特'].sort());
    assert.equal(p.length, 2);
});

test('时间线：顺序、间隔、回复、谁欠回信', () => {
    const { a, l1, l3 } = setup();
    const t = buildTimeline(a, { a: '勒鲁', b: '文森特' });
    assert.deepEqual(t.map(i => i.date), ['1890-06-27', '1890-07-05', '1890-08-01']);
    assert.equal(t[1].gap, 8);
    assert.equal(t[1].inReplyTo.id, l1.id);
    assert.ok(t[0].answered);
    assert.ok(!t[2].answered);
    const s = pairSummary(a, '勒鲁', '文森特');
    assert.equal(s.fromA + s.fromB, 3);
    assert.equal(s.owes, '文森特');
    assert.equal(s.last.letter.id, l3.id);
});

test('寄送和在谁手里分开：位置只记用户填的，AI 只给建议', () => {
    const { l1 } = setup();
    assert.equal(whereNow(l1), null);
    assert.match(deliveryText(l1), /已寄出/);
    assert.ok(suggestWhere(l1, { holder: '提奥', place: '抽屉', state: 'kept' }, { mes: 10 }));
    assert.equal(whereNow(l1), null);
    assert.equal(whereForPerson(l1, '提奥'), '');
    assert.ok(acceptSuggestion(l1));
    assert.equal(whereNow(l1).holder, '提奥');
    assert.match(whereText(whereNow(l1)), /提奥.*抽屉/);
    assert.match(whereForPerson(l1, '提奥'), /重读/);
    assert.match(whereForPerson(l1, '文森特'), /凭记忆/);
    // 寄送状态变了，位置不动
    l1.delivery = { status: 'transit', mode: 'date', eta: '1890-07-01' };
    assert.equal(deliveryState(l1), 'transit');
    assert.equal(whereNow(l1).holder, '提奥');
    assert.match(deliveryText(l1), /在路上.*1890-07-01/);
    l1.delivery = { status: 'atVia', via: '提奥' };
    assert.match(deliveryText(l1), /转交人 提奥/);
    // 建议被撤回
    suggestWhere(l1, { holder: '文森特', state: 'burned' }, { mes: 20 });
    assert.ok(revokeWhere(l1, 15));
    assert.equal(l1.whereabouts.suggest, null);
    // 旧版本 AI 直接写进去的，读进来变成建议
    const old = normalizeWhereabouts({ current: { holder: 'X', state: 'kept', by: 'ai' } });
    assert.equal(old.current, null);
    assert.equal(old.suggest.holder, 'X');
});
