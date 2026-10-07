import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchive, createLetter, resegment, knowledgeOf, nameSet, splitBody, normalizeDate, migrateArchive } from '../src/model.js';
import { retrieve } from '../src/retrieval.js';

function setup() {
    const a = createArchive();
    a.people.push({ name: '文森特·梵高', aliases: ['文森特', 'Vincent'] });
    a.people.push({ name: '提奥·梵高', aliases: ['提奥', 'Theo'] });
    const l = createLetter(a, {
        author: 'EE',
        recipients: ['提奥'],
        writtenAt: '1890-11-03',
        status: 'sent',
        body: '亲爱的提奥：\n近来可好？\n\n巴黎的沙龙今年很热闹。\n\n我最近一直有些担心文森特。\n\n佛罗里达的灌丛鸦会把食物藏起来，羽毛是很亮的蓝色。',
    });
    const [s1, s2, s3, s4] = l.segments.map(s => s.id);
    l.segments[1].tags = ['沙龙'];
    l.segments[2].tags = ['文森特', '担心'];
    l.segments[2].summary = 'EE 担心文森特的身体。';
    l.segments[3].tags = ['灌丛鸦', '蓝色', '鸟'];
    l.events = [
        { id: 'E1', type: 'sent', who: 'EE', date: '1890-11-03', segments: null },
        { id: 'E2', type: 'received', who: '提奥', date: '1890-11-05', segments: null },
        { id: 'E3', type: 'read', who: 'Theo', date: '1890-11-05', segments: null },
        { id: 'E4', type: 'heard', who: '文森特', date: '1890-11-19', segments: [s3, s4] },
    ];
    return { a, l, ids: { s1, s2, s3, s4 } };
}

test('空行分段，段内换行保留', () => {
    assert.deepEqual(splitBody('a\nb\n\n\nc\n  \nd'), ['a\nb', 'c', 'd']);
});

test('日期解析', () => {
    assert.equal(normalizeDate('1890-11-3'), '1890-11-03');
    assert.equal(normalizeDate('1890年11月'), '1890-11-00');
    assert.equal(normalizeDate('某年秋'), null);
});

test('知情推算：别名、按段落、按日期', () => {
    const { a, l, ids } = setup();
    const theo = knowledgeOf(l, nameSet(a, '提奥·梵高'), '1890-12-01');
    assert.equal(theo.segLevels[ids.s1], 'full');

    const vincentBefore = knowledgeOf(l, nameSet(a, 'Vincent'), '1890-11-10');
    assert.equal(vincentBefore.letterLevel, 'none');

    const vincentAfter = knowledgeOf(l, nameSet(a, 'Vincent'), '1890-11-20');
    assert.equal(vincentAfter.segLevels[ids.s2], 'none');
    assert.equal(vincentAfter.segLevels[ids.s3], 'full');

    const gauguin = knowledgeOf(l, nameSet(a, '高更'), '1891-01-01');
    assert.equal(gauguin.letterLevel, 'none');

    const author = knowledgeOf(l, nameSet(a, 'EE'), '1890-11-03');
    assert.equal(author.segLevels[ids.s2], 'full');

    const notYet = knowledgeOf(l, nameSet(a, 'EE'), '1890-10-01');
    assert.equal(notYet.exists, false);
});

test('检索：高更提到文森特，也拿不到那一段', () => {
    const { a } = setup();
    const r = retrieve(a, { texts: ['我最近很担心文森特'], viewer: '高更', storyDate: '1891-01-01' });
    assert.equal(r.selected.length, 0);
    assert.equal(r.text, '');
    assert.ok(r.blocked.some(b => b.reason.includes('不知道')));
});

test('检索：文森特听过 §3§4，能拿到蓝色的鸟那段原文', () => {
    const { a, ids } = setup();
    const r = retrieve(a, { texts: ['文森特想起她写过的那种蓝色的鸟'], viewer: '文森特', storyDate: '1890-12-01' });
    assert.deepEqual(r.selected.map(s => s.segId).sort(), [ids.s3, ids.s4].sort());
    assert.ok(r.text.includes('灌丛鸦会把食物藏起来'));
    assert.ok(r.text.includes('文森特读过原文'));
    assert.ok(!r.text.includes('沙龙'));
});

test('检索：剧情日期没到，挡掉并说明原因', () => {
    const { a } = setup();
    const r = retrieve(a, { texts: ['蓝色的鸟'], viewer: '文森特', storyDate: '1890-11-10' });
    assert.equal(r.selected.length, 0);
    assert.ok(r.blocked.some(b => b.reason.includes('剧情日期还没到')));
});

test('检索：转述只注入大意；没写大意的降级为“知道存在”', () => {
    const { a, l, ids } = setup();
    l.events.push({ id: 'E5', type: 'told', who: '高更', date: '1890-12-01', segments: null });
    const r = retrieve(a, { texts: ['文森特还好吗？那只鸟呢'], viewer: '高更', storyDate: '1890-12-02' });
    const s3 = r.selected.find(s => s.segId === ids.s3);
    assert.equal(s3.level, 'summary');
    assert.ok(r.text.includes('（大意）EE 担心文森特的身体。'));
    assert.ok(!r.selected.some(s => s.segId === ids.s4)); // §4 没写大意
    assert.ok(!r.text.includes('灌丛鸦会把食物藏起来'));
});

test('检索：全知模式不过滤权限，但仍然过滤还没写成的信', () => {
    const { a } = setup();
    assert.equal(retrieve(a, { texts: ['沙龙'], viewer: null, storyDate: '' }).selected.length, 1);
    assert.equal(retrieve(a, { texts: ['沙龙'], viewer: null, storyDate: '1890-01-01' }).selected.length, 0);
});

test('预算：段数与每封上限', () => {
    const { a } = setup();
    const r = retrieve(a, { texts: ['沙龙 文森特 蓝色'], viewer: null, storyDate: '', settings: { maxPerLetter: 2 } });
    assert.equal(r.selected.length, 2);
    assert.ok(r.dropped.length >= 1);
});

test('重新分段：改错字保住关键词，插入新段落不串位', () => {
    const { l, ids } = setup();
    l.body = l.body.replace('灌丛鸦', '灌丛鴉');
    resegment(l);
    assert.equal(l.segments[3].id, ids.s4);
    assert.deepEqual(l.segments[3].tags, ['灌丛鸦', '蓝色', '鸟']);

    l.body = '【新加的一段】\n\n' + l.body;
    resegment(l);
    assert.equal(l.segments.length, 5);
    assert.equal(l.segments[3].id, ids.s3); // 按原文匹配，没有串位
    assert.deepEqual(l.segments[3].tags, ['文森特', '担心']);
});

test('迁移：旧数据缺字段也能读', () => {
    const m = migrateArchive({ letters: { 'LETTER-0001': { body: 'hi' } } });
    assert.equal(m.letters['LETTER-0001'].status, 'draft');
    assert.deepEqual(m.letters['LETTER-0001'].events, []);
});

// ---------- 暗号 ----------
import { normalizeCode, nextCode, lettersByCode, ensureCodes, createArchive as cA, createLetter as cL } from '../src/model.js';
import { buildCodeBlock } from '../src/correspondence.js';

test('暗号：自动编号、补括号、只认完整暗号', () => {
    const a = cA();
    const l1 = cL(a, { author: 'A', recipients: ['B'], body: '正文一' });
    const l2 = cL(a, { author: 'A', recipients: ['B'], body: '正文二', code: '密信' });
    assert.equal(l1.code, '【信1】');
    assert.equal(l2.code, '【密信】');
    assert.equal(normalizeCode('[x]'), '[x]');
    assert.equal(nextCode(a), '【信2】');
    for (let i = 0; i < 9; i++) cL(a, { author: 'A', body: 'x' });
    assert.deepEqual(lettersByCode(a, '她又读了【信1】').map(l => l.id), [l1.id]);
    assert.deepEqual(lettersByCode(a, '信1 和 信1】'), []);
    assert.ok(!lettersByCode(a, '【信10】').some(l => l.id === l1.id));
    const b = buildCodeBlock(a, l1, {});
    assert.match(b, /正文一/); assert.match(b, /【信1】/);
    const old = cA(); old.letters.X = { id: 'X', code: '' }; assert.ok(ensureCodes(old)); assert.equal(old.letters.X.code, '【信1】');
});

test('文件夹：新建、移动、重命名、删除（信不删）', async () => {
    const { createArchive, createLetter, addFolder, folderList, lettersInFolder, renameFolder, removeFolder, migrateArchive } = await import('../src/model.js');
    const a = createArchive();
    const l = createLetter(a, { author: 'A', recipients: ['B'], body: 'x' });
    createLetter(a, { author: 'A', recipients: ['B'], body: 'y' });
    assert.equal(addFolder(a, '  月信 '), '月信');
    l.folder = '月信';
    assert.deepEqual(folderList(a), ['月信']);
    assert.equal(lettersInFolder(a, '月信').length, 1);
    assert.equal(lettersInFolder(a, '').length, 1);
    assert.ok(renameFolder(a, '月信', '勒鲁的月信'));
    assert.equal(a.letters[l.id].folder, '勒鲁的月信');
    const b = migrateArchive(JSON.parse(JSON.stringify(a)));
    assert.deepEqual(b.folders, ['勒鲁的月信']);
    removeFolder(a, '勒鲁的月信');
    assert.equal(Object.keys(a.letters).length, 2);
    assert.equal(a.letters[l.id].folder, '');
    assert.deepEqual(folderList(a), []);
});

test('角色卡：暗号按角色卡各自编号', async () => {
    const { createArchive, createLetter, nextCode, ensureCodes } = await import('../src/model.js');
    const a = createArchive();
    createLetter(a, { scope: 'char:a.png', body: 'x' });
    createLetter(a, { scope: 'char:a.png', body: 'y' });
    const b1 = createLetter(a, { scope: 'char:b.png', body: 'z' });
    assert.equal(b1.code, '【信1】');
    assert.equal(nextCode(a, 'char:a.png'), '【信3】');
    assert.equal(nextCode(a, 'char:b.png'), '【信2】');
    const old = createLetter(a, { body: 'w' });
    assert.equal(old.scope, '');
    old.code = '';
    ensureCodes(a);
    assert.equal(old.code, '【信1】');
});
