// The dashboard's drawer (dashboard/app.js): every drill target opens a layer that renders, a second
// open of the same layer is ignored, Back brings the previous layer back as it was left, and only one
// function hides the drawer (so the page behind is never left inert). app.js runs in Node against the
// small DOM of tests/fixtures/dom.ts, with the data of the built pipeline fixture served by a stubbed
// fetch; the fixture is built once for the file.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadInputs, renderOutputs } from '../src/report/build.ts';
import { numsIn } from '../src/report/targets.ts';
import { ShimDocument, ShimElement, type ShimNode } from './fixtures/dom.ts';
import { builtProject } from './fixtures/pipeline.ts';

type Target = { kind: string; [k: string]: unknown };
type App = {
  useData: (data: unknown) => void;
  openTarget: (d: Target, ctx?: Record<string, unknown>) => void;
  back: () => void;
  closeDrawer: () => void;
};

const repo = fileURLToPath(new URL('..', import.meta.url));
const appSource = readFileSync(join(repo, 'dashboard', 'app.js'), 'utf8');

// What the shim lacks and the drawer uses, added here only (tests/fixtures/dom.ts stays as it is).
const proto = ShimElement.prototype as unknown as Record<string, unknown>;
proto.contains = function contains(this: ShimElement, node: ShimNode | null): boolean {
  for (let n: ShimNode | null = node; n !== null; n = n.parentNode) if (n === this) return true;
  return false;
};
proto.closest = function closest(this: ShimElement, selector: string): ShimElement | null {
  for (let n: ShimElement | null = this; n !== null; n = n.parentNode) if (n.matches(selector)) return n;
  return null;
};

const document = new ShimDocument();
const files = new Map<string, string>();
const g = globalThis as unknown as Record<string, unknown>;
const saved = { document: g.document, location: g.location, HTMLElement: g.HTMLElement, fetch: g.fetch };
const location = { hash: '' };
let app: App;
let tmp = '';
let data: { rows: Array<{ key: string; in_total: boolean; total: { d: Target } }> } & Record<string, unknown>;
const json = (p: string): any => JSON.parse(files.get(p) as string);

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'obs drawer '));
  const { inputs, assets, shas } = loadInputs(builtProject(tmp));
  for (const [path, content] of renderOutputs(inputs, assets, shas).files) if (typeof content === 'string') files.set(path, content);
  // The page's shell: the drawer, its scrim and parts, the views and the page behind.
  const shell = (tag: string, id: string | null, cls?: string): ShimElement => {
    const e = document.createElement(tag);
    if (id) e.setAttribute('id', id);
    if (cls) e.setAttribute('class', cls);
    document.body.append(e);
    return e;
  };
  document.body.connected = true;
  shell('div', null, 'brandrule');
  const page = shell('div', null, 'shell');
  for (const v of ['overview', 'all-processes', 'open-loops', 'methodology']) {
    const view = document.createElement('div');
    view.setAttribute('id', v);
    page.append(view);
  }
  (shell('div', 'scrim') as unknown as { hidden: boolean }).hidden = true;
  const drawer = shell('aside', 'drawer');
  (drawer as unknown as { hidden: boolean }).hidden = true;
  for (const id of ['crumbs', 'd-body']) {
    const part = document.createElement('div');
    part.setAttribute('id', id);
    drawer.append(part);
  }
  g.document = document;
  g.location = location;
  g.HTMLElement = ShimElement;
  g.fetch = async (url: string) => {
    const u = String(url);
    if (u.startsWith('/api/message?id=')) {
      const id = decodeURIComponent(u.slice('/api/message?id='.length));
      return { ok: true, status: 200, json: async () => ({ id, size: 30, blob_sha: 'b'.repeat(40), text: `Subject: a message\r\n\r\nThe text of ${id}\n`, source: 'git' }) };
    }
    const body = files.get(`dashboard/${u}`);
    return body === undefined ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => JSON.parse(body) };
  };
  app = (await import(pathToFileURL(join(repo, 'dashboard', 'app.js')).href)) as App;
  data = json('dashboard/data.json');
  app.useData(data);
});

after(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v;
  rmSync(tmp, { recursive: true, force: true });
});

// Lets the stubbed fetches and the parts waiting on them finish.
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r));
}

const body = (): ShimElement => document.getElementById('d-body') as ShimElement;
const title = (): string => document.getElementById('drawer-title')?.textContent ?? '';
const depth = (): number => (document.getElementById('crumbs') as ShimElement).querySelectorAll('span.sep').length;
const isOpen = (): boolean => !(document.getElementById('drawer') as unknown as { hidden: boolean }).hidden;

test('only closeDrawer hides the drawer, and it takes the page behind out of inert; only showDrawer shows it', () => {
  const lines = appSource.split('\n');
  const range = (head: string): [number, number] => {
    const start = lines.findIndex((l) => l.startsWith(head));
    assert.ok(start >= 0, head);
    return [start, start + lines.slice(start).findIndex((l) => l === '}')];
  };
  const [cs, ce] = range('export function closeDrawer() {');
  const [ss, se] = range('function showDrawer() {');
  const where = (re: RegExp): number[] => lines.flatMap((l, i) => (re.test(l) ? [i] : []));
  const hides = where(/(?:drawer\(\)|\$\('#drawer'\)|getElementById\('drawer'\))\.hidden\s*=\s*true/);
  const shows = where(/(?:drawer\(\)|\$\('#drawer'\)|getElementById\('drawer'\))\.hidden\s*=\s*false/);
  assert.equal(hides.length, 1);
  assert.equal(shows.length, 1);
  for (const i of hides) assert.ok(i > cs && i < ce, `line ${i + 1} hides the drawer outside closeDrawer`);
  for (const i of shows) assert.ok(i > ss && i < se, `line ${i + 1} shows the drawer outside showDrawer`);
  assert.match(lines.slice(cs, ce).join('\n'), /setInert\(false\)/);
  assert.match(lines.slice(ss, se).join('\n'), /setInert\(true\)/);
  assert.doesNotMatch(appSource, /\.removeAttribute\('hidden'\)|setAttribute\('hidden'/, 'no other way round the two');
});

test('every kind of drill target in the built fixture opens a layer with a title and no failure note, or its view', async (t) => {
  // One target per kind and variant (a method section, a rows filter, the loop lists), from every built file.
  const roots = ['dashboard/data.json', 'dashboard/method.json', 'dashboard/loops.json', ...[...files.keys()].filter((p) => p.startsWith('dashboard/process/'))];
  const seen = new Map<string, Target>();
  for (const p of roots) {
    for (const { num } of numsIn(json(p))) {
      const d = num.d as Target;
      const variant = `${d.kind}:${String(d.section ?? d.filter ?? '')}:${String(d.recent ?? '')}:${String(d.drafted ?? '')}:${d.key === undefined ? 'all' : 'one'}`;
      if (!seen.has(variant)) seen.set(variant, d);
    }
  }
  // The process pages, the viewer and a thread, reached from names and lists rather than from a figure.
  for (const r of [data.rows.find((x) => x.in_total), data.rows.find((x) => !x.in_total)]) if (r) seen.set(`process:${r.key}`, { kind: 'process', key: r.key });
  const index = json('dashboard/messages/index.json') as Array<{ id: string; thread_id: string | null }>;
  const first = index.find((m) => m.thread_id !== null);
  assert.ok(first);
  seen.set('message', { kind: 'message', id: first.id });
  seen.set('thread', { kind: 'thread', id: first.thread_id as string });
  const kinds = new Set([...seen.values()].map((d) => d.kind));
  for (const k of ['total', 'process', 'formula', 'actions', 'occurrences', 'participants', 'rows', 'method', 'coverage', 'message', 'thread']) assert.ok(kinds.has(k), `the fixture reaches ${k}`);

  t.diagnostic(`${seen.size} targets: ${[...seen.keys()].join(", ")}`);
  for (const [variant, d] of seen) {
    app.closeDrawer();
    location.hash = '';
    app.openTarget(d);
    await settle();
    if (d.kind === 'method' && d.section !== 'explainer') {
      assert.equal(location.hash, 'methodology', variant);
      assert.ok(!isOpen(), `${variant}: a section of How we measured, not a layer`);
      continue;
    }
    if (d.kind === 'loops' && d.key === undefined && d.drafted !== true) {
      assert.equal(location.hash, 'open-loops', variant);
      continue;
    }
    assert.ok(isOpen(), variant);
    assert.notEqual(title().trim(), '', `${variant}: a title`);
    assert.doesNotMatch(body().textContent, /did not load|could not be read|No message with this ID|No process with this key/, `${variant}: ${body().textContent.slice(0, 200)}`);
  }
  app.closeDrawer();
});

test('a second open of the layer on top is ignored', () => {
  app.closeDrawer();
  location.hash = '';
  app.openTarget({ kind: 'total' });
  assert.equal(depth(), 1);
  app.openTarget({ kind: 'total' });
  assert.equal(depth(), 1, 'the same layer is not stacked twice');
  const row = data.rows.find((r) => r.in_total);
  assert.ok(row);
  app.openTarget(row.total.d);
  assert.equal(depth(), 2);
  app.openTarget(row.total.d);
  assert.equal(depth(), 2);
  app.closeDrawer();
});

test('Back brings the previous layer back as it was left: the same nodes, its title and its scroll', async () => {
  app.closeDrawer();
  location.hash = '';
  app.openTarget({ kind: 'total' });
  const first = title();
  const titleNode = document.getElementById('drawer-title');
  (body() as unknown as { scrollTop: number }).scrollTop = 137;
  const row = data.rows.find((r) => r.in_total);
  assert.ok(row);
  app.openTarget(row.total.d);
  await settle();
  assert.notEqual(title(), first);
  assert.equal((body() as unknown as { scrollTop: number }).scrollTop, 0, 'a new layer starts at its top');
  app.back();
  assert.equal(title(), first);
  assert.equal(document.getElementById('drawer-title'), titleNode, 'the layer is put back, not rendered again');
  assert.equal((body() as unknown as { scrollTop: number }).scrollTop, 137, 'at the scroll it was left at');
  app.back();
  assert.ok(!isOpen(), 'Back on the first layer closes the drawer');
  // Where the focus goes is not checked here: the shim's focus() records nothing (checked in Chromium).
});

test('a part whose file has the wrong shape says so in a note instead of staying blank', async () => {
  // A process of its own, so no other test's cached file is touched.
  const row = data.rows.find((r) => r.in_total);
  assert.ok(row);
  const key = 'zz-shape-fault';
  files.set(`dashboard/process/${key}.json`, '{}');
  app.useData({ ...data, rows: [...data.rows, { ...row, key, name: 'A process with a broken file' }] });
  try {
    app.closeDrawer();
    location.hash = '';
    app.openTarget({ kind: 'process', key });
    await settle();
    assert.equal(title(), 'A process with a broken file');
    assert.match(body().textContent, /The process data did not load \(.+\)\. Reload the page/);
    assert.doesNotMatch(body().textContent, /Loading…/);
  } finally {
    app.closeDrawer();
    app.useData(data);
    files.delete(`dashboard/process/${key}.json`);
  }
});
