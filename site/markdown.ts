// The site's Markdown renderer, for our own trusted Markdown only: the pages in site/pages/ and the
// repository's README.md, NOTES.md and BRIEF.md. The drafted documents are model prose and go through
// the report's escaping renderer instead (src/report/markdown.ts renderMarkdownHtml).
//
// The grammar: ATX headings with ids (from the text, or fixed by hand with a trailing {#id}),
// paragraphs, bullet and numbered lists (nested by indentation, with fenced blocks inside items),
// fenced code, GitHub tables (a first cell starting {#id} gives its row that id; every cell carries
// its column's header as data-label, so a narrow screen can show rows as blocks), blockquotes,
// horizontal rules, links, images, autolinks, inline code, bold and italics, backslash escapes. Text
// is always escaped. Raw HTML blocks pass through only when `html` is set, which the generator does
// for site/pages/ alone: README, NOTES and BRIEF are rendered with every tag shown as text.

export type MarkdownOptions = {
  html?: boolean;
  // Rewrites every link target (the generator turns repository paths into GitHub URLs); `image`
  // rewrites image sources and defaults to `link`.
  link?: (href: string) => string;
  image?: (src: string) => string;
  // Ids already taken on the page; heading ids are made unique against it and added to it.
  ids?: Set<string>;
  // 'github' gives headings the ids GitHub gives them (README, NOTES and BRIEF, so a fragment means
  // the same on the site and on GitHub); 'site', the default, the slugId of their text.
  idStyle?: 'site' | 'github';
};

export type Heading = { level: number; text: string; id: string };
export type Rendered = { html: string; headings: Heading[] };

type Ctx = { html: boolean; link: (href: string) => string; image: (src: string) => string; ids: Set<string>; headings: Heading[]; github: boolean };

const HTML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML_ESC[c] as string);

// A heading's id: lower-case ASCII letters and digits, runs of anything else as one hyphen.
export function slugId(text: string): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s === '' ? 'section' : s;
}

// The ids GitHub gives the headings of a Markdown file (for links into the repository's own .md
// files): the heading's text without its inline marks, lower-cased, every character that is not a
// letter, digit, space, hyphen or underscore dropped, each space a hyphen; repeats get -1, -2.
export const githubSlug = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');

export function githubIds(md: string): Set<string> {
  const ids = new Set<string>();
  const seen = new Map<string, number>();
  let fence: string | null = null;
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f !== null) {
      const mark = f[1] as string;
      if (fence === null) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (h === null) continue;
    const text = (h[1] as string).replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '');
    const base = githubSlug(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    ids.add(n === 0 ? base : `${base}-${n}`);
  }
  return ids;
}

// Text for a generated Markdown line: one line, every character Markdown could read as a mark
// escaped with a backslash, so data shows as written.
export const mdText = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, ' ').replace(/[\\`*_[\]<>#|~]/g, (c) => `\\${c}`);

const BLANK = /^[ \t]*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})([^`]*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const HTML_BLOCK = /^<(?:\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$))/;
const DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const PUNCT = /[!-/:-@[-`{-~]/;

const expandTabs = (line: string): string => line.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, '    '));
const indentOf = (line: string): number => (/^ */.exec(line) as RegExpExecArray)[0].length;

function closesFence(line: string, mark: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return m !== null && (m[1] as string)[0] === mark[0] && (m[1] as string).length >= mark.length;
}

function isTableStart(lines: readonly string[], i: number): boolean {
  const next = lines[i + 1];
  return (lines[i] as string).includes('|') && next !== undefined && next.includes('|') && DELIM.test(next);
}

// Whether a line starts a block that ends a paragraph.
function interrupts(line: string, ctx: Ctx): boolean {
  if (FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line)) return true;
  if (ctx.html && HTML_BLOCK.test(line)) return true;
  const item = ITEM.exec(line);
  if (item === null || (item[3] as string) === '') return false;
  // A numbered list interrupts a paragraph only when it starts at 1.
  return !/^\d/.test(item[2] as string) || /^1[.)]$/.test(item[2] as string);
}

function headingId(text: string, explicit: string | null, ctx: Ctx): string {
  if (explicit !== null) {
    ctx.ids.add(explicit);
    return explicit;
  }
  if (ctx.github) {
    const base = githubSlug(text);
    let id = base;
    for (let n = 1; ctx.ids.has(id); n++) id = `${base}-${n}`;
    ctx.ids.add(id);
    return id;
  }
  const base = slugId(text);
  let id = base;
  for (let n = 2; ctx.ids.has(id); n++) id = `${base}-${n}`;
  ctx.ids.add(id);
  return id;
}

const plainOf = (html: string): string =>
  html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e] ?? '');

// A table row's cells, split at every pipe that is not escaped.
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function table(lines: readonly string[], start: number, ctx: Ctx, out: string[]): number {
  const head = cells(lines[start] as string);
  const align = cells(lines[start + 1] as string).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : null));
  const labels = head.map((h) => escapeHtml(plainOf(inline(h, ctx))));
  const rows: string[] = [];
  let i = start + 2;
  for (; i < lines.length && !BLANK.test(lines[i] as string) && (lines[i] as string).includes('|'); i++) {
    const row = cells(lines[i] as string);
    let id = '';
    const m = /^\{#([a-z0-9][a-z0-9-]*)\}\s*/.exec(row[0] ?? '');
    if (m !== null) {
      id = ` id="${m[1] as string}"`;
      ctx.ids.add(m[1] as string);
      row[0] = (row[0] as string).slice(m[0].length);
    }
    const tds = head.map((_h, c) => {
      const a = align[c];
      return `<td data-label="${labels[c] ?? ''}"${a === null || a === undefined ? '' : ` class="${a}"`}>${inline(row[c] ?? '', ctx)}</td>`;
    });
    rows.push(`<tr${id}>${tds.join('')}</tr>`);
  }
  const ths = head.map((h, c) => {
    const a = align[c];
    return `<th scope="col"${a === null || a === undefined ? '' : ` class="${a}"`}>${inline(h, ctx)}</th>`;
  });
  out.push(`<div class="table"><table><thead><tr>${ths.join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
  return i;
}

// A list from lines[start]: every item's lines (indented to its content, blank lines kept) rendered
// as blocks of their own; tight when no blank line separates items or blocks inside an item.
function list(lines: readonly string[], start: number, ctx: Ctx, out: string[]): number {
  const first = ITEM.exec(lines[start] as string) as RegExpExecArray;
  const ordered = /^\d/.test(first[2] as string);
  const kind = ordered ? (first[2] as string).slice(-1) : (first[2] as string);
  const items: string[][] = [];
  let loose = false;
  let i = start;
  // Whether a line starts another item of this list.
  const sibling = (line: string | undefined): boolean => {
    const m = line === undefined ? null : ITEM.exec(line);
    if (m === null) return false;
    const marker = m[2] as string;
    return /^\d/.test(marker) === ordered && (ordered ? marker.slice(-1) : marker) === kind;
  };
  while (i < lines.length) {
    const m = ITEM.exec(lines[i] as string);
    if (m === null || !sibling(lines[i])) break;
    const marker = m[2] as string;
    const spaces = (m[3] as string).length;
    const content = (m[1] as string).length + marker.length + (spaces === 0 || spaces > 4 ? 1 : spaces);
    const body = [(lines[i] as string).slice(m[0].length)];
    i++;
    let blankBefore = false;
    while (i < lines.length) {
      const l = lines[i] as string;
      if (BLANK.test(l)) {
        body.push('');
        blankBefore = true;
        i++;
        continue;
      }
      if (indentOf(l) >= content) {
        body.push(l.slice(content));
        i++;
        blankBefore = false;
        continue;
      }
      // A lazy continuation of the item's paragraph.
      if (!blankBefore && !interrupts(l, ctx) && !ITEM.test(l)) {
        body.push(l.trim());
        i++;
        continue;
      }
      break;
    }
    while (body.length > 0 && body[body.length - 1] === '') {
      body.pop();
      if (sibling(lines[i])) loose = true;
    }
    if (body.some((l, k) => l === '' && k > 0 && k < body.length - 1)) loose = true;
    items.push(body);
  }
  const tag = ordered ? 'ol' : 'ul';
  const n = ordered ? Number((first[2] as string).slice(0, -1)) : 1;
  const startAttr = ordered && n !== 1 ? ` start="${n}"` : '';
  out.push(`<${tag}${startAttr}>${items.map((b) => `<li>${blocks(b, ctx, !loose)}</li>`).join('')}</${tag}>`);
  return i;
}

function blocks(source: readonly string[], ctx: Ctx, tight: boolean): string {
  const lines = source.map(expandTabs);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (BLANK.test(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const indent = (fence[1] as string).length;
      const body: string[] = [];
      for (i++; i < lines.length && !closesFence(lines[i] as string, fence[2] as string); i++) {
        const l = lines[i] as string;
        body.push(l.slice(Math.min(indent, indentOf(l))));
      }
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (ctx.html && HTML_BLOCK.test(line)) {
      for (; i < lines.length && !BLANK.test(lines[i] as string); i++) out.push(lines[i] as string);
      continue;
    }
    const atx = ATX.exec(line);
    if (atx !== null) {
      const level = (atx[1] as string).length;
      const raw = atx[2] ?? '';
      const fixed = /^(.*?)[ \t]*\{#([a-z0-9][a-z0-9-]*)\}$/.exec(raw);
      const text = fixed === null ? raw : (fixed[1] as string);
      const html = inline(text, ctx);
      const id = headingId(plainOf(html), fixed === null ? null : (fixed[2] as string), ctx);
      ctx.headings.push({ level, text: plainOf(html), id });
      out.push(`<h${level} id="${id}">${html}</h${level}>`);
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i] as string); i++) inner.push((lines[i] as string).replace(QUOTE, ''));
      out.push(`<blockquote>${blocks(inner, ctx, false)}</blockquote>`);
      continue;
    }
    if (isTableStart(lines, i)) {
      i = table(lines, i, ctx, out);
      continue;
    }
    if (ITEM.test(line)) {
      i = list(lines, i, ctx, out);
      continue;
    }
    const para = [line.trim()];
    for (i++; i < lines.length && !BLANK.test(lines[i] as string) && !interrupts(lines[i] as string, ctx); i++) para.push((lines[i] as string).trim());
    const text = inline(para.join('\n'), ctx);
    out.push(tight ? text : `<p>${text}</p>`);
  }
  return out.join('\n');
}

// The end of a backtick run of `len` starting at or after `from`, or -1.
function closingTicks(src: string, from: number, len: number): number {
  for (let j = src.indexOf('`', from); j >= 0; j = src.indexOf('`', j)) {
    let run = 0;
    while (src[j + run] === '`') run++;
    if (run === len) return j;
    j += run;
  }
  return -1;
}

type Link = { text: string; href: string; title: string | null; end: number };

// A link or image body starting at the "[" at `at`: [text](href "title").
function parseLink(src: string, at: number): Link | null {
  let depth = 0;
  let j = at;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\\') {
      j++;
      continue;
    }
    if (ch === '`') {
      let run = 0;
      while (src[j + run] === '`') run++;
      const close = closingTicks(src, j + run, run);
      if (close >= 0) j = close + run - 1;
      else j += run - 1;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) break;
  }
  if (j >= src.length || src[j + 1] !== '(') return null;
  let k = j + 2;
  while (src[k] === ' ') k++;
  let href: string;
  if (src[k] === '<') {
    const e = src.indexOf('>', k);
    if (e < 0) return null;
    href = src.slice(k + 1, e);
    k = e + 1;
  } else {
    const s = k;
    let parens = 0;
    for (; k < src.length; k++) {
      const ch = src[k] as string;
      if (ch === '\\') {
        k++;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === '(') parens++;
      else if (ch === ')') {
        if (parens === 0) break;
        parens--;
      }
    }
    href = src.slice(s, k);
  }
  while (src[k] === ' ') k++;
  let title: string | null = null;
  if (src[k] === '"') {
    const e = src.indexOf('"', k + 1);
    if (e < 0) return null;
    title = src.slice(k + 1, e);
    k = e + 1;
    while (src[k] === ' ') k++;
  }
  if (src[k] !== ')') return null;
  return { text: src.slice(at + 1, j), href, title, end: k + 1 };
}

const URL_AT = /https?:\/\/[^\s<>]+/y;

function bareUrl(src: string, i: number): string | null {
  URL_AT.lastIndex = i;
  const m = URL_AT.exec(src);
  if (m === null) return null;
  let url = m[0].replace(/[.,;:!?'"*_]+$/, '');
  while (url.endsWith(')') && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length) url = url.slice(0, -1);
  return url;
}

const anchor = (href: string, text: string, ctx: Ctx): string => `<a href="${escapeHtml(ctx.link(href))}">${text}</a>`;

function emphasis(src: string, i: number, ctx: Ctx, inLink: boolean): { html: string; end: number } | null {
  const c = src[i] as string;
  const len = src[i + 1] === c ? 2 : 1;
  const next = src[i + len] ?? ' ';
  if (/\s/.test(next) || (c === '_' && i > 0 && /[A-Za-z0-9]/.test(src[i - 1] as string))) return null;
  const marker = c.repeat(len);
  for (let j = src.indexOf(marker, i + len); j >= 0; j = src.indexOf(marker, j + 1)) {
    if (j === i + len || /\s/.test(src[j - 1] as string)) continue;
    if (len === 1 && src[j + 1] === c) {
      j++;
      continue;
    }
    if (c === '_' && /[A-Za-z0-9]/.test(src[j + len] ?? ' ')) continue;
    const tag = len === 2 ? 'strong' : 'em';
    return { html: `<${tag}>${inlineText(src.slice(i + len, j), ctx, inLink)}</${tag}>`, end: j + len };
  }
  return null;
}

function inlineText(src: string, ctx: Ctx, inLink: boolean): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '\\' && i + 1 < src.length && PUNCT.test(src[i + 1] as string)) {
      out += escapeHtml(src[i + 1] as string);
      i += 2;
      continue;
    }
    if (c === '`') {
      let run = 0;
      while (src[i + run] === '`') run++;
      const close = closingTicks(src, i + run, run);
      if (close < 0) {
        out += src.slice(i, i + run);
        i += run;
        continue;
      }
      let code = src.slice(i + run, close).replace(/\n/g, ' ');
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1);
      out += `<code>${escapeHtml(code)}</code>`;
      i = close + run;
      continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      const l = parseLink(src, i + 1);
      if (l !== null) {
        const title = l.title === null ? '' : ` title="${escapeHtml(l.title)}"`;
        out += `<img src="${escapeHtml(ctx.image(l.href))}" alt="${escapeHtml(plainOf(inlineText(l.text, ctx, true)))}"${title}>`;
        i = l.end;
        continue;
      }
    }
    if (c === '[' && !inLink) {
      const l = parseLink(src, i);
      if (l !== null) {
        const title = l.title === null ? '' : ` title="${escapeHtml(l.title)}"`;
        out += `<a href="${escapeHtml(ctx.link(l.href))}"${title}>${inlineText(l.text, ctx, true)}</a>`;
        i = l.end;
        continue;
      }
    }
    if (c === '<') {
      const m = /^<(https?:\/\/[^\s<>]+)>/.exec(src.slice(i, i + 2048));
      if (m !== null && !inLink) {
        out += anchor(m[1] as string, escapeHtml(m[1] as string), ctx);
        i += m[0].length;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      const em = emphasis(src, i, ctx, inLink);
      if (em !== null) {
        out += em.html;
        i = em.end;
        continue;
      }
      const run = src[i + 1] === c ? 2 : 1;
      out += src.slice(i, i + run);
      i += run;
      continue;
    }
    if (c === 'h' && !inLink && (i === 0 || /[\s(]/.test(src[i - 1] as string))) {
      const url = bareUrl(src, i);
      if (url !== null) {
        out += anchor(url, escapeHtml(url), ctx);
        i += url.length;
        continue;
      }
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

function inline(src: string, ctx: Ctx): string {
  return inlineText(src, ctx, false);
}

function context(opts: MarkdownOptions, html: boolean): Ctx {
  const link = opts.link ?? ((h: string) => h);
  return { html, link, image: opts.image ?? link, ids: opts.ids ?? new Set<string>(), headings: [], github: opts.idStyle === 'github' };
}

export function renderMarkdown(md: string, opts: MarkdownOptions = {}): Rendered {
  const ctx = context(opts, opts.html === true);
  const html = blocks(md.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n'), ctx, false);
  return { html, headings: ctx.headings };
}

// Inline Markdown alone (a prefix line, a table cell made by the generator).
export function renderInline(md: string, opts: MarkdownOptions = {}): string {
  return inline(md, context(opts, false));
}
