import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, scriptLang, normalizeHand, paperClasses } from '../src/render.js';

const roles = body => analyze(body).map(p => [p.role, p.lines.map(l => l.role).join('/')]);

test('法语信：日期行、称呼、署名、附言', () => {
    const r = roles('Paris, le 10 juin 1889\nMon cher Vincent,\n\nJ\'ai reçu ta lettre.\n\nJe te serre la main,\nE.\n\nP.S. Écris-moi vite.');
    assert.deepEqual(r, [['body', 'dateline/salutation'], ['body', 'body'], ['signoff', 'body/body'], ['ps', 'body']]);
});

test('中文信：称呼、此致敬礼不当署名、署名右对齐', () => {
    const r = roles('亲爱的文森特：\n\n见字如晤。近来可好？\n\n此致\n敬礼！\n\nE.\n1890年11月3日');
    assert.equal(r[0][1], 'salutation');
    assert.equal(r[2][0], 'body');
    assert.equal(r[3][0], 'signoff');
});

test('长的最后一段不当署名', () => {
    const r = roles('亲爱的提奥：\n\n' + '很长的一段话'.repeat(10));
    assert.equal(r[1][0], 'body');
});

test('书信语言与字迹', () => {
    assert.equal(scriptLang('法语（中文显示）'), 'zh');
    assert.equal(scriptLang('法语'), 'lat');
    assert.equal(scriptLang('English'), 'lat');
    assert.equal(scriptLang(''), 'zh');
    assert.equal(normalizeHand('kai'), 'personal');
    assert.equal(normalizeHand('serif'), 'formal');
    assert.equal(normalizeHand('elegant'), 'elegant');
    assert.match(paperClasses({ language: '法语', appearance: { font: 'hand', orientation: 'landscape', flourish: true } }), /font-personal orient-landscape script-lat flourish/);
});
