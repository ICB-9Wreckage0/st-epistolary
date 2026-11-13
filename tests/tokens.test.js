import test from 'node:test';
import assert from 'node:assert/strict';
import { trimOldLetters } from '../src/tokens.js';
import { memoryEntryContent, memoryQuotes } from '../src/correspondence.js';

const block = (code, n) => `【信件 ${code}｜文森特 写给 提奥｜1890-03-17】\n\n（规则……）\n\n${'信的正文。'.repeat(n)}\n\n【信件完】`;

test('旧消息里的信只留一句话；最近几层和聊天记录本身不动', () => {
    const chat = [
        { mes: `我拆开了 ${block('【信1】', 200)}`, is_user: true },
        { mes: '他读完了。' },
        { mes: `再看一封 ${block('【信2】', 200)}`, is_user: true },
        { mes: '好。' },
    ];
    const original = chat.map(m => m);
    const saved = trimOldLetters(chat, 2);
    assert.ok(saved > 900);
    assert.match(chat[0].mes, /^我拆开了 【信件 【信1】｜文森特 写给 提奥｜1890-03-17】（这封信之前已经整封读过/);
    assert.ok(!chat[0].mes.includes('信的正文'));
    assert.ok(chat[2].mes.includes('信的正文')); // 最近 2 层不动
    assert.ok(original[0].mes.includes('信的正文')); // 原来的消息对象没被改
    assert.notEqual(chat[0], original[0]);
    assert.equal(trimOldLetters(chat, 0), 0);
});

test('精简的记忆条目', () => {
    const L = { author: '文森特', recipients: ['提奥'], writtenAt: '1890-03-17', code: '【信1】' };
    const m = { person: '提奥', weight: 3, gist: '文森特说父亲留了一封信', text: '提奥记得信里写着「父亲临终前给我写过一封信」，还有「我一直没有拆开」。' + '很长的回忆。'.repeat(80), learned: [{ about: '文森特', kind: '家庭', fact: '父亲留了一封信' }] };
    const full = memoryEntryContent(L, m, '');
    const short = memoryEntryContent(L, m, '', { compact: true });
    assert.ok(short.length < full.length / 3);
    assert.match(short, /文森特说父亲留了一封信\n记得的原话：「父亲临终前给我写过一封信」「我一直没有拆开」\n记得很清楚/);
    assert.match(short, /提奥 从这封信里新知道了/);
    assert.deepEqual(memoryQuotes('「a1」「b2」「c3」', 2), ['a1', 'b2']);
});
