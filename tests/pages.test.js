import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate, countUnits, mainScript, sideLabel, pagesText, countText } from '../src/pages.js';

const zh = n => '今'.repeat(n);

test('只算主要语言：中文按字，外文按词', () => {
    assert.equal(mainScript('亲爱的提奥：今天很好。'), 'zh');
    assert.equal(mainScript('My dear Theo, today was fine (今天很好).'), 'lat');
    assert.equal(countUnits('亲爱的提奥：今天 good。'), 9); // 中文字和中文标点，不算 good
    assert.equal(countUnits('My dear Theo, (今天) it’s fine.', 'lat'), 5);
});

test('几面、几张：单面 / 正反面', () => {
    // 竖版中文：一行 20 字、一面 20 行 = 400 字
    const body = Array.from({ length: 50 }, () => zh(20)).join('\n'); // 50 行 → 3 面
    const one = paginate({ body, appearance: {} });
    assert.equal(one.units, 1000);
    assert.equal(one.sides, 3);
    assert.equal(one.sheets, 3);
    assert.deepEqual(one.breaks.map(b => [b.p, b.l, b.side]), [[0, 20, 2], [0, 40, 3]]);
    const two = paginate({ body, appearance: { duplex: true } });
    assert.equal(two.sheets, 2);
    assert.equal(sideLabel(2, true), '第 1 张 · 背面');
    assert.equal(sideLabel(3, true), '第 2 张 · 正面');
    assert.match(pagesText(two), /1000 字 · 2 张信纸，正反面写了 3 面/);
    // 字写得大：一面写得少
    assert.ok(paginate({ body, appearance: { size: 'xl' } }).sides > 3);
    // 设置里填了一面 100 字：一行 20 字 → 5 行一面
    assert.equal(paginate({ body, appearance: {} }, { capZh: 100 }).sides, 10);
});

test('短行、空行也占一行；便签很小', () => {
    const body = '提奥：\n\n' + zh(10) + '\n\n文森特';
    assert.equal(paginate({ body, appearance: {} }).sides, 1);
    const note = paginate({ kind: 'note', body: zh(80), appearance: { noteStyle: 'sticky' } }); // 8 × 8 = 64 字一面
    assert.equal(note.sides, 2); // 一段 80 字要 10 行，一面 8 行：写到背面 / 第二张
    const note2 = paginate({ kind: 'note', body: Array.from({ length: 10 }, () => zh(8)).join('\n'), appearance: { noteStyle: 'sticky' } });
    assert.equal(note2.sides, 2);
});

test('两种语言分开算；括号里的译文不占纸', () => {
    const body = 'Mon cher Théo (亲爱的提奥)，\n\nJe suis allé voir les champs aujourd’hui (今天我去看了麦田). Ils sont magnifiques (它们很美).\n\nVincent';
    const pg = paginate({ language: '法语', appearance: {}, body });
    assert.equal(pg.script, 'lat');
    assert.deepEqual(pg.counts, { zh: 19, lat: 14 });
    assert.match(pagesText(pg), /^法语 14 词 · 中文 19 字 · 一张信纸/);
    // 没填语言：看括号外面
    assert.equal(paginate({ appearance: {}, body }).script, 'lat');
    // 中文信里零星的外文名字不单独列
    assert.match(pagesText(paginate({ appearance: {}, body: '亲爱的提奥：今天很好，我买了一本 Zola 的书。' })), /^19 字 · /);
    // 译文不占纸：一段很长的中文译文不会让外文信多出一张
    const long = 'Bonjour (' + '很长的译文'.repeat(200) + ').';
    assert.equal(paginate({ language: 'fr', appearance: {}, body: long }).sides, 1);
});

test('纸张大小：A4、八开按尺寸算；自定义按一面多少字', () => {
    const body = Array.from({ length: 60 }, () => '今'.repeat(20)).join('\n'); // 1200 字
    const a4 = paginate({ body, appearance: { sheet: 'a4' } });
    assert.ok(a4.perSide > 500 && a4.perSide < 650);
    assert.match(pagesText(a4), /张 A4/);
    assert.ok(paginate({ body, appearance: { sheet: 'k8' } }).perSide > paginate({ body, appearance: { sheet: 'a5' } }).perSide * 3);
    const c = paginate({ body, appearance: { sheet: 'custom', sheetCap: 400 } });
    assert.equal(c.perSide, 400);
    assert.equal(c.sides, 3);
    assert.equal(pagesText(c), '1200 字 · 3 张纸（一面约 400 字，只写正面）');
    // 横放：一行更长、行数更少
    const l = paginate({ body, appearance: { sheet: 'a4', orientation: 'landscape' } });
    assert.ok(l.perLine > a4.perLine && l.lines < a4.lines);
});

test('外文信：中文译文不占纸；长段落不会整段挪到下一面', () => {
    const fr = n => Array.from({ length: n }, () => 'mot').join(' ') + '.';
    const body = Array.from({ length: 20 }, () => `${fr(105)}\n\n${zh(189)}`).join('\n\n');
    const pg = paginate({ body, language: '法语（中文显示）', appearance: {} });
    assert.equal(pg.script, 'lat');
    assert.ok(pg.sides <= 10, `sides ${pg.sides}`); // 2100 词，一面约 264 词
    assert.match(countText(pg), /^法语 2100 词 · 中文 \d+ 字$/);
});

test('法文一句、中文译文一句交替：译文不占纸，不因换行多算张数', async () => {
    const { paginate } = await import('../src/pages.js');
    const s1 = 'Ma chère Maria, je vous écris ce soir depuis la petite chambre.', z1 = '（我亲爱的玛丽亚，今晚我在那间小房间里给你写信。）';
    const mk = body => ({ kind: 'letter', language: '法语', body, appearance: {} });
    const inter = paginate(mk(Array.from({ length: 200 }, () => `${s1}\n${z1}`).join('\n')));
    const plain = paginate(mk(Array.from({ length: 200 }, () => s1).join(' ')));
    assert.equal(inter.sheets, plain.sheets);
});
