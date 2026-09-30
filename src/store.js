// 书信簿 · 存储
// 档案存成酒馆服务器上的一个独立 JSON 文件（data/<用户>/user/files/epistolary_archive.json），
// 不放进 settings.json，也不放在浏览器本地数据库里 —— 换浏览器、清缓存都不会丢。
// 本次会话第一次保存前，会先把读到的旧档案另存一份备份。

import { createArchive, migrateArchive } from './model.js';

export const FILE_NAME = 'epistolary_archive.json';
export const BACKUP_NAME = 'epistolary_archive.backup.json';
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
