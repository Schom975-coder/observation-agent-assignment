// The dashboard's own files (dashboard/): static checks of the front-end rules (ARCHITECTURE.md
// 6.13: nothing leaves the origin, no HTML built from strings, no inline script or style, fonts from
// fonts/) and unit tests of viewer.js, imported in Node and run against a small DOM shim
// (tests/fixtures/dom.ts): the quote marked at its stored offsets, "no usable date", the flag note,
// the lazy render of a long message, the lookup hints, and the drafted-document renderer, which must
// follow the report's grammar (src/report/markdown.ts) node for node. Checks on the page files that
// arrive with the pages (index.html, app.js, styles.css) skip with a reason while they are absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderMarkdownHtml } from '../src/report/markdown.ts';
import { inertMarkdown } from '../src/report/text.ts';
import { ShimDocument, ShimElement, byText, serialize, type ShimNode } from './fixtures/dom.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dash = join(repo, 'dashboard');
const has = (f: string): boolean => existsSync(join(dash, ...f.split('/')));
const read = (f: string): string => readFileSync(join(dash, ...f.split('/')), 'utf8');
const PAGE_FILES = ['index.html', 'app.js', 'styles.css'];
const SCRIPTS = ['app.js', 'viewer.js'];

// ---- The viewer module, as app.js imports it ----

type IndexRow = {
  id: string;
  mailbox: string;
  folder: string;
  date_utc: string | null;
  date_status: string;
  from: string;
  from_name: string | null;
  subject: string;
  recipients: number;
  thread_id: string | null;
  occurrence_id: string | null;
  duplicate_of: string | null;
  role: string | null;
  processes: string[];
  flags: string[];
};
type Quote = { id: string; kind: string; message_id: string; start: number; end: number; raw_text: string; match: string; segment: string | null; field: string; sender: string; sender_label: string; date_utc: string | null };
type Api = {
  fetchMessage: (id: string) => Promise<{ id: string; size: number; blob_sha: string; text: string; source: string }>;
  index?: Map<string, IndexRow> | IndexRow[] | (() => Map<string, IndexRow> | IndexRow[] | Promise<Map<string, IndexRow> | IndexRow[]>);
  rates?: { minutes: Record<string, number>; automatable_pct: Record<string, number> };
  processName?: (key: string) => string | undefined;
  mailboxOwner?: (key: string) => string | undefined;
  open?: (id: string) => void;
};
type Viewer = {
  useDocument: (d: unknown) => void;
  el: (tag: string, props?: Record<string, unknown> | null, ...kids: unknown[]) => ShimElement;
  pathLine: (id: string) => ShimElement;
  copyButton: (text: string, label: string, target?: unknown) => ShimElement;
  splitForMark: (text: string, start: number, end: number) => { before: string; mark: string; after: string } | null;
  needsLoadAll: (text: string) => boolean;
  lazyCut: (text: string, minEnd?: number) => number;
  LAZY: { chars: number; lines: number };
  messageView: (host: ShimElement, api: Api, opts: { id: string; quote?: Quote | null; action?: string | null; counted_in?: { process?: string; by?: string } | null; titleId?: string }) => Promise<void>;
  lookupForm: (api: Api, opts?: { prefill?: string; host?: ShimElement | null }) => ShimElement;
  renderMarkdown: (md: string, hooks?: { ids?: { has: (id: string) => boolean }; onMessageId?: (id: string) => void; base?: number }) => ShimNode[];
};

// A dynamic import: the module is plain JavaScript outside the TypeScript project. Importing it at
// all proves its top level touches no DOM.
const viewer = (await import(pathToFileURL(join(dash, 'viewer.js')).href)) as Viewer;
const document = new ShimDocument();
viewer.useDocument(document);

const ID = 'corpus/giron-d/inbox/12.';
const row = (over: Partial<IndexRow> = {}): IndexRow => ({
  id: ID,
  mailbox: 'giron-d',
  folder: 'inbox',
  date_utc: '2001-06-12T17:59:00Z',
  date_status: 'usable',
  from: 'darron.c.giron@enron.com',
  from_name: 'Giron, Darron C',
  subject: 'June settlement',
  recipients: 2,
  thread_id: 't-1',
  occurrence_id: null,
  duplicate_of: null,
  role: 'request',
  processes: ['power-settlement'],
  flags: [],
  ...over,
});
// Headers in CRLF, a body in LF with quoted-printable residue, and the quoted words twice: the
// viewer must mark the second (the stored offsets), never search for the first.
const TEXT =
  'Message-ID: <12.giron@example.invalid>\r\nDate: Tue, 12 Jun 2001 10:59:00 -0700\r\nFrom: Darron C Giron <darron.c.giron@enron.com>\r\nSubject: June settlement\r\n\r\n' +
  'Please confirm the June volumes.\n\n> Please confirm the June volumes by Friday so we can close the=\n month.\n';
const QUOTED = 'Please confirm the June volumes';
const quoteAt = (text: string, start: number, over: Partial<Quote> = {}): Quote => ({
  id: 'batch-001:e1',
  kind: 'evidence',
  message_id: ID,
  start,
  end: start + QUOTED.length,
  raw_text: text.slice(start, start + QUOTED.length),
  match: 'exact',
  segment: 'quoted',
  field: 'body',
  sender: 'darron.c.giron@enron.com',
  sender_label: 'Darron C Giron',
  date_utc: '2001-06-12T17:59:00Z',
  ...over,
});
const RATES = { minutes: { chaser: 3, read: 1, forward: 2, authored_short: 2 }, automatable_pct: { chaser: 100, read: 50, forward: 80, authored_short: 60 } };

function apiFor(rows: IndexRow[], texts: Record<string, string>, extra: Partial<Api> = {}): Api & { fetched: string[]; opened: string[] } {
  const fetched: string[] = [];
  const opened: string[] = [];
  return {
    fetched,
    opened,
    fetchMessage: async (id) => {
      fetched.push(id);
      const text = texts[id];
      if (text === undefined) throw new Error('no message with this id');
      return { id, size: Buffer.byteLength(text), blob_sha: 'b'.repeat(40), text, source: 'git' };
    },
    index: new Map(rows.map((r) => [r.id, r])),
    rates: RATES,
    processName: (k) => ({ 'power-settlement': 'Power deal settlement and disputes' })[k],
    mailboxOwner: (k) => ({ 'giron-d': 'Darron Giron' })[k],
    open: (id) => void opened.push(id),
    ...extra,
  };
}

const host = (): ShimElement => document.createElement('div');
const meta = (h: ShimElement, label: string): string | undefined => byText(h, 'p', new RegExp(`^${label}: `))?.textContent;

// ---- Static checks ----

// Every text file under dashboard/, by path, except the vendored fonts and their licence and
// sources files (they name their download and licence URLs).
const EXEMPT = new Set(['fonts/LICENSE-Archivo.txt', 'fonts/LICENSE-IBMPlexMono.txt', 'fonts/SOURCES.md']);
function dashboardTextFiles(): string[] {
  return (readdirSync(dash, { recursive: true, encoding: 'utf8' }) as string[])
    .map((p) => p.replaceAll('\\', '/'))
    .filter((p) => statSync(join(dash, p)).isFile() && !p.endsWith('.woff2') && !EXEMPT.has(p))
    .sort();
}

test('A2: no URL in the dashboard files leaves the origin (the font licences and sources exempt by name)', () => {
  const files = dashboardTextFiles();
  assert.ok(files.includes('viewer.js') && files.includes('report.css'), files.join(', '));
  const hits: string[] = [];
  for (const f of files) {
    read(f)
      .split('\n')
      .forEach((line, i) => {
        // The SVG namespace names a vocabulary for createElementNS; nothing fetches it.
        const scrubbed = f.endsWith('.js') ? line.replace(/(['"`])http:\/\/www\.w3\.org\/2000\/svg\1/g, "''") : line;
        if (/[A-Za-z][A-Za-z0-9+.-]*:\/\/|(?:["'(=]|url\()\s*\/\/[^/\s]/.test(scrubbed)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(hits, []);
});

test('the scripts build no markup from strings and run no string as code', () => {
  const present = SCRIPTS.filter(has);
  assert.ok(present.includes('viewer.js'));
  const banned = /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\b|DOMParser|createContextualFragment|setAttribute\(\s*['"](?:style|on)|\.cssText\b/;
  for (const f of present) {
    read(f)
      .split('\n')
      .forEach((line, i) => assert.doesNotMatch(line, banned, `${f}:${i + 1}`));
  }
});

test('the scripts are type-checkable ES modules', () => {
  for (const f of SCRIPTS.filter(has)) assert.match(read(f), /^\/\/ @ts-check\r?\n/, `${f} starts with // @ts-check`);
  const v = read('viewer.js');
  for (const name of ['el', 'messageView', 'renderMarkdown', 'splitForMark', 'needsLoadAll', 'lookupForm', 'pathLine', 'fetchMessage']) {
    assert.match(v, new RegExp(`^export (?:async )?function ${name}\\(`, 'm'), name);
  }
});

test('viewer.js reads the document only inside its functions', () => {
  viewer.useDocument(null);
  try {
    assert.throws(() => viewer.el('p'), /no document/);
  } finally {
    viewer.useDocument(document);
  }
});

test('the page files arrive together', (t) => {
  const present = PAGE_FILES.filter(has);
  if (present.length === 0) {
    t.skip('index.html, app.js and styles.css arrive with the pages');
    return;
  }
  assert.deepEqual(present, PAGE_FILES);
});

test('index.html: no inline script or style, no handler attribute, every script a local module', (t) => {
  if (!has('index.html')) {
    t.skip('index.html arrives with the pages');
    return;
  }
  const html = read('index.html');
  assert.doesNotMatch(html, /<style\b/i, 'no <style> element');
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'no style attribute');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no handler attribute');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, 'the page loads its script');
  for (const [, attrs = '', body = ''] of scripts) {
    assert.equal(body.trim(), '', 'no inline script');
    assert.match(attrs, /\btype\s*=\s*["']module["']/, 'a module');
    assert.match(attrs, /\bsrc\s*=\s*["'](?!\/\/|[a-z]+:)[^"']+["']/i, 'a local src');
  }
});

test('A2: the fonts load from fonts/', (t) => {
  if (!has('styles.css')) {
    t.skip('styles.css arrives with the pages');
    return;
  }
  const urls = [...read('styles.css').matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1] as string);
  assert.ok(urls.length >= 3, 'the three faces');
  for (const u of urls) {
    assert.match(u, /^fonts\/[a-z0-9-]+\.woff2$/, u);
    assert.ok(has(u), `${u} is vendored`);
  }
});

// ---- el() and the path line ----

test('el(): strings stay text; style through the CSSOM; no handler string, style string or script URL', () => {
  const p = viewer.el('p', { class: 'x', title: '"<q>"' }, '<b>bold</b>', 3, null, false, ['a', ['b']]);
  assert.equal(serialize(p), '<p class="x" title="&quot;&lt;q&gt;&quot;">&lt;b&gt;bold&lt;/b&gt;3ab</p>');
  assert.ok(p.childNodes.every((c) => c.childNodes.length === 0), 'no element was made from the string');
  const d = viewer.el('div', { style: { width: '12px', '--step': '3' } });
  assert.equal(d.getAttribute('style'), null, 'no style attribute');
  assert.equal(d.style.getPropertyValue('width'), '12px');
  assert.equal(d.style.getPropertyValue('--step'), '3');
  assert.throws(() => viewer.el('div', { style: 'color: red' }), /CSSOM/);
  assert.throws(() => viewer.el('button', { onclick: 'alert(1)' }), /function/);
  assert.throws(() => viewer.el('a', { href: ' JavaScript:alert(1)' }), /script or data URL/);
  assert.throws(() => viewer.el('img', { src: 'data:image/png;base64,AA' }), /script or data URL/);
  // As a browser reads a scheme: control characters and spaces dropped.
  for (const bad of ['java\tscript:alert(1)', '\u0001javascript:alert(1)', ' \n javascript:alert(1)', 'jav\u0000ascript:x', 'java\rscript:x', 'VBScript:x', 'da\nta:text/html,x', '\u0085javascript:x']) {
    assert.throws(() => viewer.el('a', { href: bad }), /script or data URL/, JSON.stringify(bad));
  }
  assert.equal(viewer.el('a', { href: '#top' }).getAttribute('href'), '#top');
  let clicks = 0;
  const b = viewer.el('button', { onclick: () => clicks++ }, 'Go');
  assert.equal(b.getAttribute('onclick'), null);
  b.click();
  assert.equal(clicks, 1);
});

test('A11: the path line shows the id in <code>, trailing dot included, with a copy button', () => {
  const line = viewer.pathLine(ID);
  assert.ok(line.matches('span.path'));
  const code = line.querySelector('code');
  assert.equal(code?.textContent, ID);
  const copy = line.querySelector('button.copy');
  assert.equal(copy?.textContent, 'Copy');
  assert.equal(copy?.getAttribute('aria-label'), `Copy: ${ID}`);
});

test('a copy button shows its own label again, even after a second click while it still says it copied', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Without a clipboard (Node has none): the target is selected and the button says so.
  const b = viewer.copyButton(ID, 'Copy message ID');
  b.click();
  assert.match(b.textContent, /^Selected: press Ctrl\+C/);
  t.mock.timers.tick(1000);
  b.click();
  t.mock.timers.tick(1500);
  assert.match(b.textContent, /^Selected/, 'the first reset was replaced by the second');
  t.mock.timers.tick(1000);
  assert.equal(b.textContent, 'Copy message ID');
  // With a clipboard: "Copied", twice within the reset time, then the label.
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  Object.defineProperty(nav, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
  try {
    const c = viewer.copyButton(ID, 'Copy');
    const settle = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    c.click();
    await settle();
    assert.equal(c.textContent, 'Copied');
    assert.ok(c.classList.contains('is-done'));
    t.mock.timers.tick(500);
    c.click();
    await settle();
    assert.equal(c.textContent, 'Copied');
    t.mock.timers.tick(1400);
    assert.equal(c.textContent, 'Copy', 'the label, not "Copied"');
    assert.ok(!c.classList.contains('is-done'));
  } finally {
    delete nav.clipboard;
  }
});

// ---- The raw text: the mark and the lazy render ----

test('A12: splitForMark marks text.slice(start, end) at the stored offsets and never searches', () => {
  const second = TEXT.lastIndexOf(QUOTED);
  assert.ok(second > TEXT.indexOf(QUOTED), 'the quoted words appear twice');
  const s = viewer.splitForMark(TEXT, second, second + QUOTED.length);
  assert.deepEqual(s, { before: TEXT.slice(0, second), mark: QUOTED, after: TEXT.slice(second + QUOTED.length) });
  for (const [a, b] of [[-1, 3], [5, 5], [6, 5], [0, TEXT.length + 1], [1.5, 4]] as const) assert.equal(viewer.splitForMark(TEXT, a, b), null, `${a}..${b}`);
});

test('A12: a message over 32,000 characters shows its first 1,200 lines, or through the quoted line', () => {
  assert.equal(viewer.LAZY.chars, 32000);
  assert.equal(viewer.LAZY.lines, 1200);
  assert.equal(viewer.needsLoadAll('x'.repeat(32000)), false);
  assert.equal(viewer.needsLoadAll('x'.repeat(32001)), true);
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${String(i + 1).padStart(5, '0')} of the long message`);
  const long = `${lines.join('\r\n')}\r\n`;
  const after1200 = lines.slice(0, 1200).join('\r\n').length + 2;
  assert.equal(viewer.lazyCut(long), after1200);
  assert.equal(viewer.lazyCut(TEXT), TEXT.length, 'a short message in one part');
  const inLine2000 = long.indexOf('line 02000');
  assert.equal(viewer.lazyCut(long, inLine2000 + 5), long.indexOf('\n', inLine2000) + 1, 'through the line holding the quote');
  assert.equal(viewer.lazyCut('y'.repeat(40000)), 40000, 'no line breaks: all of it');
});

// ---- The viewer ----

test('A12: the viewer shows the raw text as the file holds it, the quote marked at its offsets', async () => {
  const h = host();
  h.connected = true;
  const start = TEXT.lastIndexOf(QUOTED);
  const api = apiFor([row()], { [ID]: TEXT });
  await viewer.messageView(h, api, { id: ID, quote: quoteAt(TEXT, start) });
  assert.equal(h.querySelector('h2#drawer-title')?.textContent, ID);
  assert.equal(h.querySelector('pre.cmd')?.textContent, `git show HEAD:"${ID}"`);
  assert.ok(byText(h, 'button.copy', 'Copy message ID') && byText(h, 'button.copy', 'Copy the git show command'));
  const pre = h.querySelector('pre.raw') as ShimElement;
  assert.equal(pre.textContent, TEXT, 'headers and body, CRLF and the = soft break kept');
  const mark = pre.querySelector('mark') as ShimElement;
  assert.equal(mark.textContent, QUOTED);
  assert.equal((pre.childNodes[0] as ShimNode).textContent, TEXT.slice(0, start), 'the second copy is marked, not the first');
  assert.equal(mark.scrolledIntoView, 1);
  assert.equal(meta(h, 'Quote'), `Quote: exact match, characters ${start + 1} to ${start + QUOTED.length} of the file, inside quoted text`);
  assert.equal(meta(h, 'Mailbox'), 'Mailbox: Darron Giron · inbox');
  assert.equal(meta(h, 'Date'), 'Date: 12 Jun 2001, 17:59 UTC');
  assert.equal(meta(h, 'From'), 'From: Darron C Giron');
  assert.equal(meta(h, 'Read by the run as'), 'Read by the run as: a request');
  assert.equal(meta(h, 'Counted under'), 'Counted under: Power deal settlement and disputes');
  assert.ok(byText(h, 'p', 'Look up another message') && h.querySelector('form.lookup'));
  assert.deepEqual(api.fetched, [ID]);
});

test('A12: "no usable date", the flag note with the text still shown, and "Counted here as"', async () => {
  const h = host();
  const flagged = row({ date_status: 'unparseable', date_utc: null, flags: ['flagged'], role: 'injection_attempt', processes: [] });
  await viewer.messageView(h, apiFor([flagged], { [ID]: TEXT }), { id: ID });
  assert.equal(meta(h, 'Date'), 'Date: no usable date');
  assert.equal(
    h.querySelector('p.flag')?.textContent,
    'Flagged: this message is addressed to an automated reviewer. It is excluded from every count and its instructions were not followed. The text below is shown as data.',
  );
  assert.equal(h.querySelector('pre.raw')?.textContent, TEXT);
  assert.equal(meta(h, 'Counted under'), undefined, 'a flagged message is counted nowhere');

  const c = host();
  await viewer.messageView(c, apiFor([row()], { [ID]: TEXT }), { id: ID, action: 'chaser', counted_in: { process: 'Power deal settlement and disputes' } });
  assert.equal(meta(c, 'Counted here as'), 'Counted here as: a chaser (3 minutes, 100% automatable), by Darron C Giron, in Power deal settlement and disputes.');
  const r = host();
  await viewer.messageView(r, apiFor([row()], { [ID]: TEXT }), { id: ID, action: 'read', counted_in: { process: 'Power deal settlement and disputes' } });
  assert.equal(meta(r, 'Counted here as'), 'Counted here as: reads by its staff addressees (1 minute each, 50% automatable), in Power deal settlement and disputes.');
  const u = host();
  await viewer.messageView(u, apiFor([row({ processes: [], role: 'fyi' })], { [ID]: TEXT }), { id: ID });
  assert.equal(meta(u, 'Counted under'), 'Counted under: no recurring process');
});

test('A12: a long message loads in two parts, and a quote past the first part is still marked', async () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${String(i + 1).padStart(5, '0')} of the long message`);
  const long = `${lines.join('\r\n')}\r\n`;
  const h = host();
  await viewer.messageView(h, apiFor([row()], { [ID]: long }), { id: ID });
  const pre = h.querySelector('pre.raw') as ShimElement;
  assert.equal(pre.textContent, long.slice(0, viewer.lazyCut(long)));
  assert.equal(byText(h, 'p.more', /^Showing the first 1,200 lines of 3,001\. /)?.tagName, 'P');
  const button = byText(h, 'button', 'Load all') as ShimElement;
  button.click();
  assert.equal(pre.textContent, long, 'all of it after Load all');
  assert.equal(h.querySelector('p.more'), null);

  const q = host();
  const at = long.indexOf('line 02500');
  const quote = { ...quoteAt(long, at), end: at + 10, raw_text: long.slice(at, at + 10), segment: null };
  await viewer.messageView(q, apiFor([row()], { [ID]: long }), { id: ID, quote });
  assert.equal(q.querySelector('mark')?.textContent, 'line 02500');
  assert.ok((q.querySelector('pre.raw') as ShimElement).textContent.length < long.length, 'still in two parts');
});

test('A12: an id not in the index, a refusal from the server, a quote whose offsets do not fit, and a duplicate', async () => {
  const none = host();
  const api = apiFor([row()], { [ID]: TEXT });
  await viewer.messageView(none, api, { id: 'corpus/giron-d/inbox/99.' });
  assert.equal(byText(none, 'p.note', /^No message/)?.textContent, 'No message with this ID in the archive.');
  assert.ok(none.querySelector('form.lookup'));
  assert.deepEqual(api.fetched, [], 'not fetched');

  const refused = host();
  await viewer.messageView(refused, apiFor([row()], {}), { id: ID });
  assert.equal(byText(refused, 'p.note', /^The message/)?.textContent, 'The message could not be read (no message with this id).');

  const off = host();
  await viewer.messageView(off, apiFor([row()], { [ID]: TEXT }), { id: ID, quote: { ...quoteAt(TEXT, 3), raw_text: 'something else' } });
  assert.equal(off.querySelector('mark'), null);
  assert.equal(meta(off, 'Quote'), 'Quote: its stored place does not match this text, so nothing is marked');

  const ORIG = 'corpus/giron-d/inbox/11.';
  const OTHER = 'corpus/lokay-m/inbox/7.';
  const dup = host();
  const dupApi = apiFor([row({ id: ORIG }), row({ duplicate_of: ORIG, role: null, processes: [] }), row({ id: OTHER, duplicate_of: ORIG })], { [ID]: TEXT });
  await viewer.messageView(dup, dupApi, { id: ID });
  assert.equal(meta(dup, 'A copy of'), `A copy of: ${ORIG}, which is the one counted`);
  assert.equal(meta(dup, 'Also appears as'), `Also appears as: ${OTHER}`);
  (byText(dup, 'button', ORIG) as ShimElement).click();
  assert.deepEqual(dupApi.opened, [ORIG]);
  const orig = host();
  await viewer.messageView(orig, apiFor([row({ id: ORIG }), row({ duplicate_of: ORIG }), row({ id: OTHER, duplicate_of: ORIG })], { [ORIG]: TEXT }), { id: ORIG });
  assert.equal(meta(orig, 'Also appears as'), `Also appears as: ${ID}, ${OTHER}`);
});

test('A12: the index may be an array or a loader; a later view replaces an earlier one still loading', async () => {
  const h = host();
  let release: () => void = () => {};
  const slow = new Promise<void>((resolve) => (release = resolve));
  const first = viewer.messageView(h, apiFor([row()], { [ID]: TEXT }, { index: async () => (await slow, [row()]) }), { id: ID });
  const second = viewer.messageView(h, apiFor([row({ id: 'corpus/giron-d/inbox/13.' })], { 'corpus/giron-d/inbox/13.': 'B' }, { index: [row({ id: 'corpus/giron-d/inbox/13.' })] }), { id: 'corpus/giron-d/inbox/13.' });
  await second;
  release();
  await first;
  assert.equal(h.querySelector('h2')?.textContent, 'corpus/giron-d/inbox/13.');
  assert.equal(h.querySelector('pre.raw')?.textContent, 'B');
  assert.equal(h.querySelectorAll('pre.raw').length, 1);
});

test('the lookup form: the trailing-dot hint, an unknown id, a pasted id opened clean', async () => {
  const api = apiFor([row()], { [ID]: TEXT });
  const form = viewer.lookupForm(api);
  const input = form.querySelector('input') as ShimElement;
  const f = form.querySelector('form') as ShimElement;
  const submit = async (value: string): Promise<string> => {
    input.value = value;
    const { event, results } = f.dispatch('submit');
    await Promise.all(results);
    assert.ok(event.defaultPrevented);
    return (form.querySelector('p.small') as ShimElement).textContent;
  };
  assert.equal(await submit('  '), 'Paste a message ID, trailing dot included.');
  assert.equal(await submit(ID.slice(0, -1)), `No message has that ID. Did you mean ${ID} with its trailing dot?`);
  (byText(form, 'button', ID) as ShimElement).click();
  assert.equal(await submit('corpus/giron-d/inbox/99.'), 'No message with this ID in the archive.');
  assert.equal(await submit(` \`${ID}\` `), '');
  assert.equal(await submit(ID.replaceAll('/', '\\')), '');
  assert.deepEqual(api.opened, [ID, ID, ID]);
});

test('when the message list does not load, the lookup opens the id as typed and the viewer says why it shows less', async () => {
  const api = apiFor([row()], { [ID]: TEXT }, { index: async () => Promise.reject(new Error('offline')) });
  const form = viewer.lookupForm(api);
  (form.querySelector('input') as ShimElement).value = ID;
  await Promise.all(form.querySelector('form')?.dispatch('submit').results ?? []);
  assert.equal(form.querySelector('p.small')?.textContent, 'The message list did not load, so the ID was not checked; opening it as typed.');
  assert.deepEqual(api.opened, [ID]);
  const h = host();
  await viewer.messageView(h, api, { id: ID });
  assert.equal(h.querySelector('pre.raw')?.textContent, TEXT, 'the text is still shown');
  assert.match(byText(h, 'p.note', /^The message list did not load/)?.textContent ?? '', /not shown here\. The text below is read from the archive\.$/);
});

// ---- The drafted documents ----

const GRAMMAR = [
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
  '  continued',
  '',
  '1. first',
  '2) second',
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
  '| a \\| b | [value] |',
  '',
  '## Evidence',
  '',
  '- `corpus/a/inbox/1.` (2001-01-15, from Ann Lee):',
  '',
  '  > Please [confirm] the **June** volumes &amp; rates.',
].join('\n');
const ESCAPES = 'A \\[bracket\\]\\(not a link\\) and \\~tilde\\~ and &lt;b&gt; &amp; &quot;q&quot; &#39;s \\*not bold\\* and `a\\[b &lt;c`';
// Fences: one indented in a list item and one in quoted mail (text, not blocks), a backtick fence
// whose info holds a backtick (none), a tilde block closed by a longer run, one never closed; and
// U+2028 inside a heading, an item and a quote.
const FENCES = [
  '- item',
  '  ```',
  '  not a block',
  '  ```',
  '> ```',
  '> quoted',
  '``` a`b',
  'still a paragraph',
  '',
  '~~~ info',
  'kept [as] code',
  '~~~~~',
  '## Head line',
  '- item two',
  '> quote more',
  '',
  ' ```',
  'after an indented fence: text',
  '   ~~~',
  '',
  '```',
  'a closer with info text is not one:',
  '``` js',
  'and four spaces are not one either:',
  '    ```',
  'still inside',
  '````',
  '',
  '[ref]\\: http://example.invalid and a\\:b',
  '',
  '```',
  'never closed',
].join('\n');
const hostile = (JSON.parse(readFileSync(join(repo, 'tests', 'fixtures', 'dashboard', 'hostile.json'), 'utf8')) as { markdown: string }).markdown;

test('A15: renderMarkdown follows the report’s grammar (renderMarkdownHtml) node for node', () => {
  const ids = new Set(['code', 'corpus/a/inbox/1.']);
  for (const md of [GRAMMAR, ESCAPES, FENCES, hostile, inertMarkdown(hostile), inertMarkdown(GRAMMAR), inertMarkdown(FENCES), `${GRAMMAR.replaceAll('\n', '\r\n')}\r\n`]) {
    const nodes = viewer.renderMarkdown(md, { ids });
    assert.equal(nodes.map(serialize).join('\n'), renderMarkdownHtml(md, { base: 3, ids }), md.slice(0, 60));
  }
});

test('A15: a hostile document stays text: no element or attribute from its HTML, no link', () => {
  for (const md of [hostile, inertMarkdown(hostile), 'Look <img src=x onerror=alert(1)> and [x](javascript:alert(2)) and <script>alert(3)</script>']) {
    const wrap = document.createElement('div');
    wrap.append(...viewer.renderMarkdown(md, { onMessageId: () => {} }));
    const all: ShimElement[] = [];
    const walk = (n: ShimNode): void => {
      for (const c of n.childNodes) {
        if (c instanceof ShimElement) {
          all.push(c);
          walk(c);
        }
      }
    };
    walk(wrap);
    for (const t of new Set(all.map((e) => e.localName))) assert.ok(['h3', 'h4', 'p', 'ul', 'ol', 'li', 'blockquote', 'br', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'code', 'strong', 'mark', 'button'].includes(t), t);
    for (const e of all) for (const a of e.attributes.keys()) assert.ok(['class', 'scope', 'type'].includes(a), `${e.localName} ${a}`);
    assert.ok(/<img src=x onerror=alert\(\d\)>/.test(wrap.textContent), 'the tag is text');
    assert.ok(wrap.textContent.includes('javascript:alert('), 'the link is text');
  }
});

test('renderMarkdown reads Markdown’s escapes and the five entities as the plain characters', () => {
  const [p] = viewer.renderMarkdown(ESCAPES) as ShimElement[];
  assert.equal(p?.textContent, 'A [bracket](not a link) and ~tilde~ and <b> & "q" \'s *not bold* and a\\[b &lt;c');
  assert.equal(p?.querySelectorAll('mark').length, 0, 'an escaped bracket opens no placeholder');
  assert.equal(p?.querySelectorAll('strong').length, 0, 'escaped stars make no bold');
  assert.equal(p?.querySelector('code')?.textContent, 'a\\[b &lt;c', 'a code span is shown as written');
  // What the drafter wrote, made inert for the report, reads as written.
  const inert = inertMarkdown('See [the sheet](javascript:alert(1)) and <img src=x> for [owner to confirm].');
  const [q] = viewer.renderMarkdown(inert) as ShimElement[];
  assert.equal(q?.textContent, 'See [the sheet](javascript:alert(1)) and <img src=x> for [owner to confirm].');
  assert.deepEqual(q?.querySelectorAll('mark.blank').map((m) => m.textContent), ['[the sheet]', '[owner to confirm]']);
});

test('renderMarkdown: a fence opens a block only at the start of a line and closes only on a bare run as long', () => {
  const nodes = viewer.renderMarkdown(FENCES);
  const pres = nodes.filter((n): n is ShimElement => n instanceof ShimElement && n.localName === 'pre').map((p) => p.textContent);
  assert.deepEqual(pres, [
    'kept [as] code',
    'a closer with info text is not one:\n``` js\nand four spaces are not one either:\n    ```\nstill inside',
    'never closed',
  ]);
  const text = nodes.map((n) => n.textContent);
  for (const s of ['item ``` not a block ```', '```quoted', '``` after an indented fence: text ~~~', '[ref]: http://example.invalid and a:b']) assert.ok(text.includes(s), `${s} in ${JSON.stringify(text)}`);
  assert.ok(!text.join('\n').includes('\\:'), 'an escaped colon reads as a colon');
});

test('renderMarkdown: a message id in backticks is a button that opens it', () => {
  const opened: string[] = [];
  const nodes = viewer.renderMarkdown('- `corpus/a/inbox/1.` (from Ann):\n\n  > a quote\n\nAnd `not-an-id`.', { ids: new Set(['corpus/a/inbox/1.']), onMessageId: (id) => void opened.push(id) });
  const wrap = document.createElement('div');
  wrap.append(...nodes);
  const b = wrap.querySelector('button.msg') as ShimElement;
  assert.equal(b.textContent, 'corpus/a/inbox/1.');
  assert.equal(b.getAttribute('type'), 'button');
  b.click();
  assert.deepEqual(opened, ['corpus/a/inbox/1.']);
  assert.equal(byText(wrap, 'code', 'not-an-id')?.getAttribute('class'), null);
  assert.equal((wrap.querySelector('li') as ShimElement).querySelector('blockquote')?.textContent, 'a quote');
});
