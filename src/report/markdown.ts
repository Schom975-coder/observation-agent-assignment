// The drafted documents in the report (ARCHITECTURE.md 5.11): a model wrote their bodies, so their
// Markdown is data. renderMarkdownHtml implements the grammar of the dashboard's renderMarkdown
// (dashboard/viewer.js) in TypeScript, escaping first: paragraphs, ## and ### headings (a # title is
// dropped; the report carries it), - and 1. lists, "- [ ]" items as text, > blockquotes, fenced
// blocks as <pre>, tables, `code`, **bold** and [placeholders] marked as blanks. No HTML the document
// holds ever reaches the page as markup; Markdown's own escapes (a backslash before punctuation, the
// entities the escapers write) read as the characters they stand for. markdownForReport makes the
// document inert for report.md (src/report/text.ts inertMarkdown) and moves its headings under the
// report's own.
import { escapeHtml, inertMarkdown } from './text.ts';

// A [placeholder]: square brackets around text with a letter in it, not a "[ ]" checkbox (the rule
// of src/model/artifacts.ts).
const BRACKETED = /\[[^[\]\n]*\]/g;
const isBlank = (s: string): boolean => /[A-Za-z]/.test(s);
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const EVIDENCE_HEADING = /^##[ \t]+Evidence[ \t]*$/;

// The bracketed placeholders of a document, in order, before its Evidence footer: what the owner has
// to confirm. Counted by code.
export function blankItems(md: string): string[] {
  const out: string[] = [];
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    if (EVIDENCE_HEADING.test(line)) break;
    for (const m of line.matchAll(BRACKETED)) if (isBlank(m[0])) out.push(m[0]);
  }
  return out;
}

// Markdown's escapes, read as text: a backslash before an ASCII punctuation mark, and the five
// entities the escapers write. A held character is kept out of the way (as NUL, its index, NUL)
// while the inline marks are found, so an escaped "[" or "*" never opens one.
const NUL = String.fromCharCode(0);
const ESCAPED = /\\([!-\/:-@[-`{-~])/g;
const HELD = new RegExp(`${NUL}(\\d+)${NUL}`, 'g');
const ENTITY: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'" };
const plain = (text: string, held: readonly string[]): string =>
  text.replace(HELD, (_m, i: string) => held[Number(i)] ?? '').replace(/&(?:lt|gt|amp|quot|#39);/g, (e) => ENTITY[e] ?? e);
// A code span shows its text as written: a held character goes back with its backslash.
const raw = (text: string, held: readonly string[]): string => text.replace(HELD, (_m, i: string) => `\\${held[Number(i)] ?? ''}`);

// Inline text: escaped, then `code` (a message id among `ids` as a <code class="msg">), **bold**
// and [placeholders] as <mark class="blank">.
function inline(source: string, ids: ReadonlySet<string>): string {
  const held: string[] = [];
  const text = source.replace(ESCAPED, (_m, c: string) => `${NUL}${held.push(c) - 1}${NUL}`);
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^[\]\n]*\])/g;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    out += escapeHtml(plain(text.slice(last, at), held));
    const t = m[0];
    if (t.startsWith('`')) {
      const v = raw(t.slice(1, -1), held);
      out += ids.has(v) ? `<code class="msg">${escapeHtml(v)}</code>` : `<code>${escapeHtml(v)}</code>`;
    } else if (t.startsWith('**')) {
      out += `<strong>${escapeHtml(plain(t.slice(2, -2), held))}</strong>`;
    } else {
      const shown = escapeHtml(plain(t, held));
      out += isBlank(t) ? `<mark class="blank">${shown}</mark>` : shown;
    }
    last = at + t.length;
  }
  return out + escapeHtml(plain(text.slice(last), held));
}

// Pre-formatted text with its placeholders marked.
function preText(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(BRACKETED)) {
    const at = m.index ?? 0;
    out += escapeHtml(text.slice(last, at));
    out += isBlank(m[0]) ? `<mark class="blank">${escapeHtml(m[0])}</mark>` : escapeHtml(m[0]);
    last = at + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

const cells = (line: string): string[] => {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
};
const isDelimiter = (line: string): boolean => /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/.test(line.trim());

// The document as HTML. `base`: the heading level a "##" becomes (the report nests documents under
// its own h2 and h3, so 4). `ids`: the message ids a `code` span may name.
export function renderMarkdownHtml(md: string, opts: { base?: number; ids?: ReadonlySet<string> } = {}): string {
  const base = opts.base ?? 3;
  const ids = opts.ids ?? new Set<string>();
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  let quote: string[] = [];
  const flushPara = () => {
    if (para.length > 0) out.push(`<p>${inline(para.join(' '), ids)}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list !== null) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length > 0) {
      const html = `<blockquote>${quote.map((q) => inline(q, ids)).join('<br>')}</blockquote>`;
      if (list !== null && list.items.length > 0) list.items[list.items.length - 1] += html;
      else out.push(html);
    }
    quote = [];
  };
  const flushAll = () => {
    flushPara();
    flushQuote();
    flushList();
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    const line = raw.replace(/\s+$/, '');
    const fence = FENCE.exec(line);
    if (fence !== null) {
      flushAll();
      const mark = fence[1] as string;
      const body: string[] = [];
      for (i++; i < lines.length && !(lines[i] as string).trim().startsWith(mark.slice(0, 3)); i++) body.push(lines[i] as string);
      out.push(`<pre>${preText(body.join('\n'))}</pre>`);
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      flushQuote();
      continue;
    }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(line);
    if (heading !== null) {
      flushAll();
      const level = (heading[1] as string).length;
      if (level === 1) continue;
      const h = Math.min(6, base + level - 2);
      out.push(`<h${h}>${inline((heading[2] as string).replace(/[ \t]+#+$/, ''), ids)}</h${h}>`);
      continue;
    }
    const bq = /^[ \t]*>[ \t]?(.*)$/.exec(line);
    if (bq !== null) {
      flushPara();
      // An indented quote belongs to the list item above it (the Evidence footer's quotes); one at
      // the margin ends the list.
      if (quote.length === 0 && !/^[ \t]/.test(raw)) flushList();
      quote.push(bq[1] as string);
      continue;
    }
    flushQuote();
    if (line.includes('|') && i + 1 < lines.length && isDelimiter(lines[i + 1] as string)) {
      flushAll();
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && (lines[i] as string).includes('|') && (lines[i] as string).trim() !== ''; i++) rows.push(cells(lines[i] as string));
      i--;
      out.push(
        `<table><thead><tr>${head.map((c) => `<th scope="col">${inline(c, ids)}</th>`).join('')}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, ids)}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
      );
      continue;
    }
    const bullet = /^[ \t]*[-*+][ \t]+(.*)$/.exec(line);
    const numbered = /^[ \t]*\d{1,3}[.)][ \t]+(.*)$/.exec(line);
    if (bullet !== null || numbered !== null) {
      flushPara();
      const tag = bullet !== null ? 'ul' : 'ol';
      if (list === null || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push(inline((bullet ?? numbered)?.[1] as string, ids));
      continue;
    }
    if (list !== null && /^[ \t]{2,}\S/.test(raw) && para.length === 0) {
      list.items[list.items.length - 1] += ` ${inline(line.trim(), ids)}`;
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushAll();
  return out.join('\n');
}

// The document for report.md: made inert (src/report/text.ts inertMarkdown: no link, image, HTML or
// open fence can come from it), its "#" title dropped (the report carries it) and every other heading
// moved down by `shift` levels (to six at most), outside its fenced blocks.
export function markdownForReport(md: string, shift = 2): string {
  const lines = inertMarkdown(md).split('\n');
  const out: string[] = [];
  let fenced: string | null = null;
  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const mark = fence[1] as string;
      fenced = fenced === null ? mark.slice(0, 3) : line.trim().startsWith(fenced) ? null : fenced;
      out.push(line);
      continue;
    }
    if (fenced !== null) {
      out.push(line);
      continue;
    }
    const h = /^ {0,3}(#{1,6})([ \t]+.*)$/.exec(line);
    if (h !== null) {
      if ((h[1] as string).length === 1) continue;
      out.push(`${'#'.repeat(Math.min(6, (h[1] as string).length + shift))}${h[2] as string}`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/^\n+/, '');
}
