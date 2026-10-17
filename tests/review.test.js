import test from 'node:test';
import assert from 'node:assert/strict';
import { replyInfo } from '../src/timeline.js';
import { stripMarks, nextCode, ensureCodes } from '../src/model.js';
import { detectInChat, detectNotes } from '../src/importer.js';
import { knowledgePeople } from '../src/knowledge.js';
import { summaryEntryContent, inlineLetterBlock, buildStatusPrompt } from '../src/correspondence.js';
import { quoteSamples } from '../src/memoryscan.js';

const L = (id, author, to, extra = {}) => ({ id, author, recipients: [to], status: 'sent', events: [], memories: [], writtenAt: '1890-01-01', createdAt: `2026-01-0${id.length}`, ...extra });

test('回信：草稿、AI 草稿、没寄的不算；同一天按先后', () => {
    const a = L('a', '甲', '乙');
    const A = { people: [], letters: { a, b: L('bb', '乙', '甲', { inReplyTo: 'a', status: 'draft' }), c: L('ccc', '乙', '甲', { status: 'unsent' }) } };
    assert.equal(replyInfo(A, a).state, 'no');
    A.letters.d = L('dddd', '乙', '甲'); // 同一天、后记下的
    assert.equal(replyInfo(A, a).state, 'yes');
    A.letters.d.aiDraft = true;
    assert.equal(replyInfo(A, a).state, 'no');
});

test('格式记号：挨着字母数字的不算', () => {
    assert.equal(stripMarks('x**2** + y**2**'), 'x**2** + y**2**');
    assert.equal(stripMarks('我**真的**很'), '我真的很');
});

test('纸条识别：信封里的卡片不把信变成纸条；连字符、末行不当署名', () => {
    const body = '信封里还夹着一张小卡片。\n\n亲爱的提奥：\n\n今天天气很好，我在院子里画画，画了一整天，非常开心，想念你。\n\n紧握你的手，\n文森特';
    assert.equal(detectInChat([{ name: 'A', mes: body }])[0].kind, 'letter');
    assert.equal(detectNotes('纸条上写着：「下午3-4点在老地方等你」')[0].signoff, '');
    assert.equal(detectNotes('纸条上写着：「明天见\n别迟到」')[0].signoff, '');
});

test('没暗号的纸条补【条N】', () => {
    const A = { letters: { x: { id: 'x', kind: 'note', code: '' }, y: { id: 'y', kind: 'letter', code: '' } } };
    ensureCodes(A);
    assert.equal(A.letters.x.code, '【条1】');
    assert.equal(A.letters.y.code, '【信1】');
    assert.equal(nextCode(A, null, 'note'), '【条2】');
});

test('谁知道什么：两个聊天里读过同一封，只算一次', () => {
    const A = { people: [], letters: { a: L('a', '甲', '乙', { memories: [{ person: '乙', learned: [{ about: '甲', kind: '家庭', fact: 'f' }] }, { person: '乙', learned: [{ about: '甲', kind: '家庭', fact: 'f' }] }] }) } };
    assert.deepEqual(knowledgePeople(A).find(p => p.name === '乙'), { name: '乙', read: 1, wrote: 0, facts: 1 });
});

test('纸条在汇总、原文块、状态提示里不说成信 / 信封', () => {
    const n = L('n', '甲', '乙', { kind: 'note', envNote: '亲启', body: '老地方', appearance: { noteStyle: 'sticky' } });
    const l = L('l', '甲', '乙', { body: '近来可好' });
    const s = summaryEntryContent('乙', '甲', [{ letter: l, memory: { gist: 'x' } }, { letter: n, memory: { gist: 'y' } }]);
    assert.match(s, /1 封 甲 写的信、1 张 甲 留的纸条/);
    assert.match(inlineLetterBlock(n, '乙', ''), /^【乙 收到的便签/);
    assert.ok(!/亲启/.test(buildStatusPrompt([{ n: 1, letter: n, now: '' }], '剧情').prompt));
});

test('找读信的楼层：带格式的信也能对上原句', () => {
    assert.ok(quoteSamples('我**再也不会回到那座城市**了，你知道的。').some(q => q.startsWith('我再也不会回到那座城')));
});
