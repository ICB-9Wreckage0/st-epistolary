import test from 'node:test';
import assert from 'node:assert/strict';
import { stripMarks, aiText } from '../src/model.js';
import { renderBody, analyze } from '../src/render.js';

test('格式记号：去掉 / 给 AI 的写法', () => {
    const s = '我**真的**很想你，~~其实也没有~~。++快回信++，__一定__。';
    assert.equal(stripMarks(s), '我真的很想你，其实也没有。快回信，一定。');
    assert.equal(aiText(s), '我〔加粗：真的〕很想你，〔划掉：其实也没有〕。〔写得很大：快回信〕，〔画了线：一定〕。');
    assert.equal(stripMarks('2**3 和 a__b 不动'), '2**3 和 a__b 不动');
    assert.equal(stripMarks('**~~嵌套~~**'), '嵌套');
});

test('格式记号：渲染成 span，识别角色时不受记号影响', () => {
    const html = renderBody('亲爱的提奥：\n\n我**真的**很想你，~~其实~~。');
    assert.match(html, /<span class="epi-m m-bold">(<span[^>]*>)?真的/);
    assert.match(html, /<span class="epi-m m-strike">(<span[^>]*>)?其实/);
    assert.ok(!html.includes('**'));
    assert.equal(analyze('**亲爱的提奥：**\n\n正文')[0].lines[0].text, '亲爱的提奥：');
});
