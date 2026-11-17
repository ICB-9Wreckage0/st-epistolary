// 书信簿 · 导出成 .md / .txt
// md：保留格式（加粗、划掉、放大、下划线），信头做成一小段说明；txt：纯文字，格式记号去掉。
// 可以顺带导出“读后记忆”和“经过”（谁什么时候寄出、收到、读了）。

import { MARK_RE, MARKS, stripMarks, isNote, noteWord, noteLook } from './model.js';
import { analyze } from './render.js';
import { paginate, pagesText } from './pages.js';
import { letterStory } from './timeline.js';

// 信上的格式 → Markdown（GFM）：**加粗** ~~划掉~~ 原样；++放大++、__下划线__ 换成 HTML（Markdown 里 __ 是加粗）
function marksToMd(text) {
    let t = String(text || '');
    for (let pass = 0; pass < 6 && MARK_RE.test(t); pass++) {
        t = t.replace(new RegExp(MARK_RE.source, 'g'), (all, m, inner) => {
            switch (MARKS[m]) {
                case 'bold': return `**${inner}**`;
                case 'strike': return `~~${inner}~~`;
                case 'big': return `<big>${inner}</big>`;
                case 'under': return `<u>${inner}</u>`;
                default: return inner;
            }
        });
    }
    return t;
}

// 一个 Markdown 段落里换行要留住：行末加两个空格
const mdLines = lines => lines.map(l => l.replace(/\s+$/, '')).join('  \n');
// 行首这些字符在 Markdown 里有特殊意思（标题、列表、引用），前面垫一个反斜杠
const mdSafe = line => line.replace(/^(\s*)([#>*+-]|\d+\.)(\s)/, '$1\\$2$3');

function title(l) {
    const who = `${l.author || '？'} → ${(l.recipients || []).join('、') || '？'}`;
    return [l.code, l.title ? `「${l.title}」` : '', l.blurb || who].filter(Boolean).join(' ');
}

function metaRows(l, pagesOpts) {
    const pg = paginate(l, pagesOpts);
    return [
        ['类型', isNote(l) ? `${noteWord(l)}${noteLook(l) ? `（${noteLook(l)}）` : ''}` : '信'],
        ['写信人', l.author],
        ['收信人', (l.recipients || []).join('、')],
        ['日期', l.writtenAt],
        ['地点', [l.placeFrom, l.placeTo].filter(Boolean).join(' → ')],
        ['暗号', l.code],
        ['一句话简介', l.blurb],
        ['信封上写着', !isNote(l) ? l.envNote : ''],
        ['篇幅', pg.units ? pagesText(pg, { note: isNote(l) }) : ''],
        ['语言', l.language],
    ].filter(([, v]) => String(v || '').trim());
}

function storyLines(l) {
    return letterStory(l).map(e => `${e.date ? `${e.date} ` : ''}${e.who || ''}${e.label}${e.to ? `（给 ${e.to}）` : ''}${e.note ? `：${e.note}` : ''}`);
}

// 一封信 → Markdown
export function letterToMarkdown(l, { meta = true, memories = false, story = false, level = 2, pagesOpts = {} } = {}) {
    const h = '#'.repeat(Math.min(6, Math.max(1, level)));
    const out = [`${h} ${title(l)}`, ''];
    if (meta) {
        for (const [k, v] of metaRows(l, pagesOpts)) out.push(`- **${k}**：${String(v).replace(/\n/g, ' ')}`);
        out.push('');
    }
    // 正文：一段一段，段内换行保留
    const paras = analyze(l.body || '');
    if (paras.length) {
        for (const p of paras) {
            out.push(mdLines(p.lines.map(x => mdSafe(marksToMd(x.raw ?? x.text)))));
            out.push('');
        }
    } else out.push('*（正文还没写）*', '');
    if (l.enclosures?.length) out.push(`*随信附上：${l.enclosures.map(e => e.label || e.name || e.kind || '').filter(Boolean).join('、')}*`, '');
    if (memories && l.memories?.length) {
        out.push(`${h}# 读后记忆`, '');
        for (const m of l.memories) {
            out.push(`**${m.person}**${m.weight ? `（${'●'.repeat(m.weight)}${'○'.repeat(3 - m.weight)}）` : ''}`, '');
            out.push(String(m.text || '').trim(), '');
            for (const f of m.learned || []) out.push(`- 新知道的事（${f.kind || '其他'}）：${f.about ? `${f.about}——` : ''}${f.fact}`);
            if (m.learned?.length) out.push('');
        }
    }
    if (story) {
        const s = storyLines(l);
        if (s.length) { out.push(`${h}# 经过`, '', ...s.map(x => `- ${x}`), ''); }
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// 一封信 → 纯文本
export function letterToText(l, { meta = true, memories = false, story = false, pagesOpts = {} } = {}) {
    const out = [title(l), '='.repeat(Math.min(40, Math.max(8, title(l).length * 2))), ''];
    if (meta) {
        for (const [k, v] of metaRows(l, pagesOpts)) out.push(`${k}：${String(v).replace(/\n/g, ' ')}`);
        out.push('');
    }
    const body = stripMarks(String(l.body || '')).replace(/\r/g, '').trim();
    out.push(body || '（正文还没写）', '');
    if (l.enclosures?.length) out.push(`（随信附上：${l.enclosures.map(e => e.label || e.name || e.kind || '').filter(Boolean).join('、')}）`, '');
    if (memories && l.memories?.length) {
        out.push('—— 读后记忆 ——', '');
        for (const m of l.memories) {
            out.push(`【${m.person}】${m.weight ? `（${'●'.repeat(m.weight)}${'○'.repeat(3 - m.weight)}）` : ''}`, String(m.text || '').trim());
            for (const f of m.learned || []) out.push(`  · 新知道的事（${f.kind || '其他'}）：${f.about ? `${f.about}——` : ''}${f.fact}`);
            out.push('');
        }
    }
    if (story) {
        const s = storyLines(l);
        if (s.length) out.push('—— 经过 ——', ...s.map(x => `  · ${x}`), '');
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// 好几封 → 一个文件（按日期、再按记下的先后排）
export function exportLetters(letters, format = 'md', { title: docTitle = '书信簿', ...opts } = {}) {
    const list = [...letters].sort((a, b) => String(a.writtenAt || '9999').localeCompare(String(b.writtenAt || '9999')) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    if (format === 'txt') {
        const head = list.length > 1 ? `${docTitle}\n共 ${list.length} 封${list.some(isNote) ? '（含纸条）' : ''}\n\n${'─'.repeat(30)}\n\n` : '';
        return head + list.map(l => letterToText(l, opts)).join(`\n${'─'.repeat(30)}\n\n`);
    }
    if (list.length === 1) return letterToMarkdown(list[0], { ...opts, level: 1 });
    const toc = list.map((l, i) => `${i + 1}. ${title(l)}${l.writtenAt ? `（${l.writtenAt}）` : ''}`).join('\n');
    return `# ${docTitle}\n\n共 ${list.length} 封${list.some(isNote) ? '（含纸条）' : ''}\n\n${toc}\n\n---\n\n` + list.map(l => letterToMarkdown(l, { ...opts, level: 2 })).join('\n---\n\n');
}

// 文件名：去掉文件系统不认的字符
export function exportFileName(base, format) {
    const clean = String(base || '书信簿').replace(/[\\/:*?"<>|【】\s]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || '书信簿';
    return `${clean}.${format === 'txt' ? 'txt' : 'md'}`;
}

