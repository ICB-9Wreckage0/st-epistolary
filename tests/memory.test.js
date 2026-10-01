import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchive, createLetter, normalizeLetter } from '../src/model.js';
import { buildMemoryPrompt, parseMemories, checkQuotes, memoryEntryContent, memoryKeys } from '../src/correspondence.js';

const body = 'Paris, le 27 juin 1890\n\n亲爱的文森特：\n\n不过，他毕竟是真心喜欢艺术的人。我每月会寄一封信来。\n\n勒鲁';

test('解析 AI 返回的记忆', () => {
    const got = parseMemories('好的：\n[{"person":"提奥","memory":"提奥记得……"},{"person":"","memory":"x"},{"person":"文森特"}]');
    assert.deepEqual(got, [{ person: '提奥', text: '提奥记得……' }]);
    assert.deepEqual(parseMemories('没有'), []);
    assert.deepEqual(parseMemories('[oops'), []);
});

test('「」里的原话不在信里，就标成大意', () => {
    const out = checkQuotes('他记得「不过，他毕竟是 真心喜欢艺术的人」，也记得「我会每天写信」。', body);
    assert.match(out, /「不过，他毕竟是 真心喜欢艺术的人」/);
    assert.match(out, /“我会每天写信”（大意）/);
});

test('世界书条目的内容和关键词', () => {
    const a = createArchive();
    const l = createLetter(a, { author: '勒鲁', recipients: ['文森特'], writtenAt: '1890-06-27', body, status: 'sent', recallKeys: '七月的信，那笔钱' });
    const c = memoryEntryContent(l, { person: '提奥', text: '提奥记得……' });
    assert.match(c, /^【提奥的记忆｜勒鲁 写给 文森特 的信（1890-06-27）】/);
    assert.match(c, new RegExp(l.code.replace(/[【】]/g, '.')));
    const keys = memoryKeys(l, ['Leroux']);
    const re = keys[0].match(/^\/(.*)\/i$/)[1];
    assert.ok(new RegExp(re, 'i').test('他又想起勒鲁的那封信'));
    assert.ok(new RegExp(re, 'i').test('the letter from Leroux'));
    assert.ok(!new RegExp(re, 'i').test('勒鲁走进了画廊。他什么也没说。'));
    assert.ok(keys.includes(l.code));
    assert.ok(keys.includes('七月的信') && keys.includes('那笔钱'));
});

test('旧档案没有记忆字段也能读', () => {
    const l = normalizeLetter({ body: 'x' }, 'L1');
    assert.deepEqual(l.memories, []);
    assert.deepEqual(l.recallKeys, []);
    const m = normalizeLetter({ body: 'x', memories: [{ person: '提奥', text: 't', wiUid: 3 }, { person: '', text: 'y' }] }, 'L2').memories;
    assert.equal(m.length, 1);
    assert.equal(m[0].wiUid, 3);
});

test('记忆提示词：带上已有记忆、排除用户', () => {
    const a = createArchive();
    const l = createLetter(a, { author: '勒鲁', recipients: ['文森特'], body, status: 'sent' });
    const { prompt } = buildMemoryPrompt(l, '提奥拆开信读了。', { existing: [{ person: '提奥', text: '旧记忆' }], userName: '勒鲁', storyDate: '1890-07-01' });
    assert.match(prompt, /勒鲁 是用户扮演的角色/);
    assert.match(prompt, /提奥：旧记忆/);
    assert.match(prompt, /1890-07-01/);
    assert.match(prompt, /毕竟是真心喜欢艺术的人/);
});

test('“相信”“信任”不算提到信', () => {
    const a = createArchive();
    const l = createLetter(a, { author: '勒鲁', recipients: ['文森特'], body, status: 'sent' });
    const re = new RegExp(memoryKeys(l)[0].match(/^\/(.*)\/i$/)[1], 'i');
    assert.ok(!re.test('勒鲁相信他会好起来'));
    assert.ok(!re.test('勒鲁很信任提奥'));
    assert.ok(re.test('勒鲁寄来的信'));
    assert.ok(re.test('那封信是勒鲁写的'));
});

test('新格式：记忆 + gist + 信的位置', async () => {
    const { parseMemoryResult, summaryEntryContent, letterOwnKeys, rereadKey } = await import('../src/correspondence.js');
    const r = parseMemoryResult('```json\n{"memories":[{"person":"提奥","memory":"提奥记得……","gist":"每月一封"}],"letter":{"holder":"提奥","place":"抽屉","state":"kept"}}\n```');
    assert.equal(r.memories[0].gist, '每月一封');
    assert.equal(r.where.place, '抽屉');
    assert.equal(parseMemoryResult('{"memories": [], "letter": null}').where, null);
    const a = createArchive();
    const l = createLetter(a, { author: '勒鲁', recipients: ['文森特'], writtenAt: '1890-07-01', body, status: 'sent' });
    const month = letterOwnKeys(l).find(k => k.startsWith('/'));
    const re = new RegExp(month.match(/^\/(.*)\/i$/)[1], 'i');
    assert.ok(re.test('七月那封信'));
    assert.ok(re.test('la lettre de juillet'));
    assert.ok(!re.test('八月那封信'));
    const rr = new RegExp(rereadKey(l).match(/^\/(.*)\/i$/)[1], 'i');
    assert.ok(rr.test('他从抽屉里翻出勒鲁的信'));
    assert.ok(!rr.test('勒鲁走了进来'));
    const sum = summaryEntryContent('提奥', '勒鲁', [{ letter: l, memory: { text: '提奥记得，信里说每月寄一封。', gist: '' }, where: '' }]);
    assert.match(sum, /一共读过 1 封/);
    assert.match(sum, /信里说每月寄一封/);
});

test('读信那一轮的经过：寄出 / 收到 / 读 / 剧情日期', async () => {
    const { parseMemoryResult } = await import('../src/correspondence.js');
    const r = parseMemoryResult('{"memories":[],"events":[{"type":"sent","who":"勒鲁","to":"提奥","date":"1890-06-28","mes":"12"},{"type":"received","who":"文森特","place":"奥维尔"},{"type":"飞走","who":"x"}],"storyDate":"1890-07-02","letter":null}');
    assert.equal(r.events.length, 2);
    assert.equal(r.events[0].mes, 12);
    assert.equal(r.events[0].to, '提奥');
    assert.equal(r.events[1].place, '奥维尔');
    assert.equal(r.events[1].mes, null);
    assert.equal(r.storyDate, '1890-07-02');
});
