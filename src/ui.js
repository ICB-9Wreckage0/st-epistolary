// 书信簿 · 界面
// 简单模式：信件 / 写信 / 人物。写信页像文档一样，直接在信纸上写。
// 专家模式：多出段落与关键词、流转记录、知情一览、套语管理、注入预览。

import {
    KINDS, STATUSES, AUTHENTICITY, EVENT_TYPES, LEVEL_LABELS,
    createLetter, normalizeLetter, normalizePerson, resegment, segmentPosition, knowledgeTable,
    parseTags, parseNames, splitSamples, findPerson, clone,
} from './model.js';
import { allPresets, POSITIONS, LANGS } from './presets.js';
import {
    addDays, formatDateLine, guessLang, deliveryEvents, arrivalOf,
    buildReplyPrompt, cleanReply, EXAMPLE_PROFILES,
} from './correspondence.js';
import { playSeal, playOpen, WAX_LABELS, ENVELOPE_LABELS } from './envelope.js';
import { HANDS, ORIENTATIONS, paperClasses, renderBody, analyze, scriptLang } from './render.js';

const PAPERS = { plain: '素白', cream: '奶油棉纸', aged: '泛黄旧纸', lined: '横格信笺', blue: '淡蓝航空信纸' };
const INKS = { black: '墨黑', blueblack: '蓝黑', brown: '深褐', faded: '褪色铁胆' };
const FONTS = Object.fromEntries(Object.entries(HANDS).map(([k, v]) => [k, `字迹：${v.label}`]));
const LENGTH_LABELS = { natural: '按本人习惯', short: '短', medium: '中', long: '长（可带附言）' };
const PS_TEXT = { zh: '\n\n又及：', fr: '\n\nP.-S. ', en: '\n\nP.S. ', de: '\n\nPS: ' };

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function asText(v, sep = '、') {
    return Array.isArray(v) ? v.join(sep) : (v ?? '');
}
function options(map, current) {
    return Object.entries(map).map(([k, v]) => `<option value="${esc(k)}" ${k === current ? 'selected' : ''}>${esc(v)}</option>`).join('');
}
function preview(text, n = 60) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
}
function charCount(text) {
    return String(text || '').replace(/\s/g, '').length;
}
function daysBetween(a, b) {
    const pa = Date.parse(a), pb = Date.parse(b);
    if (Number.isNaN(pa) || Number.isNaN(pb)) return null;
    return Math.round((pb - pa) / 86400000);
}

export class UI {
    /**
     * @param {import('./store.js').Store} store
     * @param {object} hooks 由 index.js 提供的酒馆接口
     */
    constructor(store, hooks) {
        this.store = store;
        this.hooks = hooks;
        this.tab = 'list';
        this.draft = null;
        this.search = '';
        this.presetLang = '';
        this.openSections = new Set();
        this.busy = false;
    }

    get archive() { return this.store.archive; }
    get expert() { return this.hooks.getMode() === 'expert'; }

    mount() {
        const root = document.createElement('div');
        root.id = 'epi-root';
        root.className = 'epi-hidden';
        root.innerHTML = `
            <div class="epi-window" role="dialog" aria-label="书信簿">
                <div class="epi-header">
                    <span class="epi-title">✉ 书信簿</span>
                    <nav class="epi-tabs"></nav>
                    <div class="epi-mode" title="简单模式只显示写信需要的东西；专家模式显示段落、流转、注入等全部细节">
                        <button data-act="mode" data-mode="simple">简单</button><button data-act="mode" data-mode="expert">专家</button>
                    </div>
                    <button class="epi-close" data-act="close" title="关闭">✕</button>
                </div>
                <div class="epi-body"></div>
            </div>
            <div class="epi-reader-wrap epi-hidden"></div>
            <div class="epi-dialog-wrap epi-hidden"></div>`;
        document.body.appendChild(root);
        this.root = root;
        this.body = root.querySelector('.epi-body');
        root.addEventListener('click', e => this.onClick(e));
        root.addEventListener('input', e => this.onInput(e));
        root.addEventListener('change', e => this.onInput(e));
        root.addEventListener('toggle', e => {
            const sec = e.target?.dataset?.sec;
            if (!sec) return;
            if (e.target.open) this.openSections.add(sec); else this.openSections.delete(sec);
        }, true);
        root.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && this.tab === 'edit' && this.draft) {
                e.preventDefault();
                this.saveDraft();
                this.rerenderKeepScroll();
            }
        });
    }

    tabs() {
        return this.expert
            ? [['list', '信件'], ['edit', '写信'], ['people', '人物'], ['presets', '套语'], ['preview', '注入预览']]
            : [['list', '信件'], ['edit', '写信'], ['people', '人物']];
    }

    open(tab) {
        this.root.classList.remove('epi-hidden');
        this.show(tab || this.tab);
    }

    close() {
        if (this.draft && this.draftDirty && !confirm('这封信有未保存的修改，确定关闭吗？')) return;
        this.root.classList.add('epi-hidden');
    }

    show(tab) {
        if (!this.tabs().some(([k]) => k === tab)) tab = 'list';
        this.tab = tab;
        this.root.querySelector('.epi-tabs').innerHTML = this.tabs()
            .map(([k, v]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${v}</button>`).join('');
        this.root.querySelectorAll('.epi-mode button').forEach(b => b.classList.toggle('active', b.dataset.mode === this.hooks.getMode()));
        const r = {
            list: () => this.renderList(),
            edit: () => this.renderComposer(),
            people: () => this.renderPeople(),
            presets: () => this.renderPresets(),
            preview: () => this.renderPreview(),
        }[tab];
        // 重绘前先让输入框失焦；失焦触发的 change 事件在重绘期间忽略（内容已经在 input 事件里同步过了）
        this.rendering = true;
        try {
            const active = document.activeElement;
            if (active && this.body.contains(active)) active.blur();
            this.body.innerHTML = r ? r() : '';
        } finally {
            this.rendering = false;
        }
        this.body.scrollTop = 0;
        if (tab === 'edit') this.fitPage();
    }

    rerenderKeepScroll() {
        const y = this.body.scrollTop;
        this.show(this.tab);
        this.body.scrollTop = y;
        if (this.draftDirty) this.setDirty();
    }

    refresh() {
        if (!this.root.classList.contains('epi-hidden') && this.tab !== 'edit') this.show(this.tab);
    }

    // ================= 信件列表 =================

    renderList() {
        const q = this.search.trim().toLowerCase();
        const letters = Object.values(this.archive.letters)
            .filter(l => !q || [l.id, l.title, l.author, ...l.recipients, ...l.tags, l.body].join(' ').toLowerCase().includes(q))
            .sort((a, b) => (a.writtenAt || '').localeCompare(b.writtenAt || '') || a.id.localeCompare(b.id));
        const ex = this.expert;

        const rows = letters.map(l => `
            <div class="epi-card">
                <div class="epi-card-main" data-act="read" data-id="${esc(l.id)}">
                    <div class="epi-card-top">
                        <b>${esc(l.author || '？')} → ${esc(l.recipients.join('、') || '？')}</b>
                        <span class="epi-muted">${esc(l.writtenAt || '日期不详')}</span>
                        ${l.status !== 'sent' ? `<span class="epi-chip epi-status-${esc(l.status)}">${esc(STATUSES[l.status])}</span>` : ''}
                        ${l.inReplyTo ? `<span class="epi-chip">↩ 回信</span>` : ''}
                        ${ex ? `<span class="epi-muted">${esc(l.id)}</span>` : ''}
                        ${ex && l.authenticity !== 'original' ? `<span class="epi-chip">${esc(AUTHENTICITY[l.authenticity])}</span>` : ''}
                    </div>
                    <div class="epi-muted">${esc(preview(l.body, 90))}</div>
                    ${ex && l.tags.length ? `<div class="epi-tags">${l.tags.map(t => `<span>#${esc(t)}</span>`).join('')}</div>` : ''}
                </div>
                <div class="epi-card-actions">
                    <button class="menu_button" data-act="edit" data-id="${esc(l.id)}">编辑</button>
                    <button class="menu_button" data-act="delete" data-id="${esc(l.id)}">删除</button>
                </div>
            </div>`).join('');

        return `
            <div class="epi-toolbar">
                <button class="menu_button" data-act="new">✎ 写新信</button>
                <input class="text_pole epi-search" data-act="search" placeholder="搜索人名、关键词、正文…" value="${esc(this.search)}">
                <span class="epi-muted">${letters.length} 封</span>
            </div>
            ${rows || '<div class="epi-empty">还没有信件。点「写新信」开始，或者把聊天里的信粘贴进来。</div>'}
            <div class="epi-muted epi-foot">${esc(this.store.statusText())}</div>`;
    }

    // ================= 写信页（文档式） =================

    startEdit(id) {
        if (id) {
            this.draft = clone(this.archive.letters[id]);
            this.draftIsNew = false;
        } else {
            this.draft = normalizeLetter({
                id: '（新信件）',
                status: 'draft',
                author: this.hooks.getUserName() || '',
                recipients: [this.hooks.getCharName()].filter(Boolean),
                writtenAt: this.hooks.getStoryDate() || '',
            }, '');
            this.applyAuthorHand(this.draft);
            this.draftIsNew = true;
        }
        this.draftDirty = false;
        this.fontTouched = false;
        this.presetLang = '';
        this.show('edit');
    }

    // 写信人的人物档案里设了字迹，就用它
    applyAuthorHand(d) {
        const p = findPerson(this.archive, d.author);
        if (p?.hand) d.appearance.font = p.hand;
    }

    // 回复一封信（用户自己写）
    startUserReply(originalId) {
        const o = this.archive.letters[originalId];
        if (!o) return;
        this.draft = normalizeLetter({
            id: '（新信件）',
            status: 'draft',
            author: o.recipients[0] || this.hooks.getUserName() || '',
            recipients: [o.author],
            writtenAt: this.hooks.getStoryDate() || '',
            placeFrom: o.placeTo, placeTo: o.placeFrom,
            language: o.language,
            appearance: { ...o.appearance },
            inReplyTo: o.id,
        }, '');
        this.applyAuthorHand(this.draft);
        this.fontTouched = false;
        this.draftIsNew = true;
        this.draftDirty = false;
        this.closeReader();
        this.show('edit');
    }

    currentLang() {
        return this.presetLang || guessLang(this.draft?.language);
    }

    commitRaw(d) {
        for (const e of d.events) {
            if (typeof e.segments === 'string') {
                const s = e.segments.trim();
                if (!s || s === '全部') e.segments = null;
                else {
                    const ids = s.split(/[,，、\s]+/).map(x => parseInt(x.replace(/[§]/g, ''), 10))
                        .filter(n => n >= 1 && n <= d.segments.length)
                        .map(n => d.segments[n - 1].id);
                    e.segments = ids.length ? ids : null;
                }
            }
        }
        for (const seg of d.segments) {
            if (typeof seg.references === 'string') {
                seg.references = seg.references.split(/[,，、;\s]+/).filter(Boolean).map(ref => {
                    const m = ref.match(/^(LETTER-\d+)(?:§(\d+))?$/i);
                    if (!m) return null;
                    const target = this.archive.letters[m[1].toUpperCase()];
                    const segId = target && m[2] ? target.segments[parseInt(m[2], 10) - 1]?.id : null;
                    return { letter: m[1].toUpperCase(), segment: segId || null };
                }).filter(Boolean);
            }
            seg.tags = parseTags(seg.tags);
            seg.aiTags = parseTags(seg.aiTags);
        }
    }

    refSummary(refs) {
        if (typeof refs === 'string') return refs;
        return (refs || []).map(r => {
            const t = this.archive.letters[r.letter];
            const pos = t && r.segment ? segmentPosition(t, r.segment) : null;
            return pos ? `${r.letter}§${pos}` : r.letter;
        }).join(', ');
    }

    evSegText(d, ev) {
        if (typeof ev.segments === 'string') return ev.segments;
        if (!ev.segments) return '全部';
        return ev.segments.map(id => segmentPosition(d, id)).filter(Boolean).join(',');
    }

    presetSelect(pos, label) {
        const lang = this.currentLang();
        const list = allPresets(this.archive).filter(p => p.lang === lang && p.position === pos);
        if (!list.length) return '';
        return `<select class="epi-rsel" data-act="ins" title="插入${esc(label)}">
            <option value="">${esc(label)} ▾</option>
            ${list.map(p => `<option value="${esc(p.text)}" title="${esc([p.era, p.formality, p.relation, p.note].filter(Boolean).join(' · '))}">${esc(p.text.replace(/\n/g, ' ⏎ '))}　〔${esc(p.era || '')}〕</option>`).join('')}
        </select>`;
    }

    renderComposer() {
        const d = this.draft;
        if (!d) {
            return `<div class="epi-empty">
                <p>在「信件」里点「编辑」，或者：</p>
                <button class="menu_button" data-act="new">✎ 写新信</button>
            </div>`;
        }
        const ex = this.expert;
        const a = d.appearance;
        const saved = !this.draftIsNew;
        const orig = d.inReplyTo ? this.archive.letters[d.inReplyTo] : null;

        let banner = '';
        if (d.aiDraft) {
            banner = `<div class="epi-banner">
                <div>这是 AI 按 <b>${esc(d.author)}</b> 的口吻代写的回信草稿。可以直接在信纸上修改。</div>
                <div class="epi-banner-actions">
                    <button class="menu_button" data-act="accept-reply">✓ 收下这封回信</button>
                    <button class="menu_button" data-act="regen-reply">↻ 重新写</button>
                    <button class="menu_button" data-act="discard-draft">丢弃</button>
                </div>
            </div>`;
        } else if (orig) {
            banner = `<div class="epi-banner epi-banner-soft">↩ 回复 <a href="#" data-act="read" data-id="${esc(orig.id)}">${esc(orig.author)} ${esc(orig.writtenAt)} 的来信</a></div>`;
        }

        const canAskReply = saved && !d.aiDraft && d.recipients.length > 0;
        const ribbon = `
            <div class="epi-ribbon">
                <div class="epi-rgroup">
                    <button class="epi-rbtn epi-primary" data-act="save" title="保存（Ctrl+S）">💾 保存</button>
                    ${d.aiDraft ? '' : `<button class="epi-rbtn" data-act="send-open" title="寄出这封信：记录送达，可以让收件人在聊天里读信">✉ 寄出</button>`}
                    ${canAskReply ? `<button class="epi-rbtn" data-act="reply-open" title="让收件人用自己的口吻写回信">↩ 让对方回信</button>` : ''}
                </div>
                <div class="epi-rgroup">
                    <span class="epi-rlabel">插入</span>
                    ${this.presetSelect('salutation', '称呼')}
                    ${this.presetSelect('opening', '开头')}
                    ${this.presetSelect('closing', '结尾')}
                    ${this.presetSelect('signoff', '署名前')}
                    <button class="epi-rbtn" data-act="ins-dateline" title="按书信语言的习惯插入地点和日期">日期行</button>
                    <button class="epi-rbtn" data-act="ins-ps">附言</button>
                    <select class="epi-rsel" data-act="preset-lang" title="套语的语言">${options(LANGS, this.currentLang())}</select>
                </div>
                <div class="epi-rgroup">
                    <select class="epi-rsel" data-f="appearance.orientation" title="信纸版式">${options(ORIENTATIONS, a.orientation)}</select>
                    <select class="epi-rsel" data-f="appearance.paper" title="信纸">${options(PAPERS, a.paper)}</select>
                    <select class="epi-rsel" data-f="appearance.ink" title="墨水">${options(INKS, a.ink)}</select>
                    <select class="epi-rsel" data-f="appearance.font" title="${esc(Object.values(HANDS).map(h => `${h.label}：${h.desc}`).join('\n'))}">${options(FONTS, a.font)}</select>
                    <button class="epi-rbtn ${a.flourish ? 'epi-on' : ''}" data-act="toggle-flourish" title="阅读时把称呼和署名换成花体（Great Vibes / 马善政）">✍ 花体称呼署名</button>
                    <select class="epi-rsel" data-f="appearance.envelope" title="信封">${options(ENVELOPE_LABELS, a.envelope)}</select>
                    <select class="epi-rsel" data-f="appearance.wax" title="火漆">${options(WAX_LABELS, a.wax)}</select>
                </div>
            </div>`;

        const letterhead = `
            <div class="epi-letterhead">
                <label><span>写信人</span><input data-f="author" value="${esc(d.author)}" size="8"></label>
                <label><span>寄给</span><input data-f="recipients" value="${esc(asText(d.recipients))}" size="10" placeholder="多人用顿号分隔"></label>
                <label><span>写于</span><input data-f="writtenAt" value="${esc(d.writtenAt)}" size="10" placeholder="1890-11-03"></label>
                <label><span>从</span><input data-f="placeFrom" value="${esc(d.placeFrom)}" size="6" placeholder="寄出地"></label>
                <label><span>到</span><input data-f="placeTo" value="${esc(d.placeTo)}" size="6" placeholder="寄往地"></label>
                <label><span>语言</span><input data-f="language" value="${esc(d.language)}" size="10" placeholder="如 法语（中文显示）"></label>
            </div>`;

        const page = `
            <div class="epi-desk">
                <div class="${esc(paperClasses(d))} epi-paper-edit">
                    <textarea class="epi-page" data-f="body" spellcheck="false" placeholder="在这里写信……&#10;&#10;空一行就是新的一段。上面的「插入」可以加称呼、结尾语和日期行。">${esc(d.body)}</textarea>
                </div>
            </div>
            <div class="epi-docstatus">
                <span>${esc(STATUSES[d.status])}</span>
                <span data-role="count">${charCount(d.body)} 字</span>
                ${ex ? `<span>${esc(d.id)}</span><span>${d.segments.length} 段</span>` : ''}
                <span data-role="dirty" class="epi-dirty">${this.draftDirty ? '● 未保存' : ''}</span>
            </div>`;

        return `<div class="epi-doc">${ribbon}${banner}${letterhead}${page}${ex ? this.renderExpertSections(d) : ''}</div>`;
    }

    renderExpertSections(d) {
        const storyDate = this.hooks.getStoryDate();
        const open = k => (this.openSections.has(k) ? 'open' : '');

        const segs = d.segments.map((s, i) => `
            <div class="epi-seg">
                <div class="epi-seg-head"><b>§${i + 1}</b><span class="epi-muted">${esc(preview(s.text, 80))}</span></div>
                <div class="epi-grid2">
                    <label>关键词<input class="text_pole" data-seg="${esc(s.id)}" data-sf="tags" value="${esc(asText(s.tags))}" placeholder="用逗号或顿号分隔"></label>
                    <label>AI 建议关键词<input class="text_pole" data-seg="${esc(s.id)}" data-sf="aiTags" value="${esc(asText(s.aiTags))}"></label>
                    <label>大意（转述时用）<input class="text_pole" data-seg="${esc(s.id)}" data-sf="summary" value="${esc(s.summary)}" placeholder="听人转述的角色只会知道这句"></label>
                    <label>回应的是<input class="text_pole" data-seg="${esc(s.id)}" data-sf="references" value="${esc(this.refSummary(s.references))}" placeholder="如 LETTER-0003§2"></label>
                </div>
            </div>`).join('');

        const evRows = d.events.map(ev => `
            <tr>
                <td><select class="text_pole" data-ev="${esc(ev.id)}" data-ef="type">${options(Object.fromEntries(Object.entries(EVENT_TYPES).map(([k, v]) => [k, v.label])), ev.type)}</select></td>
                <td><input class="text_pole" data-ev="${esc(ev.id)}" data-ef="who" value="${esc(ev.who)}" placeholder="谁"></td>
                <td><input class="text_pole" data-ev="${esc(ev.id)}" data-ef="date" value="${esc(ev.date)}" placeholder="日期"></td>
                <td><input class="text_pole" data-ev="${esc(ev.id)}" data-ef="segments" value="${esc(this.evSegText(d, ev))}" title="全部，或段落号如 3,4"></td>
                <td><input class="text_pole" data-ev="${esc(ev.id)}" data-ef="note" value="${esc(ev.to || ev.note)}" placeholder="${ev.type === 'forwarded' ? '转寄给谁' : '备注'}"></td>
                <td><button class="menu_button" data-act="ev-del" data-id="${esc(ev.id)}">✕</button></td>
            </tr>`).join('');

        let knowHtml = '';
        try {
            const tmp = clone(d);
            this.commitRaw(tmp);
            tmp.recipients = parseNames(tmp.recipients);
            knowHtml = knowledgeTable(this.archive, tmp, storyDate).map(row => {
                if (!row.exists) return `<li><b>${esc(row.name)}</b>：信还没写成</li>`;
                const full = tmp.segments.filter(s => row.segLevels[s.id] === 'full').map(s => segmentPosition(tmp, s.id));
                const sum = tmp.segments.filter(s => row.segLevels[s.id] === 'summary').map(s => segmentPosition(tmp, s.id));
                const parts = [];
                if (full.length) parts.push(full.length === tmp.segments.length ? '全文原文' : `原文 §${full.join(',')}`);
                if (sum.length) parts.push(`大意 §${sum.join(',')}`);
                if (!parts.length) parts.push(LEVEL_LABELS[row.letterLevel]);
                return `<li><b>${esc(row.name)}</b>：${esc(parts.join('；'))}</li>`;
            }).join('');
        } catch (e) { console.error(e); }

        return `
            <details class="epi-sec" data-sec="props" ${open('props')}><summary>其他属性</summary>
                <div class="epi-grid3">
                    <label>类型<select class="text_pole" data-f="kind">${options(KINDS, d.kind)}</select></label>
                    <label>状态<select class="text_pole" data-f="status">${options(STATUSES, d.status)}</select></label>
                    <label>真实性<select class="text_pole" data-f="authenticity">${options(AUTHENTICITY, d.authenticity)}</select></label>
                    <label>署名（只用于显示）<input class="text_pole" data-f="signature" value="${esc(d.signature)}"></label>
                    <label>标题/备忘<input class="text_pole" data-f="title" value="${esc(d.title)}"></label>
                    <label>整封信的关键词<input class="text_pole" data-f="tags" value="${esc(asText(d.tags))}"></label>
                    <label>回复的是哪封信<input class="text_pole" data-f="inReplyTo" value="${esc(d.inReplyTo)}" placeholder="LETTER-0003"></label>
                    <label>关联作品 ID（创作助手）<input class="text_pole" data-f="links.works" value="${esc(asText(d.links.works, ', '))}"></label>
                    <label>备注<input class="text_pole" data-f="notes" value="${esc(d.notes)}"></label>
                </div>
            </details>
            <details class="epi-sec" data-sec="segs" ${open('segs')}><summary>段落与关键词（${d.segments.length} 段）</summary>
                <div class="epi-toolbar">
                    <button class="menu_button" data-act="resplit">按正文重新分段</button>
                    <button class="menu_button" data-act="ai-analyze" title="调用当前 API，为每段建议关键词和大意">✨ AI 分析段落</button>
                </div>
                ${segs || '<div class="epi-muted">正文为空。</div>'}
            </details>
            <details class="epi-sec" data-sec="events" ${open('events')}><summary>流转记录（${d.events.length} 条）</summary>
                <div class="epi-muted">谁在什么时候收到、读过、听过、被转述过这封信。没有记录的人，AI 扮演时就不会知道信的内容。段落填「全部」或段落号（如 3,4）。</div>
                <div class="epi-table-wrap"><table class="epi-table">
                    <thead><tr><th>事件</th><th>谁</th><th>日期</th><th>段落</th><th>备注/转寄给</th><th></th></tr></thead>
                    <tbody>${evRows}</tbody>
                </table></div>
                <div class="epi-toolbar">
                    <button class="menu_button" data-act="ev-quick-sent">＋ 写信人寄出</button>
                    <button class="menu_button" data-act="ev-quick-read">＋ 收件人收到并阅读</button>
                    <button class="menu_button" data-act="ev-add">＋ 其他事件</button>
                </div>
            </details>
            <details class="epi-sec" data-sec="know" ${open('know')}><summary>知情一览</summary>
                <div class="epi-muted">按当前剧情日期：${esc(storyDate || '未设置，不按日期过滤')}</div>
                <ul class="epi-know">${knowHtml || '<li class="epi-muted">还没有相关人物</li>'}</ul>
            </details>`;
    }

    // 信纸按版式保持纸张比例（竖版约 1:1.41，横版约 1.41:1），字多了再往下长
    fitPage() {
        const ta = this.body.querySelector('.epi-page');
        const paper = this.body.querySelector('.epi-paper-edit');
        if (!ta || !paper) return;
        const cs = getComputedStyle(paper);
        const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        const ratio = paper.classList.contains('orient-landscape') ? 0.707 : 1.414;
        const minH = Math.max(260, paper.clientWidth * ratio - padV);
        ta.style.height = 'auto';
        ta.style.height = Math.max(ta.scrollHeight, minH) + 'px';
    }

    setDirty() {
        this.draftDirty = true;
        const el = this.body.querySelector('[data-role="dirty"]');
        if (el) el.textContent = '● 未保存';
    }

    resplitDraft() {
        this.commitRaw(this.draft);
        resegment(this.draft);
    }

    // 保存草稿。返回保存后的信件
    saveDraft({ silent = false } = {}) {
        const d = this.draft;
        this.commitRaw(d);
        resegment(d);
        d.links.works = parseTags(d.links.works);
        for (const e of d.events) if (e.type === 'forwarded') e.to = e.note;
        let letter;
        if (this.draftIsNew) {
            letter = createLetter(this.archive, { ...d, id: undefined });
        } else {
            letter = normalizeLetter(d, d.id);
            letter.updatedAt = new Date().toISOString();
            this.archive.letters[d.id] = letter;
        }
        this.store.save();
        this.draft = clone(letter);
        this.draftIsNew = false;
        this.draftDirty = false;
        if (!silent) toastr?.success('已保存');
        this.maybeAutoAnalyze(letter.id);
        return letter;
    }

    // 简单模式下，保存后自动为没有关键词的段落生成关键词
    maybeAutoAnalyze(id) {
        if (this.expert || !this.hooks.getSettings().autoKeywords) return;
        const l = this.archive.letters[id];
        if (!l || l.aiDraft || !l.segments.length) return;
        const missing = l.segments.some(s => !s.tags.length && !s.aiTags.length);
        if (!missing) return;
        this.analyzeSegments(l, { quiet: true }).then(n => {
            if (!n) return;
            this.store.save();
            if (this.draft?.id === id && !this.draftDirty) this.draft = clone(this.archive.letters[id]);
        }).catch(e => console.warn('[书信簿] 自动关键词失败', e));
    }

    async analyzeSegments(l, { quiet = false } = {}) {
        const list = l.segments.map((s, i) => `§${i + 1}\n${s.text}`).join('\n\n');
        const system = '你是书信档案的整理助手。只按要求的格式输出，不要解释。';
        const prompt = `下面是一封信（写信人：${l.author || '未知'}，收件人：${asText(l.recipients) || '未知'}）的各个段落。
请为每一段给出 3 到 6 个检索关键词（人物、地点、物品、事件、情绪等，日后对话中提到这些词时要能找回这一段），再用一句话写出这一段的大意（用第三人称，例如“EE 说她担心文森特”）。
每段输出一行，格式严格如下：
§段落号 | 关键词1, 关键词2, 关键词3 | 大意

${list}`;
        const out = await this.hooks.generateRaw(prompt, system);
        let n = 0;
        for (const line of String(out || '').split('\n')) {
            const m = line.match(/§?\s*(\d+)\s*[|｜]\s*([^|｜]*)(?:[|｜]\s*(.*))?/);
            if (!m) continue;
            const seg = l.segments[parseInt(m[1], 10) - 1];
            if (!seg) continue;
            seg.aiTags = parseTags(m[2]);
            if (m[3] && !String(seg.summary || '').trim()) seg.summary = m[3].trim();
            n++;
        }
        if (!n && !quiet) console.log('[书信簿] AI 分析原始回复：', out);
        return n;
    }

    async aiAnalyzeDraft() {
        this.resplitDraft();
        if (!this.draft.segments.length) { toastr?.info('正文为空'); return; }
        const btn = this.body.querySelector('[data-act="ai-analyze"]');
        if (btn) { btn.disabled = true; btn.textContent = '分析中…'; }
        try {
            const n = await this.analyzeSegments(this.draft);
            if (!n) toastr?.warning('没能解析 AI 的回复，请看控制台');
            else toastr?.success(`已为 ${n} 段填入建议，请检查后保存`);
        } catch (e) {
            console.error(e);
            toastr?.error('AI 分析失败：' + (e.message || e));
        }
        this.openSections.add('segs');
        this.rerenderKeepScroll();
        this.setDirty();
    }

    newEventId() {
        let max = 0;
        for (const e of this.draft.events) {
            const n = parseInt(String(e.id).replace(/\D/g, ''), 10);
            if (n > max) max = n;
        }
        return `E${max + 1}`;
    }

    addEvent(partial) {
        this.draft.events.push({ id: this.newEventId(), type: 'read', who: '', date: '', segments: null, to: '', note: '', ...partial });
        this.setDirty();
    }

    insertAtCursor(text, { ownLine = false } = {}) {
        const ta = this.body.querySelector('.epi-page');
        if (!ta || !this.draft) return;
        const start = ta.selectionStart ?? ta.value.length;
        const end = ta.selectionEnd ?? start;
        let t = text;
        if (ownLine) {
            const before = ta.value.slice(0, start);
            if (before && !before.endsWith('\n')) t = '\n' + t;
            if (!ta.value.slice(end).startsWith('\n')) t = t + '\n';
        }
        ta.value = ta.value.slice(0, start) + t + ta.value.slice(end);
        ta.selectionStart = ta.selectionEnd = start + t.length;
        ta.focus();
        this.draft.body = ta.value;
        this.fitPage();
        this.updateCount();
        this.setDirty();
    }

    updateCount() {
        const el = this.body.querySelector('[data-role="count"]');
        if (el) el.textContent = `${charCount(this.draft.body)} 字`;
    }

    // ================= 寄出 =================

    openSendDialog() {
        const d = this.draft;
        if (!d.body.trim()) { toastr?.info('信还是空的'); return; }
        const rs = parseNames(d.recipients);
        if (!rs.length) { toastr?.info('先填「寄给」谁'); return; }
        const base = d.writtenAt || this.hooks.getStoryDate();
        const arrival = addDays(base, 3) || '';
        const reader = rs[0];
        const charName = this.hooks.getCharName();
        const mismatch = charName && !rs.some(r => findPerson(this.archive, r) ? findPerson(this.archive, r) === findPerson(this.archive, charName) : r === charName);

        this.openDialog(`
            <h3>寄出这封信</h3>
            <p>寄给 <b>${esc(rs.join('、'))}</b>${d.writtenAt ? `，写于 ${esc(d.writtenAt)}` : ''}。</p>
            <label>送达日期
                <div class="epi-row">
                    <input class="text_pole" id="epi-send-arrival" value="${esc(arrival)}" placeholder="送达那天的日期">
                    ${base ? [1, 3, 7, 14].map(n => `<button class="menu_button epi-mini" data-act="send-days" data-days="${n}">+${n === 7 ? '1周' : n === 14 ? '2周' : n + '天'}</button>`).join('') : ''}
                </div>
                <small class="epi-muted">路上要走多久由你定：同城一两天，跨国一周左右，跨洋两三周。</small>
            </label>
            <label class="checkbox_label"><input type="checkbox" id="epi-send-events" checked> 记录寄出、送达和阅读（收件人从此知道信的内容）</label>
            <label class="checkbox_label"><input type="checkbox" id="epi-send-date" ${this.hooks.hasChat() ? 'checked' : 'disabled'}> 把本聊天的剧情日期改成送达那天</label>
            <div class="epi-choice">
                <label><input type="radio" name="epi-send-next" value="archive"> 只寄出、存档</label>
                <label><input type="radio" name="epi-send-next" value="chat" ${this.hooks.hasChat() ? 'checked' : 'disabled'}> 发到聊天，让 <b>${esc(reader)}</b> 读信并做出反应</label>
                <label><input type="radio" name="epi-send-next" value="reply" ${this.hooks.hasChat() ? '' : 'checked'}> 让 <b>${esc(reader)}</b> 直接写回信</label>
            </div>
            ${mismatch ? `<p class="epi-warn">当前聊天的角色是 ${esc(charName)}，不是收件人。发到聊天后，读信的会是 ${esc(charName)} 扮演的场景。</p>` : ''}
            <div class="epi-dialog-actions">
                <button class="menu_button" data-act="dialog-close">取消</button>
                <button class="menu_button epi-primary" data-act="send-confirm">寄出</button>
            </div>`);
        this.sendBase = base;
    }

    async confirmSend() {
        const q = sel => this.root.querySelector(sel);
        const arrival = q('#epi-send-arrival').value.trim();
        const record = q('#epi-send-events').checked;
        const setDate = q('#epi-send-date').checked;
        const next = this.root.querySelector('input[name="epi-send-next"]:checked')?.value || 'archive';

        this.draft.status = 'sent';
        const letter = this.saveDraft({ silent: true });
        if (record) {
            letter.events.push(...deliveryEvents(letter, arrival, letter.events));
        }
        this.store.save();
        this.draft = clone(letter);
        if (setDate && arrival) this.hooks.setStoryDate(arrival);
        this.closeDialog();
        if (this.hooks.getSettings().animations) {
            await playSeal({ ...letter, placeFrom: letter.placeFrom, writtenAt: letter.writtenAt }, { flyOut: next !== 'archive' });
        }
        toastr?.success('信已寄出');

        const reader = letter.recipients[0];
        if (next === 'chat') {
            await this.hooks.postLetterToChat(letter, reader, arrival);
            this.root.classList.add('epi-hidden');
        } else if (next === 'reply') {
            this.openReplyDialog(letter.id, reader);
        } else {
            this.show('edit');
        }
    }

    // ================= 让对方回信 =================

    openReplyDialog(letterId, replierName) {
        const l = this.archive.letters[letterId];
        if (!l) return;
        const replier = replierName || l.recipients[0];
        const arrival = arrivalOf(this.archive, l, replier);
        const replyDate = addDays(arrival || l.writtenAt || this.hooks.getStoryDate(), arrival ? 2 : 5) || '';
        const person = findPerson(this.archive, replier);
        const styleInfo = !person
            ? `还没有 ${esc(replier)} 的文风档案，AI 会按自己对这个人的了解来写。可以去「人物」页添加。`
            : `已找到 ${esc(person.name)} 的文风档案：${person.historical ? '真实历史人物，' : ''}${person.styleNotes ? '有文风要点，' : ''}${person.styleSamples.length} 段书信样本。`;
        const isChar = this.hooks.isCurrentCharacter(replier);

        this.openDialog(`
            <h3>让 ${esc(replier)} 回信</h3>
            <p class="epi-muted">回复 ${esc(l.author)} ${esc(l.writtenAt)} 的来信${arrival ? `（${esc(replier)} 于 ${esc(arrival)} 收到）` : ''}。</p>
            ${l.recipients.length > 1 ? `<label>谁来回信<select class="text_pole" id="epi-reply-who">${l.recipients.map(r => `<option ${r === replier ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>` : `<input type="hidden" id="epi-reply-who" value="${esc(replier)}">`}
            <label>回信日期<input class="text_pole" id="epi-reply-date" value="${esc(replyDate)}"></label>
            <label>篇幅<select class="text_pole" id="epi-reply-length">${options(LENGTH_LABELS, 'natural')}</select></label>
            <p class="epi-muted">${styleInfo}</p>
            <p class="epi-muted">${isChar ? `会带上 ${esc(replier)} 的角色卡设定和最近的聊天一起写。` : '会只根据信件往来和文风档案来写。'}</p>
            <div class="epi-dialog-actions">
                <button class="menu_button" data-act="dialog-close">取消</button>
                <button class="menu_button epi-primary" data-act="reply-confirm" data-id="${esc(l.id)}">开始写</button>
            </div>`);
    }

    async generateReply(letterId, opts) {
        const l = this.archive.letters[letterId];
        const { replier, replyDate, length } = opts;
        const { system, prompt } = buildReplyPrompt(this.archive, l, replier, { replyDate, length });
        this.lastReply = { letterId, ...opts };
        this.busy = true;
        toastr?.info(`${replier} 正在写回信……`);
        try {
            const raw = await this.hooks.generateReply({ system, prompt, replier });
            const body = cleanReply(raw);
            if (!body) throw new Error('AI 没有返回内容');
            this.draft = normalizeLetter({
                id: '（回信草稿）',
                status: 'draft',
                author: replier,
                recipients: [l.author],
                writtenAt: replyDate,
                placeFrom: l.placeTo,
                placeTo: l.placeFrom,
                language: l.language,
                appearance: { ...l.appearance, font: findPerson(this.archive, replier)?.hand || l.appearance.font },
                inReplyTo: l.id,
                aiDraft: true,
                body,
            }, '');
            resegment(this.draft);
            this.draftIsNew = true;
            this.draftDirty = true;
            this.closeReader();
            if (this.hooks.getSettings().animations) {
                this.root.classList.add('epi-hidden');
                await playOpen(this.draft);
            }
            this.open('edit');
            this.setDirty();
        } catch (e) {
            console.error(e);
            toastr?.error('写回信失败：' + (e.message || e));
        } finally {
            this.busy = false;
        }
    }

    // 收下 AI 写的回信：保存，记录寄出和送达
    async acceptReply() {
        const d = this.draft;
        const o = this.archive.letters[d.inReplyTo];
        d.aiDraft = false;
        d.status = 'sent';
        const letter = this.saveDraft({ silent: true });
        // 回信路上走的天数，沿用来信的天数
        let days = 3;
        if (o) {
            const arr = arrivalOf(this.archive, o, letter.author);
            const n = daysBetween(o.writtenAt, arr);
            if (n != null && n >= 0) days = n;
        }
        const arrival = addDays(letter.writtenAt, days) || '';
        letter.events.push(...deliveryEvents(letter, arrival, letter.events));
        this.store.save();
        this.draft = clone(letter);
        this.maybeAutoAnalyze(letter.id);

        this.openDialog(`
            <h3>回信已收下</h3>
            <p>${esc(letter.author)} 的回信写于 ${esc(letter.writtenAt || '（未填）')}，预计 ${esc(arrival || '（未填）')} 送到 ${esc(letter.recipients.join('、'))} 手上。</p>
            <label class="checkbox_label"><input type="checkbox" id="epi-acc-date" ${this.hooks.hasChat() ? '' : 'disabled'}> 把本聊天的剧情日期改成 ${esc(arrival)}</label>
            <div class="epi-dialog-actions">
                <button class="menu_button" data-act="dialog-close">只存档</button>
                <button class="menu_button epi-primary" data-act="acc-post" data-arrival="${esc(arrival)}" ${this.hooks.hasChat() ? '' : 'disabled'}>发到聊天</button>
            </div>`);
        this.show('edit');
    }

    // ================= 人物 =================

    renderPeople() {
        const ex = this.expert;
        const cards = this.archive.people.map((p, i) => `
            <div class="epi-person">
                <div class="epi-person-head">
                    <input class="text_pole epi-person-name" data-person="${i}" data-pf="name" value="${esc(p.name)}" placeholder="名字">
                    <label class="checkbox_label"><input type="checkbox" data-person="${i}" data-pf="historical" ${p.historical ? 'checked' : ''}> 真实历史人物</label>
                    <button class="menu_button epi-mini" data-act="person-del" data-i="${i}" title="删除">✕</button>
                </div>
                <div class="epi-grid2">
                    <label>别名<input class="text_pole" data-person="${i}" data-pf="aliases" value="${esc(asText(p.aliases))}" placeholder="同一个人的其他叫法，顿号分隔：文森特、Vincent、梵高"></label>
                    <label>字迹（此人写信时默认）<select class="text_pole" data-person="${i}" data-pf="hand"><option value="">未指定</option>${options(Object.fromEntries(Object.entries(HANDS).map(([k, v]) => [k, `${v.label}　${v.desc}`])), p.hand)}</select></label>
                </div>
                <details class="epi-sec" data-sec="person-${i}" ${this.openSections.has(`person-${i}`) ? 'open' : ''}>
                    <summary>文风档案 ${p.styleNotes || p.styleSamples.length ? `<span class="epi-muted">（${p.styleSamples.length} 段样本）</span>` : '<span class="epi-muted">（未填写）</span>'}</summary>
                    <label>参考的书信集<input class="text_pole" data-person="${i}" data-pf="styleSource" value="${esc(p.styleSource)}" placeholder="如：梵高书信（致提奥）"></label>
                    <label>文风要点<textarea class="text_pole" rows="5" data-person="${i}" data-pf="styleNotes" placeholder="怎么称呼对方、怎么结尾、句子长短、常谈什么、对不同的人口吻有什么不同……">${esc(p.styleNotes)}</textarea></label>
                    <label>书信样本<textarea class="text_pole" rows="6" data-person="${i}" data-pf="styleSamples" placeholder="粘贴此人真实书信的片段。多段之间用单独一行 --- 隔开。&#10;写回信时会随机挑几段给 AI 参考口吻。">${esc(p.styleSamples.join('\n---\n'))}</textarea></label>
                    ${ex ? `<label>常用书信语言<input class="text_pole" data-person="${i}" data-pf="language" value="${esc(p.language)}" placeholder="法语（中文显示）"></label>` : ''}
                </details>
            </div>`).join('');
        return `
            <p class="epi-muted">同一个人的不同叫法写成别名，这样“提奥”“Theo”“提奥·梵高”会被当作同一个人；角色卡的名字也按这里匹配。<br>
            填了「文风档案」的人，写回信时会更像本人。真实历史人物勾上之后，AI 会参照此人现存书信的口吻。</p>
            <div class="epi-toolbar">
                <button class="menu_button" data-act="person-add">＋ 添加人物</button>
                <button class="menu_button" data-act="person-collect">从信件中收集人名</button>
                <button class="menu_button" data-act="person-example" data-key="vangogh">载入示例：文森特·梵高</button>
            </div>
            ${cards || '<div class="epi-empty">还没有人物。</div>'}`;
    }

    // ================= 套语（专家模式） =================

    renderPresets() {
        const custom = this.archive.presets.map((p, i) => `
            <tr><td>${esc(p.text)}</td><td>${esc(POSITIONS[p.position] || '')}</td><td>${esc(LANGS[p.lang] || p.lang)}</td><td>${esc(p.era || '')}</td><td>${esc(p.note || '')}</td>
            <td><button class="menu_button" data-act="preset-del" data-i="${i}">✕</button></td></tr>`).join('');
        const builtin = allPresets({ presets: [] }).map(p => `
            <tr><td>${esc(p.text)}</td><td>${esc(POSITIONS[p.position])}</td><td>${esc(LANGS[p.lang])}</td><td>${esc(p.era)}</td><td>${esc([p.formality, p.relation, p.note].filter(Boolean).join(' · '))}</td><td></td></tr>`).join('');
        return `
            <h4>添加自己的套语</h4>
            <div class="epi-grid3">
                <label>内容<input class="text_pole" id="epi-np-text" placeholder="如：见信好"></label>
                <label>位置<select class="text_pole" id="epi-np-pos">${options(POSITIONS, 'opening')}</select></label>
                <label>语言<select class="text_pole" id="epi-np-lang">${options(LANGS, 'zh')}</select></label>
                <label>时代<input class="text_pole" id="epi-np-era" placeholder="民国"></label>
                <label>备注<input class="text_pole" id="epi-np-note" placeholder="适合对象、语气"></label>
                <label>&nbsp;<button class="menu_button" data-act="preset-add">＋ 添加</button></label>
            </div>
            <h4>我的套语</h4>
            <div class="epi-table-wrap"><table class="epi-table"><thead><tr><th>内容</th><th>位置</th><th>语言</th><th>时代</th><th>备注</th><th></th></tr></thead><tbody>${custom || '<tr><td colspan="6" class="epi-muted">还没有</td></tr>'}</tbody></table></div>
            <h4>内置套语</h4>
            <div class="epi-table-wrap"><table class="epi-table"><thead><tr><th>内容</th><th>位置</th><th>语言</th><th>时代</th><th>说明</th><th></th></tr></thead><tbody>${builtin}</tbody></table></div>`;
    }

    // ================= 注入预览（专家模式） =================

    renderPreview() {
        let p;
        try { p = this.hooks.runPreview(); } catch (e) { return `<div class="epi-empty">无法预览：${esc(e.message || e)}</div>`; }
        const { viewer, storyDate, result, enabled, texts, reaction } = p;
        const segLabel = (lid, sid) => `${lid} §${segmentPosition(this.archive.letters[lid], sid)}`;
        const sel = result.selected.map(s => `<li><b>${esc(segLabel(s.letterId, s.segId))}</b>　${s.level === 'full' ? '原文' : '大意'}　<span class="epi-muted">命中：${esc(s.hits.join('、'))}（分数 ${s.score.toFixed(2)}）</span></li>`).join('');
        const blocked = result.blocked.map(b => `<li><b>${esc(segLabel(b.letterId, b.segId))}</b>　${esc(b.reason)}　<span class="epi-muted">命中：${esc(b.hits.join('、'))}</span></li>`).join('');
        const dropped = result.dropped.map(b => `<li><b>${esc(segLabel(b.letterId, b.segId))}</b>　${esc(b.dropped)}</li>`).join('');
        return `
            <div class="epi-toolbar"><button class="menu_button" data-act="preview-refresh">↻ 刷新</button>
                <span>${enabled ? '注入已开启' : '⚠ 注入已关闭（在扩展设置里开启）'}</span></div>
            <p>视角角色：<b>${esc(viewer || '全知（不过滤权限）')}</b>　剧情日期：<b>${esc(storyDate || '未设置')}</b>　扫描了最近 ${texts.length} 条消息</p>
            ${reaction ? `<h4>收信反应引导（下一次回复生效）</h4><pre class="epi-pre">${esc(reaction)}</pre>` : ''}
            <h4>会注入的段落</h4><ul>${sel || '<li class="epi-muted">没有</li>'}</ul>
            ${result.existsOnly.length ? `<h4>只提“知道存在”的信</h4><ul>${result.existsOnly.map(id => `<li>${esc(id)}</li>`).join('')}</ul>` : ''}
            <h4>命中了但被挡住的</h4><ul>${blocked || '<li class="epi-muted">没有</li>'}</ul>
            ${dropped ? `<h4>因预算没放进去的</h4><ul>${dropped}</ul>` : ''}
            <h4>实际注入文本（约 ${result.chars} 字）</h4>
            <pre class="epi-pre">${esc(result.text || '（空）')}</pre>`;
    }

    // ================= 阅读视图 =================

    // 打开阅读视图。寄给“我”（用户人设）的信，第一次打开时先播放拆信动画
    async openReaderWithAnim(id) {
        const l = this.archive.letters[id];
        if (!l) return;
        const me = this.hooks.getUserName();
        const toMe = me && l.recipients.some(r => r === me || findPerson(this.archive, r) === findPerson(this.archive, me) && findPerson(this.archive, me));
        if (toMe && !l.openedAt && l.status === 'sent' && this.hooks.getSettings().animations) {
            this.root.classList.add('epi-hidden');
            await playOpen(l);
            this.root.classList.remove('epi-hidden');
        }
        if (toMe && !l.openedAt) { l.openedAt = new Date().toISOString(); this.store.save(); }
        this.openReader(id);
    }

    openReader(id) {
        const l = this.archive.letters[id];
        if (!l) return;
        const wrap = this.root.querySelector('.epi-reader-wrap');
        const a = l.appearance || {};
        // 正文第一行已经写了地点日期，就不再在信头重复
        const hasDateline = analyze(l.body)[0]?.lines[0]?.role === 'dateline';
        const place = hasDateline ? '' : formatDateLine(scriptLang(l.language) === 'zh' ? 'zh' : guessLang(l.language), l.placeFrom, l.writtenAt);
        const attach = l.attachments.length ? `<div class="epi-paper-note">附件：${esc(l.attachments.join('、'))}</div>` : '';
        const showSign = l.signature && !l.body.trim().endsWith(l.signature.trim());
        const orig = l.inReplyTo ? this.archive.letters[l.inReplyTo] : null;
        const replies = Object.values(this.archive.letters).filter(x => x.inReplyTo === l.id);
        const recipient = l.recipients[0];
        wrap.innerHTML = `
            <div class="epi-reader">
                <div class="epi-reader-bar">
                    <span><b>${esc(l.author)}</b> → ${esc(l.recipients.join('、'))}
                        ${l.status !== 'sent' ? `<span class="epi-chip">${esc(STATUSES[l.status])}</span>` : ''}
                        ${l.authenticity !== 'original' ? `<span class="epi-chip">${esc(AUTHENTICITY[l.authenticity])}</span>` : ''}</span>
                    <span class="epi-reader-actions">
                        <button class="menu_button" data-act="user-reply" data-id="${esc(l.id)}" title="以 ${esc(recipient || '收件人')} 的身份写回信">✎ 回复这封信</button>
                        ${recipient ? `<button class="menu_button" data-act="reply-open-for" data-id="${esc(l.id)}">↩ 让 ${esc(recipient)} 回信</button>` : ''}
                        <button class="menu_button" data-act="edit" data-id="${esc(l.id)}">编辑</button>
                        <button class="menu_button" data-act="reader-close">关闭</button>
                    </span>
                </div>
                ${orig ? `<div class="epi-reader-link">↩ 这是对 <a href="#" data-act="read" data-id="${esc(orig.id)}">${esc(orig.author)} ${esc(orig.writtenAt)} 来信</a> 的回复</div>` : ''}
                <div class="${esc(paperClasses(l))} epi-paper-read">
                    ${place ? `<div class="epi-paper-place">${esc(place)}</div>` : ''}
                    <div class="epi-paper-body">${renderBody(l.body)}</div>
                    ${showSign ? `<div class="epi-paper-sign">${esc(l.signature)}</div>` : ''}
                    ${attach}
                </div>
                ${replies.length ? `<div class="epi-reader-link">回信：${replies.map(r => `<a href="#" data-act="read" data-id="${esc(r.id)}">${esc(r.author)} ${esc(r.writtenAt)}</a>`).join('　')}</div>` : ''}
            </div>`;
        wrap.classList.remove('epi-hidden');
        wrap.scrollTop = 0;
    }

    closeReader() {
        this.root.querySelector('.epi-reader-wrap').classList.add('epi-hidden');
    }

    // ================= 对话框 =================

    openDialog(html) {
        const wrap = this.root.querySelector('.epi-dialog-wrap');
        wrap.innerHTML = `<div class="epi-dialog">${html}</div>`;
        wrap.classList.remove('epi-hidden');
    }

    closeDialog() {
        this.root.querySelector('.epi-dialog-wrap').classList.add('epi-hidden');
    }

    // ================= 事件处理 =================

    onClick(e) {
        const tabBtn = e.target.closest('[data-tab]');
        if (tabBtn) { this.show(tabBtn.dataset.tab); return; }
        const el = e.target.closest('[data-act]');
        if (!el) {
            if (e.target === this.root) this.close();
            if (e.target.classList?.contains('epi-reader-wrap')) this.closeReader();
            if (e.target.classList?.contains('epi-dialog-wrap')) this.closeDialog();
            return;
        }
        if (el.tagName === 'SELECT' || el.tagName === 'INPUT') return;
        if (el.tagName === 'A') e.preventDefault();
        const act = el.dataset.act;
        const id = el.dataset.id;
        switch (act) {
            case 'close': this.close(); break;
            case 'mode':
                this.hooks.setMode(el.dataset.mode);
                if (this.tab === 'edit' && this.draft) this.commitRaw(this.draft);
                this.rerenderKeepScroll();
                break;
            case 'new': this.startEdit(null); break;
            case 'edit':
                if (this.draftDirty && this.draft?.id !== id && !confirm('当前这封信有未保存的修改，放弃修改吗？')) break;
                this.closeReader(); this.startEdit(id); break;
            case 'read': this.openReaderWithAnim(id); break;
            case 'reader-close': this.closeReader(); break;
            case 'user-reply': this.startUserReply(id); break;
            case 'reply-open-for': this.openReplyDialog(id); break;
            case 'delete':
                if (confirm('确定删除这封信？此操作不能撤销（档案文件有一份会话开始时的备份）。')) {
                    delete this.archive.letters[id];
                    if (this.draft?.id === id) this.draft = null;
                    this.store.save();
                    this.show('list');
                }
                break;
            case 'save': this.saveDraft(); this.rerenderKeepScroll(); break;
            case 'send-open': this.openSendDialog(); break;
            case 'send-days': {
                const inp = this.root.querySelector('#epi-send-arrival');
                inp.value = addDays(this.sendBase, parseInt(el.dataset.days, 10));
                break;
            }
            case 'send-confirm': this.confirmSend(); break;
            case 'reply-open':
                if (this.draftDirty) this.saveDraft({ silent: true });
                this.openReplyDialog(this.draft.id);
                break;
            case 'reply-confirm': {
                if (this.busy) break;
                const opts = {
                    replier: this.root.querySelector('#epi-reply-who').value,
                    replyDate: this.root.querySelector('#epi-reply-date').value.trim(),
                    length: this.root.querySelector('#epi-reply-length').value,
                };
                this.closeDialog();
                this.generateReply(id, opts);
                break;
            }
            case 'regen-reply':
                if (this.lastReply && !this.busy) this.generateReply(this.lastReply.letterId, this.lastReply);
                break;
            case 'accept-reply': this.acceptReply(); break;
            case 'acc-post': {
                const letter = this.archive.letters[this.draft.id];
                if (this.root.querySelector('#epi-acc-date')?.checked && el.dataset.arrival) this.hooks.setStoryDate(el.dataset.arrival);
                this.closeDialog();
                this.hooks.postReplyToChat(letter);
                this.root.classList.add('epi-hidden');
                break;
            }
            case 'discard-draft':
                if (confirm('丢弃这份回信草稿？')) { this.draft = null; this.draftDirty = false; this.show('list'); }
                break;
            case 'dialog-close': this.closeDialog(); break;
            case 'ins-dateline': {
                const d = this.draft;
                this.insertAtCursor(formatDateLine(this.currentLang(), d.placeFrom, d.writtenAt), { ownLine: true });
                break;
            }
            case 'toggle-flourish':
                this.draft.appearance.flourish = !this.draft.appearance.flourish;
                el.classList.toggle('epi-on', this.draft.appearance.flourish);
                this.setDirty();
                toastr?.info(this.draft.appearance.flourish ? '阅读时，称呼和署名会显示为花体' : '已关闭花体称呼署名');
                break;
            case 'ins-ps': this.insertAtCursor(PS_TEXT[this.currentLang()] || PS_TEXT.zh); break;
            case 'resplit': this.resplitDraft(); this.openSections.add('segs'); this.rerenderKeepScroll(); this.setDirty(); break;
            case 'ai-analyze': this.aiAnalyzeDraft(); break;
            case 'ev-add': this.commitRaw(this.draft); this.addEvent({}); this.rerenderKeepScroll(); break;
            case 'ev-quick-sent':
                this.commitRaw(this.draft);
                this.addEvent({ type: 'sent', who: this.draft.author, date: this.draft.writtenAt });
                this.rerenderKeepScroll(); break;
            case 'ev-quick-read': {
                this.commitRaw(this.draft);
                const rs = parseNames(this.draft.recipients);
                if (!rs.length) { toastr?.info('先填收件人'); break; }
                for (const r of rs) { this.addEvent({ type: 'received', who: r }); this.addEvent({ type: 'read', who: r }); }
                this.rerenderKeepScroll(); break;
            }
            case 'ev-del':
                this.commitRaw(this.draft);
                this.draft.events = this.draft.events.filter(ev => ev.id !== id);
                this.rerenderKeepScroll(); this.setDirty(); break;
            case 'person-add': this.archive.people.push(normalizePerson({})); this.store.save(); this.show('people'); break;
            case 'person-del':
                if (confirm('删除这个人物档案？（不会删除信件）')) { this.archive.people.splice(parseInt(el.dataset.i, 10), 1); this.store.save(); this.show('people'); }
                break;
            case 'person-collect': this.collectPeople(); break;
            case 'person-example': this.loadExample(el.dataset.key); break;
            case 'preset-add': {
                const text = this.root.querySelector('#epi-np-text').value.trim();
                if (!text) break;
                this.archive.presets.push({
                    id: `custom-${Date.now()}`, text,
                    position: this.root.querySelector('#epi-np-pos').value,
                    lang: this.root.querySelector('#epi-np-lang').value,
                    era: this.root.querySelector('#epi-np-era').value.trim(),
                    note: this.root.querySelector('#epi-np-note').value.trim(),
                });
                this.store.save(); this.show('presets'); break;
            }
            case 'preset-del': this.archive.presets.splice(parseInt(el.dataset.i, 10), 1); this.store.save(); this.show('presets'); break;
            case 'preview-refresh': this.show('preview'); break;
        }
    }

    onInput(e) {
        if (this.rendering) return;
        const t = e.target;
        const act = t.dataset.act;
        if (act === 'search') {
            if (e.type !== 'input') return;
            this.search = t.value;
            const pos = t.selectionStart;
            this.show('list');
            const s = this.body.querySelector('.epi-search');
            s.focus(); s.setSelectionRange(pos, pos);
            return;
        }
        if (act === 'ins') {
            if (e.type !== 'change' || !t.value) return;
            const text = t.value;
            t.value = '';
            this.insertAtCursor(text, { ownLine: true });
            return;
        }
        if (act === 'preset-lang') {
            if (e.type !== 'change') return;
            this.presetLang = t.value;
            this.commitRaw(this.draft);
            this.rerenderKeepScroll();
            return;
        }
        const d = this.draft;
        if (t.dataset.f && d) {
            const path = t.dataset.f.split('.');
            if (path.length === 2) d[path[0]][path[1]] = t.value; else d[path[0]] = t.value;
            if (path[0] === 'appearance') {
                const paper = this.body.querySelector('.epi-paper-edit');
                if (paper) paper.className = `${paperClasses(d)} epi-paper-edit`;
                if (t.dataset.f === 'appearance.font') this.fontTouched = true;
                if (t.dataset.f === 'appearance.orientation') this.fitPage();
            }
            if (t.dataset.f === 'body') { this.fitPage(); this.updateCount(); }
            if (t.dataset.f === 'author' && e.type === 'change' && !this.fontTouched) {
                const before = d.appearance.font;
                this.applyAuthorHand(d);
                if (d.appearance.font !== before) { this.commitRaw(d); this.rerenderKeepScroll(); }
            }
            if (t.dataset.f === 'language' && e.type === 'change' && !this.presetLang) {
                this.commitRaw(d); this.rerenderKeepScroll();
            }
            this.setDirty();
            return;
        }
        if (t.dataset.seg && d) {
            const seg = d.segments.find(s => s.id === t.dataset.seg);
            if (seg) seg[t.dataset.sf] = t.value;
            this.setDirty();
            return;
        }
        if (t.dataset.ev && d) {
            const ev = d.events.find(x => x.id === t.dataset.ev);
            if (ev) {
                if (t.dataset.ef === 'note') { ev.note = t.value; ev.to = t.value; } else ev[t.dataset.ef] = t.value;
                if (t.dataset.ef === 'type' && e.type === 'change') { this.commitRaw(d); this.rerenderKeepScroll(); }
            }
            this.setDirty();
            return;
        }
        if (t.dataset.person !== undefined) {
            const p = this.archive.people[parseInt(t.dataset.person, 10)];
            if (!p) return;
            const f = t.dataset.pf;
            if (f === 'aliases') p.aliases = parseNames(t.value);
            else if (f === 'historical') p.historical = t.checked;
            else if (f === 'styleSamples') p.styleSamples = splitSamples(t.value);
            else if (f === 'name') p.name = t.value.trim();
            else p[f] = t.value;
            this.store.save();
        }
    }

    collectPeople() {
        const known = new Set();
        for (const p of this.archive.people) [p.name, ...(p.aliases || [])].forEach(n => known.add(String(n).toLowerCase()));
        let added = 0;
        for (const l of Object.values(this.archive.letters)) {
            for (const n of [l.author, ...l.recipients, ...l.events.map(e => e.who)]) {
                const k = String(n || '').trim();
                if (k && !known.has(k.toLowerCase())) {
                    known.add(k.toLowerCase());
                    this.archive.people.push(normalizePerson({ name: k }));
                    added++;
                }
            }
        }
        this.store.save();
        toastr?.info(`新增 ${added} 个人物`);
        this.show('people');
    }

    loadExample(key) {
        const ex = EXAMPLE_PROFILES[key];
        if (!ex) return;
        const existing = findPerson(this.archive, ex.name) || ex.aliases.map(n => findPerson(this.archive, n)).find(Boolean);
        if (existing) {
            if (!confirm(`已经有「${existing.name}」了。用示例的文风要点补充它吗？（名字、别名、样本会保留）`)) return;
            existing.historical = true;
            existing.styleSource = existing.styleSource || ex.styleSource;
            existing.styleNotes = existing.styleNotes ? existing.styleNotes + '\n' + ex.styleNotes : ex.styleNotes;
            existing.aliases = [...new Set([...existing.aliases, ...ex.aliases.filter(a => a !== existing.name)])];
        } else {
            this.archive.people.push(normalizePerson(ex));
        }
        this.openSections.add(`person-${this.archive.people.indexOf(existing || this.archive.people[this.archive.people.length - 1])}`);
        this.store.save();
        this.show('people');
        toastr?.info('已载入。文风要点是概括描述，不含书信原文；想更像的话，在「书信样本」里粘贴几段你手头的梵高书信。');
    }
}
