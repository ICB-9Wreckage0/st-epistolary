import test from 'node:test';
import assert from 'node:assert/strict';
import { detectInMessage, detectInChat, sliceVerbatim, parseImportResponse, guessRecipient, guessAuthor, findDuplicate } from '../src/importer.js';
import { createArchive, createLetter } from '../src/model.js';
import { parseStoryDate } from '../src/correspondence.js';

const MSG = `她坐在窗前，展开信纸，写下：

> 亲爱的文森特：
>
> 你在圣雷米还好吗？钱够用吗？
>
> 我在佛罗里达看到了灌丛鸦，蓝得像你的颜料。
>
> 紧握你的手，
> E.

写完，她把信折好，放进信封。`;

test('按格式识别：去掉引用符号，截出完整的信，不带前后的叙述', () => {
    const r = detectInMessage(MSG);
    assert.equal(r.length, 1);
    assert.ok(r[0].text.startsWith('亲爱的文森特：'));
    assert.ok(r[0].text.endsWith('E.'));
    assert.ok(!r[0].text.includes('窗前'));
    assert.ok(!r[0].text.includes('写完'));
});

test('按格式识别：法语信带日期行和附言', () => {
    const t = "Il écrivit :\n\nArles, le 3 mai 1888\nMon cher Théo,\n\nJ'ai reçu ta lettre.\n\nJe te serre la main,\nVincent\n\nP.S. Écris vite.\n\nPuis il sortit.";
    const r = detectInMessage(t);
    assert.equal(r.length, 1);
    assert.ok(r[0].text.startsWith('Arles, le 3 mai 1888'));
    assert.ok(r[0].text.includes('P.S.'));
    assert.ok(!r[0].text.includes('Puis il sortit'));
});

test('普通对话不会被当成信', () => {
    assert.equal(detectInMessage('文森特：你来了！\n\n我们去散步吧。').length, 0);
});

test('猜收信人、写信人', () => {
    assert.equal(guessRecipient('亲爱的文森特：'), '文森特');
    assert.equal(guessRecipient('父亲大人膝下：'), '父亲');
    assert.equal(guessRecipient('Mon cher Théo,'), 'Théo');
    assert.equal(guessAuthor('儿 敬上'), '儿');
    assert.equal(guessAuthor('Vincent'), 'Vincent');
});

test('整段聊天：记下消息编号，跳过本插件发进去的信', () => {
    const chat = [
        { name: 'E.', is_user: true, mes: MSG },
        { name: '文森特', is_user: false, mes: '他读完信，笑了。' },
        { name: 'E.', is_user: true, mes: MSG, extra: { epistolary: { kind: 'letter' } } },
    ];
    const r = detectInChat(chat);
    assert.equal(r.length, 1);
    assert.equal(r[0].mesIndex, 0);
    assert.equal(r[0].recipient, '文森特');
});

test('AI 识别：只按起止片段从原文逐字截取，对不上就丢弃', () => {
    const v = sliceVerbatim(MSG, '亲爱的文森特：你在圣雷米', '紧握你的手，E.');
    assert.ok(v.startsWith('亲爱的文森特：'));
    assert.ok(v.endsWith('E.'));
    assert.ok(v.includes('灌丛鸦'));
    assert.equal(sliceVerbatim(MSG, '亲爱的高更', 'E.'), null);
});

test('解析 AI 返回的 JSON（夹杂说明文字也行）', () => {
    const r = parseImportResponse('找到一封：\n```json\n[{"message": 3, "start": "a", "end": "b"}]\n```');
    assert.equal(r.length, 1);
    assert.equal(parseImportResponse('没有').length, 0);
});

test('查重', () => {
    const a = createArchive();
    const l = createLetter(a, { body: '亲爱的文森特：\n\n你在圣雷米还好吗？钱够用吗？我在佛罗里达看到了灌丛鸦，蓝得像你的颜料。\n\n紧握你的手，\nE.' });
    assert.equal(findDuplicate(a, l.body.replace(/\n/g, '\n\n')), l.id);
    assert.equal(findDuplicate(a, '完全不同的一封信，内容是别的事情，写给另一个人的，长度也差不多足够长了吧。'), null);
});

test('剧情日期：不倒退，格式不对就不要', () => {
    assert.equal(parseStoryDate('1889-06-17', '1889-06-10'), '1889-06-17');
    assert.equal(parseStoryDate('现在是1889年6月20日。', '1889-06-17'), '1889-06-20');
    assert.equal(parseStoryDate('1889-06-01', '1889-06-10'), null);
    assert.equal(parseStoryDate('不知道', '1889-06-10'), null);
});

test('称呼里带空格和外文名（亲爱的 E.：）也能认出来', () => {
    const r = detectInMessage('他写道：\n\n> 亲爱的 E.：\n>\n> 你上次问我天空是什么颜色。我想了好几天。\n>\n> 紧握你的手，\n> 文森特\n\n他把信折好。');
    assert.equal(r.length, 1);
    assert.ok(r[0].text.startsWith('亲爱的 E.：'));
    assert.equal(guessRecipient(r[0].salutation), 'E.');
});

// ---------- 空壳信 ----------
import { parseShellResponse, buildShellPrompt, findShellDuplicate } from '../src/importer.js';
import { createArchive as mkA, createLetter as mkL } from '../src/model.js';

test('空壳信：解析 AI 的结果，每封一项', () => {
    const r = parseShellResponse('[{"message": 649, "author": "勒鲁", "recipients": "文森特", "label": "1er juillet", "holder": "提奥", "target": "1890-07-01", "legDays": "1", "state": "withVia", "wax": "red"}, {"author": "", "recipients": []}]');
    assert.equal(r.length, 1);
    assert.deepEqual(r[0].recipients, ['文森特']);
    assert.equal(r[0].legDays, 1);
    assert.equal(r[0].wax, '');
    assert.equal(r[0].state, 'withVia');
    assert.deepEqual(parseShellResponse('没有'), []);
    assert.match(buildShellPrompt([{ idx: 1, name: 'A', text: 'x' }]).prompt, /每封单独列一项/);
    const a = mkA();
    const l = mkL(a, { author: '勒鲁', recipients: ['文森特'], title: '1er juillet', body: '', shell: true });
    assert.equal(findShellDuplicate(a, r[0]), l.id);
});

test('边想边写：信中间的旁白不进正文', () => {
    const t = '*文森特铺开信纸，写道：*\n\n亲爱的 E.：\n\n你的信我收到了。这几天麦田全黄了，我每天早上都出去画。\n\n*写到这里，他停下笔，望着窗外出神。*\n\n他蘸了蘸墨，又写道：\n\n等秋天到了，我想再画一次星空。\n\n紧握你的手，\n文森特';
    const [r] = detectInMessage(t);
    assert.ok(r);
    assert.ok(!r.text.includes('停下笔'));
    assert.ok(!r.text.includes('蘸了蘸墨'));
    assert.ok(r.text.includes('再画一次星空'));
    const q = '他坐下来写信。\n\n> 亲爱的 E.：\n>\n> 你好吗？这里的天气很好，我在画麦田，每天都很忙。\n\n他顿了顿，没有写下去。\n\n> 想念你。\n>\n> 紧握你的手，\n> 文森特';
    assert.ok(!detectInMessage(q)[0].text.includes('顿了顿'));
});
