import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate, countUnits, mainScript, sideLabel, pagesText } from '../src/pages.js';

const zh = n => '今'.repeat(n);

test('只算主要语言：中文按字，外文按词', () => {
    assert.equal(mainScript('亲爱的提奥：今天很好。'), 'zh');
    assert.equal(mainScript('My dear Theo, today was fine (今天很好).'), 'lat');
    assert.equal(countUnits('亲爱的提奥：今天 good。'), 9); // 中文字和中文标点，不算 good
    assert.equal(countUnits('My dear Theo, (今天) it’s fine.', 'lat'), 5);
});

test('几面、几张：单面 / 正反面', () => {
    // 竖版中文：一行 20 字、一面 15 行 = 300 字
    const body = Array.from({ length: 40 }, () => zh(20)).join('\n'); // 40 行 → 3 面
    const one = paginate({ body, appearance: {} });
    assert.equal(one.units, 800);
    assert.equal(one.sides, 3);
    assert.equal(one.sheets, 3);
    assert.deepEqual(one.breaks.map(b => [b.p, b.l, b.side]), [[0, 15, 2], [0, 30, 3]]);
    const two = paginate({ body, appearance: { duplex: true } });
    assert.equal(two.sheets, 2);
    assert.equal(sideLabel(2, true), '第 1 张 · 背面');
    assert.equal(sideLabel(3, true), '第 2 张 · 正面');
    assert.match(pagesText(two), /800 字 · 2 张信纸，正反面写了 3 面/);
    // 字写得大：一面写得少
    assert.ok(paginate({ body, appearance: { size: 'xl' } }).sides > 3);
    // 设置里填了一面 100 字：一行 20 字 → 5 行一面
    assert.equal(paginate({ body, appearance: {} }, { capZh: 100 }).sides, 8);
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
