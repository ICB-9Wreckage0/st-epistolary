// 书信簿 · 写信套语预设
// 每条都带元数据，避免“1890 年的法国人写信用见字如晤”这种事。
// position: salutation 称呼 / opening 开头 / closing 结尾祝颂 / signoff 署名前
// lang: zh 中文 / fr 法语 / en 英语 / de 德语

export const POSITIONS = {
    salutation: '称呼',
    opening: '开头',
    closing: '结尾',
    signoff: '署名前',
};

export const LANGS = {
    zh: '中文',
    fr: '法语',
    en: '英语',
    de: '德语',
};

export const BUILTIN_PRESETS = [
    // —— 中文 ——
    { id: 'zh-jianzi', text: '见字如晤。', position: 'opening', lang: 'zh', era: '传统家书，清末民国常见', formality: '半正式', relation: '家人、熟人', note: '旧式书信，有“看到字就像见到面”的意思' },
    { id: 'zh-jinlai', text: '近来可好？', position: 'opening', lang: 'zh', era: '近现代', formality: '亲近', relation: '朋友、家人', note: '' },
    { id: 'zh-zhanxin', text: '展信佳。', position: 'opening', lang: 'zh', era: '当代', formality: '亲近', relation: '平辈朋友', note: '比较现代的说法，用在民国以前的信里会出戏' },
    { id: 'zh-cizhi', text: '此致\n敬礼！', position: 'closing', lang: 'zh', era: '现代白话（二十世纪起）', formality: '正式', relation: '通用', note: '“此致”另起一行空两格，“敬礼”顶格' },
    { id: 'zh-shunsong', text: '顺颂\n时祺', position: 'closing', lang: 'zh', era: '民国及以后', formality: '正式', relation: '平辈、公务', note: '' },
    { id: 'zh-jisong', text: '即颂\n近安', position: 'closing', lang: 'zh', era: '民国及以后', formality: '半正式', relation: '平辈朋友', note: '' },
    { id: 'zh-daan', text: '敬请\n大安', position: 'closing', lang: 'zh', era: '传统', formality: '正式', relation: '长辈', note: '写给长辈' },
    { id: 'zh-zhiduan', text: '纸短情长，不尽欲言。', position: 'closing', lang: 'zh', era: '传统至今', formality: '亲近', relation: '亲友', note: '' },
    { id: 'zh-zhuanci', text: '专此奉达。', position: 'signoff', lang: 'zh', era: '传统、民国', formality: '正式', relation: '公务、长辈', note: '' },

    // —— 法语（十九世纪） ——
    { id: 'fr-moncher', text: 'Mon cher ___,', position: 'salutation', lang: 'fr', era: '19 世纪至今', formality: '亲近', relation: '朋友、家人（男性收信人）', note: '女性收信人用 Ma chère' },
    { id: 'fr-chermonsieur', text: 'Cher Monsieur,', position: 'salutation', lang: 'fr', era: '19 世纪至今', formality: '正式', relation: '不熟的人、公务', note: '' },
    { id: 'fr-serre', text: 'Je te serre la main.', position: 'closing', lang: 'fr', era: '19 世纪', formality: '亲近', relation: '男性朋友、兄弟', note: '“我紧握你的手”，十九世纪男性之间常见' },
    { id: 'fr-toutatoi', text: 'Tout à toi,', position: 'signoff', lang: 'fr', era: '19 世纪至今', formality: '亲近', relation: '亲密朋友', note: '' },
    { id: 'fr-agreer', text: "Veuillez agréer, Monsieur, l'expression de mes sentiments distingués.", position: 'closing', lang: 'fr', era: '19 世纪至今', formality: '很正式', relation: '公务、陌生人', note: '' },

    // —— 英语（维多利亚时代） ——
    { id: 'en-mydear', text: 'My dear ___,', position: 'salutation', lang: 'en', era: '19 世纪', formality: '亲近', relation: '朋友、家人', note: '维多利亚时代 My dear 比 Dear 更亲近' },
    { id: 'en-faithfully', text: 'I remain, Sir, your obedient servant,', position: 'signoff', lang: 'en', era: '18–19 世纪', formality: '很正式', relation: '公务', note: '' },
    { id: 'en-ever', text: 'Ever yours,', position: 'signoff', lang: 'en', era: '19 世纪至今', formality: '亲近', relation: '亲密朋友', note: '' },
    { id: 'en-affectionate', text: 'Your affectionate friend,', position: 'signoff', lang: 'en', era: '19 世纪', formality: '亲近', relation: '朋友', note: '' },

    // —— 德语 ——
    { id: 'de-lieber', text: 'Lieber ___,', position: 'salutation', lang: 'de', era: '19 世纪至今', formality: '亲近', relation: '朋友（男性收信人）', note: '女性收信人用 Liebe' },
    { id: 'de-herzlich', text: 'Mit herzlichen Grüßen', position: 'signoff', lang: 'de', era: '20 世纪至今', formality: '半正式', relation: '通用', note: '' },
];

export function allPresets(archive) {
    return [...BUILTIN_PRESETS, ...(archive.presets || []).map(p => ({ ...p, custom: true }))];
}
