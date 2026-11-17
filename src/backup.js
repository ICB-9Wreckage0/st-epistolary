// 书信簿 · 一键备份
// 一个 .json 文件里装：全部信件档案（所有角色卡）和 / 或 书信簿的设置。
// 导入时自动认：完整备份、只有设置的备份、以前“导出档案”导出的纯档案文件都能读。
// 自定义 API 的密钥默认不放进备份（文件可能会发给别人），要带上得自己勾。

export const BACKUP_KIND = 'epistolary-backup';

// 设置里不该跟着备份走的东西：密钥（除非勾了）、只对这台电脑有意义的悬浮按钮位置
function cleanSettings(s, { includeKey = false } = {}) {
    const out = JSON.parse(JSON.stringify(s || {}));
    if (out.api && !includeKey) out.api.key = '';
    delete out.fabPos;
    return out;
}

// 做一个备份包：what = 'all' | 'archive' | 'settings'
export function buildBackup({ archive, settings, what = 'all', includeKey = false, version = '' }) {
    const pack = { kind: BACKUP_KIND, version, exportedAt: new Date().toISOString(), contains: [] };
    if (what !== 'settings' && archive) { pack.archive = archive; pack.contains.push('archive'); }
    if (what !== 'archive' && settings) {
        pack.settings = cleanSettings(settings, { includeKey });
        pack.contains.push('settings');
        pack.hasKey = !!(includeKey && settings.api?.key);
    }
    return pack;
}

// 读一个备份文件：返回 { archive, settings, kind, letters, exportedAt }
export function parseBackup(text) {
    let raw;
    try { raw = JSON.parse(text); } catch { throw new Error('不是有效的 JSON 文件'); }
    if (!raw || typeof raw !== 'object') throw new Error('文件里没有内容');
    if (raw.kind === BACKUP_KIND) {
        const archive = raw.archive && typeof raw.archive === 'object' ? raw.archive : null;
        const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : null;
        if (!archive && !settings) throw new Error('这个备份里既没有信件也没有设置');
        return { kind: 'bundle', archive, settings, letters: countLetters(archive), exportedAt: raw.exportedAt || '', version: raw.version || '', hasKey: !!raw.hasKey };
    }
    // 以前“导出档案”的文件：整个就是档案
    if (raw.letters && typeof raw.letters === 'object') return { kind: 'archive', archive: raw, settings: null, letters: countLetters(raw), exportedAt: '', version: '', hasKey: false };
    throw new Error('认不出这个文件：不是书信簿的备份');
}

export function countLetters(archive) {
    return archive?.letters ? Object.values(archive.letters).filter(l => l && l.status !== 'draft').length : 0;
}

// 把备份里的设置合到现在的设置上：备份里没带密钥，就保留现在的密钥；悬浮按钮位置也保留现在的
export function mergeSettings(current, incoming) {
    const next = { ...JSON.parse(JSON.stringify(incoming || {})) };
    if (next.api && !next.api.key && current?.api?.key) next.api.key = current.api.key;
    if (current?.fabPos) next.fabPos = current.fabPos;
    return next;
}

export function backupFileName(what, date = new Date()) {
    const p = n => String(n).padStart(2, '0');
    const d = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
    const label = what === 'settings' ? '设置备份' : what === 'archive' ? '信件备份' : '完整备份';
    return `书信簿${label}_${d}.json`;
}
