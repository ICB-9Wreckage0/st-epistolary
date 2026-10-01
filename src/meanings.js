// 书信簿 · 外观选项的含义
// 信纸、墨水、封缄、信封在不同时代和文化里各有讲究。选的时候给一句说明，
// 有“会被误读”的选项（黑火漆＝丧事、红墨水写信＝绝交……）标上 ⚠，寄出前再提醒一次。
// 说明里的讲究多来自 19 世纪欧洲的书信礼仪和中文书信习惯，各地并不完全一致。

export const MEANINGS = {
    wax: {
        crimson: { text: '最普通的颜色，日常私信、公务都用，没有特别的意思。' },
        navy: { text: '比红色少见。有的礼仪书说代表忠诚、思念，多见于私人信件，不会引起误会。' },
        forest: { text: '不太常见。有的礼仪书说代表希望，也有说用于情书；收信人多半只会觉得别致。' },
        gold: { text: '显得贵重、喜庆，适合贺信、请柬、喜讯。日常私信用它会显得隆重。' },
        black: {
            warn: true,
            short: '丧事',
            text: '黑色火漆用于丧事：讣告、吊唁信、服丧期间的通信。收信人一看到黑色封口，第一反应往往是“有人去世了”。只是觉得好看的话，换一种颜色。',
        },
        chop: { text: '中式信件在封口盖朱红的“缄”字印，表示“已封好”，是平常用法。（家里有丧事、服丧期间，按旧俗会改用蓝色或黑色的印。）' },
        none: { text: '用胶水或浆糊封口，朴素、日常。便条、急信、公务信常这样。' },
    },
    ink: {
        black: { text: '最常见的墨色，正式、稳重。' },
        blueblack: { text: '19 世纪起最常用的书写墨水，刚写时偏蓝，日久变黑。日常通信的默认选择。' },
        navy: { text: '常见的蓝墨水，私人信件里很普通。' },
        brown: { text: '深褐色，像年代久远的铁胆墨水，或用乌贼墨写的，显得古旧。' },
        crimson: {
            warn: true,
            short: '红笔写信',
            text: '中文书信里，用红墨水写信有“绝交”或不吉利的意思，收信人可能会很介意；西方则常被理解为急事或带着火气。只是想要颜色的话，可以换深褐或墨绿。',
        },
        green: { text: '不常见的墨色，显得有个性。没有特别的忌讳。' },
        faded: { text: '褪色的铁胆墨水：看起来是很久以前写的，或者墨水兑了水。' },
        custom: { text: '自定义颜色。偏红的颜色要注意：中文书信里红笔写信有“绝交”的意思。' },
    },
    envelope: {
        ivory: { text: '象牙白信封，私人信件最常见。' },
        kraft: { text: '牛皮纸信封，结实朴素，多用于公务、账单、寄东西。用来寄私人信件会显得公事公办。' },
        blue: { text: '淡蓝信封，私人信件，显得清爽。' },
        white: { text: '白信封，最普通。' },
        airmail: { text: '红蓝斜纹边的航空信封。航空邮件 1918 年前后才出现，更早的故事里用它会显得穿越。', since: 1918 },
    },
    paper: {
        plain: { text: '素白信纸，最普通。' },
        cream: { text: '奶油色棉纸，质地好，显得用心。' },
        aged: { text: '泛黄的旧纸：信放了很久，或者纸本来就便宜。' },
        lined: { text: '印着横格的信笺，常见于学生、普通人家的信。' },
        redline: { text: '中式竖格红线信笺（八行笺），传统书信用纸。' },
        blue: { text: '很薄的淡蓝航空信纸，为了减轻邮资。航空邮件 1918 年前后才出现。', since: 1918 },
    },
    font: {
        typewriter: { text: '打字机打的信显得公事公办。打字机 1874 年才上市、19 世纪末才在办公室普及；私人信件用它，收信人可能会觉得冷淡。', since: 1874 },
    },
};

// 某个选项的含义；year 是写信的年份，用来提醒“这个年代还没有”
export function meaningOf(field, value, year) {
    const m = MEANINGS[field]?.[value];
    if (!m) return null;
    const anachronism = m.since && year && year < m.since;
    return { ...m, warn: !!m.warn || !!anachronism, anachronism: !!anachronism };
}

// 选项标签后面加一个 ⚠ 提示
export function labelWithWarn(field, map) {
    const out = {};
    for (const [k, v] of Object.entries(map)) {
        const m = MEANINGS[field]?.[k];
        out[k] = m?.warn ? `${v}  ⚠ ${m.short}` : v;
    }
    return out;
}

// 这封信外观里，可能被收信人误读的地方
export function lookWarnings(letter) {
    const a = letter.appearance || {};
    const year = parseInt(String(letter.writtenAt || '').slice(0, 4), 10) || 0;
    const out = [];
    for (const field of ['wax', 'ink', 'envelope', 'paper', 'font']) {
        const m = meaningOf(field, a[field], year);
        if (m?.warn) out.push(m.text);
    }
    return out;
}
