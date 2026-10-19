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

test('blankItems: the decisions before the Evidence footer, in order; per-use blanks are not counted', () => {
  const doc =
    '# T\n\n## Owner\n\nOwner: [process owner to confirm].\n\n- [ ] Send it to [name or list] [proposed: same day]\n\n' +
    'Call on the hour [Confirm still in force].\n\n```\nDear [name],\n```\n\n## Evidence\n\n- [proposed: not counted]\n';
  assert.deepEqual(blankItems(doc), ['[process owner to confirm]', '[proposed: same day]', '[Confirm still in force]']);
  // A field that only mentions the word is a blank, not a decision.
  assert.deepEqual(blankItems('Sent to [confirmation recipient] on [proposal date].\n'), []);
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


// ---- Data that could act in report.md (items 1 and 2 of both Task 1 reviews) ----

// Whether the character at `at` is escaped: an odd run of backslashes right before it.
function escapedAt(line: string, at: number): boolean {
  let n = 0;
  for (let k = at - 1; k >= 0 && line[k] === '\\'; k--) n++;
  return n % 2 === 1;
}

// Whether a line holds `pair` live: its first character unescaped and the second right after it.
function live(line: string, pair: string): boolean {
  for (let at = line.indexOf(pair); at !== -1; at = line.indexOf(pair, at + 1)) if (!escapedAt(line, at)) return true;
  return false;
}

// What can stand in front of a line's text in Markdown: blanks, quote markers and list markers.
const CONTAINER_LEAD = /^(?:[ \t]|>|[-+*](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))*/;

// Nothing in a Markdown text can act, read block by block the way a CommonMark reader would: a
// fence at the margin opens a code block, which must close (at the same character, at least as
// many, indented at most three, nothing after); outside a block no fence stands after blanks, a list
// marker or a quote marker (it would open a block inside a list item or a quote, which the next
// line at the margin ends, leaving a fence open below it); and no line holds a live "](" (a link),
// "![" (an image) or "]:" (a reference definition, whatever its label looks like, wherever the line
// starts), an HTML tag or autolink, or a run of = or - under a line of text (a setext heading),
// containers stripped.
function assertInert(md: string, where: string): void {
  let open: string | null = null;
  let previous = '';
  for (const line of md.split('\n')) {
    if (open !== null) {
      const t = line.replace(/^ {0,3}/, '').replace(/[ \t]+$/, '');
      if (t.length >= open.length && [...t].every((c) => c === open?.[0])) open = null;
      previous = '';
      continue;
    }
    const lead = (CONTAINER_LEAD.exec(line) as RegExpExecArray)[0];
    const fence = /^(`{3,}|~{3,})([\s\S]*)$/.exec(line.slice(lead.length));
    if (fence !== null && !((fence[1] as string)[0] === '`' && (fence[2] as string).includes('`'))) {
      assert.equal(lead, '', `${where}: a fence opens inside a list item or a quote, or after blanks: "${line}"`);
      open = fence[1] as string;
      continue;
    }
    assert.doesNotMatch(line, /<[A-Za-z!/?]/, `${where}: HTML in "${line}"`);
    assert.ok(!live(line, ']('), `${where}: a link in "${line}"`);
    assert.ok(!live(line, '!['), `${where}: an image in "${line}"`);
    assert.ok(!live(line, ']:'), `${where}: a reference definition in "${line}"`);
    const rest = line.replace(/^(?:[ \t]*>)*[ \t]*/, '');
    if (/^(?:=+|-+)[ \t]*$/.test(rest)) assert.equal(previous.trim(), '', `${where}: "${line}" underlines "${previous}" as a heading`);
    previous = rest;
  }
  assert.equal(open, null, `${where}: a fence is left open`);
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
  // The whole text, line by line: the heading, the numbered step, the quote and the list item read
  // as before; every link, image, reference definition, tag and autolink is text; the closed block
  // is kept whole; the fence and the underline in the quote and the fence that never closes are text.
  assert.equal(
    out,
    [
      '## Steps',
      '',
      '1. Open [the sheet]\\(javascript:alert(1)) and !\\[x]\\(http://example.invalid/i.png) for [owner to confirm].',
      '[r]\\: http://example.invalid',
      '&lt;script>alert(1)&lt;/script> and &lt;http://example.invalid>',
      '',
      '```',
      'Dear [name], <b>kept as code</b>',
      '```',
      '',
      '- `corpus/a/b/1.` (from Ann):',
      '',
      '  > A quote with !\\[img]\\(http://example.invalid/q.png)',
      '  > [q]\\: http://example.invalid',
      '  > \\~~~',
      '  > \\---',
      '',
      '\\~~~',
      'never closed',
    ].join('\n'),
  );
  assert.equal(inertMarkdown(out), out, 'a second pass changes nothing');
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

// ---- The second review: reference definitions in any container, fences in list items, U+2028 ----

// Each input and the whole text inertMarkdown makes of it. Read by CommonMark, every output is the
// same blocks as its input with the link machinery as text: a list item, a quote or a paragraph
// holding "[label]: url" as words, and no fenced block opening where the next line at the margin
// would leave it open over the rest of the document.
const SECOND_REVIEW: ReadonlyArray<[string, string, string]> = [
  ['a definition behind a bullet', '- [Owner]: http://evil.example', '- [Owner]\\: http://evil.example'],
  ['behind a number', '1. [x]: u', '1. [x]\\: u'],
  ['behind a quote and a bullet', '> - [x]: u', '> - [x]\\: u'],
  [
    'in an Evidence footer quote, also behind a bullet or a number',
    '- `corpus/m5/inbox/01` (2001-01-15, from Ann Lee):\n\n  > [Owner]: http://evil.example\n  > - [x]: u\n  > 1. [y]: u',
    '- `corpus/m5/inbox/01` (2001-01-15, from Ann Lee):\n\n  > [Owner]\\: http://evil.example\n  > - [x]\\: u\n  > 1. [y]\\: u',
  ],
  ['with an escaped bracket in its label', '[a\\]b]: http://evil.example', '[a\\]b]\\: http://evil.example'],
  ['with its label over two lines', '[foo\nbar]: http://evil.example', '[foo\nbar]\\: http://evil.example'],
  ['a footnote definition', '[^1]: http://evil.example', '[^1]\\: http://evil.example'],
  ['a fence in a list item, then one at the margin', '- item\n  ```\n```\n\n## After', '- item\n  \\```\n\\```\n\n## After'],
  ['a fenced block in a numbered step', '1. step\n   ~~~\n   code\n   ~~~', '1. step\n   \\~~~\n   code\n   \\~~~'],
  ['fences in quoted mail', '> ```js\n> code\n> ```', '> \\```js\n> code\n> \\```'],
  ['fences as list items', '- ```\n- code\n- ```', '- \\```\n- code\n- \\```'],
  ['a fenced block indented at the margin', '  ```\n  code\n  ```', '  \\```\n  code\n  \\```'],
  ['a tab before a fence', '\t```\ncode', '\t\\```\ncode'],
  ['a block at the margin with a fence-like line inside and an indented closer, kept whole', '```\n```js\n<b>code</b>\n   ```', '```\n```js\n<b>code</b>\n   ```'],
  ['a block whose only closer is indented four, never closed', '```\ncode\n    ```', '\\```\ncode\n    \\```'],
  ["a backtick in a backtick fence's info: no fence, left as it is", '```a`b', '```a`b'],
];

test('inertMarkdown (second review): a reference definition in a list item or a quote, with an escaped or a broken label; a fence in a list item, a quote or after blanks', () => {
  for (const [name, input, expected] of SECOND_REVIEW) {
    const out = inertMarkdown(input);
    assert.equal(out, expected, name);
    assert.equal(inertMarkdown(out), out, `${name}: a second pass changes nothing`);
    assertInert(out, name);
  }
});

test('second review: the same cases in a drafted document and in email quotes stay text in report.md, and no fence is left open', () => {
  const { inputs, assets, shas } = loadInputs(root);
  const x = structuredClone(inputs);
  for (const v of x.validated) for (const e of v.evidence) e.raw_text = SECOND_REVIEW.map(([, input]) => input).join('\n');
  const art = x.artifacts.artifacts.find((a) => a.status === 'done');
  assert.ok(art !== undefined && art.path !== null);
  const texts = new Map(x.artifactText);
  const body = SECOND_REVIEW.map(([, input]) => input).join('\n\n');
  texts.set(art.path, `# T: SOP\n\n## Purpose\n\n${body}\n\n## Evidence\n\n- \`corpus/m5/inbox/01\` (2001-01-15, from Ann Lee):\n\n  > ${body.split('\n').join('\n  > ')}\n`);
  const md = renderOutputs({ ...x, artifactText: texts }, assets, shas).files.get('report.md') as string;
  assert.ok(md.includes('- [Owner]\\: http://evil.example') && md.includes('[foo\nbar]\\: http://evil.example'), 'the document is there, as text');
  assertInert(md, 'report.md');
});

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

test('U+2028 and U+2029 are ordinary characters to inertMarkdown, markdownForReport and renderMarkdownHtml', () => {
  for (const sep of [LINE_SEPARATOR, PARAGRAPH_SEPARATOR]) {
    const md = [`# Title${sep}x`, '', `## Head${sep}ing`, '', `Text${sep}more [x](u)`, '', `> quote${sep}line ![i](u)`, '', `- item${sep}[y]: u`, '', `\`\`\`${sep}`, 'code', '```'].join('\n');
    const inert = [`## Head${sep}ing`, '', `Text${sep}more [x]\\(u)`, '', `> quote${sep}line !\\[i]\\(u)`, '', `- item${sep}[y]\\: u`, '', `\`\`\`${sep}`, 'code', '```'];
    const out = inertMarkdown(md);
    assert.equal(out, [`# Title${sep}x`, '', ...inert].join('\n'));
    assert.equal(inertMarkdown(out), out);
    assert.equal(markdownForReport(md), [`#### Head${sep}ing`, ...inert.slice(1)].join('\n'));
    const html = renderMarkdownHtml(md, { base: 3 });
    assert.ok(html.includes(`<h3>Head${sep}ing</h3>`), html);
    assert.ok(html.includes(`<blockquote>quote${sep}line !<mark class="blank">[i]</mark>(u)</blockquote>`), html);
    assert.ok(html.includes(`<li>item${sep}<mark class="blank">[y]</mark>: u</li>`), html);
    assert.ok(html.includes('<pre>code</pre>'), html);
  }
});

test('U+2028 and U+2029 in a drafted document and in an email quote: report.md and report.html build with them as text', () => {
  const { inputs, assets, shas } = loadInputs(root);
  for (const sep of [LINE_SEPARATOR, PARAGRAPH_SEPARATOR]) {
    const x = structuredClone(inputs);
    const quote = `First line${sep}second [r]: http://example.invalid`;
    for (const v of x.validated) for (const e of v.evidence) e.raw_text = quote;
    const art = x.artifacts.artifacts.find((a) => a.status === 'done');
    assert.ok(art !== undefined && art.path !== null);
    const texts = new Map(x.artifactText);
    texts.set(art.path, `# T: SOP\n\n## Purpose${sep}now\n\nA body${sep}line.\n\n## Evidence\n\n- \`corpus/m5/inbox/01\` (2001-01-15, from Ann Lee):\n\n  > ${quote}\n`);
    const out = renderOutputs({ ...x, artifactText: texts }, assets, shas);
    const md = out.files.get('report.md') as string;
    const html = out.files.get('report.html') as string;
    assert.ok(md.includes(`#### Purpose${sep}now\n\nA body${sep}line.`) && md.includes(`  > First line${sep}second [r]\\: http://example.invalid`), 'the document');
    assert.ok(md.includes(`> First line${sep}second \\[r\\]: http://example.invalid`), 'the email quote');
    assertInert(md, 'report.md');
    assert.ok(html.includes(`A body${sep}line.`) && html.includes(`First line${sep}second [r]: http://example.invalid`));
  }
});
