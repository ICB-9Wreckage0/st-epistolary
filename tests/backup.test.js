import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBackup, parseBackup, mergeSettings, backupFileName } from '../src/backup.js';

const archive = { version: 3, letters: { a: { id: 'a', status: 'sent' }, b: { id: 'b', status: 'draft' } } };
const settings = { mode: 'expert', api: { mode: 'custom', key: 'sk-secret', url: 'u' }, fabPos: { right: 1, bottom: 2 }, noteWords: '名片' };

test('完整备份默认不带密钥、不带悬浮按钮位置', () => {
    const p = buildBackup({ archive, settings, what: 'all' });
    assert.deepEqual(p.contains, ['archive', 'settings']);
    assert.equal(p.settings.api.key, '');
    assert.equal(p.settings.fabPos, undefined);
    assert.equal(settings.api.key, 'sk-secret'); // 原设置没被改
    const back = parseBackup(JSON.stringify(p));
    assert.equal(back.letters, 1);
    assert.equal(back.settings.noteWords, '名片');
});

test('勾了带密钥', () => {
    const p = buildBackup({ archive, settings, what: 'settings', includeKey: true });
    assert.equal(p.archive, undefined);
    assert.equal(p.settings.api.key, 'sk-secret');
    assert.equal(parseBackup(JSON.stringify(p)).hasKey, true);
});

test('旧的纯档案文件也能读', () => {
    const r = parseBackup(JSON.stringify(archive));
    assert.equal(r.kind, 'archive');
    assert.equal(r.settings, null);
});

test('认不出的文件报错', () => {
    assert.throws(() => parseBackup('{"x":1}'));
    assert.throws(() => parseBackup('not json'));
});

test('合并设置：没带密钥就留着现在的，位置也留着', () => {
    const m = mergeSettings(settings, { mode: 'simple', api: { mode: 'custom', key: '' } });
    assert.equal(m.api.key, 'sk-secret');
    assert.equal(m.mode, 'simple');
    assert.deepEqual(m.fabPos, { right: 1, bottom: 2 });
});

test('文件名', () => {
    assert.match(backupFileName('all', new Date(2026, 10, 17)), /^书信簿完整备份_2026-11-17\.json$/);
    assert.match(backupFileName('settings'), /设置备份/);
});
