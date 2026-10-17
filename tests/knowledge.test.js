import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgePeople, knowledgeOf } from '../src/knowledge.js';

test('谁知道什么：按人整理读过的、知道的、被知道的', () => {
    const archive = { people: [{ name: '文森特', aliases: ['V'] }], letters: {
        a: { id: 'a', author: '文森特', recipients: ['提奥'], status: 'sent', writtenAt: '1890-03-17', memories: [{ person: '提奥', weight: 3, learned: [{ about: '', kind: '家庭', fact: '父亲留了一封信' }] }] },
        b: { id: 'b', author: '提奥', recipients: ['V'], status: 'sent', writtenAt: '1890-03-25', memories: [{ person: 'V', weight: 2, learned: [{ about: '乔', kind: '身体', fact: '乔头晕' }, { about: '提奥', kind: '家庭', fact: '要当父亲' }] }] },
        c: { id: 'c', author: '文森特', recipients: ['提奥'], status: 'draft', memories: [] },
    } };
    const ppl = knowledgePeople(archive);
    assert.deepEqual(ppl.find(p => p.name === '文森特'), { name: '文森特', read: 1, wrote: 1, facts: 2 });
    const k = knowledgeOf(archive, '文森特');
    assert.equal(k.read.length, 1);
    assert.deepEqual(k.learnedBy.map(g => [g.about, g.facts.map(f => f.fact)]), [['乔', ['乔头晕']], ['提奥', ['要当父亲']]]);
    assert.deepEqual(k.aboutMe.map(f => [f.who, f.fact]), [['提奥', '父亲留了一封信']]);
    assert.equal(k.wrote.length, 1); // 草稿不算
    assert.deepEqual(k.wrote[0].readers.map(r => r.person), ['提奥']);
});
