import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchive, createLetter } from '../src/model.js';
import { findReadingScenes, sceneText, quoteSamples } from '../src/memoryscan.js';

const body = 'Paris, le 27 juin 1890\n\n亲爱的文森特：\n\n提奥说你最近又在画麦田了，我很想看看那些在风里起伏的金黄色。\n\n每个月底我都会寄一封信来，你不必急着回。\n\n勒鲁';

function setup() {
    const a = createArchive();
    const l = createLetter(a, { author: '勒鲁', recipients: ['文森特'], body, status: 'sent' });
    const chat = [
        { name: '提奥', mes: '提奥在画廊里整理账册。' },                                   // 0
        { name: 'E', is_user: true, mes: '（继续）' },                                       // 1
        { name: '提奥', mes: '他拆开信。“我很想看看那些在风里起伏的金黄色”——提奥笑了。' }, // 2 引用原句
        { name: 'E', is_user: true, mes: '（继续）' },                                       // 3
        { name: '提奥', mes: '几天后。' },                                                   // 4
        { name: '提奥', mes: '天气很好。' },                                                 // 5
        { name: 'E', is_user: true, mes: `他又读了${l.code}。\n\n【信件 ${l.code}｜勒鲁 写给 文森特】\n\n${body}\n\n【信件完】` }, // 6 暗号
        { name: '文森特', mes: '文森特把信读了两遍。' },                                     // 7
        { name: '文森特', mes: '很多天过去了。' },                                           // 8
        { name: '文森特', mes: '……' },                                                       // 9
        { name: '文森特', mes: '……' },                                                       // 10
        { name: '文森特', mes: '他想起勒鲁那封信，又笑了。' },                               // 11 提到
        { name: '文森特', mes: '……' },                                                       // 12
    ];
    return { l, chat };
}

test('找出过去读信的楼层', () => {
    const { l, chat } = setup();
    const sc = findReadingScenes(chat, l);
    const find = r => sc.find(s => s.reasons.includes(r));
    assert.ok(find('quote') && find('quote').from <= 2 && find('quote').to >= 2);
    assert.deepEqual([find('code').from, find('code').to], [6, 7]);
    assert.ok(find('mention') && !find('mention').strong);
    assert.ok(find('code').strong);
});

test('原文所在的那一层', () => {
    const { l, chat } = setup();
    l.source = { chatId: 'c1', mes: 4 };
    const sc = findReadingScenes(chat, l, { chatId: 'c1' });
    assert.ok(sc.some(s => s.reasons.includes('source') && s.from <= 4 && s.to >= 5));
    assert.ok(!findReadingScenes(chat, l, { chatId: 'other' }).some(s => s.reasons.includes('source')));
});

test('拼剧情时信件块换成一句话', () => {
    const { chat } = setup();
    const t = sceneText(chat, 6, 7);
    assert.match(t, /\[第 6 层\]/);
    assert.match(t, /附信原文略/);
    assert.ok(!t.includes('每个月底'));
});

test('原句片段不取称呼和落款', () => {
    const s = quoteSamples(body);
    assert.ok(s.length > 0);
    assert.ok(s.every(x => !x.includes('亲爱的') && !x.includes('勒鲁')));
});
