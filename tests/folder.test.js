import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchive, createLetter, pairFolder } from '../src/model.js';

test('同一写信人写给同一收信人：跟上一封放同一个文件夹', () => {
    const A = createArchive();
    createLetter(A, { author: '我', recipients: ['特斯拉'], body: 'a', folder: '电学' });
    const b = createLetter(A, { author: '我', recipients: ['特斯拉'], body: 'b' });
    assert.equal(b.folder, '电学');
    // 自己指定了（哪怕是“未分类”）就不动
    const c = createLetter(A, { author: '我', recipients: ['特斯拉'], body: 'c', folder: '' });
    assert.equal(c.folder, '');
    // 上一封是 c（未分类）：下一封跟着未分类
    assert.equal(pairFolder(A, null, 'letter', { author: '我', recipients: ['特斯拉'] }), '');
});

test('同方向没有就看回信方向；别人之间的信不算', () => {
    const A = createArchive();
    createLetter(A, { author: '我', recipients: ['特斯拉'], body: 'a', folder: '电学' });
    createLetter(A, { author: '我', recipients: ['爱迪生'], body: 'x', folder: '别的' });
    const r = createLetter(A, { author: '特斯拉', recipients: ['我'], body: '回信' });
    assert.equal(r.folder, '电学');
    const n = createLetter(A, { author: '特斯拉', recipients: ['威斯汀豪斯'], body: 'y' });
    assert.equal(n.folder, '');
});
