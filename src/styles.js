// 书信簿 · 款式包
// 一个款式包就是一组外观参数：纸、墨、字迹、版式、信封、封缄、磨损、笔迹抖动、花体。
// 动画和排版都不用改，换一组参数就是另一种信。用户也可以把当前的样子存成自己的款式包。

export const STYLE_KEYS = ['paper', 'ink', 'font', 'orientation', 'envelope', 'wax', 'wear', 'wobble', 'flourish'];

export const STYLE_PACKS = [
    {
        id: 'fr1890', name: '1890 法国私人信', desc: '奶油棉纸、蓝黑墨水、自然手写，朱红火漆，花体称呼署名',
        language: '法语（中文显示）',
        appearance: { paper: 'cream', ink: 'blueblack', font: 'personal', orientation: 'portrait', envelope: 'ivory', wax: 'crimson', wear: 1, wobble: '', flourish: true },
    },
    {
        id: 'victorian', name: '维多利亚英国', desc: '素白信纸、黑墨、端正字迹，白信封配朱红火漆',
        language: '英语',
        appearance: { paper: 'plain', ink: 'black', font: 'formal', orientation: 'portrait', envelope: 'white', wax: 'crimson', wear: 1, wobble: '', flourish: true },
    },
    {
        id: 'mourning', name: '讣告 · 吊唁信', desc: '⚠ 黑火漆：只用于报丧、吊唁和服丧期间的通信，收信人一看就知道有人去世了',
        language: '',
        appearance: { paper: 'plain', ink: 'black', font: 'formal', orientation: 'portrait', envelope: 'white', wax: 'black', wear: 0, wobble: '', flourish: false },
    },
    {
        id: 'minguo', name: '民国家书', desc: '红线信笺、自然手写，牛皮纸信封，盖朱印“缄”字',
        language: '',
        appearance: { paper: 'redline', ink: 'black', font: 'personal', orientation: 'portrait', envelope: 'kraft', wax: 'chop', wear: 2, wobble: '', flourish: false },
    },
    {
        id: 'wartime', name: '战地家书', desc: '粗糙的白纸、匆忙潦草的字、褪色墨水，胶封，纸已经旧了',
        language: '',
        appearance: { paper: 'plain', ink: 'faded', font: 'casual', orientation: 'portrait', envelope: 'kraft', wax: 'none', wear: 2, wobble: 3, flourish: false },
    },
    {
        id: 'airmail', name: '航空信', desc: '淡蓝薄信纸、横版平放，红蓝边航空信封，胶封',
        language: '',
        appearance: { paper: 'blue', ink: 'blueblack', font: 'casual', orientation: 'landscape', envelope: 'airmail', wax: 'none', wear: 0, wobble: '', flourish: false },
    },
    {
        id: 'official', name: '公函 / 打字机', desc: '打字机字体、白信封、不封火漆',
        language: '',
        appearance: { paper: 'plain', ink: 'black', font: 'typewriter', orientation: 'portrait', envelope: 'white', wax: 'none', wear: 0, wobble: '', flourish: false },
    },
    {
        id: 'fantasy', name: '奇幻羊皮纸', desc: '泛黄破损的旧纸、深褐墨水，金色火漆',
        language: '',
        appearance: { paper: 'aged', ink: 'brown', font: 'personal', orientation: 'landscape', envelope: 'kraft', wax: 'gold', wear: 3, wobble: '', flourish: true },
    },
];

// 从信件外观里取出款式包需要的那部分
export function pickStyle(appearance) {
    const out = {};
    for (const k of STYLE_KEYS) if (k in appearance) out[k] = appearance[k];
    return out;
}

// 套用：只改外观，不碰正文。书信语言只在原来没填时才补上
export function applyStyle(letter, pack) {
    letter.appearance = { ...letter.appearance, ...pickStyle(pack.appearance || {}) };
    if (pack.language && !String(letter.language || '').trim()) letter.language = pack.language;
    return letter;
}
