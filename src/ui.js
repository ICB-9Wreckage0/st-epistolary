// 书信簿 · 界面
// 简单模式：信件 / 写信 / 人物。写信页像文档一样，直接在信纸上写。
// 简单模式：存档 + 暗号（聊天里写信的暗号，这一轮就把信交给 AI）。
// 高级模式：寄送、转交、知情过滤、自动注入，以及段落与关键词、流转记录、知情一览、套语、注入预览。

import {
    KINDS, STATUSES, AUTHENTICITY, EVENT_TYPES, LEVEL_LABELS,
    createLetter, normalizeLetter, normalizePerson, resegment, segmentPosition, knowledgeTable, normalizeCode, nextCode,
    parseTags, parseNames, splitSamples, findPerson, clone, normalizeDate,
} from './model.js';
import { allPresets, POSITIONS, LANGS } from './presets.js';
import {
    addDays, formatDateLine, guessLang, deliveryEvents, arrivalOf,
    buildReplyPrompt, cleanReply, EXAMPLE_PROFILES,
    buildTranslatePrompt, TRANSLATE_TARGETS, TRANSLATE_STYLES,
    viaReceivedEvents, VIA_ACTIONS, threadBetween, viaDeadline, nextEventId,
    HEAD_FIELDS, guessHeadFromThread, buildFillPrompt, parseFill,
} from './correspondence.js';
import { detectInChat, chunkChat, buildImportPrompt, parseImportResponse, sliceVerbatim, dropParagraphs, findDuplicate, buildShellPrompt, parseShellResponse, findShellDuplicate, SHELL_STATES } from './importer.js';
import { API_MODES, listProfiles, testConnection, fetchModels } from './api.js';
import { playSeal, playOpen, WAX_LABELS, ENVELOPE_LABELS } from './envelope.js';
import { STYLE_PACKS, applyStyle, pickStyle } from './styles.js';
import { meaningOf, labelWithWarn, lookWarnings } from './meanings.js';
import { ENCLOSURE_KINDS, normalizeEnclosure, extractEnclosures, enclosureText } from './enclosures.js';
import { HANDS, ORIENTATIONS, paperClasses, renderBody, analyze, scriptLang, renderOptions, WOBBLE_LABELS, WEAR_LABELS, paperLayer, ensureWearFilters, hashSeed, INKS, inkColor, inkContrast, paperStyle, SIZE_LABELS, CJK_SIZE_LABELS } from './render.js';

const PAPERS = { plain: '素白', cream: '奶油棉纸', aged: '泛黄旧纸', lined: '横格信笺', redline: '红线信笺', blue: '淡蓝航空信纸' };
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
        root.style.setProperty('--edit', String(this.editZoom()));
        root.innerHTML = `
            <div class="epi-window" role="dialog" aria-label="书信簿">
                <div class="epi-header">
                    <span class="epi-title">✉ 书信簿</span>
                    <nav class="epi-tabs"></nav>
                    <div class="epi-mode" title="简单模式：存档信件 + 暗号。高级模式：寄送、转交、知情过滤、自动注入等全部功能">
                        <button data-act="mode" data-mode="simple">简单</button><button data-act="mode" data-mode="expert">高级</button>
                    </div>
                    <button class="epi-close" data-act="close" title="关闭">✕</button>
                </div>
                <div class="epi-body"></div>
            </div>
            <div class="epi-reader-wrap epi-hidden"></div>
            <div class="epi-dialog-wrap epi-hidden"></div>`;
        document.body.appendChild(root);
        ensureWearFilters();
        this.mountPostbox();
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
            ? [['list', '信件'], ['edit', '写信'], ['people', '人物'], ['presets', '套语'], ['preview', '注入预览'], ['settings', '⚙ 设置']]
            : [['list', '信件'], ['edit', '写信'], ['people', '人物'], ['settings', '⚙ 设置']];
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
            settings: () => this.renderSettings(),
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
                        ${l.code ? `<button class="epi-chip epi-code" data-act="copy-code" data-code="${esc(l.code)}" title="点一下复制暗号">${esc(l.code)}</button>` : ''}
                        <b>${esc(l.author || '？')} → ${esc(l.recipients.join('、') || '？')}</b>
                        <span class="epi-muted">${esc(l.writtenAt || '日期不详')}</span>
                        ${l.status !== 'sent' ? `<span class="epi-chip epi-status-${esc(l.status)}">${esc(STATUSES[l.status])}</span>` : ''}
                        ${ex && l.delivery?.status === 'transit' ? `<span class="epi-chip epi-transit">📮 在途 · ${esc(this.etaText(l))}</span>` : ''}
                        ${ex && l.delivery?.status === 'arrived' ? `<span class="epi-chip epi-transit">📬 刚送到</span>` : ''}
                        ${ex ? this.viaChip(l) : ''}
                        ${l.shell ? '<span class="epi-chip epi-shell" title="剧情里已经有这封信了，正文还没写。点「编辑」写正文">📄 空壳 · 待写正文</span>' : ''}
                        ${l.inReplyTo ? `<span class="epi-chip">↩ 回信</span>` : ''}
                        ${ex ? `<span class="epi-muted">${esc(l.id)}</span>` : ''}
                        ${ex && l.authenticity !== 'original' ? `<span class="epi-chip">${esc(AUTHENTICITY[l.authenticity])}</span>` : ''}
                    </div>
                    <div class="epi-muted">${l.title ? `「${esc(l.title)}」 ` : ''}${l.shell ? '（正文还没写）' : esc(preview(l.body, 90))}</div>
                    ${ex && l.tags.length ? `<div class="epi-tags">${l.tags.map(t => `<span>#${esc(t)}</span>`).join('')}</div>` : ''}
                </div>
                <div class="epi-card-actions">
                    ${ex && l.delivery?.status === 'transit' ? `<button class="menu_button" data-act="deliver-now" data-id="${esc(l.id)}" title="不等了，现在就送到">现在送达</button>` : ''}
                    ${ex && ['atVia', 'held', 'withheld'].includes(l.delivery?.status) && this.isMe(l.delivery.via) ? `<button class="menu_button" data-act="via-forward" data-id="${esc(l.id)}" title="${esc(l.delivery.via)} 改主意了，把信转交出去">让 ${esc(l.delivery.via)} 转交</button>` : ''}
                    <button class="menu_button" data-act="edit" data-id="${esc(l.id)}">编辑</button>
                    <button class="menu_button" data-act="delete" data-id="${esc(l.id)}">删除</button>
                </div>
            </div>`).join('');

        return `
            <div class="epi-toolbar">
                <button class="menu_button" data-act="new">✎ 写新信</button>
                <button class="menu_button" data-act="import-open" title="把聊天里已经写出来的信，逐字存进档案">📥 从聊天记录找信</button>
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
                code: nextCode(this.archive),
            }, '');
            // 沿用两人之前通信的地点和语言
            const g = guessHeadFromThread(this.archive, this.draft.author, this.draft.recipients[0]);
            for (const k of ['placeFrom', 'placeTo', 'language']) if (g[k]) this.draft[k] = g[k];
            this.applyAuthorHand(this.draft);
            this.draftIsNew = true;
        }
        // 信头：哪些是自动填的（AI 可以覆盖），哪些是用户自己改过的（不动）
        this.lhAuto = new Set(id ? [] : HEAD_FIELDS);
        this.lhAI = new Set();
        this.draftTravel = null;
        this.headFilled = false;
        this.draftDirty = false;
        this.fontTouched = false;
        this.presetLang = '';
        this.show('edit');
        if (!id && this.hooks.hasChat() && this.hooks.getSettings().autoFill !== false) this.aiFillHead({ auto: true });
    }

    // 让 AI 根据剧情和正文填信头（写信人、收信人、日期、地点、语言），并估算路上几天。
    // 只覆盖空着的、自动填的、或者上次 AI 填的字段；用户自己改过的不动。
    async aiFillHead({ auto = false } = {}) {
        const d = this.draft;
        if (!d || this.filling) return;
        this.filling = true;
        const btn = this.root.querySelector('[data-act="ai-fill"]');
        if (btn) { btn.disabled = true; btn.textContent = '✨ 填写中…'; }
        try {
            const chat = this.hooks.getChat().filter(m => m && !m.is_system && typeof m.mes === 'string').slice(-10);
            const recentChat = chat.map(m => `${m.name}：${String(m.mes).slice(0, 600)}`).join('\n');
            const rs = parseNames(d.recipients);
            const who = () => `${d.author}|${parseNames(d.recipients).join('、')}`;
            const asked = who();
            const thread = d.author && rs[0] ? threadBetween(this.archive, d.author, rs[0]).filter(l => l.id !== d.id).slice(-3)
                .map(l => `${l.writtenAt || '日期不详'}，${l.author} → ${l.recipients.join('、')}，${l.placeFrom || '?'} → ${l.placeTo || '?'}${l.language ? `，${l.language}` : ''}`) : [];
            const { system, prompt } = buildFillPrompt({
                draft: { ...d, recipients: rs },
                userName: this.hooks.getUserName(),
                charName: this.hooks.getCharName(),
                storyDate: this.hooks.getStoryDate(),
                recentChat,
                people: this.archive.people.map(p => p.name),
                thread,
            });
            const out = parseFill(await this.hooks.callAI(system, prompt, { kind: 'fill' }));
            if (!out) throw new Error('AI 没有给出能用的结果');
            if (this.draft !== d) return; // 已经换了一封信
            if (who() !== asked) {
                // 等待期间你改了写信人或收信人，AI 的地点和路程是按旧的推断的，不用了
                const note = this.root.querySelector('[data-role="fill-note"]');
                if (note) note.textContent = '你刚改了写信人或收信人，再点一次「✨ AI 填写」按新的来填';
                this.headFilled = false;
                return;
            }
            const filled = [];
            for (const k of HEAD_FIELDS) {
                if (!(k in out)) continue;
                const cur = k === 'recipients' ? parseNames(d[k]).join('、') : String(d[k] || '');
                const val = k === 'recipients' ? out[k].join('、') : out[k];
                const free = !cur || this.lhAuto.has(k) || this.lhAI.has(k);
                if (!free || cur === val) continue;
                d[k] = k === 'recipients' ? out[k] : val;
                this.lhAuto.delete(k);
                this.lhAI.add(k);
                filled.push(k);
                const inp = this.root.querySelector(`.epi-letterhead [data-f="${k}"]`);
                if (inp && inp !== document.activeElement) { inp.value = val; inp.classList.add('epi-lh-ai'); }
            }
            if (out.travelDays != null) this.draftTravel = out.travelDays;
            if (out.enclosures?.length && !d.enclosures.length) {
                d.enclosures = out.enclosures.map((x, k) => ({ ...normalizeEnclosure(x, k), id: `ENC${Date.now().toString(36)}${k}` }));
                filled.push('enclosures');
                const box = this.root.querySelector('.epi-enc');
                if (box) box.outerHTML = this.renderEnclosures(d);
            }
            this.headFilled = true;
            if (filled.includes('author') && !this.fontTouched) { this.applyAuthorHand(d); this.refreshPaper(); }
            if (filled.length) {
                this.setDirty();
                const note = this.root.querySelector('[data-role="fill-note"]');
                if (note) note.textContent = `标黄的是 AI 填的，可以直接改${out.travelDays != null ? `；估计路上要走 ${out.travelDays} 天` : ''}${out.note ? `。依据：${out.note}` : ''}`;
                if (!auto) toastr?.success('信头填好了，标黄的是 AI 填的，可以直接改');
            } else if (!auto) {
                toastr?.info('信头已经是 AI 认为对的了，没有改动');
            }
        } catch (e) {
            console.warn('[书信簿] 自动填写信头失败', e);
            if (!auto) toastr?.error('自动填写失败：' + (e.message || e));
        } finally {
            this.filling = false;
            const b = this.root.querySelector('[data-act="ai-fill"]');
            if (b) { b.disabled = false; b.textContent = '✨ AI 填写'; }
        }
    }

    // 正文渲染参数：手写随机感的种子和程度
    renderOpts(letter) {
        return renderOptions(letter, findPerson(this.archive, letter.author), this.hooks.getSettings().jitter !== false);
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
        if (d.shell && !d.aiDraft) {
            banner = `<div class="epi-banner">📄 这是一封<b>空壳信</b>：剧情里已经有这封信了，正文还没写。直接在下面的信纸上写，保存就行，寄送状态（在谁手里、哪天送到）不会变。</div>`;
        } else if (d.aiDraft) {
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
                    ${d.aiDraft || !ex ? '' : `<button class="epi-rbtn" data-act="send-open" title="把信寄出去：选择路上走多久，到了以后再切过去看收信反应">✉ 寄出</button>`}
                    ${canAskReply ? `<button class="epi-rbtn" data-act="reply-open" title="让收信人用自己的口吻写回信">↩ 让对方回信</button>` : ''}
                    <button class="epi-rbtn" data-act="preview" title="不用保存，先看看写好以后在信纸上的样子，还能回放封缄、拆信动画">👁 预览</button>
                    <button class="epi-rbtn" data-act="translate-open" title="把这封信翻译成另一种语言，比如中文草稿译成法语">🌐 翻译</button>
                </div>
                <div class="epi-rgroup">
                    <span class="epi-rlabel">插入</span>
                    ${this.presetSelect('salutation', '称呼')}
                    ${this.presetSelect('opening', '开头语')}
                    ${this.presetSelect('closing', '结尾祝语')}
                    ${this.presetSelect('signoff', '署名前')}
                    <button class="epi-rbtn" data-act="ins-dateline" title="按书信语言的习惯，插入“地点，日期”一行">日期行</button>
                    <button class="epi-rbtn" data-act="ins-ps" title="在光标处插入“又及 / P.S.”">附言</button>
                    <label class="epi-rinline" title="上面几个下拉菜单里列出哪种语言的套语">套语语言 <select class="epi-rsel" data-act="preset-lang">${options(LANGS, this.currentLang())}</select></label>
                </div>
                <div class="epi-rgroup epi-rgroup-zoom" title="写信时信纸上的字看起来多大。只影响你写信时看的效果，不改这封信的字号（信的字号在「外观与款式」里）">
                    <span class="epi-rlabel">编辑字号</span>
                    <button class="epi-rbtn" data-act="edit-zoom" data-step="-1" title="小一点">A−</button>
                    <span class="epi-zoom-val" data-role="zoom">${Math.round(this.editZoom() * 100)}%</span>
                    <button class="epi-rbtn" data-act="edit-zoom" data-step="1" title="大一点">A+</button>
                </div>
                <div class="epi-rgroup epi-rgroup-look">
                    <button class="epi-rbtn epi-primary" data-act="style-open" title="信纸、墨水、字迹、信封、封缄，以及一键套用的款式包">✦ 外观与款式</button>
                    <span class="epi-look-summary" data-role="look">${esc(this.lookSummary(a))}</span>
                </div>
            </div>`;

        const field = (key, label, value, placeholder, hint) => `
            <label class="epi-lh-field" title="${esc(hint)}">
                <span class="epi-lh-label">${label}</span>
                <input class="epi-lh-input ${this.lhAI?.has(key) ? 'epi-lh-ai' : ''}" data-f="${key}" value="${esc(value)}" placeholder="${esc(placeholder)}">
            </label>`;
        const letterhead = `
            <div class="epi-letterhead">
                ${field('author', '写信人', d.author, '谁写的', '写这封信的人。这个名字决定谁“知道”信的内容，也用来匹配人物档案里的字迹和文风。')}
                ${field('recipients', '收信人', asText(d.recipients), '多人用顿号分隔', '寄给谁。多人用顿号分隔。')}
                ${field('writtenAt', '写信日期', d.writtenAt, '如 1889-06-10', '故事里写这封信的日期。用来推算什么时候送到、谁在什么时候知道了内容。')}
                ${field('placeFrom', '寄出地', d.placeFrom, '如 Paris', '从哪里寄出。会写在日期行和信封上。')}
                ${field('placeTo', '寄往地', d.placeTo, '如 Saint-Rémy', '寄到哪里。会写在信封的地址上。')}
                ${field('language', '书信语言', d.language, '留空 = 中文', '信实际用什么语言写。影响套语、日期写法、翻译和回信的语言。“法语（中文显示）”表示人物之间用法语通信，但纸上用中文写出来。')}
                <div class="epi-lh-code">
                    <span class="epi-lh-label">暗号</span>
                    <input class="epi-lh-input epi-code-input" data-f="code" value="${esc(d.code)}" placeholder="如【信1】">
                    <button class="menu_button epi-mini" data-act="copy-code" data-code="${esc(d.code)}" title="复制暗号">复制</button>
                    <span class="epi-muted">在聊天里写上这个暗号（连括号一起），那一轮 AI 就会读到这封信。</span>
                </div>
                <div class="epi-lh-fill">
                    <button class="menu_button" data-act="ai-fill" title="让 AI 根据最近的剧情和信的正文，填写信人、收信人、日期、地点和语言，并估算路上要走几天。你自己改过的格子不会被覆盖。">${this.filling ? '✨ 填写中…' : '✨ AI 填写'}</button>
                    <span class="epi-muted" data-role="fill-note">${this.lhAI?.size ? '标黄的是 AI 填的，可以直接改' : '不想自己填？写完正文点这里，AI 会根据剧情补全'}</span>
                </div>
            </div>`;

        const contrast = inkContrast(a);
        const page = `
            ${contrast < 4.5 ? `<div class="epi-banner epi-banner-soft">这支墨水在这种纸上颜色偏浅（对比度 ${contrast.toFixed(1)}），读起来会吃力。可以在「✦ 外观与款式」里换一支深一点的墨水。</div>` : ''}
            <div class="epi-desk">
                <div class="${esc(paperClasses(d))} epi-paper-edit" style="${esc(paperStyle(d))}">${paperLayer(d, hashSeed(d.id + d.author))}
                    <textarea class="epi-page" data-f="body" spellcheck="false" placeholder="在这里写信……&#10;&#10;空一行就是新的一段。上面的「插入」可以加称呼、结尾语和日期行。">${esc(d.body)}</textarea>
                </div>
            </div>
            ${this.renderEnclosures(d)}
            <div class="epi-docstatus">
                <span>${esc(STATUSES[d.status])}${d.delivery?.status === 'transit' ? `（在途，${esc(this.etaText(d))}）` : ''}</span>
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
        for (const e of d.events) if (e.type === 'forwarded' && !e.to) e.to = e.note;
        d.code = normalizeCode(d.code);
        const clash = d.code && Object.values(this.archive.letters).find(l => l.id !== d.id && l.code === d.code);
        if (clash) {
            toastr?.warning(`暗号 ${d.code} 已经给了 ${clash.author} → ${clash.recipients.join('、')} 那封信，这封换成了新的暗号`);
            d.code = '';
        }
        let letter;
        if (this.draftIsNew) {
            letter = createLetter(this.archive, { ...d, id: undefined });
        } else {
            if (!d.code) d.code = nextCode(this.archive);
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

    // ================= 随信附上 =================

    renderEnclosures(d) {
        const list = d.enclosures || [];
        const kindOpts = Object.fromEntries(Object.entries(ENCLOSURE_KINDS).map(([k, v]) => [k, `${v.icon} ${v.label}`]));
        const others = Object.values(this.archive.letters).filter(l => l.id !== d.id);
        const mentions = !list.length && extractEnclosures(d.body).length;
        const rows = list.map((e, i) => `
            <div class="epi-enc-row">
                <select class="text_pole epi-enc-kind" data-enc="${i}" data-ef="kind">${options(kindOpts, e.kind)}</select>
                ${e.kind === 'letter'
                    ? `<select class="text_pole" data-enc="${i}" data-ef="letterRef"><option value="">选一封档案里的信…</option>${others.map(l => `<option value="${esc(l.id)}" ${l.id === e.letterRef ? 'selected' : ''}>${esc(l.code || l.id)} ${esc(l.author)} → ${esc(l.recipients.join('、'))}${l.writtenAt ? ` · ${esc(l.writtenAt)}` : ''}</option>`).join('')}</select>`
                    : `<input class="text_pole" data-enc="${i}" data-ef="name" value="${esc(e.name)}" placeholder="是什么，如：五枚二十法郎金币、一张麦田速写">`}
                ${e.kind === 'money' ? `<input class="text_pole epi-enc-value" data-enc="${i}" data-ef="value" value="${esc(e.value)}" placeholder="金额，如 100 法郎">` : ''}
                <input class="text_pole" data-enc="${i}" data-ef="desc" value="${esc(e.desc)}" placeholder="样子 / 细节（可选）">
                <button class="menu_button epi-mini" data-act="enc-del" data-i="${i}" title="删掉这件">✕</button>
            </div>`).join('');
        return `
            <div class="epi-enc">
                <div class="epi-enc-head">
                    <b>📎 随信附上</b>
                    <span class="epi-muted">钱、礼物、速写、照片、压花、附页、另一封信……收信人拆信时会一起拿到，AI 也会知道。</span>
                </div>
                ${rows}
                <div class="epi-row">
                    <button class="menu_button epi-mini" data-act="enc-add">＋ 添加一件</button>
                    <button class="menu_button epi-mini" data-act="enc-detect" title="在正文里找“随信附上……”“另附……”“ci-joint……”这样的句子">从正文里找</button>
                    ${mentions ? '<span class="epi-warn">正文里提到了随信附上的东西，点「从正文里找」记下来。</span>' : ''}
                </div>
            </div>`;
    }

    // ================= 编辑时的字号 =================

    editZoom() {
        const z = Number(this.hooks.getSettings().editZoom);
        return z >= 0.5 && z <= 1.6 ? z : 0.9;
    }

    applyEditZoom() {
        this.root?.style.setProperty('--edit', String(this.editZoom()));
        const el = this.root?.querySelector('[data-role="zoom"]');
        if (el) el.textContent = `${Math.round(this.editZoom() * 100)}%`;
        this.fitPage?.();
    }

    stepEditZoom(step) {
        const z = Math.round(Math.min(1.6, Math.max(0.5, this.editZoom() + step * 0.1)) * 10) / 10;
        this.hooks.getSettings().editZoom = z;
        this.hooks.saveSettings();
        this.applyEditZoom();
    }

    // 复制暗号
    async copyCode(code) {
        if (!code) { toastr?.info('这封信还没有暗号'); return; }
        try {
            await navigator.clipboard.writeText(code);
        } catch {
            const ta = document.createElement('textarea');
            ta.value = code;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch { /* 复制不了就算了 */ }
            ta.remove();
        }
        toastr?.success(`已复制 ${code}。在聊天里写上它，那一轮 AI 就会读到这封信`);
    }

    // 简单模式下，保存后自动为没有关键词的段落生成关键词
    maybeAutoAnalyze(id) {
        if (!this.expert || !this.hooks.getSettings().autoKeywords) return; // 关键词只在高级模式的自动注入里用
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

    // 送达方式的表单（寄信和收下回信共用）
    deliveryFields(prefix, { base, arrival, floors, mode, via = null }) {
        const hasChat = this.hooks.hasChat();
        const viaBox = via === null ? '' : `
            <details class="epi-via-box" ${via ? 'open' : ''}>
                <summary>🤝 托人转交（可选）</summary>
                <div class="epi-via-fields">
                    <label>转交人<input class="text_pole" id="${prefix}-via" value="${esc(via)}" placeholder="留空 = 直接寄给收信人"></label>
                    <label>转交人拿到以后，再过<span class="epi-row"><input class="text_pole epi-num" id="${prefix}-leg" type="number" min="0" max="500" value="1"><span>天（按楼层送达时是“层”）送到收信人手里</span></span></label>
                    <label>希望收信人最晚哪天收到（可选，按剧情日期送达时用）<input class="text_pole" id="${prefix}-target" placeholder="如 1889-06-20；留空 = 不设期限"></label>
                    <div class="epi-via-plan epi-muted" data-role="via-plan" data-prefix="${prefix}"></div>
                    <small class="epi-muted">信先送到转交人手里。之后拆不拆、看不看、交不交，都由转交人自己决定：转交人是角色的话，切过去看那边的剧情，书信簿会照角色的做法处理；转交人是你的话，在右下角信箱里自己选。转交人没拆的话，只知道有这封信，不知道内容。</small>
                </div>
            </details>`;
        const quick = base ? [1, 3, 7, 14].map(n => `<button class="menu_button epi-mini" data-act="days" data-target="#${prefix}-arrival" data-base="${esc(base)}" data-days="${n}">+${n === 7 ? '1周' : n === 14 ? '2周' : n + '天'}</button>`).join('') : '';
        return `
            <div class="epi-choice">
                <label><input type="radio" name="${prefix}-mode" value="date" ${mode === 'date' ? 'checked' : ''} ${hasChat ? '' : 'disabled'}>
                    <span><b>按剧情日期送达</b>：故事里到了这一天，信才送到
                    <span class="epi-row epi-indent"><input class="text_pole" id="${prefix}-arrival" value="${esc(arrival)}" placeholder="送达日期，如 1889-06-17">${quick}</span>
                    <small class="epi-muted">路上走多久由你定：同城一两天，跨国一周左右，跨洋两三周。剧情日期会每隔几层自动推算，也可以在「设置」里手动改。</small></span></label>
                <label><input type="radio" name="${prefix}-mode" value="floors" ${mode === 'floors' ? 'checked' : ''} ${hasChat ? '' : 'disabled'}>
                    <span><b>按聊天楼层送达</b>：再聊 <input class="text_pole epi-num" id="${prefix}-floors" type="number" min="1" max="500" value="${esc(floors)}"> 层后送到
                    <small class="epi-muted">故事里没有明确日期时用这个。</small></span></label>
                <label><input type="radio" name="${prefix}-mode" value="instant" ${mode === 'instant' || !hasChat ? 'checked' : ''}>
                    <span><b>立即送达</b>：不等了，现在就送到</span></label>
            </div>${viaBox}`;
    }

    readDelivery(prefix) {
        const q = sel => this.root.querySelector(sel);
        return {
            mode: this.root.querySelector(`input[name="${prefix}-mode"]:checked`)?.value || 'instant',
            arrival: q(`#${prefix}-arrival`)?.value.trim() || '',
            floors: Math.max(1, parseInt(q(`#${prefix}-floors`)?.value, 10) || 8),
            via: q(`#${prefix}-via`)?.value.trim() || '',
            leg: Math.max(0, parseInt(q(`#${prefix}-leg`)?.value, 10) || 0),
            target: normalizeDate(q(`#${prefix}-target`)?.value.trim()) ? q(`#${prefix}-target`).value.trim() : '',
        };
    }

    // 托人转交的时间安排：到转交人手里 → 最晚转交 → 收信人收到
    syncViaPlan(prefix) {
        const el = this.root.querySelector(`[data-role="via-plan"][data-prefix="${prefix}"]`);
        if (!el) return;
        const dv = this.readDelivery(prefix);
        if (!dv.via) { el.textContent = ''; return; }
        if (dv.mode === 'floors') {
            el.textContent = `信先走 ${dv.floors} 层到 ${dv.via} 手里；TA 转交以后再过 ${dv.leg || 1} 层送到。TA 拿着信超过 4 层还没处理，会提醒你。`;
            return;
        }
        const toVia = dv.mode === 'date' ? dv.arrival : (this.hooks.getStoryDate() || '');
        const earliest = toVia ? addDays(toVia, dv.leg) : '';
        if (!dv.target) {
            el.textContent = toVia ? `${toVia} 到 ${dv.via} 手里；TA 当天就转交的话，${earliest} 送到。` : '';
            return;
        }
        const deadline = viaDeadline(dv.target, dv.leg);
        const tight = toVia && normalizeDate(deadline) < normalizeDate(toVia);
        el.innerHTML = tight
            ? `<span class="epi-warn">来不及：${esc(toVia)} 才到 ${esc(dv.via)} 手里，转交后还要走 ${dv.leg} 天，最早 ${esc(earliest)} 才能送到。</span>`
            : `${esc(toVia || '（日期未定）')} 到 ${esc(dv.via)} 手里 → TA <b>最晚 ${esc(deadline)}</b> 要看完、转交出去 → ${esc(dv.target)} 前送到。到了期限 TA 还没处理，会提醒你。`;
    }

    // 转交状态的小标签
    viaChip(l) {
        const dv = l.delivery;
        if (!dv?.via) return '';
        const via = esc(dv.via);
        const map = {
            toVia: `🤝 经 ${via} 转交`,
            atVia: `🤝 在 ${via} 手里`,
            held: `🤝 ${via} 先留着`,
            withheld: `🚫 被 ${via} 扣下`,
        };
        const key = dv.status === 'transit' ? (dv.stage === 'toVia' ? 'toVia' : null) : dv.status;
        const text = map[key] || `🤝 经 ${via} 转交${dv.tampered ? ' · 被拆过' : ''}`;
        return `<span class="epi-chip epi-via">${text}${dv.opened && key && key !== 'toVia' ? ' · 拆看过' : ''}</span>`;
    }

    etaText(l) {
        const dv = l.delivery;
        if (!dv) return '';
        if (dv.mode === 'floors') {
            const left = (dv.sentFloor + dv.floors) - this.hooks.getFloor();
            const to = dv.via && dv.stage === 'toVia' ? `到 ${dv.via} 手里` : '';
            return left > 0 ? `还要 ${left} 层${to}` : '马上就到';
        }
        const to = dv.via && dv.stage === 'toVia' ? `送到 ${dv.via} 手里` : '送达';
        return dv.eta ? `预计 ${dv.eta} ${to}` : '送达日期未定';
    }

    // 把一封信设为“在途”
    startTransit(letter, { mode, arrival, floors, via, leg, target = '' }, extra = {}) {
        if (via) {
            // 托人转交：第一段送到转交人手里
            letter.delivery = {
                mode,
                eta: mode === 'date' ? arrival : '',
                floors: mode === 'floors' ? floors : 0,
                sentFloor: this.hooks.getFloor(),
                chatId: this.hooks.getChatId(),
                status: 'transit',
                via,
                stage: 'toVia',
                leg2: { days: leg ?? 1, floors: Math.max(1, leg || 2) },
                target: mode === 'date' ? target : '',
                viaDeadline: mode === 'date' && target ? viaDeadline(target, leg) : '',
                reader: letter.recipients[0] || '',
                ...extra,
            };
            return;
        }
        letter.events.push(...deliveryEvents(letter, '', letter.events, { sentOnly: true }));
        letter.delivery = {
            mode,
            eta: mode === 'date' ? arrival : '',
            floors: mode === 'floors' ? floors : 0,
            sentFloor: this.hooks.getFloor(),
            chatId: this.hooks.getChatId(),
            status: 'transit',
            reader: letter.recipients[0] || '',
            ...extra,
        };
    }

    // 立即送到转交人手里
    instantToVia(letter, dv, arrival) {
        letter.delivery = {
            mode: 'instant', status: 'atVia', eta: '', via: dv.via, stage: 'atVia', viaArrivedAt: arrival,
            chatId: this.hooks.getChatId(), sentFloor: this.hooks.getFloor(),
            leg2: { days: dv.leg ?? 0, floors: Math.max(1, dv.leg || 2) }, reader: letter.recipients[0] || '',
            target: dv.target || '', viaDeadline: dv.target ? viaDeadline(dv.target, dv.leg) : '',
        };
        letter.events.push(...viaReceivedEvents(letter, dv.via, arrival, letter.events));
    }

    async openSendDialog() {
        const d = this.draft;
        if (!d.body.trim()) { toastr?.info('信还是空的'); return; }
        // 信头还有空着的：先让 AI 补全（每封信只自动补一次）
        const missing = ['recipients', 'writtenAt', 'placeFrom', 'placeTo'].some(k => !parseNames(d[k]).length);
        if ((missing || this.draftTravel == null) && !this.headFilled && this.hooks.hasChat() && this.hooks.getSettings().autoFill !== false) {
            toastr?.info('先让 AI 补全信头……');
            await this.aiFillHead({ auto: true });
            this.headFilled = true;
        }
        const rs = parseNames(d.recipients);
        if (!rs.length) { toastr?.info('先填「收信人」'); return; }
        const s = this.hooks.getSettings();
        const base = d.writtenAt || this.hooks.getStoryDate();
        const reader = rs[0];
        const toMe = this.isMe(reader);
        const charName = this.hooks.getCharName();
        const mismatch = !toMe && charName && !rs.some(r => findPerson(this.archive, r) ? findPerson(this.archive, r) === findPerson(this.archive, charName) : r === charName);

        this.openDialog(`
            <h3>寄出这封信</h3>
            <p>寄给 <b>${esc(rs.join('、'))}</b>${d.writtenAt ? `，写于 ${esc(d.writtenAt)}` : ''}。</p>
            ${this.draftTravel != null ? `<p class="epi-muted">AI 估计从 ${esc(d.placeFrom || '寄出地')} 到 ${esc(d.placeTo || '寄往地')} 路上要走 ${this.draftTravel} 天，下面的送达日期已经按这个算好了，可以改。</p>` : ''}
            ${this.deliveryFields('epi-send', { base, arrival: addDays(base, this.draftTravel ?? 3) || '', floors: s.delivery.floors, mode: s.delivery.mode, via: d.delivery?.via || '' })}
            <div class="epi-send-later">
                <label class="checkbox_label"><input type="checkbox" id="epi-send-auto" ${s.delivery.autoSwitch ? 'checked' : ''}> 信到了就自动切过去看 ${esc(reader)} 的收信反应（不勾的话，会先提醒你）</label>
                <p class="epi-muted">寄出后，你这边的剧情照常继续。${esc(reader)} 在信送到之前不会知道信的内容。</p>
            </div>
            <div class="epi-send-now">
                <p class="epi-muted">立即送达以后：</p>
                <div class="epi-choice">
                    <label><input type="radio" name="epi-send-next" value="chat" ${this.hooks.hasChat() ? 'checked' : 'disabled'}> <span>切到 <b data-role="next-who">${esc(reader)}</b> 那边，看<span data-role="next-what">收信反应</span></span></label>
                    <label data-role="next-reply"><input type="radio" name="epi-send-next" value="reply" ${this.hooks.hasChat() ? '' : 'checked'}> <span>让 <b>${esc(reader)}</b> 直接写回信</span></label>
                    <label><input type="radio" name="epi-send-next" value="archive"> 只记录送达，不做别的</label>
                </div>
            </div>
            ${lookWarnings(d).map(w => `<p class="epi-warn">⚠ ${esc(w)}（可以在「✦ 外观与款式」里换。）</p>`).join('')}
            ${mismatch ? `<p class="epi-warn" data-role="mismatch">当前聊天的角色是 ${esc(charName)}，不是收信人。切过去看收信反应时，会由 ${esc(charName)} 的 AI 来描写 ${esc(reader)} 读信的场景。</p>` : ''}
            <div class="epi-dialog-actions">
                <button class="menu_button" data-act="dialog-close">取消</button>
                <button class="menu_button epi-primary" data-act="send-confirm">寄出</button>
            </div>`);
        this.syncSendDialog();
    }

    // 立即送达时才显示“送达以后做什么”
    syncSendDialog() {
        const mode = this.root.querySelector('input[name="epi-send-mode"]:checked')?.value;
        const now = this.root.querySelector('.epi-send-now');
        const later = this.root.querySelector('.epi-send-later');
        if (now) now.hidden = mode !== 'instant';
        if (later) later.hidden = mode === 'instant';
        // 托人转交时，立即送达是送到转交人手里
        const via = this.root.querySelector('#epi-send-via')?.value.trim();
        const who = this.root.querySelector('[data-role="next-who"]');
        if (who) {
            who.dataset.reader = who.dataset.reader || who.textContent;
            who.textContent = via || who.dataset.reader;
            this.root.querySelector('[data-role="next-what"]').textContent = via ? '拿到信以后怎么处理' : '收信反应';
            const r = this.root.querySelector('[data-role="next-reply"]');
            if (r) r.hidden = !!via;
            const mm = this.root.querySelector('[data-role="mismatch"]');
            if (mm) mm.hidden = !!via;
        }
    }

    async confirmSend() {
        const dv = this.readDelivery('epi-send');
        if (dv.mode === 'date' && !normalizeDate(dv.arrival)) { toastr?.warning('送达日期要写成 1889-06-17 这样的格式'); return; }
        if (dv.via && parseNames(this.draft.recipients).some(r => r === dv.via || (findPerson(this.archive, r) && findPerson(this.archive, r) === findPerson(this.archive, dv.via)))) { toastr?.warning('转交人不能是收信人自己'); return; }
        const auto = !!this.root.querySelector('#epi-send-auto')?.checked;
        const next = this.root.querySelector('input[name="epi-send-next"]:checked')?.value || 'archive';
        const s = this.hooks.getSettings();
        s.delivery.mode = dv.mode;
        if (dv.mode === 'floors') s.delivery.floors = dv.floors;
        this.hooks.saveSettings();

        this.draft.status = 'sent';
        const letter = this.saveDraft({ silent: true });
        const reader = letter.recipients[0];
        if (dv.mode === 'instant' && dv.via) {
            this.instantToVia(letter, dv, dv.arrival || this.hooks.getStoryDate() || letter.writtenAt);
        } else if (dv.mode === 'instant') {
            const arrival = dv.arrival || letter.writtenAt || this.hooks.getStoryDate();
            letter.events.push(...deliveryEvents(letter, arrival, letter.events));
            letter.delivery = { mode: 'instant', status: 'viewed', eta: arrival, reader };
        } else {
            this.startTransit(letter, dv, { auto });
        }
        this.store.save();
        this.draft = clone(letter);
        this.closeDialog();
        if (s.animations) await playSeal(letter, { flyOut: next !== 'archive' || dv.mode !== 'instant', render: this.renderOpts(letter) });

        if (dv.mode !== 'instant') {
            toastr?.success(`信已寄出，${this.etaText(letter)}`);
            this.renderPostbox();
            this.show('edit');
            return;
        }
        if (dv.via) {
            toastr?.success(`信交到了 ${dv.via} 手里`);
            this.renderPostbox();
            if (next === 'chat' && !this.isMe(dv.via)) {
                this.root.classList.add('epi-hidden');
                await this.hooks.switchToVia(letter);
            } else {
                this.show('edit');
            }
            return;
        }
        toastr?.success('信已送达');
        if (next === 'chat') {
            this.root.classList.add('epi-hidden');
            await this.hooks.switchToRecipient(letter);
        } else if (next === 'reply') {
            this.openReplyDialog(letter.id, reader);
        } else {
            this.show('edit');
        }
    }

    // 这个名字是不是“我”（当前用户人设）
    isMe(name) {
        const me = this.hooks.getUserName();
        if (!me || !name) return false;
        const p = findPerson(this.archive, me);
        return name === me || (!!p && findPerson(this.archive, name) === p);
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
            <p class="epi-muted">${isChar ? `会带上 ${esc(replier)} 的角色卡设定和最近的剧情一起写。` : '会根据信件往来和文风档案来写。'}</p>
            <div class="epi-dialog-actions">
                <button class="menu_button" data-act="dialog-close">取消</button>
                <button class="menu_button epi-primary" data-act="reply-confirm" data-id="${esc(l.id)}">开始写</button>
            </div>`);
    }

    async generateReply(letterId, opts) {
        const l = this.archive.letters[letterId];
        const { replier, replyDate, length } = opts;
        const extra = this.hooks.getCharacterContext(replier) || {};
        const { system, prompt } = buildReplyPrompt(this.archive, l, replier, { replyDate, length, ...extra });
        this.lastReply = { letterId, ...opts };
        this.busy = true;
        toastr?.info(`${replier} 正在写回信……`);
        try {
            const raw = await this.hooks.callAI(system, prompt, { kind: 'reply', replier });
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
            this.open('edit');
            this.setDirty();
            toastr?.success('回信草稿写好了，可以先改一改，再点「收下这封回信」');
        } catch (e) {
            console.error(e);
            toastr?.error('写回信失败：' + (e.message || e));
        } finally {
            this.busy = false;
        }
    }

    // 收下 AI 写的回信：选择怎么送到“我”手上
    acceptReply() {
        const d = this.draft;
        if (!this.expert) {
            // 简单模式：没有寄送，直接存进档案
            d.aiDraft = false;
            d.status = 'sent';
            const letter = this.saveDraft({ silent: true });
            toastr?.success(`回信已存进档案。暗号是 ${letter.code}，在聊天里写上它，AI 就会读到这封回信`);
            this.show('edit');
            return;
        }
        const o = this.archive.letters[d.inReplyTo];
        // 回信路上走的天数，沿用来信的天数
        let days = 3;
        if (o) {
            const arr = arrivalOf(this.archive, o, d.author);
            const n = daysBetween(o.writtenAt, arr);
            if (n != null && n >= 0) days = n;
        }
        const s = this.hooks.getSettings();
        const mode = o?.delivery?.mode && o.delivery.mode !== 'instant' ? o.delivery.mode : s.delivery.mode;
        this.openDialog(`
            <h3>收下 ${esc(d.author)} 的回信</h3>
            <p>回信写于 ${esc(d.writtenAt || '（未填）')}，寄给 ${esc(d.recipients.join('、'))}。它要怎么送到？</p>
            ${this.deliveryFields('epi-acc', { base: d.writtenAt, arrival: addDays(d.writtenAt, days) || '', floors: o?.delivery?.floors || s.delivery.floors, mode, via: '' })}
            <div class="epi-dialog-actions">
                <button class="menu_button" data-act="dialog-close">再改改</button>
                <button class="menu_button epi-primary" data-act="accept-confirm">寄出回信</button>
            </div>`);
    }

    async confirmAccept() {
        const dv = this.readDelivery('epi-acc');
        if (dv.mode === 'date' && !normalizeDate(dv.arrival)) { toastr?.warning('送达日期要写成 1889-06-17 这样的格式'); return; }
        const d = this.draft;
        d.aiDraft = false;
        d.status = 'sent';
        const letter = this.saveDraft({ silent: true });
        if (dv.mode === 'instant' && dv.via) {
            this.instantToVia(letter, dv, dv.arrival || letter.writtenAt);
        } else if (dv.mode === 'instant') {
            const arrival = dv.arrival || letter.writtenAt;
            letter.events.push(...deliveryEvents(letter, arrival, letter.events));
            letter.delivery = { mode: 'instant', status: 'arrived', eta: arrival, reader: letter.recipients[0] || '' };
        } else {
            this.startTransit(letter, dv);
        }
        this.store.save();
        this.draft = clone(letter);
        this.closeDialog();
        this.maybeAutoAnalyze(letter.id);
        if (dv.mode === 'instant' && dv.via) {
            this.renderPostbox();
            toastr?.success(`回信交到了 ${dv.via} 手里，转不转交看 ${dv.via} 的了`);
        } else if (dv.mode === 'instant') {
            this.renderPostbox();
            toastr?.success('回信送到了，在右下角的信箱里拆开看');
        } else {
            toastr?.success(`回信已寄出，${this.etaText(letter)}`);
            this.renderPostbox();
        }
        this.show('edit');
    }

    // ================= 翻译 =================

    openTranslateDialog() {
        const d = this.draft;
        if (!d?.body.trim()) { toastr?.info('信还是空的'); return; }
        const guess = { fr: 'fr', en: 'en', de: 'de' }[guessLang(d.language)] || 'fr';
        this.openDialog(`
            <h3>🌐 翻译这封信</h3>
            <div class="epi-grid2">
                <label>翻译成<select class="text_pole" id="epi-tr-target">${options(TRANSLATE_TARGETS, scriptLang(d.language) === 'lat' ? 'zh' : guess)}<option value="__custom">其他语言…</option></select></label>
                <label>文风<select class="text_pole" id="epi-tr-style">${options(TRANSLATE_STYLES, 'period')}</select></label>
            </div>
            <label id="epi-tr-custom-wrap" hidden>语言名称<input class="text_pole" id="epi-tr-custom" placeholder="如 葡萄牙语、拉丁文、古英语"></label>
            <p class="epi-muted">“按写信年代的书信体”会参考写信日期（${esc(d.writtenAt || '未填')}），用那个年代的称呼、客套语和结尾。段落会保持一一对应。</p>
            <div class="epi-dialog-actions">
                <button class="menu_button" data-act="dialog-close">取消</button>
                <button class="menu_button epi-primary" data-act="translate-run">开始翻译</button>
            </div>
            <div id="epi-tr-result"></div>`, 'epi-dialog-wide');
    }

    async runTranslate() {
        const d = this.draft;
        this.commitRaw(d);
        const sel = this.root.querySelector('#epi-tr-target').value;
        const target = sel === '__custom' ? this.root.querySelector('#epi-tr-custom').value.trim() : TRANSLATE_TARGETS[sel];
        if (!target) { toastr?.info('先填要翻译成什么语言'); return; }
        const style = this.root.querySelector('#epi-tr-style').value;
        const box = this.root.querySelector('#epi-tr-result');
        const btn = this.root.querySelector('[data-act="translate-run"]');
        btn.disabled = true; btn.textContent = '翻译中……';
        try {
            const { system, prompt } = buildTranslatePrompt(d, target, style);
            const out = cleanReply(await this.hooks.callAI(system, prompt, { kind: 'translate', target }));
            if (!out) throw new Error('AI 没有返回内容');
            this.lastTranslation = { target, sel, text: out };
            box.innerHTML = `
                <h4>译文（可以直接改）</h4>
                <textarea class="text_pole epi-tr-text" id="epi-tr-text" rows="12">${esc(out)}</textarea>
                <div class="epi-dialog-actions">
                    <button class="menu_button" data-act="translate-copy">复制</button>
                    <button class="menu_button" data-act="translate-new" title="原信保留，另存一封“译本”">另存为译本</button>
                    <button class="menu_button epi-primary" data-act="translate-replace" title="原文挪到这封信的备注里">替换正文</button>
                </div>`;
        } catch (e) {
            console.error(e);
            box.innerHTML = `<p class="epi-warn">翻译失败：${esc(e.message || e)}</p>`;
        } finally {
            btn.disabled = false; btn.textContent = '重新翻译';
        }
    }

    translationLanguage(target) {
        // 中文译成外语后，纸上就是外语了
        return target === '中文' ? '' : target;
    }

    applyTranslation(asNew) {
        const d = this.draft;
        const text = this.root.querySelector('#epi-tr-text')?.value.trim();
        if (!text || !this.lastTranslation) return;
        const lang = this.translationLanguage(this.lastTranslation.target);
        if (asNew) {
            // 原稿先存下来，不然新写的草稿会丢
            if (this.draftIsNew || this.draftDirty) this.saveDraft({ silent: true });
            const orig = this.draft;
            const copy = normalizeLetter({ ...clone(orig), id: undefined, body: text, language: lang, authenticity: 'translation', status: 'draft', delivery: null, events: [], segments: [], notes: `译自 ${orig.id}` }, '');
            copy.links = { ...(copy.links || {}), translationOf: orig.id };
            const created = createLetter(this.archive, copy);
            this.store.save();
            this.closeDialog();
            this.startEdit(created.id);
            toastr?.success('已另存为译本');
            return;
        }
        d.notes = [d.notes, `【翻译前的原文】\n${d.body}`].filter(Boolean).join('\n\n');
        d.body = text;
        d.language = lang;
        this.presetLang = '';
        this.closeDialog();
        this.commitRaw(d);
        resegment(d);
        this.rerenderKeepScroll();
        this.setDirty();
        toastr?.success('已替换正文，原文放在这封信的备注里');
    }

    // 阅读页：看中文译文（会缓存，下次直接显示）
    async showReaderTranslation(id) {
        const l = this.archive.letters[id];
        const box = this.root.querySelector('.epi-reader-translation');
        if (!l || !box) return;
        if (l.translations?.zh?.source === l.body) {
            box.hidden = !box.hidden;
            return;
        }
        box.hidden = false;
        box.innerHTML = '<p class="epi-muted">翻译中……</p>';
        try {
            const { system, prompt } = buildTranslatePrompt(l, '中文', 'keep');
            const out = cleanReply(await this.hooks.callAI(system, prompt, { kind: 'translate', target: '中文' }));
            if (!out) throw new Error('AI 没有返回内容');
            l.translations = { ...(l.translations || {}), zh: { text: out, source: l.body } };
            this.store.save();
            box.innerHTML = `<h4>中文译文</h4><div class="epi-tr-read">${esc(out)}</div>`;
        } catch (e) {
            box.innerHTML = `<p class="epi-warn">翻译失败：${esc(e.message || e)}</p>`;
        }
    }

    // ================= 从聊天记录导入 =================

    openImportDialog() {
        const n = this.hooks.getChat().length;
        if (!n) { toastr?.info('当前没有打开聊天，或者聊天是空的'); return; }
        this.openDialog(`
            <h3>📥 从聊天记录里找信</h3>
            <p class="epi-muted">在当前聊天（共 ${n} 条消息）里找出已经写出来的信，逐字存进档案。</p>
            <div class="epi-grid2">
                <label>范围<select class="text_pole" id="epi-imp-range">
                    ${[10, 30, 50, 100, 200].filter(k => k < n).map(k => `<option value="${n - k}" data-k="${k}" ${k === (this.impRange || 50) ? 'selected' : ''}>最近 ${k} 条</option>`).join('')}
                    <option value="0" data-k="all" ${this.impRange === 'all' || n <= 10 ? 'selected' : ''}>整个聊天</option>
                </select></label>
                <label>方法<select class="text_pole" id="epi-imp-method">
                    <option value="format">按格式识别：快，不调用 AI</option>
                    <option value="ai">AI 识别：更准，会调用 AI</option>
                    ${this.expert ? '<option value="shell">找空壳信：剧情里提到了、正文还没写的信（AI）</option>' : ''}
                </select></label>
            </div>
            <p class="epi-muted" id="epi-imp-est"></p>
            <p class="epi-muted" ${this.expert ? '' : 'hidden'}>空壳信：比如“他写了五封信交给提奥保管”，信已经存在，但正文没出现在聊天里。会建好这几封信、记下在谁手里、哪天该送到，正文之后再写。</p>
            <p class="epi-muted">按格式识别：找“称呼……结尾/署名”这样的段落。AI 识别：AI 只负责指出每封信从哪句开始、到哪句结束，正文一律从聊天原文逐字截取，AI 改写过的内容不会进档案。</p>
            <div class="epi-dialog-actions">
                <button class="menu_button" data-act="dialog-close">取消</button>
                <button class="menu_button epi-primary" data-act="import-run">开始查找</button>
            </div>
            <div id="epi-imp-result"></div>`, 'epi-dialog-wide');
        this.updateImportEstimate();
    }

    // AI 识别时，聊天记录太长会分几批发给 AI：提前告诉用户要调用几次
    updateImportEstimate() {
        const el = this.root.querySelector('#epi-imp-est');
        const rangeSel = this.root.querySelector('#epi-imp-range');
        if (!el || !rangeSel) return;
        const k = rangeSel.selectedOptions[0]?.dataset.k;
        this.impRange = k === 'all' ? 'all' : parseInt(k, 10) || 50;
        if (this.root.querySelector('#epi-imp-method').value === 'format') { el.textContent = ''; return; }
        const from = parseInt(rangeSel.value, 10) || 0;
        const batches = chunkChat(this.hooks.getChat(), { from }).length;
        el.textContent = batches > 1
            ? `这个范围的聊天记录比较长，AI 识别会分 ${batches} 批，调用 ${batches} 次 AI。`
            : '这个范围一次就能发给 AI，调用 1 次。';
    }

    async runImport() {
        const chat = this.hooks.getChat();
        const from = parseInt(this.root.querySelector('#epi-imp-range').value, 10) || 0;
        const method = this.root.querySelector('#epi-imp-method').value;
        const box = this.root.querySelector('#epi-imp-result');
        const btn = this.root.querySelector('[data-act="import-run"]');
        btn.disabled = true;
        this.importMode = method;
        if (method === 'shell') { await this.runShellImport(chat, from, box, btn); return; }
        let found = [];
        try {
            if (method === 'ai') {
                const chunks = chunkChat(chat, { from });
                for (let i = 0; i < chunks.length; i++) {
                    btn.textContent = `AI 识别中 ${i + 1}/${chunks.length}……`;
                    const { system, prompt } = buildImportPrompt(chunks[i]);
                    const out = await this.hooks.callAI(system, prompt, { kind: 'import' });
                    for (const r of parseImportResponse(out)) {
                        const m = chat[Number(r.message)];
                        if (!m) continue;
                        const sliced = sliceVerbatim(m.mes, r.start, r.end);
                        const text = sliced && dropParagraphs(sliced, r.skip);
                        if (!text) continue;
                        found.push({ mesIndex: Number(r.message), speaker: m.name, text, author: r.author || m.name || '', recipient: r.recipient || '', date: normalizeDate(r.date) ? r.date : '', place: r.place || '' });
                    }
                }
            } else {
                found = detectInChat(chat, { from });
            }
        } catch (e) {
            console.error(e);
            box.innerHTML = `<p class="epi-warn">查找失败：${esc(e.message || e)}</p>`;
            btn.disabled = false; btn.textContent = '重新查找';
            return;
        }
        btn.disabled = false; btn.textContent = '重新查找';
        // 同一段文字只留一份
        const seen = new Set();
        found = found.filter(f => { const k = f.text.replace(/\s/g, ''); if (seen.has(k)) return false; seen.add(k); return true; });
        this.importFound = found.map(f => ({ ...f, dup: findDuplicate(this.archive, f.text) }));
        if (!found.length) {
            box.innerHTML = `<p class="epi-muted">没有找到。${method === 'format' ? '格式比较随意的信，可以换成「AI 识别」再试。' : ''}</p>`;
            return;
        }
        const storyDate = this.hooks.getStoryDate();
        box.innerHTML = `
            <h4>找到 ${found.length} 封</h4>
            ${this.importFound.map((f, i) => `
                <div class="epi-imp-item">
                    <label class="checkbox_label"><input type="checkbox" data-imp="${i}" ${f.dup ? '' : 'checked'}> 第 ${f.mesIndex} 条消息（${esc(f.speaker || '')}）${f.dup ? `<span class="epi-chip">档案里已有：${esc(f.dup)}</span>` : ''}</label>
                    <div class="epi-grid3">
                        <label>写信人<input class="text_pole" data-imp-f="author" data-i="${i}" value="${esc(f.author)}"></label>
                        <label>收信人<input class="text_pole" data-imp-f="recipient" data-i="${i}" value="${esc(f.recipient)}"></label>
                        <label>日期<input class="text_pole" data-imp-f="date" data-i="${i}" value="${esc(f.date || storyDate)}"></label>
                    </div>
                    <details><summary class="epi-muted">${esc(preview(f.text, 80))}</summary><pre class="epi-pre">${esc(f.text)}</pre></details>
                </div>`).join('')}
            <label class="checkbox_label"><input type="checkbox" id="epi-imp-read" checked> 记为收信人已经读过（他们会“记得”信里的内容）</label>
            <div class="epi-dialog-actions">
                <button class="menu_button epi-primary" data-act="import-confirm">导入勾选的信</button>
            </div>`;
    }

    // 空壳信：AI 只找“提到了的信”，不写内容
    async runShellImport(chat, from, box, btn) {
        let found = [];
        try {
            const chunks = chunkChat(chat, { from });
            for (let i = 0; i < chunks.length; i++) {
                btn.textContent = `AI 查找中 ${i + 1}/${chunks.length}……`;
                const { system, prompt } = buildShellPrompt(chunks[i], { userName: this.hooks.getUserName(), storyDate: this.hooks.getStoryDate() });
                found.push(...parseShellResponse(await this.hooks.callAI(system, prompt, { kind: 'shell' })));
            }
        } catch (e) {
            console.error(e);
            box.innerHTML = `<p class="epi-warn">查找失败：${esc(e.message || e)}</p>`;
            btn.disabled = false; btn.textContent = '重新查找';
            return;
        }
        btn.disabled = false; btn.textContent = '重新查找';
        this.shellFound = found.map(f => ({ ...f, dup: findShellDuplicate(this.archive, f) }));
        if (!found.length) { box.innerHTML = '<p class="epi-muted">没有找到提到了、但正文没写的信。</p>'; return; }
        const storyDate = this.hooks.getStoryDate();
        const stateSel = (i, v) => `<select class="text_pole" data-imp-f="state" data-i="${i}">${options(SHELL_STATES, v)}</select>`;
        box.innerHTML = `
            <h4>找到 ${found.length} 封空壳信</h4>
            ${this.shellFound.map((f, i) => `
                <div class="epi-imp-item">
                    <label class="checkbox_label"><input type="checkbox" data-imp="${i}" ${f.dup ? '' : 'checked'}> 第 ${f.message} 条消息提到${f.label ? `：信封上写着「${esc(f.label)}」` : ''}${f.dup ? `<span class="epi-chip">档案里已有：${esc(f.dup)}</span>` : ''}</label>
                    ${f.note ? `<div class="epi-muted">${esc(f.note)}</div>` : ''}
                    <div class="epi-grid3">
                        <label>写信人<input class="text_pole" data-imp-f="author" data-i="${i}" value="${esc(f.author)}"></label>
                        <label>收信人<input class="text_pole" data-imp-f="recipient" data-i="${i}" value="${esc(f.recipients.join('、'))}"></label>
                        <label>写信日期<input class="text_pole" data-imp-f="date" data-i="${i}" value="${esc(f.writtenAt || storyDate)}"></label>
                        <label>信封上的字<input class="text_pole" data-imp-f="label" data-i="${i}" value="${esc(f.label)}"></label>
                        <label>现在<span>${stateSel(i, f.state)}</span></label>
                        <label>在谁手里（转交 / 保管人）<input class="text_pole" data-imp-f="holder" data-i="${i}" value="${esc(f.holder)}"></label>
                        <label>该哪天送到<input class="text_pole" data-imp-f="target" data-i="${i}" value="${esc(f.target)}" placeholder="不知道就留空"></label>
                        <label>从保管人那里寄出后路上几天<input class="text_pole epi-num" type="number" min="0" data-imp-f="leg" data-i="${i}" value="${esc(f.legDays)}"></label>
                        <label>已经读过的人<input class="text_pole" data-imp-f="readers" data-i="${i}" value="${esc(f.readers.join('、'))}"></label>
                    </div>
                </div>`).join('')}
            <p class="epi-muted">建好以后，信件列表里会标着「📄 空壳 · 待写正文」。正文可以之后再写；在那之前，谁拆开这封信，AI 只会写到拆开为止，不会自己编内容。</p>
            <div class="epi-dialog-actions">
                <button class="menu_button epi-primary" data-act="import-confirm">建立勾选的空壳信</button>
            </div>`;
    }

    confirmShellImport() {
        const items = [...this.root.querySelectorAll('[data-imp]')].filter(c => c.checked).map(c => parseInt(c.dataset.imp, 10));
        if (!items.length) { toastr?.info('没有勾选'); return; }
        const val = (i, f) => this.root.querySelector(`[data-imp-f="${f}"][data-i="${i}"]`)?.value.trim() || '';
        const today = this.hooks.getStoryDate();
        const created = [];
        for (const i of items) {
            const f = this.shellFound[i];
            const author = val(i, 'author');
            const date = val(i, 'date');
            const state = val(i, 'state') || 'sealed';
            const holder = val(i, 'holder');
            const target = normalizeDate(val(i, 'target')) ? val(i, 'target') : '';
            const leg = Math.max(0, parseInt(val(i, 'leg'), 10) || 0);
            const letter = createLetter(this.archive, {
                author,
                recipients: parseNames(val(i, 'recipient')),
                writtenAt: date,
                title: val(i, 'label'),
                body: '',
                shell: true,
                status: state === 'sealed' ? 'sealed' : 'sent',
                appearance: { font: findPerson(this.archive, author)?.hand || 'personal', ...(f.wax ? { wax: f.wax } : {}) },
                source: { chatId: this.hooks.getChatId(), mes: f.message },
            });
            const reader = letter.recipients[0] || '';
            const when = today || date;
            const base = { chatId: this.hooks.getChatId(), sentFloor: this.hooks.getFloor(), reader };
            if (state === 'withVia' && holder) {
                letter.events = viaReceivedEvents(letter, holder, when, []);
                letter.delivery = {
                    ...base, mode: 'instant', status: 'held', stage: 'atVia', via: holder, eta: '',
                    viaArrivedAt: when, viaArrivedFloor: this.hooks.getFloor(),
                    leg2: { days: leg, floors: Math.max(1, leg || 2) },
                    target, viaDeadline: target ? viaDeadline(target, leg) : '',
                };
            } else if (state === 'transit') {
                letter.events = deliveryEvents(letter, '', [], { sentOnly: true });
                letter.delivery = { ...base, mode: target ? 'date' : 'floors', eta: target, floors: target ? 0 : 8, status: 'transit' };
            } else if (state === 'delivered') {
                letter.events = deliveryEvents(letter, '', [], { sentOnly: true });
                for (const r of letter.recipients) letter.events.push({ id: nextEventId(letter.events), type: 'received', who: r, date: when, segments: null, to: '', note: '' });
                letter.delivery = { ...base, mode: 'instant', status: 'arrived', eta: when, arrivedAt: when };
            } else if (state === 'read') {
                letter.events = deliveryEvents(letter, when, []);
                letter.delivery = { ...base, mode: 'instant', status: 'viewed', eta: when, arrivedAt: when };
            } else {
                letter.events = [];
                letter.delivery = null;
            }
            for (const r of parseNames(val(i, 'readers'))) {
                if (!letter.events.some(e => e.type === 'read' && e.who === r)) letter.events.push({ id: nextEventId(letter.events), type: 'read', who: r, date: when, segments: null, to: '', note: '' });
                if (letter.delivery && r === letter.delivery.via) letter.delivery.opened = true;
            }
            created.push(letter.id);
        }
        this.store.save();
        this.closeDialog();
        this.renderPostbox();
        toastr?.success(`已建立 ${created.length} 封空壳信，正文可以之后再写`);
        this.show('list');
    }

    confirmImport() {
        if (this.importMode === 'shell') { this.confirmShellImport(); return; }
        const read = this.root.querySelector('#epi-imp-read')?.checked;
        const items = [...this.root.querySelectorAll('[data-imp]')].filter(c => c.checked).map(c => parseInt(c.dataset.imp, 10));
        if (!items.length) { toastr?.info('没有勾选'); return; }
        const val = (i, f) => this.root.querySelector(`[data-imp-f="${f}"][data-i="${i}"]`)?.value.trim() || '';
        const created = [];
        for (const i of items) {
            const f = this.importFound[i];
            const date = val(i, 'date');
            const letter = createLetter(this.archive, {
                author: val(i, 'author'),
                recipients: parseNames(val(i, 'recipient')),
                writtenAt: date,
                placeFrom: f.place || '',
                body: f.text,
                status: 'sent',
                appearance: { font: findPerson(this.archive, val(i, 'author'))?.hand || 'personal' },
                enclosures: extractEnclosures(f.text),
                source: { chatId: this.hooks.getChatId(), mes: f.mesIndex },
            });
            letter.events = read ? deliveryEvents(letter, date, []) : deliveryEvents(letter, '', [], { sentOnly: true });
            letter.delivery = { mode: 'instant', status: 'viewed', eta: date, reader: letter.recipients[0] || '' };
            created.push(letter.id);
        }
        this.store.save();
        this.closeDialog();
        toastr?.success(`已导入 ${created.length} 封信`);
        // 简单模式下，自动补关键词（一封一封来，免得同时发太多请求）
        (async () => { for (const id of created) { this.maybeAutoAnalyze(id); await new Promise(r => setTimeout(r, 1500)); } })();
        this.show('list');
    }

    // ================= 款式包 =================

    styleCard(pack, key, deletable) {
        const fake = { appearance: { ...this.draft.appearance, ...pack.appearance }, language: pack.language || this.draft.language };
        const sample = scriptLang(fake.language) === 'lat' ? 'Mon cher ami,' : '见字如晤，近来可好？';
        return `<button class="epi-style-card" data-act="style-apply" data-key="${esc(key)}" title="${esc(pack.desc || '')}">
            <div class="${esc(paperClasses(fake))} epi-style-swatch">${paperLayer(fake, hashSeed(key))}<span class="epi-paper-body">${esc(sample)}</span></div>
            <span class="epi-style-name">${esc(pack.name)}</span>
            ${pack.desc ? `<span class="epi-style-desc">${esc(pack.desc)}</span>` : ''}
            ${deletable ? `<span class="epi-style-del" data-act="style-del" data-key="${esc(key)}" title="删除">✕</span>` : ''}
        </button>`;
    }

    lookSummary(a) {
        const hand = HANDS[a.font]?.label || '';
        return [ORIENTATIONS[a.orientation]?.replace(/（.*）/, ''), PAPERS[a.paper], a.ink === 'custom' ? '自定义墨色' : INKS[a.ink]?.label, hand && `字迹${hand}`, a.size && a.size !== 'md' ? `字号${SIZE_LABELS[a.size].replace(/（.*）/, '')}` : '', ENVELOPE_LABELS[a.envelope], WAX_LABELS[a.wax]]
            .filter(Boolean).join(' · ') + (lookWarnings({ appearance: a }).length ? '  ⚠ 有容易被误读的选项' : '');
    }

    openStyleDialog() {
        const d = this.draft;
        if (!d) return;
        const mine = this.archive.styles || [];
        const a = d.appearance;
        const row = (label, control, hint) => `
            <div class="epi-ap-row">
                <span class="epi-ap-label">${label}</span>
                <div class="epi-ap-control">${control}${hint ? `<small class="epi-muted">${hint}</small>` : ''}</div>
            </div>`;
        const sel = (key, map, value, extra = '') => `<select class="text_pole" data-f="appearance.${key}" ${extra}>${options(map, String(value))}</select>`;
        // 当前选项的含义（⚠ = 收信人可能会误读）
        const year = parseInt(String(d.writtenAt || '').slice(0, 4), 10) || 0;
        const mean = (field, base = '') => {
            const m = meaningOf(field, a[field], year);
            const txt = m ? `<span class="${m.warn ? 'epi-meaning epi-meaning-warn' : 'epi-meaning'}">${m.warn ? '⚠ ' : '含义：'}${esc(m.text)}</span>` : '';
            return [base, txt].filter(Boolean).join('<br>');
        };
        this.openDialog(`
            <h3>✦ 外观与款式</h3>
            <h4>一键套用</h4>
            <p class="epi-muted">点一下套用整套外观。只改样子，不动正文。</p>
            <div class="epi-style-grid">${STYLE_PACKS.map(p => this.styleCard(p, p.id, false)).join('')}</div>
            ${mine.length ? `<h4>我的款式</h4><div class="epi-style-grid">${mine.map((p, i) => this.styleCard(p, `mine:${i}`, true)).join('')}</div>` : ''}

            <h4>信纸</h4>
            ${row('版式', sel('orientation', ORIENTATIONS, a.orientation), '竖版：寄出时对折一次再装进信封。横版：平放着装进去。')}
            ${row('纸张', sel('paper', PAPERS, a.paper), mean('paper'))}
            ${row('磨损', sel('wear', WEAR_LABELS, a.wear), '纸边毛糙程度和污渍。只影响纸，不影响字。')}

            <h4>字</h4>
            ${row('字迹', sel('font', Object.fromEntries(Object.entries(HANDS).map(([k, v]) => [k, `${v.label}：${v.desc}`])), a.font), mean('font', '这个人的字写成什么样。英文、法文和中文会自动用各自的字体。'))}
            ${row('字号', sel('size', SIZE_LABELS, a.size), '纸上的字写多大。写信和阅读时都按这个显示；也会告诉 AI（字小而密、字写得很大，读信的人能看出来）。')}
            ${scriptLang(d.language) === 'lat' ? row('中文字号', sel('cjkSize', CJK_SIZE_LABELS, a.cjkSize), '外文信里夹着的中文（比如括号里的翻译）单独的大小。外文手写体为了看得清会放大，中文不跟着放大；觉得中文还是太大，就选“小”或“很小”。只影响阅读和信封动画，写信页是普通文字。') : ''}
            ${row('墨水', `${sel('ink', labelWithWarn('ink', Object.fromEntries(Object.entries(INKS).map(([k, v]) => [k, v.label]))), a.ink)}
                <input type="color" class="epi-ink-picker" data-f="appearance.inkColor" value="${esc(a.inkColor || inkColor(a))}" title="自定义墨水颜色" ${a.ink === 'custom' ? '' : 'hidden'}>
                <span class="epi-ink-swatch" style="background:${esc(inkColor(a))}"></span>`, mean('ink', `和纸的对比度 ${inkContrast(a).toFixed(1)}${inkContrast(a) < 4.5 ? '，偏浅，建议换深一点的墨水' : '，清楚'}。`))}
            ${row('笔迹抖动', `<select class="text_pole" data-f="appearance.wobble"><option value="">跟随写信人档案</option>${options(WOBBLE_LABELS, String(a.wobble))}</select>`, '每个字轻微的歪斜、高低和墨色深浅，让字看起来是手写的。只在阅读时显示，写信时是普通文字。')}
            ${row('花体', `<label class="checkbox_label"><input type="checkbox" data-act="toggle-flourish-cb" ${a.flourish ? 'checked' : ''}> 称呼和署名用花体</label>`, '阅读时，开头的称呼和结尾的署名换成花体字，正文不变。')}

            <h4>信封</h4>
            ${row('信封', sel('envelope', ENVELOPE_LABELS, a.envelope), mean('envelope', '寄信、拆信动画里信封的样子。'))}
            ${row('封缄', sel('wax', labelWithWarn('wax', WAX_LABELS), a.wax), mean('wax'))}
            <p class="epi-muted">纸、墨水、封缄和信封的样子都会告诉 AI，收信人会按这些来理解。“含义”多来自 19 世纪欧洲的书信礼仪和中文书信习惯，各地不完全一样。</p>

            <div class="epi-dialog-actions">
                <button class="menu_button" data-act="style-save">把当前样子存为我的款式</button>
                <button class="menu_button epi-primary" data-act="dialog-close">完成</button>
            </div>`, 'epi-dialog-wide');
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
                    <label>笔迹抖动（字写得稳不稳）<select class="text_pole" data-person="${i}" data-pf="wobble"><option value="">按字迹默认</option>${options(WOBBLE_LABELS, String(p.wobble))}</select></label>
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

    // ================= 信箱（右下角的到信提醒） =================

    mountPostbox() {
        const box = document.createElement('div');
        box.id = 'epi-postbox';
        box.hidden = true;
        document.body.appendChild(box);
        this.postbox = box;
        box.addEventListener('click', e => this.onPostboxClick(e));
    }

    // 这个聊天里相关的信：没有绑定聊天的，或者就是在这个聊天里寄出的
    chatLetters() {
        const chatId = this.hooks.getChatId();
        return Object.values(this.archive.letters).filter(l => l.delivery && (!l.delivery.chatId || l.delivery.chatId === chatId));
    }

    renderPostbox() {
        const box = this.postbox;
        if (!box) return;
        // 角色回复里寄给你、还封着的信（两种模式都有）
        const sealed = this.hooks.getSealed?.() || [];
        const sealedItems = sealed.map(s => s.received
            ? `<div class="epi-pb-item epi-pb-new">
                <div>📬 你收到了 <b>${esc(s.author)}</b> 的信${s.letterIds.length > 1 ? `（${s.letterIds.length} 封）` : ''}</div>
                <div class="epi-pb-actions"><button class="menu_button" data-pb="unseal" data-mes="${s.mesId}">拆开</button></div></div>`
            : `<div class="epi-pb-item">
                <div>✉ <b>${esc(s.author)}</b> 写了一封给你的信，还没到你手里。</div>
                <div class="epi-muted">剧情里写到你收到了，就会提醒你拆。</div>
                <div class="epi-pb-actions"><button class="menu_button epi-mini" data-pb="unseal" data-mes="${s.mesId}" title="剧情里其实已经收到了，现在就拆">已经收到了，拆开</button></div></div>`);
        if (!this.expert) {
            // 简单模式没有寄送，只有来信
            box.innerHTML = sealedItems.join('');
            box.hidden = !sealedItems.length;
            return;
        }
        const letters = this.chatLetters();
        const arrived = letters.filter(l => l.delivery.status === 'arrived');
        const follow = letters.filter(l => l.delivery.status === 'viewed' && l.delivery.followup);
        const transit = letters.filter(l => l.delivery.status === 'transit');
        const atVia = letters.filter(l => l.delivery.status === 'atVia');
        const viaFollow = letters.filter(l => l.delivery.viaFollowup && l.delivery.status !== 'atVia');
        const held = letters.filter(l => l.delivery.status === 'held');
        const queued = (this.hooks.getInbox?.() || []).filter(i => this.archive.letters[i.letterId]);
        if (!arrived.length && !follow.length && !transit.length && !atVia.length && !viaFollow.length && !held.length && !queued.length && !sealedItems.length) { box.hidden = true; box.innerHTML = ''; return; }
        const items = [...sealedItems];
        for (const i of queued) {
            const l = this.archive.letters[i.letterId];
            items.push(`<div class="epi-pb-item">
                <div>📖 下一次生成时，<b>${esc(i.reader)}</b> 会读到 ${esc(l.author)} 的信${i.peek ? '（拆开了别人托转交的信）' : ''}。</div>
                ${l.shell ? '<div class="epi-warn">⚠ 这是空壳信，正文还没写。现在 AI 只会写到拆开为止；写好正文以后，下一次生成就会读到。</div>' : '<div class="epi-muted">原文直接交给 AI，不发进聊天。</div>'}
                <div class="epi-pb-actions">${l.shell ? `<button class="menu_button epi-mini" data-pb="write" data-id="${esc(l.id)}">写正文</button>` : `<button class="menu_button epi-mini" data-pb="open-text" data-id="${esc(l.id)}">看原文</button>`}</div></div>`);
        }
        for (const l of atVia) items.push(this.viaItem(l));
        for (const l of viaFollow) {
            const dv = l.delivery;
            const what = dv.status === 'withheld' ? `${esc(dv.via)} 把信扣下了` : dv.status === 'held' ? `${esc(dv.via)} 先把信留着` : `${esc(dv.via)} 把信转交出去了`;
            items.push(`<div class="epi-pb-item">
                <div>🤝 ${what}${dv.opened ? '（拆看过）' : ''}。</div>
                <div class="epi-pb-actions">
                    <button class="menu_button" data-pb="via-return" data-id="${esc(l.id)}" title="插入一句旁白：镜头回到写信人这边">↩ 回到 ${esc(l.author)} 这边</button>
                    <button class="menu_button epi-mini" data-pb="via-dismiss" data-id="${esc(l.id)}" title="收起">✕</button>
                </div></div>`);
        }
        for (const l of arrived) {
            const reader = l.delivery.reader || l.recipients[0] || '';
            const when = l.delivery.arrivedAt || l.delivery.eta || '';
            if (this.isMe(reader)) {
                items.push(`<div class="epi-pb-item epi-pb-new">
                    <div>📬 ${when ? `${esc(when)}，` : ''}你收到了 <b>${esc(l.author)}</b> 的${l.inReplyTo ? '回信' : '来信'}</div>
                    <div class="epi-pb-actions">
                        <button class="menu_button" data-pb="open" data-id="${esc(l.id)}">拆开看</button>
                        <button class="menu_button" data-pb="post" data-id="${esc(l.id)}" title="作为 ${esc(l.author)} 的消息放进聊天">放进聊天</button>
                    </div></div>`);
            } else {
                items.push(`<div class="epi-pb-item epi-pb-new">
                    <div>📬 ${when ? `${esc(when)}，` : ''}<b>${esc(reader)}</b> 收到了 ${esc(l.author)} 的信</div>
                    <div class="epi-pb-actions">
                        <button class="menu_button" data-pb="switch" data-id="${esc(l.id)}" title="镜头切到 ${esc(reader)} 那边，看收信、读信的反应">切过去看收信反应</button>
                        <button class="menu_button" data-pb="later" data-id="${esc(l.id)}" title="先不看，信已经送到了">不看了</button>
                    </div></div>`);
            }
        }
        for (const l of follow) {
            const reader = l.delivery.reader || l.recipients[0] || '';
            items.push(`<div class="epi-pb-item">
                <div>刚才看了 <b>${esc(reader)}</b> 读信。</div>
                <div class="epi-pb-actions">
                    <button class="menu_button" data-pb="return" data-id="${esc(l.id)}" title="插入一句旁白：镜头回到写信人这边">↩ 回到 ${esc(l.author)} 这边</button>
                    <button class="menu_button" data-pb="reply" data-id="${esc(l.id)}">让 ${esc(reader)} 写回信</button>
                    <button class="menu_button epi-mini" data-pb="dismiss" data-id="${esc(l.id)}" title="收起">✕</button>
                </div></div>`);
        }
        if (transit.length || held.length) {
            items.push(`<details class="epi-pb-transit" ${this.postboxOpen ? 'open' : ''}>
                <summary>${[transit.length ? `📮 在途 ${transit.length} 封` : '', held.length ? `🤝 压在转交人手里 ${held.length} 封` : ''].filter(Boolean).join(' · ')}</summary>
                ${transit.map(l => `<div class="epi-pb-row"><span>${esc(l.author)} → ${esc(l.recipients.join('、'))}${l.delivery.via ? `（经 ${esc(l.delivery.via)}）` : ''}：${esc(this.etaText(l))}</span>
                    <button class="menu_button epi-mini" data-pb="deliver" data-id="${esc(l.id)}">现在送达</button></div>`).join('')}
                ${held.map(l => `<div class="epi-pb-row"><span>${esc(l.author)} → ${esc(l.recipients.join('、'))}：${esc(l.delivery.via)} 先留着${l.delivery.opened ? '（拆看过）' : ''}</span>
                    ${this.isMe(l.delivery.via) ? `<button class="menu_button epi-mini" data-pb="via-forward" data-id="${esc(l.id)}" title="你决定转交">转交</button>` : ''}</div>`).join('')}
            </details>`);
        }
        box.innerHTML = items.join('');
        box.hidden = false;
        box.querySelector('details')?.addEventListener('toggle', ev => { this.postboxOpen = ev.target.open; });
    }

    // 信在转交人手里
    viaItem(l) {
        const dv = l.delivery;
        const via = esc(dv.via);
        const to = esc(l.recipients.join('、'));
        const when = dv.viaArrivedAt ? `${esc(dv.viaArrivedAt)}，` : '';
        const id = esc(l.id);
        const today = normalizeDate(this.hooks.getStoryDate());
        const late = dv.viaDeadline && today && today > normalizeDate(dv.viaDeadline);
        const deadline = dv.viaDeadline ? `<div class="${late ? 'epi-warn' : 'epi-muted'}">⏰ ${late ? `已经过了最晚转交日 ${esc(dv.viaDeadline)}，收信人会晚收到` : `最晚 ${esc(dv.viaDeadline)} 要${dv.opened ? '' : '看完、'}转交出去，${esc(to)} 才能在 ${esc(dv.target)} 前收到`}</div>` : '';
        const btn = (act, text, title = '', cls = '') => `<button class="menu_button ${cls}" data-pb="${act}" data-id="${id}" ${title ? `title="${esc(title)}"` : ''}>${text}</button>`;
        const decide = `
            ${dv.opened ? '' : btn('via-peek', '拆开看', `${dv.via} 拆开了这封信`)}
            ${btn('via-forward', `转交给 ${to}…`)}
            ${btn('via-later', '先留着', '暂时不交，以后还可以再转交')}
            ${btn('via-withhold', '不转交', '扣下这封信，收信人不会收到')}`;
        if (this.isMe(dv.via)) {
            return `<div class="epi-pb-item epi-pb-new">
                <div>🤝 ${when}<b>${esc(l.author)}</b> 托你把一封信转交给 <b>${to}</b>。${dv.opened ? '你已经拆开看过了。' : '信是封着的。'}</div>
                ${deadline}
                <div class="epi-pb-actions">${decide}</div></div>`;
        }
        const g = dv.viaGuess;
        const guess = g ? `<div class="epi-pb-guess">目前：${dv.opened ? '已经拆开看过，' : ''}还没决定怎么处理${g.note ? `——${esc(g.note)}` : ''}</div>` : '';
        const waiting = `<div class="epi-muted">拆不拆、交不交由 ${via} 在剧情里决定，书信簿每层都会看一眼，照剧情办。</div>`;
        return `<div class="epi-pb-item epi-pb-new">
            <div>🤝 ${when}<b>${via}</b> 拿到了 ${esc(l.author)} 托 TA 转交给 ${to} 的信${dv.opened ? '，已经拆开看过了' : ''}。</div>
            ${deadline}${waiting}${guess}
            <div class="epi-pb-actions">
                ${dv.viaViewed ? '' : btn('via-switch', `切过去看 ${via} 怎么处理`, `镜头切到 ${dv.via} 那边。TA 不知道信的内容，拆不拆、交不交由 TA 自己决定`)}

            </div></div>`;
    }

    // 转交的对话框
    openForwardDialog(id) {
        const l = this.archive.letters[id];
        if (!l?.delivery) return;
        const dv = l.delivery;
        const s = this.hooks.getSettings();
        const base = this.hooks.getStoryDate() || dv.viaArrivedAt || l.writtenAt;
        const mode = dv.mode === 'instant' ? 'instant' : dv.mode;
        this.open('list');
        this.openDialog(`
            <h3>${esc(dv.via)} 把信转交给 ${esc(l.recipients.join('、'))}</h3>
            ${this.deliveryFields('epi-fwd', { base, arrival: addDays(base, dv.leg2?.days ?? 1) || '', floors: dv.leg2?.floors || s.delivery.floors, mode })}
            ${dv.opened ? `<label class="checkbox_label"><input type="checkbox" id="epi-fwd-reseal"> 拆过的信重新封好了（收信人看不出被拆过）</label>` : ''}
            <div class="epi-dialog-actions">
                <button class="menu_button" data-act="dialog-close">取消</button>
                <button class="menu_button epi-primary" data-act="forward-confirm" data-id="${esc(l.id)}">转交</button>
            </div>`);
    }

    confirmForward(id) {
        const l = this.archive.letters[id];
        const dv = this.readDelivery('epi-fwd');
        if (dv.mode === 'date' && !normalizeDate(dv.arrival)) { toastr?.warning('送达日期要写成 1889-06-17 这样的格式'); return; }
        const resealed = !!this.root.querySelector('#epi-fwd-reseal')?.checked;
        this.closeDialog();
        this.hooks.forwardLetter(l, dv, { resealed });
        this.refresh();
    }

    async onPostboxClick(e) {
        const el = e.target.closest('[data-pb]');
        if (!el) return;
        if (el.dataset.pb === 'unseal') { await this.hooks.unseal(parseInt(el.dataset.mes, 10)); return; }
        const l = this.archive.letters[el.dataset.id];
        if (!l) return;
        const act = el.dataset.pb;
        if (act === 'open') {
            this.open('list');
            await this.openReaderWithAnim(l.id, { force: true });
        } else if (act === 'post') {
            l.delivery.status = 'viewed';
            this.store.save();
            await this.hooks.postReplyToChat(l);
        } else if (act === 'switch') {
            await this.hooks.switchToRecipient(l);
        } else if (act === 'later') {
            l.delivery.status = 'viewed';
            this.store.save();
        } else if (act === 'return') {
            l.delivery.followup = false;
            this.store.save();
            await this.hooks.postSceneReturn(l);
        } else if (act === 'reply') {
            l.delivery.followup = false;
            this.store.save();
            this.open('list');
            this.openReplyDialog(l.id);
        } else if (act === 'dismiss') {
            l.delivery.followup = false;
            this.store.save();
        } else if (act === 'deliver') {
            this.hooks.deliverNow(l.id);
        } else if (act === 'write') {
            this.open('list');
            this.startEdit(l.id);
        } else if (act === 'open-text') {
            this.open('list');
            this.openReader(l.id);
        } else if (act === 'via-switch') {
            await this.hooks.switchToVia(l);
        } else if (act === 'via-peek') {
            if (this.isMe(l.delivery.via)) {
                await this.hooks.letViaRead(l, { post: false });
                this.open('list');
                this.root.classList.add('epi-hidden');
                if (this.hooks.getSettings().animations) await playOpen(l, { render: this.renderOpts(l) });
                this.root.classList.remove('epi-hidden');
                this.openReader(l.id);
            } else {
                await this.hooks.letViaRead(l);
            }
        } else if (act === 'via-forward') {
            this.openForwardDialog(l.id);
        } else if (act === 'via-later' || act === 'via-withhold') {
            this.hooks.setViaAction(l, act === 'via-later' ? 'later' : 'withhold');
        } else if (act === 'via-apply') {
            await this.hooks.applyViaDecision(l, l.delivery.viaGuess);
        } else if (act === 'via-return') {
            l.delivery.viaFollowup = false;
            this.store.save();
            await this.hooks.postSceneReturn(l);
        } else if (act === 'via-dismiss') {
            l.delivery.viaFollowup = false;
            this.store.save();
        }
        this.renderPostbox();
    }

    // ================= 设置 =================

    renderSettings() {
        const s = this.hooks.getSettings();
        const api = s.api;
        const ex = this.expert;
        const chk = (key, label, hint = '') => `<label class="checkbox_label" title="${esc(hint)}"><input type="checkbox" data-s="${key}" ${this.getS(key) ? 'checked' : ''}> ${label}</label>`;
        const profiles = listProfiles();
        const storyDate = this.hooks.getStoryDate();
        return `
            <div class="epi-settings">
            <section class="epi-sec-card">
                <h4>🤖 AI 接口</h4>
                <p class="epi-muted">写回信、翻译、生成关键词、从聊天里识别信件、推算剧情日期，都用这里设置的接口。可以和你聊天用的 API 分开，比如聊天用好的模型，这些杂事用便宜的模型。</p>
                <label>使用<select class="text_pole" data-s="api.mode">${options(API_MODES, api.mode)}</select></label>
                ${api.mode === 'profile' ? `
                    <label>连接配置<select class="text_pole" data-s="api.profileId"><option value="">请选择</option>${profiles.map(p => `<option value="${esc(p.id)}" ${p.id === api.profileId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
                    ${profiles.length ? '' : '<p class="epi-warn">还没有连接配置。在酒馆顶部的“API 连接”里设好一套接口后，点“连接配置”旁的“+”保存，就会出现在这里。</p>'}` : ''}
                ${api.mode === 'custom' ? `
                    <label>接口地址<input class="text_pole" data-s="api.url" value="${esc(api.url)}" placeholder="如 https://api.deepseek.com/v1"></label>
                    <label>密钥（API Key）<input class="text_pole" type="password" data-s="api.key" value="${esc(api.key)}" placeholder="sk-…" autocomplete="off"></label>
                    <label>模型<div class="epi-row"><input class="text_pole" data-s="api.model" value="${esc(api.model)}" list="epi-model-list" placeholder="如 deepseek-chat"><button class="menu_button" data-act="api-models">获取模型列表</button></div></label>
                    <datalist id="epi-model-list">${(this.modelList || []).map(m => `<option value="${esc(m)}">`).join('')}</datalist>
                    <p class="epi-muted">任何兼容 OpenAI 格式的接口都可以（DeepSeek、硅基流动、OpenRouter、本地的 Ollama 等）。请求经由酒馆服务端转发。密钥保存在酒馆的设置文件里。</p>` : ''}
                <div class="epi-grid2">
                    <label>最多生成多少 token<input class="text_pole" type="number" min="200" max="32000" step="100" data-s="api.maxTokens" value="${esc(api.maxTokens)}"></label>
                    ${api.mode === 'custom' ? `<label>温度<input class="text_pole" type="number" min="0" max="2" step="0.1" data-s="api.temperature" value="${esc(api.temperature)}"></label>` : ''}
                </div>
                <div class="epi-row"><button class="menu_button" data-act="api-test">测试连接</button><span class="epi-muted" data-role="api-result"></span></div>
            </section>

            <section class="epi-sec-card">
                <h4>🔑 暗号</h4>
                <p>每封信都有一个暗号，比如 <b>【信1】</b>。在聊天里写上它（连括号一起），那一轮生成时 AI 就会读到这封信的全文；没写暗号，就不会注入。</p>
                <label>暗号怎么生效<select class="text_pole" data-s="codeMode">
                    <option value="embed" ${s.codeMode !== 'inject' ? 'selected' : ''}>把信的全文接在你的消息后面，聊天里折叠成“✉ 某某的信”（最稳，推荐）</option>
                    <option value="inject" ${s.codeMode === 'inject' ? 'selected' : ''}>不改你的消息，只在生成时悄悄注入（有些预设会把它挤掉）</option>
                </select></label>
                <p class="epi-muted">暗号在写信页的信头里改，信件列表和阅读页里点一下就能复制。暗号本身不会出现在 AI 的回复里。${ex ? '高级模式下，暗号和下面的自动注入、寄送功能同时生效。' : '想要寄送（信在路上走几天）、托人转交、按“谁读过”自动注入，切到「高级」模式。'}</p>
            </section>

            <section class="epi-sec-card">
                <h4>🧠 读信的记忆</h4>
                <p>角色在剧情里读完一封信（用暗号把信交给 AI 的那一轮${ex ? '，或者信送到、转交人偷看' : ''}），书信簿会再请 AI 整理一段“这个人记得什么”：在意的地方、记住的几句原话、当时的联想、读完做了什么。</p>
                ${chk('memory.auto', '读完信自动整理记忆', '每封信每轮多调用一次上面设置的 AI 接口。关掉以后，也可以在阅读页里手动点“从最近的剧情整理”。')}
                ${chk('memory.worldbook', '把记忆写进这个聊天的世界书', '写进聊天绑定的世界书；没绑定就自动建一本。每人每封信一条，关键词是“写信人+信”、暗号、标题和你填的关键词，按深度插入。')}
                <label>世界书条目插入深度<input class="text_pole epi-num" type="number" min="0" max="50" data-s="memory.depth" value="${esc(s.memory?.depth ?? 4)}"></label>
                <p class="epi-muted">世界书里只放记忆，不放原文，所以角色“想起来”的是 TA 当时记住的东西，像真人一样会记不全；要逐字读，还是写暗号。记忆在阅读页底部能看、能改、能删，改过的不会被自动整理覆盖。</p>
            </section>

            <section class="epi-sec-card" ${ex ? '' : 'hidden'}>
                <h4>📮 寄信与送达</h4>
                <label>当前剧情日期（只对这个聊天）<div class="epi-row"><input class="text_pole" data-chat="storyDate" value="${esc(storyDate)}" placeholder="如 1889-06-08" ${this.hooks.hasChat() ? '' : 'disabled'}><button class="menu_button" data-act="date-now" ${this.hooks.hasChat() ? '' : 'disabled'}>让 AI 推算</button></div></label>
                ${chk('delivery.autoDate', '自动推算剧情日期', '有在途的信时，每隔几层让 AI 根据最近的对话推算故事里现在是哪天。日期只会往后走。')}
                <label>每隔几层推算一次<input class="text_pole epi-num" type="number" min="1" max="100" data-s="delivery.dateEvery" value="${esc(s.delivery.dateEvery)}"></label>
                ${chk('delivery.autoSwitch', '信到了就自动切过去看收信反应（不勾的话，先在右下角提醒）')}
                <p class="epi-muted">寄信时可以选“按剧情日期送达”“按聊天楼层送达”或“立即送达”。在途的信，收信人在送到之前不会知道内容。</p>
            </section>

            <section class="epi-sec-card">
                <h4>🖋 显示</h4>
                <label>写信时的字号<select class="text_pole" data-s="editZoom">${[0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3].map(z => `<option value="${z}" ${Math.abs(this.editZoom() - z) < 0.01 ? 'selected' : ''}>${Math.round(z * 100)}%${z === 0.9 ? '（默认）' : ''}</option>`).join('')}</select></label>
                <label>模式<select class="text_pole" data-s="mode"><option value="simple" ${s.mode === 'simple' ? 'selected' : ''}>简单：存档信件 + 暗号</option><option value="expert" ${s.mode === 'expert' ? 'selected' : ''}>高级：寄送、转交、知情过滤、自动注入，以及段落、流转、注入预览</option></select></label>
                ${chk('animations', '寄信时的封缄动画、收信时的拆信动画')}
                ${chk('jitter', '手写随机感（阅读时每个字轻微的歪斜和墨色深浅）')}
                ${chk('onlineFonts', '在线加载中文书信字体（霞鹜文楷、思源宋体、马善政楷书）', '英文和法文字体已随插件附带；中文字体从 jsDelivr 按需加载，只下载用到的字。关闭后用电脑自带的楷体和宋体（刷新后生效）。')}
                ${ex ? chk('autoKeywords', '保存信件时，自动用 AI 给没有关键词的段落生成检索关键词') : ''}
                ${ex ? chk('detectArrival', '剧情里写到收信、拆信时，自动把信的原文交给 AI', '角色的回复（包括它的思考过程）或你自己的消息里，写到收信人收到信（名字 + 收信/来信/拆信等说法 + 送达日期，或者信已经到了），就把原文发进聊天让角色读；写到转交人拆信、转交、扣下，也会照办。还会提醒 AI：已经送到但还没读的信不要自己编内容。') : ''}
                ${chk('sealIncoming', '角色写给你的信：先藏起来，剧情里收到了再拆（拆信动画以后才看得到内容）', '按格式认出“称呼是你”的信（称呼要对得上你的用户名，或者「人物」页里你的别名）。认出以后存进档案，聊天里只把信的那几段藏起来，旁白照常显示。之后剧情里写到你收到了（AI 的回复、思考，或者你自己写“我收到了信”），右下角提醒你拆；点「拆开」播放拆信动画、打开信纸，藏起来的那几段才露出来。开着流式输出时，一写到给你的称呼，那条消息会先模糊掉。')}
                ${chk('describeLook', '读信时把信的样子告诉 AI（信纸、墨水、字迹、字号、信封、封口）', '角色收信、读信时，AI 会知道这封信摸上去、看上去是什么样，比如字写得潦草发抖、纸很旧、封着火漆。正文永远会给。')}
                ${chk('autoFill', '写新信时让 AI 自动填信头（写信人、收信人、日期、地点、语言）', '根据最近的剧情推断，并估算路上要走几天。你自己改过的格子不会被覆盖。写信页里随时可以点「✨ AI 填写」重新填。')}
            </section>

            <section class="epi-sec-card">
                <h4>🧠 注入给 AI</h4>
                ${chk('enabled', ex ? '聊天生成时注入信件：暗号点名的信，以及角色知道的相关段落' : '聊天生成时注入暗号点名的信')}
                ${ex ? `
                <label>视角角色<select class="text_pole" data-s="viewpointMode">
                    <option value="auto" ${s.viewpointMode === 'auto' ? 'selected' : ''}>跟随当前发言的角色</option>
                    <option value="manual" ${s.viewpointMode === 'manual' ? 'selected' : ''}>手动指定</option>
                    <option value="omniscient" ${s.viewpointMode === 'omniscient' ? 'selected' : ''}>全知（不过滤，调试用）</option>
                </select></label>
                ${s.viewpointMode === 'manual' ? `<label>手动指定的角色<input class="text_pole" data-s="manualViewpoint" value="${esc(s.manualViewpoint)}"></label>` : ''}
                <div class="epi-grid2">
                    <label>扫描最近几条消息<input type="number" min="1" max="20" class="text_pole" data-s="scanDepth" value="${esc(s.scanDepth)}"></label>
                    <label>最多注入几段<input type="number" min="1" max="20" class="text_pole" data-s="maxSegments" value="${esc(s.maxSegments)}"></label>
                    <label>每封信最多几段<input type="number" min="1" max="20" class="text_pole" data-s="maxPerLetter" value="${esc(s.maxPerLetter)}"></label>
                    <label>注入字数上限<input type="number" min="200" max="20000" step="100" class="text_pole" data-s="maxChars" value="${esc(s.maxChars)}"></label>
                    <label>注入位置<select class="text_pole" data-s="position">
                        <option value="1" ${String(s.position) === '1' ? 'selected' : ''}>聊天记录中（按深度）</option>
                        <option value="0" ${String(s.position) === '0' ? 'selected' : ''}>系统提示词之后</option>
                        <option value="2" ${String(s.position) === '2' ? 'selected' : ''}>系统提示词之前</option>
                    </select></label>
                    <label>深度<input type="number" min="0" max="100" class="text_pole" data-s="depth" value="${esc(s.depth)}"></label>
                </div>` : '<p class="epi-muted">简单模式只认暗号。按“谁读过、谁知道”自动注入相关段落的功能在高级模式里。</p>'}
            </section>

            <section class="epi-sec-card">
                <h4>💾 档案</h4>
                <p class="epi-muted">${esc(this.store.statusText())}</p>
                <div class="epi-row">
                    <button class="menu_button" data-act="export">导出档案</button>
                    <button class="menu_button" data-act="import-file">导入档案</button>
                    <input type="file" id="epi-import-file" accept=".json,application/json" hidden>
                </div>
            </section>
            </div>`;
    }

    getS(path) {
        return path.split('.').reduce((o, k) => (o == null ? o : o[k]), this.hooks.getSettings());
    }

    setS(path, value) {
        const keys = path.split('.');
        let o = this.hooks.getSettings();
        for (const k of keys.slice(0, -1)) o = o[k];
        o[keys[keys.length - 1]] = value;
        this.hooks.saveSettings();
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
    async openReaderWithAnim(id, { force = false } = {}) {
        const l = this.archive.letters[id];
        if (!l) return;
        const toMe = l.recipients.some(r => this.isMe(r));
        // 还在路上的信，收信人看不到
        if (toMe && l.delivery?.status === 'transit' && !force) {
            this.openReader(id);
            return;
        }
        if (toMe && l.delivery?.status === 'arrived') {
            l.delivery.status = 'viewed';
            this.store.save();
            this.renderPostbox();
        }
        if (toMe && (!l.openedAt || force) && l.status === 'sent' && this.hooks.getSettings().animations) {
            this.root.classList.add('epi-hidden');
            await playOpen(l, { render: this.renderOpts(l) });
            this.root.classList.remove('epi-hidden');
        }
        if (toMe && !l.openedAt) { l.openedAt = new Date().toISOString(); this.store.save(); }
        this.openReader(id);
    }

    // 预览正在写的信：不保存，按阅读页的样子渲染（手写随机感、花体、随信附上都有），还可以回放动画
    previewLetter() {
        const d = this.draft;
        if (!d) return null;
        const l = normalizeLetter(clone(d), d.id || '（预览）');
        l.enclosures = (l.enclosures || []).filter(e => e.name || e.letterRef);
        return l;
    }

    openPreview() {
        const l = this.previewLetter();
        if (!l) return;
        if (!l.body.trim()) { toastr?.info('信还是空的，先写几句再预览'); return; }
        this.openReader(null, l);
    }

    async playPreviewAnim(kind) {
        const l = this.previewLetter();
        if (!l) return;
        const wrap = this.root.querySelector('.epi-reader-wrap');
        this.root.classList.add('epi-hidden');
        try {
            if (kind === 'seal') await playSeal(l, { flyOut: true, render: this.renderOpts(l) });
            else await playOpen(l, { render: this.renderOpts(l) });
        } finally {
            this.root.classList.remove('epi-hidden');
            wrap?.classList.remove('epi-hidden');
        }
    }

    openReader(id, preview = null) {
        const l = preview || this.archive.letters[id];
        if (!l) return;
        const wrap = this.root.querySelector('.epi-reader-wrap');
        const a = l.appearance || {};
        // 正文第一行已经写了地点日期，就不再在信头重复
        const hasDateline = analyze(l.body)[0]?.lines[0]?.role === 'dateline';
        const place = hasDateline ? '' : formatDateLine(scriptLang(l.language) === 'zh' ? 'zh' : guessLang(l.language), l.placeFrom, l.writtenAt);
        const attach = l.enclosures?.length ? `<div class="epi-paper-note epi-enc-read"><b>📎 随信附上</b>${l.enclosures.map(e => {
            const target = e.kind === 'letter' && e.letterRef ? (this.archive.letters[e.letterRef] || null) : null;
            return `<div>${target ? `<a href="#" data-act="read" data-id="${esc(target.id)}">${esc(enclosureText(e, { archive: this.archive }))}</a>` : esc(enclosureText(e, { archive: this.archive }))}</div>`;
        }).join('')}</div>` : '';
        const showSign = l.signature && !l.body.trim().endsWith(l.signature.trim());
        const orig = l.inReplyTo ? this.archive.letters[l.inReplyTo] : null;
        const replies = preview ? [] : Object.values(this.archive.letters).filter(x => x.inReplyTo === l.id);
        const recipient = l.recipients[0];
        wrap.innerHTML = `
            <div class="epi-reader">
                <div class="epi-reader-bar">
                    <span><b>${esc(l.author)}</b> → ${esc(l.recipients.join('、'))}
                        ${l.status !== 'sent' ? `<span class="epi-chip">${esc(STATUSES[l.status])}</span>` : ''}
                        ${l.authenticity !== 'original' ? `<span class="epi-chip">${esc(AUTHENTICITY[l.authenticity])}</span>` : ''}</span>
                    <span class="epi-reader-actions">
                        ${preview ? `<span class="epi-chip">👁 预览 · 还没保存</span>
                        <button class="menu_button" data-act="preview-seal" title="回放寄信时的封缄动画：信纸折好装进信封、封口、飞走">▶ 封缄动画</button>
                        <button class="menu_button" data-act="preview-open" title="回放收信时的拆信动画">▶ 拆信动画</button>
                        <button class="menu_button epi-primary" data-act="reader-close">继续写</button>` : `
                        ${l.code ? `<button class="menu_button epi-code" data-act="copy-code" data-code="${esc(l.code)}" title="在聊天里写上这个暗号，那一轮 AI 就会读到这封信。点一下复制">暗号 ${esc(l.code)}</button>` : ''}
                        <button class="menu_button" data-act="user-reply" data-id="${esc(l.id)}" title="以 ${esc(recipient || '收件人')} 的身份写回信">✎ 回复这封信</button>
                        ${recipient ? `<button class="menu_button" data-act="reply-open-for" data-id="${esc(l.id)}">↩ 让 ${esc(recipient)} 回信</button>` : ''}
                        ${scriptLang(l.language) === 'lat' ? `<button class="menu_button" data-act="reader-translate" data-id="${esc(l.id)}" title="用 AI 翻译成中文看（只是给你看，不改原信）">🌐 中文译文</button>` : ''}
                        <button class="menu_button" data-act="edit" data-id="${esc(l.id)}">编辑</button>
                        <button class="menu_button" data-act="reader-close">关闭</button>`}
                    </span>
                </div>
                ${orig ? `<div class="epi-reader-link">↩ 这是对 <a href="#" data-act="read" data-id="${esc(orig.id)}">${esc(orig.author)} ${esc(orig.writtenAt)} 来信</a> 的回复</div>` : ''}
                <div class="${esc(paperClasses(l))} epi-paper-read" style="${esc(paperStyle(l))}">${paperLayer(l, hashSeed(l.id + l.author))}
                    ${place ? `<div class="epi-paper-place">${esc(place)}</div>` : ''}
                    <div class="epi-paper-body">${l.shell ? '<p class="epi-muted">（这封信的正文还没写。点「编辑」写正文。）</p>' : renderBody(l.body, this.renderOpts(l))}</div>
                    ${showSign ? `<div class="epi-paper-sign">${esc(l.signature)}</div>` : ''}
                    ${attach}
                </div>
                <div class="epi-reader-translation" ${l.translations?.zh?.source === l.body ? '' : 'hidden'}>${l.translations?.zh?.source === l.body ? `<h4>中文译文</h4><div class="epi-tr-read">${esc(l.translations.zh.text)}</div>` : ''}</div>
                ${replies.length ? `<div class="epi-reader-link">回信：${replies.map(r => `<a href="#" data-act="read" data-id="${esc(r.id)}">${esc(r.author)} ${esc(r.writtenAt)}</a>`).join('　')}</div>` : ''}
                ${preview ? '' : this.memoryHtml(l)}
            </div>`;
        wrap.classList.remove('epi-hidden');
        wrap.scrollTop = 0;
    }

    closeReader() {
        this.root.querySelector('.epi-reader-wrap').classList.add('epi-hidden');
    }

    // 阅读页底部：谁读过这封信、记得什么（会写进世界书）
    memoryHtml(l) {
        const mems = l.memories || [];
        const book = this.hooks.getMemoryBook?.() || '';
        const wb = this.hooks.getSettings().memory?.worldbook !== false;
        return `<div class="epi-memories" data-id="${esc(l.id)}">
            <h4>🧠 读过的人记得什么</h4>
            <p class="epi-muted epi-mem-hint">角色读完这封信，书信簿会让 AI 整理一段“TA 记得什么”：信里 TA 在意的地方、记住的几句原话、想到了什么、读完做了什么。${wb ? `这些记忆写进这个聊天的世界书${book ? `「${esc(book)}」` : '（第一次写的时候自动建一本）'}，以后剧情里提到 ${esc(l.author || '写信人')} 的信${l.code ? `或 ${esc(l.code)}` : ''}，角色就会想起来。` : '（设置里关掉了“写进世界书”，现在只存在书信簿里。）'}需要逐字读全文时，还是用暗号。</p>
            ${mems.length ? mems.map(m => `<div class="epi-mem">
                <div class="epi-mem-head"><b>${esc(m.person)}</b>
                    ${m.auto === false ? '<span class="epi-chip">手改过</span>' : ''}
                    ${m.wiBook ? `<span class="epi-chip" title="世界书「${esc(m.wiBook)}」里的第 ${esc(m.wiUid)} 条">📖 已进世界书</span>` : ''}
                    <span class="epi-mem-acts">
                        <button class="menu_button epi-mini" data-act="mem-edit" data-id="${esc(l.id)}" data-person="${esc(m.person)}">改</button>
                        <button class="menu_button epi-mini" data-act="mem-del" data-id="${esc(l.id)}" data-person="${esc(m.person)}">删</button>
                    </span></div>
                <div class="epi-mem-text">${esc(m.text)}</div>
            </div>`).join('') : '<p class="epi-muted">还没有。角色在剧情里读过这封信以后会自动整理；也可以点下面的按钮。</p>'}
            <div class="epi-mem-bar">
                <button class="menu_button" data-act="mem-recent" data-id="${esc(l.id)}" title="把最近几层剧情交给 AI，看谁读了这封信、记住了什么">🧠 从最近的剧情整理</button>
                <button class="menu_button" data-act="mem-add" data-id="${esc(l.id)}">＋ 自己写一段</button>
            </div>
            <label class="epi-mem-keys">想起这封信的额外关键词（逗号分开，可不填）
                <span class="epi-row"><input type="text" class="text_pole" id="epi-recall-keys" value="${esc((l.recallKeys || []).join('，'))}" placeholder="比如：七月的信，那笔钱，蒙马特的画室">
                <button class="menu_button epi-mini" data-act="recall-save" data-id="${esc(l.id)}">保存</button></span>
            </label>
        </div>`;
    }

    openMemoryDialog(id, person = '') {
        const l = this.archive.letters[id];
        if (!l) return;
        const m = (l.memories || []).find(x => x.person === person);
        this.openDialog(`
            <h3>🧠 ${m ? `${esc(m.person)} 的记忆` : '写一段记忆'}</h3>
            <p class="epi-muted">${esc(l.author)} 写给 ${esc(l.recipients.join('、'))} 的信。用第三人称写这个人记得什么；信里的原话用「」括起来。改过的不会被之后自动整理覆盖。</p>
            ${m ? '' : '<label>谁的记忆<input type="text" class="text_pole" id="epi-mem-person" placeholder="比如：提奥"></label>'}
            <textarea class="text_pole" id="epi-mem-text" rows="9">${esc(m?.text || '')}</textarea>
            <div class="epi-dialog-actions">
                <button class="menu_button" data-act="dialog-close">取消</button>
                <button class="menu_button epi-primary" data-act="mem-save" data-id="${esc(id)}" data-person="${esc(person)}">保存</button>
            </div>`);
    }

    // ================= 对话框 =================

    openDialog(html, cls = '') {
        const wrap = this.root.querySelector('.epi-dialog-wrap');
        wrap.innerHTML = `<div class="epi-dialog ${cls}">${html}</div>`;
        wrap.classList.remove('epi-hidden');
    }

    closeDialog() {
        this.root.querySelector('.epi-dialog-wrap').classList.add('epi-hidden');
    }

    // ================= 事件处理 =================

    async onClick(e) {
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
            case 'ai-fill': this.aiFillHead(); break;
            case 'edit-zoom': this.stepEditZoom(parseInt(el.dataset.step, 10)); break;
            case 'preview': this.openPreview(); break;
            case 'preview-seal': this.playPreviewAnim('seal'); break;
            case 'preview-open': this.playPreviewAnim('open'); break;
            case 'enc-add':
                this.draft.enclosures.push(normalizeEnclosure({ kind: 'other', name: '' }, this.draft.enclosures.length));
                this.draft.enclosures.at(-1).id = `ENC${Date.now().toString(36)}`;
                this.setDirty(); this.rerenderKeepScroll();
                break;
            case 'enc-del':
                this.draft.enclosures.splice(parseInt(el.dataset.i, 10), 1);
                this.setDirty(); this.rerenderKeepScroll();
                break;
            case 'enc-detect': {
                const found = extractEnclosures(this.draft.body).filter(f => !this.draft.enclosures.some(e => e.name === f.name));
                found.forEach((f, k) => { f.id = `ENC${Date.now().toString(36)}${k}`; this.draft.enclosures.push(f); });
                toastr?.[found.length ? 'success' : 'info'](found.length ? `找到 ${found.length} 件，名字和金额可以再改` : '正文里没找到“随信附上……”这样的句子');
                if (found.length) { this.setDirty(); this.rerenderKeepScroll(); }
                break;
            }
            case 'mem-recent': {
                if (this.busy) break;
                if (!this.hooks.hasChat()) { toastr?.info('先打开一个聊天'); break; }
                this.busy = true;
                el.disabled = true; el.textContent = '整理中…';
                try {
                    const got = await this.hooks.memoriesFromRecent(id);
                    if (!got.length) toastr?.info('最近的剧情里没看到有人读这封信');
                } catch (err) { toastr?.error(String(err?.message || err), '整理记忆失败'); }
                this.busy = false;
                this.openReader(id);
                break;
            }
            case 'mem-add': this.openMemoryDialog(id); break;
            case 'mem-edit': this.openMemoryDialog(id, el.dataset.person); break;
            case 'mem-del':
                if (confirm(`删掉 ${el.dataset.person} 对这封信的记忆？世界书里对应的条目也会删掉。`)) {
                    await this.hooks.saveMemoryEdit(id, el.dataset.person, '');
                    this.openReader(id);
                }
                break;
            case 'mem-save': {
                const person = el.dataset.person || this.root.querySelector('#epi-mem-person')?.value.trim();
                const text = this.root.querySelector('#epi-mem-text').value;
                if (!person) { toastr?.warning('写上这是谁的记忆'); break; }
                this.closeDialog();
                await this.hooks.saveMemoryEdit(id, person, text);
                this.openReader(id);
                break;
            }
            case 'recall-save': {
                const v = this.root.querySelector('#epi-recall-keys').value;
                await this.hooks.saveRecallKeys(id, v.split(/[,，、;；\n]+/).map(x => x.trim()).filter(Boolean));
                toastr?.success('保存了');
                break;
            }
            case 'copy-code': this.copyCode(el.closest('.epi-lh-code') ? normalizeCode(this.draft?.code) : el.dataset.code); break;
            case 'days': {
                const inp = this.root.querySelector(el.dataset.target);
                if (inp) inp.value = addDays(el.dataset.base, parseInt(el.dataset.days, 10));
                const radio = inp?.closest('label')?.querySelector('input[type="radio"]');
                if (radio) { radio.checked = true; this.syncSendDialog(); }
                const pf = el.dataset.target.slice(1).split('-').slice(0, 2).join('-');
                this.syncViaPlan(pf);
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
            case 'accept-confirm': this.confirmAccept(); break;
            case 'translate-open': this.openTranslateDialog(); break;
            case 'translate-run': this.runTranslate(); break;
            case 'translate-copy': {
                const t = this.root.querySelector('#epi-tr-text');
                navigator.clipboard?.writeText(t.value).then(() => toastr?.success('已复制'), () => { t.select(); document.execCommand('copy'); });
                break;
            }
            case 'translate-new': this.applyTranslation(true); break;
            case 'translate-replace': this.applyTranslation(false); break;
            case 'reader-translate': this.showReaderTranslation(id); break;
            case 'import-open': this.openImportDialog(); break;
            case 'import-run': this.runImport(); break;
            case 'import-confirm': this.confirmImport(); break;
            case 'deliver-now': this.hooks.deliverNow(id); break;
            case 'via-forward': this.openForwardDialog(id); break;
            case 'forward-confirm': this.confirmForward(el.dataset.id); break;
            case 'api-test': {
                const out = this.body.querySelector('[data-role="api-result"]');
                out.textContent = '测试中……';
                testConnection(this.hooks.getSettings().api)
                    .then(r => { out.textContent = `✓ 连接成功：${r}`; })
                    .catch(err => { out.textContent = `✕ ${err.message || err}`; });
                break;
            }
            case 'api-models':
                fetchModels(this.hooks.getSettings().api)
                    .then(list => { this.modelList = list; const y = this.body.scrollTop; this.show('settings'); this.body.scrollTop = y; toastr?.success(`找到 ${list.length} 个模型，在“模型”输入框里可以选`); })
                    .catch(err => toastr?.error('获取模型列表失败：' + (err.message || err)));
                break;
            case 'date-now':
                this.hooks.inferStoryDate({ force: true }).then(d => {
                    const y = this.body.scrollTop; this.show('settings'); this.body.scrollTop = y;
                    toastr?.info(d ? `剧情日期：${d}` : '没能推算出新的日期');
                });
                break;
            case 'export': this.hooks.exportArchive(); break;
            case 'import-file': this.root.querySelector('#epi-import-file')?.click(); break;
            case 'discard-draft':
                if (confirm('丢弃这份回信草稿？')) { this.draft = null; this.draftDirty = false; this.show('list'); }
                break;
            case 'dialog-close':
                this.closeDialog();
                if (this.tab === 'edit' && this.draft) { this.commitRaw(this.draft); this.rerenderKeepScroll(); }
                break;
            case 'style-open': this.openStyleDialog(); break;
            case 'style-apply': {
                if (e.target.closest('[data-act="style-del"]')) break;
                const key = el.dataset.key;
                const pack = key.startsWith('mine:') ? this.archive.styles[parseInt(key.slice(5), 10)] : STYLE_PACKS.find(p => p.id === key);
                if (!pack) break;
                applyStyle(this.draft, pack);
                this.commitRaw(this.draft);
                this.closeDialog();
                this.rerenderKeepScroll();
                this.setDirty();
                toastr?.success(`已套用：${pack.name}`);
                break;
            }
            case 'style-del': {
                e.stopPropagation();
                const i = parseInt(el.dataset.key.slice(5), 10);
                const pack = this.archive.styles[i];
                if (pack && confirm(`删除款式「${pack.name}」？（用过它的信不受影响）`)) {
                    this.archive.styles.splice(i, 1);
                    this.store.save();
                    this.openStyleDialog();
                }
                break;
            }
            case 'style-save': {
                const name = prompt('给这个款式起个名字：', '');
                if (!name || !name.trim()) break;
                this.archive.styles = this.archive.styles || [];
                this.archive.styles.push({ id: `mine-${Date.now()}`, name: name.trim(), desc: '', language: this.draft.language || '', appearance: pickStyle(this.draft.appearance) });
                this.store.save();
                toastr?.success('已存为我的款式');
                this.openStyleDialog();
                break;
            }
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

    // 写信页的信纸跟着外观设置实时更新
    refreshPaper() {
        const d = this.draft;
        const paper = this.body.querySelector('.epi-paper-edit');
        if (paper && d) {
            paper.className = `${paperClasses(d)} epi-paper-edit`;
            paper.setAttribute('style', paperStyle(d));
            paper.querySelector('.epi-wear-layer')?.remove();
            paper.insertAdjacentHTML('afterbegin', paperLayer(d, hashSeed(d.id + d.author)));
        }
        const look = this.body.querySelector('[data-role="look"]');
        if (look && d) look.textContent = this.lookSummary(d.appearance);
    }

    reopenStyleDialog() {
        const dlg = this.root.querySelector('.epi-dialog');
        const y = dlg ? dlg.scrollTop : 0;
        this.openStyleDialog();
        const nd = this.root.querySelector('.epi-dialog');
        if (nd) nd.scrollTop = y;
    }

    onInput(e) {
        if (this.rendering) return;
        const t = e.target;
        const act = t.dataset.act;
        if (t.closest?.('.epi-dialog') && /^epi-(send|acc)-(mode|via|leg|target|arrival|floors)$/.test(t.name || t.id || '')) {
            const prefix = (t.name || t.id).split('-').slice(0, 2).join('-');
            if (prefix === 'epi-send') this.syncSendDialog();
            this.syncViaPlan(prefix);
            return;
        }
        if (t.id === 'epi-imp-range' || t.id === 'epi-imp-method') { this.updateImportEstimate(); return; }
        if (t.dataset.s) {
            const key = t.dataset.s;
            let v = t.type === 'checkbox' ? t.checked : t.value;
            if (t.type === 'number') v = Number(v);
            if (key === 'position' || key === 'editZoom') v = Number(v);
            this.setS(key, v);
            if (key === 'editZoom') this.applyEditZoom();
            if (e.type === 'change' && ['api.mode', 'mode', 'viewpointMode'].includes(key)) {
                const y = this.body.scrollTop;
                this.show('settings');
                this.body.scrollTop = y;
            }
            if (key === 'onlineFonts' && v) this.hooks.loadFonts?.();
            if (key === 'jitter') this.closeReader();
            return;
        }
        if (t.dataset.chat === 'storyDate') {
            if (e.type === 'input') this.hooks.setStoryDate(t.value.trim());
            return;
        }
        if (t.id === 'epi-import-file') {
            if (e.type === 'change') this.hooks.importFile(t);
            return;
        }
        if (t.id === 'epi-tr-target') {
            const w = this.root.querySelector('#epi-tr-custom-wrap');
            if (w) w.hidden = t.value !== '__custom';
            return;
        }
        if (t.dataset.imp !== undefined || t.dataset.impF) return;
        if (act === 'toggle-flourish-cb') {
            if (e.type !== 'change' || !this.draft) return;
            this.draft.appearance.flourish = t.checked;
            this.refreshPaper();
            this.setDirty();
            return;
        }
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
            if (HEAD_FIELDS.includes(t.dataset.f)) {
                this.lhAuto?.delete(t.dataset.f);
                this.lhAI?.delete(t.dataset.f);
                t.classList.remove('epi-lh-ai');
            }
            const path = t.dataset.f.split('.');
            if (path.length === 2) d[path[0]][path[1]] = t.value; else d[path[0]] = t.value;
            if (path[0] === 'appearance') {
                if (t.dataset.f === 'appearance.inkColor') d.appearance.ink = 'custom';
                this.refreshPaper();
                if (t.dataset.f === 'appearance.font') this.fontTouched = true;
                if (t.dataset.f === 'appearance.orientation') this.fitPage();
                // 外观对话框里改了选项：重绘对话框，让说明和对比度跟着变
                if (e.type === 'change' && t.closest('.epi-dialog')) this.reopenStyleDialog();
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
        if (t.dataset.enc !== undefined && d) {
            const item = d.enclosures[parseInt(t.dataset.enc, 10)];
            if (!item) return;
            item[t.dataset.ef] = t.value;
            // 换了种类（钱要填金额、另一封信要选信）：重绘这一块
            if (t.dataset.ef === 'kind' && e.type === 'change') this.rerenderKeepScroll();
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
