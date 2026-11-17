import test from 'node:test';
import assert from 'node:assert/strict';
import { letterToMarkdown, letterToText, exportLetters, exportFileName } from '../src/exporter.js';

const L = (extra = {}) => ({ code: '【电学5】', author: 'User', recipients: ['特斯拉'], writtenAt: '1899-03-02', appearance: {}, memories: [], events: [], body: '亲爱的特斯拉先生：\n\n我**真的**很想知道，~~也许~~能++照亮++__整个__城市。\n# 不是标题\n\n此致\nUser', ...extra });

test('Markdown：保留格式、段内换行、行首特殊字符转义', () => {
    const md = letterToMarkdown(L());
    assert.match(md, /^## 【电学5】 User → 特斯拉/);
    assert.match(md, /- \*\*写信人\*\*：User/);
    assert.match(md, /我\*\*真的\*\*很想知道，~~也许~~能<big>照亮<\/big><u>整个<\/u>城市。 {2}\n\\# 不是标题/);
    assert.match(md, /此致 {2}\nUser/);
    assert.ok(!letterToMarkdown(L(), { meta: false }).includes('写信人'));
});

test('纯文本：去掉格式记号；可以附上读后记忆和经过', () => {
    const t = letterToText(L({ memories: [{ person: '特斯拉', weight: 2, text: '他记得……', learned: [{ about: 'User', kind: '处境', fact: '住在纽约' }] }], events: [{ type: 'sent', date: '1899-03-03', who: 'User' }] }), { memories: true, story: true });
    assert.match(t, /我真的很想知道，也许能照亮整个城市。/);
    assert.match(t, /—— 读后记忆 ——\n\n【特斯拉】（●●○）\n他记得……\n {2}· 新知道的事（处境）：User——住在纽约/);
    assert.match(t, /—— 经过 ——\n {2}· 1899-03-03 User寄出/);
});

test('好几封：按日期排，有目录；文件名干净', () => {
    const md = exportLetters([L({ code: '【电学6】', writtenAt: '1899-05-01' }), L()], 'md', { title: '书信簿' });
    assert.match(md, /^# 书信簿\n\n共 2 封\n\n1\. 【电学5】.*\n2\. 【电学6】/);
    assert.ok(md.indexOf('## 【电学5】') < md.indexOf('## 【电学6】'));
    assert.equal(exportFileName('书信簿_【电学5】 User/特斯拉', 'txt'), '书信簿_电学5_User_特斯拉.txt');
});
