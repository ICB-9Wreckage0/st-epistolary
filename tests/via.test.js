import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchive, createLetter, fixSelfVia } from '../src/model.js';
import { deliveryText } from '../src/whereabouts.js';

test('转交人是收信人自己：去掉，信算已送到', () => {
    const A = createArchive();
    const l = createLetter(A, { author: '埃里克', recipients: ['玛丽亚·德莱斯姆'], status: 'sent', body: 'x' });
    l.delivery = { status: 'viewed', via: '玛丽亚·德莱斯姆', reader: '玛丽亚·德莱斯姆', arrivedAt: '1890-05-02', stage: 'done' };
    assert.equal(fixSelfVia(A, l), true);
    assert.equal(l.delivery.via, undefined);
    assert.doesNotMatch(deliveryText(l), /转交/);
    assert.match(deliveryText(l), /已送到 玛丽亚·德莱斯姆 · 1890-05-02/);
});

test('转交人是写信人自己、信还“在转交人那里”：算在路上', () => {
    const A = createArchive();
    const l = createLetter(A, { author: '玛丽亚·德莱斯姆', recipients: ['埃里克'], status: 'sent', body: 'x' });
    l.delivery = { status: 'atVia', stage: 'atVia', via: '玛丽亚·德莱斯姆', reader: '玛丽亚·德莱斯姆', viaArrivedAt: '1890-05-01' };
    fixSelfVia(A, l);
    assert.equal(l.delivery.via, undefined);
    assert.equal(l.delivery.status, 'transit');
    assert.equal(l.delivery.reader, '埃里克');
});

test('真正的转交人不动', () => {
    const A = createArchive();
    const l = createLetter(A, { author: '埃里克', recipients: ['玛丽亚'], status: 'sent', body: 'x' });
    l.delivery = { status: 'viewed', via: '吉里夫人', reader: '玛丽亚', arrivedAt: '1890-05-02' };
    assert.equal(fixSelfVia(A, l), false);
    assert.match(deliveryText(l), /经 吉里夫人 转交/);
});

test('旧数据没修也不显示“经自己转交”', () => {
    const l = { author: '埃里克', recipients: ['玛丽亚'], status: 'sent', delivery: { status: 'viewed', via: '玛丽亚', reader: '玛丽亚', arrivedAt: '1890-05-02' } };
    assert.doesNotMatch(deliveryText(l), /转交/);
});

test('没写收信人的（文章稿之类）记了转交人：清掉寄送记录，不猜收信人', () => {
    const A = createArchive();
    const l = createLetter(A, { author: 'E·E·勒鲁', recipients: [], status: 'sent', body: 'x', folder: '文章' });
    l.delivery = { status: 'atVia', stage: 'atVia', via: '阿尔弗雷德·瓦莱特', viaArrivedAt: '1890-06-24' };
    assert.equal(fixSelfVia(A, l), true);
    assert.deepEqual(l.recipients, []);
    assert.equal(l.delivery, null);
});
