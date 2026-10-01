import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchive, createLetter, normalizePerson } from '../src/model.js';
import { addDays, formatDateLine, guessLang, threadBetween, deliveryEvents, arrivalOf, buildReplyPrompt, cleanReply, buildReactionGuidance, EXAMPLE_PROFILES } from '../src/correspondence.js';
import { retrieve } from '../src/retrieval.js';

function setup() {
    const a = createArchive();
    a.people.push(normalizePerson(EXAMPLE_PROFILES.vangogh));
    a.people.push(normalizePerson({ name: '提奥', aliases: ['Theo'] }));
    const first = createLetter(a, { author: '文森特', recipients: ['提奥'], writtenAt: '1888-09-01', body: '亲爱的提奥：\n\n我在画一幅夜间咖啡馆。\n\n紧握你的手，\n文森特', status: 'sent' });
    const mine = createLetter(a, { author: 'EE', recipients: ['Vincent'], writtenAt: '1888-09-10', language: '法语（中文显示）', body: '亲爱的文森特：\n\n你在阿尔勒还好吗？钱够用吗？\n\n我在佛罗里达看到了灌丛鸦，蓝得像你的颜料。\n\nE.', status: 'sent' });
    mine.events = deliveryEvents(mine, '1888-09-14', []);
    const prev = createLetter(a, { author: '文森特', recipients: ['EE'], writtenAt: '1888-08-20', body: '亲爱的 E.：\n\n谢谢你的来信。\n\n文森特', status: 'sent' });
    return { a, first, mine, prev };
}

test('日期推算与信头格式', () => {
    assert.equal(addDays('1888-09-10', 4), '1888-09-14');
    assert.equal(addDays('1888-12-30', 3), '1889-01-02');
    assert.equal(addDays('某年秋', 3), '某年秋');
    assert.equal(formatDateLine('fr', 'Arles', '1888-09-01'), 'Arles, le 1er septembre 1888');
    assert.equal(formatDateLine('en', 'London', '1888-09-22'), 'London, 22nd September 1888');
    assert.equal(formatDateLine('zh', '巴黎', '1890-11-03'), '巴黎，1890年11月3日');
    assert.equal(guessLang('法语（中文显示）'), 'fr');
    assert.equal(guessLang(''), 'zh');
});

test('自动流转记录：寄出、收到、阅读，不重复添加', () => {
    const { mine } = setup();
    assert.deepEqual(mine.events.map(e => [e.type, e.who, e.date]), [
        ['sent', 'EE', '1888-09-10'], ['received', 'Vincent', '1888-09-14'], ['read', 'Vincent', '1888-09-14'],
    ]);
    assert.equal(deliveryEvents(mine, '1888-09-20', mine.events).length, 0);
});

test('往来信件串：按别名识别双方，按日期排序', () => {
    const { a, mine, prev } = setup();
    const t = threadBetween(a, '文森特·梵高', 'EE', mine.id);
    assert.deepEqual(t.map(l => l.id), [prev.id]);
    assert.equal(arrivalOf(a, mine, '梵高'), '1888-09-14');
});

test('回信提示词包含来信、往来、文风、语言与真实感要求', () => {
    const { a, mine, prev, first } = setup();
    const { system, prompt } = buildReplyPrompt(a, mine, '文森特', { replyDate: '1888-09-16' });
    assert.ok(system.includes('文森特'));
    assert.ok(prompt.includes('1888-09-14收到'));
    assert.ok(prompt.includes('§2 你在阿尔勒还好吗'));
    assert.ok(prompt.includes(prev.id));           // 往来
    assert.ok(prompt.includes(first.id));          // 本人写给别人的信
    assert.ok(prompt.includes('真实存在过的历史人物'));
    assert.ok(prompt.includes('铬黄'));            // 文风要点
    assert.ok(prompt.includes('不要用中文特有的套语'));
    assert.ok(prompt.includes('不会逐条答复'));
    assert.ok(prompt.includes('1888-09-16'));
});

test('没有文风档案时也能生成提示词', () => {
    const { a, mine } = setup();
    mine.recipients = ['高更'];
    const { prompt } = buildReplyPrompt(a, mine, '高更', {});
    assert.ok(prompt.includes('没有 高更 的文风档案'));
});

test('清理 AI 回信里多余的包装', () => {
    assert.equal(cleanReply('以下是回信：\n\n亲爱的 E.：\n……'), '亲爱的 E.：\n……');
    assert.equal(cleanReply('```\n亲爱的\n```'), '亲爱的');
});

test('收信反应引导提到收件人和历史人物', () => {
    const { a, mine } = setup();
    const g = buildReactionGuidance(a, mine, 'Vincent', '1888-09-14');
    assert.ok(g.includes('Vincent 收到了 EE'));
    assert.ok(g.includes('真实历史人物'));
});

test('检索可以排除正在聊天里读的那封信', () => {
    const { a, mine } = setup();
    mine.segments[2].tags = ['灌丛鸦'];
    const texts = ['灌丛鸦'];
    assert.equal(retrieve(a, { texts, viewer: null, storyDate: '' }).selected.length, 1);
    assert.equal(retrieve(a, { texts, viewer: null, storyDate: '', exclude: new Set([mine.id]) }).selected.length, 0);
});

// ---------- 托人转交 ----------
import { viaReceivedEvents, parseViaDecision, buildViaGuidance, viaSceneMessage, nextEventId } from '../src/correspondence.js';
import { knowledgeOf as kOf, createArchive as mkArchive, createLetter as mkLetter } from '../src/model.js';

test('托人转交：转交人只知道有信，拆看后才知道内容，收信人送到前一无所知', () => {
    const a = mkArchive();
    const l = mkLetter(a, { author: '安娜', recipients: ['伊万'], writtenAt: '1890-03-01', body: '亲爱的伊万：\n\n我要走了。\n\n安娜', status: 'sent' });
    l.events.push(...viaReceivedEvents(l, '女仆玛莎', '1890-03-02', l.events));
    assert.equal(kOf(l, new Set(['女仆玛莎']), '1890-03-05').letterLevel, 'exists');
    assert.equal(kOf(l, new Set(['伊万']), '1890-03-05').letterLevel, 'none');
    l.events.push({ id: nextEventId(l.events), type: 'read', who: '女仆玛莎', date: '1890-03-03', segments: null, to: '', note: '' });
    assert.equal(kOf(l, new Set(['女仆玛莎']), '1890-03-05').letterLevel, 'full');
    assert.equal(kOf(l, new Set(['伊万']), '1890-03-05').letterLevel, 'none');
    assert.ok(l.events.some(e => e.type === 'sent' && e.to === '女仆玛莎'));
});

test('托人转交：解析转交人的决定', () => {
    assert.deepEqual(parseViaDecision('好的：{"opened": true, "resealed": true, "action": "forward", "note": "明天送去"}'), { opened: true, resealed: true, action: 'forward', note: '明天送去' });
    assert.equal(parseViaDecision('{"opened": false, "action": "burn"}').action, 'unclear');
    assert.equal(parseViaDecision('不知道'), null);
});

test('托人转交：转交人那边的旁白和提示不含信的内容', () => {
    const a = mkArchive();
    const l = mkLetter(a, { author: '安娜', recipients: ['伊万'], writtenAt: '1890-03-01', body: '秘密内容', status: 'sent' });
    assert.ok(!viaSceneMessage(l, '玛莎', '1890-03-02').includes('秘密内容'));
    const g = buildViaGuidance(a, l, '玛莎', '1890-03-02');
    assert.ok(!g.includes('秘密内容'));
    assert.match(g, /不要编造信的内容/);
});
