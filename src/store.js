// 书信簿 · 存储
// 档案存成酒馆服务器上的一个独立 JSON 文件（data/<用户>/user/files/epistolary_archive.json），
// 不放进 settings.json，也不放在浏览器本地数据库里 —— 换浏览器、清缓存都不会丢。
// 本次会话第一次保存前，会先把读到的旧档案另存一份备份。

import { createArchive, migrateArchive } from './model.js';

export const FILE_NAME = 'epistolary_archive.json';
export const BACKUP_NAME = 'epistolary_archive.backup.json';
export const BACKUP_INDEX = 'epistolary_backups.json';   // 自动备份的清单
const BACKUP_PREFIX = 'epistolary_backup_';
const FALLBACK_KEY = 'epistolary_fallback_archive';

function ctx() {
    return SillyTavern.getContext();
}

function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}

async function uploadFile(name, text) {
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ name, data: toBase64(text) }),
    });
    if (!res.ok) throw new Error(`上传失败：HTTP ${res.status}`);
    return res.json().catch(() => ({}));
}

export class Store {
    constructor() {
        this.archive = createArchive();
        this.mode = 'unloaded';   // 'file' | 'fallback' | 'unloaded'
        this.rawLoaded = null;    // 读到的原始文本，用于第一次保存前的备份
        this.backedUp = false;
        this.saveTimer = null;
        this.lastError = '';
        this.listeners = new Set();
        this.backups = [];
    }

    onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit() { this.listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); }

    async load() {
        try {
            const res = await fetch(`/user/files/${FILE_NAME}?t=${Date.now()}`, { cache: 'no-store' });
            if (res.ok) {
                const text = await res.text();
                this.rawLoaded = text;
                this.archive = migrateArchive(JSON.parse(text));
                this.mode = 'file';
            } else if (res.status === 404) {
                this.archive = this.loadFallback() || createArchive();
                this.mode = 'file';
            } else {
                throw new Error(`HTTP ${res.status}`);
            }
        } catch (e) {
            console.warn('[书信簿] 读取档案文件失败，改用备用存储', e);
            this.lastError = String(e.message || e);
            this.archive = this.loadFallback() || createArchive();
            this.mode = 'fallback';
        }
        this.emit();
        return this.archive;
    }

    loadFallback() {
        const s = ctx().extensionSettings?.[FALLBACK_KEY];
        return s ? migrateArchive(s) : null;
    }

    // 防抖保存：连续改动只写一次
    save() {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.saveNow(), 600);
        this.emit();
    }

    async saveNow() {
        clearTimeout(this.saveTimer);
        const text = JSON.stringify(this.archive, null, 2);
        try {
            if (!this.backedUp && this.rawLoaded) {
                await uploadFile(BACKUP_NAME, this.rawLoaded);
            }
            this.backedUp = true;
            await uploadFile(FILE_NAME, text);
            if (this.mode === 'fallback') {
                // 文件存储恢复了，清掉备用存储里的旧副本
                delete ctx().extensionSettings[FALLBACK_KEY];
                ctx().saveSettingsDebounced();
            }
            this.mode = 'file';
            this.lastError = '';
        } catch (e) {
            console.error('[书信簿] 保存到文件失败，暂存到扩展设置里', e);
            this.lastError = String(e.message || e);
            this.mode = 'fallback';
            ctx().extensionSettings[FALLBACK_KEY] = this.archive;
            ctx().saveSettingsDebounced();
            toastr?.warning('书信簿：保存到文件失败，已暂存到酒馆设置里。建议尽快导出备份。');
        }
        this.emit();
    }

    // ---------- 自动备份 ----------
    // 每天第一次打开酒馆时，把读到的档案另存一份 epistolary_backup_日期.json，只留最近 keep 份。
    // 手动备份（“立即备份”）另外存，不会被自动清掉。

    async loadBackupIndex() {
        try {
            const res = await fetch(`/user/files/${BACKUP_INDEX}?t=${Date.now()}`, { cache: 'no-store' });
            const list = res.ok ? JSON.parse(await res.text()) : [];
            this.backups = Array.isArray(list) ? list.filter(b => b && b.name) : [];
        } catch {
            this.backups = [];
        }
        this.backups.sort((a, b) => String(b.at).localeCompare(String(a.at)));
        return this.backups;
    }

    async saveBackupIndex() {
        await uploadFile(BACKUP_INDEX, JSON.stringify(this.backups, null, 2));
    }

    static today() {
        const d = new Date();
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    static countLetters(text) {
        try { return Object.keys(JSON.parse(text).letters || {}).length; } catch { return 0; }
    }

    async writeBackup(text, { manual = false, note = '' } = {}) {
        const now = new Date();
        const p = n => String(n).padStart(2, '0');
        const date = Store.today();
        const name = manual || note
            ? `${BACKUP_PREFIX}${date}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.json`
            : `${BACKUP_PREFIX}${date}.json`;
        await uploadFile(name, text);
        this.backups = (this.backups || []).filter(b => b.name !== name);
        this.backups.unshift({ name, date, at: now.toISOString(), letters: Store.countLetters(text), size: text.length, manual: !!manual, note });
        return name;
    }

    async deleteBackupFile(name) {
        try {
            await fetch('/api/files/delete', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ path: `user/files/${name}` }) });
        } catch { /* 文件已经不在了 */ }
    }

    // 打开酒馆时调用：今天还没备份过就备份一份，再删掉多出来的旧的自动备份
    async autoBackup(keep = 7) {
        if (this.mode !== 'file' || !this.rawLoaded || !(keep > 0)) return null;
        await this.loadBackupIndex();
        const today = Store.today();
        let made = null;
        if (!this.backups.some(b => !b.manual && !b.note && b.date === today)) made = await this.writeBackup(this.rawLoaded);
        const autos = this.backups.filter(b => !b.manual && !b.note).sort((a, b) => String(b.at).localeCompare(String(a.at)));
        const extra = autos.slice(keep);
        for (const b of extra) await this.deleteBackupFile(b.name);
        // “恢复前”的自动快照最多留 5 份
        const pre = this.backups.filter(b => b.note).slice(5);
        for (const b of pre) await this.deleteBackupFile(b.name);
        if (made || extra.length || pre.length) {
            const drop = new Set([...extra, ...pre].map(b => b.name));
            this.backups = this.backups.filter(b => !drop.has(b.name));
            await this.saveBackupIndex();
        }
        return made;
    }

    async backupNow({ note = '' } = {}) {
        await this.loadBackupIndex();
        const name = await this.writeBackup(this.exportJson(), { manual: !note, note });
        await this.saveBackupIndex();
        return name;
    }

    async readBackup(name) {
        const res = await fetch(`/user/files/${encodeURIComponent(name)}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`读不到备份文件（HTTP ${res.status}）`);
        return res.text();
    }

    // 恢复：先把现在的档案存一份“恢复前”的快照，再换成备份里的
    async restoreBackup(name) {
        const text = await this.readBackup(name);
        migrateArchive(JSON.parse(text)); // 先确认能读
        await this.backupNow({ note: `恢复前的快照` });
        this.importJson(text);
        await this.saveNow();
        return this.archive;
    }

    async removeBackup(name) {
        await this.loadBackupIndex();
        await this.deleteBackupFile(name);
        this.backups = this.backups.filter(b => b.name !== name);
        await this.saveBackupIndex();
    }

    statusText() {
        if (this.mode === 'file') return `档案文件：user/files/${FILE_NAME}`;
        if (this.mode === 'fallback') return `⚠ 文件存储不可用，暂存在酒馆设置里（${this.lastError}）。请导出备份。`;
        return '尚未读取';
    }

    exportJson() {
        return JSON.stringify(this.archive, null, 2);
    }

    importJson(text) {
        const parsed = migrateArchive(JSON.parse(text));
        this.archive = parsed;
        this.save();
        return parsed;
    }
}
