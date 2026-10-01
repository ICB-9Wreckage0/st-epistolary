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
