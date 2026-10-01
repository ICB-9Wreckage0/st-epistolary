// 书信簿 · 演示页的初始数据：三个人物、三封信，流转记录设计成能看出“谁知道什么”的差别。
// 信件内容是为演示编写的，不是历史原信。

import { createArchive, createLetter, normalizePerson } from '../src/model.js';
import { EXAMPLE_PROFILES } from '../src/correspondence.js';

export function seedArchive() {
    const a = createArchive();
    a.people.push(normalizePerson({ ...EXAMPLE_PROFILES.vangogh, hand: 'personal' }));
    a.people.push(normalizePerson({ name: '提奥·梵高', aliases: ['提奥', 'Theo'], historical: true, hand: 'formal' }));
    a.people.push(normalizePerson({ name: '高更', aliases: ['Gauguin', '保罗·高更'], historical: true, hand: 'casual' }));
    a.people.push(normalizePerson({ name: 'E.', aliases: ['EE'], hand: 'personal' }));

    const l1 = createLetter(a, {
        author: 'E.', signature: 'E.', recipients: ['提奥'], writtenAt: '1889-05-20',
        placeFrom: 'Paris', placeTo: 'Paris', language: '法语（中文显示）', status: 'sent',
        body: `Paris, le 20 mai 1889
Mon cher Théo,

谢谢你上周请我喝咖啡。巴黎的沙龙今年很热闹，我替你看了几场，回头细细写给你。

我最近一直有些担心文森特。他上封信里的字迹很乱，不知道是累了还是病了。你若方便，替我问问他。

佛罗里达的灌丛鸦会把橡子偷偷藏在地里，过了好几个月还记得在哪儿。它们的羽毛是很亮的蓝色，像他调的颜料。

Je te serre la main,
E.`,
        appearance: { paper: 'cream', ink: 'blueblack', font: 'personal', orientation: 'portrait', flourish: true, envelope: 'ivory', wax: 'crimson', wear: 1 },
    });
    const [, s2, s3, s4] = l1.segments.map(s => s.id);
    l1.segments[1].tags = ['沙龙', '巴黎'];
    l1.segments[2].tags = ['文森特', '担心', '字迹', '生病'];
    l1.segments[2].summary = 'E. 说她担心文森特的身体，他最近的字迹很乱。';
    l1.segments[3].tags = ['灌丛鸦', '鸟', '蓝色', '橡子', '颜料'];
    l1.segments[3].summary = 'E. 讲了佛罗里达一种会藏橡子的蓝色鸟。';
    l1.events = [
        { id: 'E1', type: 'sent', who: 'E.', date: '1889-05-20' },
        { id: 'E2', type: 'received', who: '提奥', date: '1889-05-21' },
        { id: 'E3', type: 'read', who: '提奥', date: '1889-05-21' },
        // 提奥去看文森特时，把讲鸟的那一段念给他听了，没念担心他的那段
        { id: 'E4', type: 'heard', who: '文森特', date: '1889-06-02', segments: [s4], note: '提奥念给他听的' },
    ];
    void s2; void s3;

    const l2 = createLetter(a, {
        author: '文森特', signature: '文森特', recipients: ['E.'], writtenAt: '1889-06-05',
        placeFrom: 'Saint-Rémy', placeTo: 'Paris', language: '法语（中文显示）', status: 'sent',
        body: `Saint-Rémy, le 5 juin 1889
亲爱的 E.：

提奥来的时候念了你写的那段鸟。我一直在想那种蓝，是钴蓝里掺了一点白，还是更冷一些的普鲁士蓝？

这里的麦田开始发黄了，我每天早上出去画，下午回来画柏树。柏树像埃及的方尖碑一样，线条和比例都很美。

紧握你的手，
文森特`,
        appearance: { paper: 'aged', ink: 'brown', font: 'personal', orientation: 'portrait', envelope: 'kraft', wax: 'navy', wear: 2 },
    });
    l2.segments[1].tags = ['鸟', '蓝色', '钴蓝', '普鲁士蓝'];
    l2.segments[2].tags = ['麦田', '柏树', '画'];
    l2.events = [
        { id: 'E1', type: 'sent', who: '文森特', date: '1889-06-05' },
        { id: 'E2', type: 'received', who: 'E.', date: '1889-06-08' },
        { id: 'E3', type: 'read', who: 'E.', date: '1889-06-08' },
    ];
    l2.openedAt = '';

    const l3 = createLetter(a, {
        author: '高更', signature: 'P. Gauguin', recipients: ['文森特'], writtenAt: '1889-05-30',
        placeFrom: 'Le Pouldu', placeTo: 'Saint-Rémy', language: '法语', status: 'sent',
        body: `Le Pouldu, 30 mai 1889
Mon cher Vincent,

Ici la mer est grise et les paysans ne parlent que breton. Je travaille, je mange mal, et je pense à Tahiti.

Écris-moi quand tu pourras.

Paul`,
        appearance: { paper: 'plain', ink: 'faded', font: 'casual', orientation: 'landscape', envelope: 'white', wax: 'none', wear: 2 },
    });
    l3.segments[1].tags = ['Tahiti', '大海', 'Bretagne', '布列塔尼'];
    l3.events = [
        { id: 'E1', type: 'sent', who: '高更', date: '1889-05-30' },
        { id: 'E2', type: 'received', who: '文森特', date: '1889-06-03' },
        { id: 'E3', type: 'read', who: '文森特', date: '1889-06-03' },
    ];
    return a;
}
