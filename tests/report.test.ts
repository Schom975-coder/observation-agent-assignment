// The report (src/report/report.ts, markdown.ts, text.ts): one model rendered as report.md and
// report.html. A17: every money and hour figure in either render is a figure of the data; the eight
// sections in order with page one first; report.md holds no HTML tag and cites Git paths in
// backticks; report.html is self-contained. And the escaping Markdown renderer and the escapers.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadInputs, renderOutputs } from '../src/report/build.ts';
import { blankItems, markdownForReport, renderMarkdownHtml } from '../src/report/markdown.ts';
import { escapeHtml, escapeMd, inertMarkdown } from '../src/report/text.ts';
import { numsIn } from '../src/report/targets.ts';
import type { DashboardData, MethodData, ProcessData } from '../src/report/types.ts';
import { builtProject } from './fixtures/pipeline.ts';

const tmp = mkdtempSync(join(tmpdir(), 'obs report '));
after(() => rmSync(tmp, { recursive: true, force: true }));

let root = '';
let md = '';
let html = '';
before(() => {
  root = builtProject(tmp);
  md = readFileSync(join(root, 'out', 'report.md'), 'utf8');
  html = readFileSync(join(root, 'out', 'report.html'), 'utf8');
});

const MONEY = /-?\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g;
const HOURS = /(\d[\d,]*\.\d)(?=\s+hours?\b)/g;

// A17: on a redacted build (every data-text field replaced, so only code-written text is left),
// every dollar and hour figure either render shows is the text or the exact text of a Num in the
// data. The run's own formula strings, quoted as they are one level down, are taken out first.
test('A17: every money and hour figure in report.md and report.html is a figure of the data', () => {
  const { inputs, assets, shas } = loadInputs(root);
  const out = renderOutputs(inputs, assets, shas, { redact: true });
  const data = JSON.parse(out.files.get('dashboard/data.json') as string) as DashboardData;
  const shown = new Set<string>();
  const roots: unknown[] = [data, ...out.built.processes, out.built.method];
  for (const r of roots) for (const { num } of numsIn(r)) for (const s of [num.t, num.x]) if (s !== undefined) shown.add(s);
  // The typical reply wait is written by the formatter into the row as text (reply_gap.median_h).
  for (const r of data.rows) if (r.reply_gap !== null) shown.add(r.reply_gap.median_h);
  const formulas = out.built.processes.flatMap((p) => [p.formula.counted, p.formula.estimated, p.formula.total]).filter((x): x is string => x !== null);
  for (const name of ['report.md', 'report.html']) {
    let text = out.files.get(name) as string;
    for (const f of formulas) text = text.split(f).join(' ').split(escapeHtml(f)).join(' ');
    if (name === 'report.html') text = text.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ');
    const money = [...text.matchAll(MONEY)].map((m) => m[0]);
    const hours = [...text.matchAll(HOURS)].map((m) => m[1] as string);
    assert.ok(money.length > 20 && hours.length > 3, `${name}: ${money.length} money and ${hours.length} hour figures`);
    for (const m of money) assert.ok([...shown].some((s) => s === m || s.startsWith(`${m} `) || s.split(' to ').includes(m)), `${name}: ${m} is no figure of the data`);
    for (const x of hours) assert.ok(shown.has(x), `${name}: ${x} hours is no figure of the data`);
  }
});

test('A17: the eight sections in order, page one first and standing alone', () => {
  const heads = [...md.matchAll(/^(#{1,2}) (.+)$/gm)].map((m) => m[2] as string);
  assert.equal(heads[0], 'Recurring work in one mailbox');
  const order = ['Where the data comes from, and its limits', 'All 7 recurring processes, ranked', 'Rank 1: ', 'Why the rows below the line got no document', 'How the numbers are made', 'What was not counted', 'Run facts'];
  let at = 0;
  for (const want of order) {
    const i = heads.findIndex((h, j) => j >= at && h.startsWith(want));
    assert.ok(i >= at, `"${want}" after "${heads[at - 1] ?? ''}"`);
    at = i + 1;
  }
  // report.md: the first rule closes page one, after its footer line.
  const pageOne = md.slice(0, md.indexOf('\n---\n'));
  for (const piece of ['Where this comes from', 'What we found', 'Every process, ranked', 'Next steps', 'messages:', 'an hour. Counted means']) assert.ok(pageOne.includes(piece), piece);
  // report.html: page one is its own section, closed before the page break.
  const one = html.indexOf('<section class="page-one">');
  const close = html.indexOf('</section>', one);
  const pagebreak = html.indexOf('<div class="pagebreak"');
  assert.ok(one > 0 && close > one && pagebreak > close && html.indexOf('<h2>Where the data comes from') > pagebreak);
});

test('A17: report.md has no HTML tag and cites Git paths in backticks; the threshold sentence as data.json has it', () => {
  const outsideFences = md.replace(/^```[\s\S]*?^```$/gm, '');
  assert.doesNotMatch(outsideFences, /<\/?[A-Za-z][^>]*>/);
  const paths = [...md.matchAll(/corpus\/[^\s`)]+/g)];
  assert.ok(paths.length > 0);
  for (const m of paths) assert.equal(md[(m.index ?? 0) - 1], '`', `${m[0]} in backticks`);
  const data = JSON.parse(readFileSync(join(root, 'out', 'dashboard', 'data.json'), 'utf8')) as DashboardData;
  assert.ok(md.includes(data.sentences.threshold) && html.includes(escapeHtml(data.sentences.threshold)));
});

test('report.html: self-contained, the two fonts inlined, no script, no external URL', () => {
  assert.match(html, /^<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport"/);
  assert.match(html, /<title>Recurring work in one mailbox<\/title>/);
  assert.equal((html.match(/<style>/g) ?? []).length, 1);
  assert.equal((html.match(/@font-face \{ font-family: 'Archivo'; src: url\('data:font\/woff2;base64,/g) ?? []).length, 1);
  assert.equal((html.match(/@font-face \{ font-family: 'IBM Plex Mono'; src: url\('data:font\/woff2;base64,/g) ?? []).length, 1);
  assert.ok(html.includes('@page { size: letter; margin: 18mm; }') && html.includes('.page-one { break-after: page; }'));
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<link /);
});

test('the method words, the drafted documents and the formula strings reach the report', () => {
  const method = JSON.parse(readFileSync(join(root, 'out', 'dashboard', 'method.json'), 'utf8')) as MethodData;
  for (const w of [...method.words.rounding, ...method.words.tiers]) assert.ok(md.includes(escapeMd(w)), w);
  assert.ok(md.includes('Proposed once by the synthesizer agent (model `opus`, effort `medium`, set in its agent definition) from 3 to 12 cited quotes'));
  const p = JSON.parse(readFileSync(join(root, 'out', 'dashboard', 'process', 'alpha-work.json'), 'utf8')) as ProcessData;
  assert.ok(md.includes(p.formula.counted) && html.includes(escapeHtml(p.formula.counted)));
  assert.ok(md.includes('### The document: SOP') && html.includes('<div class="doc">'));
  assert.ok(md.includes('#### Owner'), 'the document’s headings moved under the report’s');
});

// ---- The escaping Markdown renderer and the escapers ----

test('renderMarkdownHtml: the grammar, everything escaped, placeholders marked', () => {
  const md2 = [
    '# Title dropped',
    '',
    '## Purpose',
    '',
    'A paragraph with **bold**, `code` and [a blank] and [ ] and a',
    'second line.',
    '',
    '### Sub',
    '',
    '- one',
    '- [ ] a checkbox item',
    '  > a quote under the item',
    '',
    '1. first',
    '2. second',
    '',
    '> quoted',
    '> twice',
    '',
    '```',
    'Subject: [subject]',
    '<b>raw</b>',
    '```',
    '',
    '| Field | Value |',
    '|---|---:|',
    '| a | [value] |',
  ].join('\n');
  const out = renderMarkdownHtml(md2, { base: 3, ids: new Set(['code']) });
  assert.ok(!out.includes('Title dropped'));
  assert.ok(out.includes('<h3>Purpose</h3>') && out.includes('<h4>Sub</h4>'));
  assert.ok(out.includes('<p>A paragraph with <strong>bold</strong>, <code class="msg">code</code> and <mark class="blank">[a blank]</mark> and [ ] and a second line.</p>'));
  assert.ok(out.includes('<li>[ ] a checkbox item<blockquote>a quote under the item</blockquote></li>'));
  assert.ok(out.includes('<ol><li>first</li><li>second</li></ol>'));
  assert.ok(out.includes('<blockquote>quoted<br>twice</blockquote>'));
  assert.ok(out.includes('<pre>Subject: <mark class="blank">[subject]</mark>\n&lt;b&gt;raw&lt;/b&gt;</pre>'));
  assert.ok(out.includes('<table><thead><tr><th scope="col">Field</th><th scope="col">Value</th></tr></thead><tbody><tr><td>a</td><td><mark class="blank">[value]</mark></td></tr></tbody></table>'));
});

test('renderMarkdownHtml: an <img onerror> and a javascript: link stay text', () => {
  const out = renderMarkdownHtml('Look <img src=x onerror=alert(1)> and [x](javascript:alert(2)) and <script>alert(3)</script>');
  assert.equal(out, '<p>Look &lt;img src=x onerror=alert(1)&gt; and <mark class="blank">[x]</mark>(javascript:alert(2)) and &lt;script&gt;alert(3)&lt;/script&gt;</p>');
  assert.doesNotMatch(out, /<img|<script|href=/);
});

test('blankItems: the bracketed placeholders before the Evidence footer, in order', () => {
  const doc = '# T\n\n## Owner\n\nOwner: [process owner to confirm].\n\n- [ ] Send it to [name or list]\n\n```\nDear [name],\n```\n\n## Evidence\n\n- [not counted]\n';
  assert.deepEqual(blankItems(doc), ['[process owner to confirm]', '[name or list]', '[name]']);
});

test('markdownForReport: the title dropped, headings moved down outside fences, tags written as text, an open fence made text', () => {
  assert.equal(markdownForReport('# T\n\n## Purpose\n\n<b>x</b>\n\n### Sub\n'), '#### Purpose\n\n&lt;b>x&lt;/b>\n\n##### Sub\n');
  assert.equal(markdownForReport('## A\n\n```\n<b>\n'), '#### A\n\n\\```\n&lt;b>\n');
  assert.equal(markdownForReport('## A\n\n```\n## not a heading\n<b>\n```\n'), '#### A\n\n```\n## not a heading\n<b>\n```\n');
});

test('the escapers', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeMd('a*b_c [d] #e >f |g `h` \\i'), 'a\\*b\\_c \\[d\\] \\#e \\>f \\|g \\`h\\` \\\\i');
  assert.equal(escapeMd('12. not a list'), '12\\. not a list');
  assert.equal(escapeMd('- not a list'), '\\- not a list');
  assert.equal(escapeMd('<script>'), '&lt;script\\>');
});


// ---- Data that could act in report.md (items 1 and 2 of the Task 1 review) ----

// The lines of report.md outside its fenced blocks, and whether every fence it opens closes.
function outsideFences(md: string): { lines: string[]; balanced: boolean } {
  const lines: string[] = [];
  let open: string | null = null;
  for (const line of md.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      const mark = fence[1] as string;
      if (open === null) open = mark;
      else if (mark[0] === open[0] && mark.length >= open.length && line.trim() === mark) open = null;
      continue;
    }
    if (open === null) lines.push(line);
  }
  return { lines, balanced: open === null };
}

// Nothing in these lines can act: no HTML tag or autolink, no link or image, no reference
// definition, no setext underline under a line of text.
function assertInert(md: string, where: string): void {
  const { lines, balanced } = outsideFences(md);
  assert.ok(balanced, `${where}: a fence is left open`);
  lines.forEach((line, i) => {
    assert.doesNotMatch(line, /<[A-Za-z!/?]/, `${where}: HTML in "${line}"`);
    assert.doesNotMatch(line, /(?<!\\)\]\(/, `${where}: a link in "${line}"`);
    assert.doesNotMatch(line, /(?<!\\)!\[/, `${where}: an image in "${line}"`);
    assert.doesNotMatch(line, /^ {0,3}(?:>\s*)*\[[^\]]*\]:/, `${where}: a reference definition in "${line}"`);
    if (/^ {0,3}(?:=+|-+)\s*$/.test(line)) assert.equal((lines[i - 1] ?? '').trim(), '', `${where}: "${line}" underlines "${lines[i - 1]}" as a heading`);
  });
}

test('inertMarkdown: structure kept, links, images, references, HTML and open fences made text; idempotent', () => {
  const md = [
    '## Steps',
    '',
    '1. Open [the sheet](javascript:alert(1)) and ![x](http://example.invalid/i.png) for [owner to confirm].',
    '[r]: http://example.invalid',
    '<script>alert(1)</script> and <http://example.invalid>',
    '',
    '```',
    'Dear [name], <b>kept as code</b>',
    '```',
    '',
    '- `corpus/a/b/1.` (from Ann):',
    '',
    '  > A quote with ![img](http://example.invalid/q.png)',
    '  > [q]: http://example.invalid',
    '  > ~~~',
    '  > ---',
    '',
    '~~~',
    'never closed',
  ].join('\n');
  const out = inertMarkdown(md);
  assert.equal(inertMarkdown(out), out, 'a second pass changes nothing');
  assert.ok(out.includes('## Steps') && out.includes('1. Open [the sheet]\\(javascript:alert(1)) and !\\[x]\\(http://example.invalid/i.png) for [owner to confirm].'));
  assert.ok(out.includes('\n\\[r]: http://example.invalid\n'));
  assert.ok(out.includes('&lt;script>alert(1)&lt;/script> and &lt;http://example.invalid>'));
  assert.ok(out.includes('```\nDear [name], <b>kept as code</b>\n```'), 'a closed fence is kept whole');
  assert.ok(out.includes('  > A quote with !\\[img]\\(http://example.invalid/q.png)\n  > \\[q]: http://example.invalid\n  > \\~~~\n  > \\---'));
  assert.ok(out.includes('\n\\~~~\nnever closed'));
  assertInert(out, 'inertMarkdown');
  // The report's HTML reads the escapes as text: no doubled backslash, no entity shown.
  const html = renderMarkdownHtml(out);
  assert.ok(html.includes('[the sheet]</mark>(javascript:alert(1))') && !html.includes('\\(') && !html.includes('href'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !html.includes('&amp;lt;'));
});

test('item 1: an image, a javascript: link, a reference definition and a bare ~~~ in a quote and in a document stay text in report.md', () => {
  const { inputs, assets, shas } = loadInputs(root);
  const x = structuredClone(inputs);
  const hostileQuote = 'See ![pixel](http://example.invalid/p.png) and [click](javascript:alert(1))\n[ref]: http://example.invalid\n~~~\nthe rest';
  for (const v of x.validated) for (const e of v.evidence) e.raw_text = hostileQuote;
  const art = x.artifacts.artifacts.find((a) => a.status === 'done');
  assert.ok(art !== undefined && art.path !== null);
  const texts = new Map(x.artifactText);
  texts.set(art.path, `# T: SOP\n\n## Purpose\n\n${hostileQuote}\n\n## Evidence\n\n- \`corpus/m5/inbox/01\` (2001-01-15, from Ann Lee):\n\n  > ${hostileQuote.split('\n').join('\n  > ')}\n`);
  const md = renderOutputs({ ...x, artifactText: texts }, assets, shas).files.get('report.md') as string;
  assert.ok(md.includes('pixel') && md.includes('javascript:alert(1)'), 'the hostile text is there, as text');
  assertInert(md, 'report.md');
});

test('item 2: every data-text field as a hostile multi-line token: report.md opens no fence, setext heading, link or HTML', () => {
  const { inputs, assets, shas } = loadInputs(root);
  const token = ['x', '```', '<b>bold</b> <http://example.invalid>', '===', '[a](javascript:1) ![i](http://example.invalid/i.png)', '[r]: http://example.invalid', '~~~', '1) one', '- two', '# h', '&amp; &lt;', '---'].join('\n');
  const out = renderOutputs(inputs, assets, shas, { redact: true, token });
  const md = out.files.get('report.md') as string;
  assert.ok(md.includes('javascript:1'), 'the token reached the report');
  assertInert(md, 'report.md');
  const html = out.files.get('report.html') as string;
  assert.doesNotMatch(html.replace(/<style>[\s\S]*?<\/style>/, ''), /<b>bold|<http|href=|<img/);
});
