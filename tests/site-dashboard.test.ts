// The static copy of the dashboard for the project site (site/dashboard.ts): a complete small
// project made by the pipeline fixture (tests/fixtures/pipeline.ts), with the page's own files so
// the build copies an index.html, then copied. Checked: every dashboard file copied byte for byte
// and only the copy's page marked; one file per manifest message holding what the server's
// /api/message answers for it, but for its source; the same bytes twice; the refusals (two ids on one
// path, a bad id, a missing input, a page without its tag, a folder that is not an earlier copy);
// and viewer.js agreeing with the generator on every path.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openCorpus, type CorpusEntry } from '../src/corpus/reader.ts';
import { createServer, isMessageIdShape } from '../src/serve/server.ts';
import { STATIC_PAGE_TAG, staticMessagePath, writeStaticDashboard } from '../site/dashboard.ts';
import { REPO, fixtureM5, runPipeline } from './fixtures/pipeline.ts';

const tmp = mkdtempSync(join(tmpdir(), 'obs site '));
after(() => rmSync(tmp, { recursive: true, force: true }));

const viewer = (await import(pathToFileURL(join(REPO, 'dashboard', 'viewer.js')).href)) as { staticMessagePath: (id: string) => string };

let root = '';
let out = '';
let entries: CorpusEntry[] = [];

// Every file under dir, by "/" path relative to it.
function tree(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const p of readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[]) {
    if (statSync(join(dir, p)).isFile()) files.set(p.replaceAll('\\', '/'), readFileSync(join(dir, p)));
  }
  return files;
}

// An output folder to break: the built dashboard and the manifest of the fixture, copied.
function outCopy(name: string): string {
  const dir = join(tmp, name);
  cpSync(join(out, 'dashboard'), join(dir, 'dashboard'), { recursive: true });
  copyFileSync(join(out, 'manifest.json'), join(dir, 'manifest.json'));
  return dir;
}
const withEntries = (dir: string, list: CorpusEntry[]): void => writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ count: list.length, entries: list }));

before(() => {
  root = fixtureM5(tmp, 'project');
  // The fixture copies only the build's required assets; the copy needs the page itself.
  for (const f of ['index.html', 'app.js', 'styles.css', 'viewer.js']) copyFileSync(join(REPO, 'dashboard', f), join(root, 'dashboard', f));
  runPipeline(root);
  out = join(root, 'out');
  entries = (JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { entries: CorpusEntry[] }).entries;
  assert.equal(entries.length, 30);
});

test('the copy: every dashboard file as built, the report beside the page, and one file per message', () => {
  const dist = join(tmp, 'dist');
  const r = writeStaticDashboard(root, out, dist);
  const built = tree(join(out, 'dashboard'));
  const copy = tree(join(dist, 'dashboard'));
  assert.equal(r.messages, entries.length);
  assert.equal(r.files, built.size + 1 + entries.length, 'the dashboard files, report.html and the messages');
  assert.equal(copy.size, r.files);
  assert.equal(r.bytes, [...copy.values()].reduce((n, b) => n + b.length, 0));
  for (const [p, bytes] of built) {
    if (p !== 'index.html') assert.ok(bytes.equals(copy.get(p) as Buffer), `${p} copied byte for byte`);
  }
  assert.ok(readFileSync(join(out, 'report.html')).equals(copy.get('report.html') as Buffer), 'the report the page links to');
  const page = (copy.get('index.html') as Buffer).toString('utf8');
  const original = (built.get('index.html') as Buffer).toString('utf8');
  assert.equal(page.split('data-static="1"').length - 1, 1, 'the copy is marked once');
  assert.doesNotMatch(original, /data-static/, 'the built page is not');
  assert.equal(page, original.replace('<html lang="en">', STATIC_PAGE_TAG), 'and nothing else changed');
  const messages = [...copy.keys()].filter((p) => p.startsWith('m/')).sort();
  assert.deepEqual(messages, entries.map((e) => staticMessagePath(e.id)).sort());
});

test('a message file holds what /api/message answers for its id, but for its source, with no trailing newline', async () => {
  const dist = join(tmp, 'dist-api');
  writeStaticDashboard(root, out, dist);
  const corpus = openCorpus(root);
  const server = await createServer(root, { port: 0 });
  try {
    for (const e of entries) {
      const raw = readFileSync(join(dist, 'dashboard', ...staticMessagePath(e.id).split('/')), 'utf8');
      assert.ok(!raw.endsWith('\n'), e.id);
      const copy = JSON.parse(raw) as Record<string, unknown>;
      assert.deepEqual(Object.keys(copy), ['id', 'size', 'blob_sha', 'text', 'source']);
      const bytes = corpus.read(e.id);
      assert.deepEqual(copy, { id: e.id, size: bytes.length, blob_sha: e.blob_sha, text: bytes.toString('utf8'), source: 'static' });
    }
    for (const e of entries.slice(0, 3)) {
      const res = await fetch(`${server.url}api/message?id=${encodeURIComponent(e.id)}`);
      assert.equal(res.status, 200);
      const served = (await res.json()) as Record<string, unknown>;
      const copy = JSON.parse(readFileSync(join(dist, 'dashboard', ...staticMessagePath(e.id).split('/')), 'utf8')) as Record<string, unknown>;
      assert.deepEqual(Object.keys(served), Object.keys(copy), 'the same keys in the same order');
      assert.deepEqual({ ...copy, source: served.source }, served, e.id);
    }
  } finally {
    await server.close();
  }
});

test('two runs write the same bytes, the second replacing the first copy', () => {
  const a = join(tmp, 'twice-a');
  const b = join(tmp, 'twice-b');
  writeStaticDashboard(root, out, a);
  const first = tree(join(a, 'dashboard'));
  writeFileSync(join(a, 'dashboard', 'm', 'stale.json'), '{}');
  writeStaticDashboard(root, out, a);
  writeStaticDashboard(root, out, b);
  for (const again of [tree(join(a, 'dashboard')), tree(join(b, 'dashboard'))]) {
    assert.deepEqual([...again.keys()].sort(), [...first.keys()].sort(), 'a file left by an earlier copy is gone');
    for (const [p, bytes] of first) assert.ok(bytes.equals(again.get(p) as Buffer), p);
  }
});

test('refusals: two ids on one path, a bad id or name, a missing input, a page without its tag, a folder that is not a copy', () => {
  const [one, two] = entries as [CorpusEntry, CorpusEntry];
  const dist = join(tmp, 'refused');
  const refuses = (dir: string, list: CorpusEntry[] | null, pattern: RegExp): void => {
    if (list !== null) withEntries(dir, list);
    assert.throws(() => writeStaticDashboard(root, dir, dist), (e: unknown) => e instanceof Error && pattern.test(e.message) && !e.message.includes('\n'), pattern.source);
  };
  const dir = outCopy('broken');
  refuses(dir, [one, { ...one, id: `${one.id}.` }], /^corpus\/m5\/inbox\/01 and corpus\/m5\/inbox\/01\. would be written to one file, m\/m5\/inbox\/01\.json\.$/);
  refuses(dir, [one, { ...two, id: one.id.toUpperCase().replace('CORPUS/', 'corpus/') }], /would be written to one file/);
  refuses(dir, [one, { ...two, id: 'corpus/../x' }], /"corpus\/\.\.\/x", which is not a message id/);
  refuses(dir, [one, { ...two, id: 'corpus/m5/con/1.' }], /^corpus\/m5\/con\/1\. would be written as m\/m5\/con\/1\.json, and "con" is not a name every system can hold\.$/);
  for (const [id, name] of [['corpus/m5/COM0/1.', 'COM0'], ['corpus/m5/inbox/lpt¹', 'lpt¹.json'], ['corpus/m5/a /1.', 'a '], ['corpus/m5/a:b/1.', 'a:b'], ['corpus/m5/.hidden/1.', '.hidden'], ['corpus/m5/a./1.', 'a.']] as const) {
    refuses(dir, [one, { ...two, id }], new RegExp(`and ${JSON.stringify(name).replace(/[.*?]/g, '\\$&')} is not a name every system can hold\\.$`));
  }
  refuses(dir, [one, { ...two, id: 'corpus/m5/inbox' }, { ...two, id: 'corpus/m5/inbox.json/1.' }], /needs a folder/);
  refuses(dir, [one, { ...two, id: 'corpus/m5/inbox/99.' }], /^corpus\/m5\/inbox\/99\. is in manifest\.json but not in the corpus/);
  refuses(dir, [one, { ...two, blob_sha: one.blob_sha }], /does not match the corpus/);
  rmSync(join(dir, 'manifest.json'));
  refuses(dir, null, /^manifest\.json is missing/);
  const noData = outCopy('no-data');
  rmSync(join(noData, 'dashboard', 'data.json'));
  refuses(noData, null, /^dashboard\/data\.json is missing/);
  const changed = outCopy('changed-page');
  const page = join(changed, 'dashboard', 'index.html');
  writeFileSync(page, readFileSync(page, 'utf8').replace('<html lang="en">', '<html lang="en-US">'));
  refuses(changed, null, /must hold <html lang="en"> exactly once/);
  assert.equal(existsSync(dist), false, 'nothing written by a refused call');

  mkdirSync(join(tmp, 'site', 'dashboard'), { recursive: true });
  writeFileSync(join(tmp, 'site', 'dashboard', 'keep.txt'), 'mine');
  assert.throws(() => writeStaticDashboard(root, out, join(tmp, 'site')), /not a static copy/);
  assert.equal(readFileSync(join(tmp, 'site', 'dashboard', 'keep.txt'), 'utf8'), 'mine', 'a folder that is not a copy is never removed');
  mkdirSync(join(tmp, 'file-site'));
  writeFileSync(join(tmp, 'file-site', 'dashboard'), 'a file');
  assert.throws(() => writeStaticDashboard(root, out, join(tmp, 'file-site')), /^Error: the site folder already has a file named dashboard/);
  assert.throws(() => writeStaticDashboard(root, out, out), /overlap/);
  assert.throws(() => writeStaticDashboard(root, out, join(out, 'dashboard')), /overlap/);
  assert.throws(() => writeStaticDashboard(root, out, join(out.toUpperCase(), 'dashboard')), /overlap/, 'compared without case');
  // The output folder inside the folder the copy would replace.
  const nest = join(tmp, 'nest');
  cpSync(join(out, 'dashboard'), join(nest, 'dashboard', 'out', 'dashboard'), { recursive: true });
  copyFileSync(join(out, 'manifest.json'), join(nest, 'dashboard', 'out', 'manifest.json'));
  assert.throws(() => writeStaticDashboard(root, join(nest, 'dashboard', 'out'), nest), /overlap/);
  assert.ok(existsSync(join(nest, 'dashboard', 'out', 'dashboard', 'data.json')), 'and nothing removed');
});

test('an empty dashboard/ folder is filled; without out/report.html the copy has no report', () => {
  const site = join(tmp, 'empty-site');
  mkdirSync(join(site, 'dashboard'), { recursive: true });
  const noReport = outCopy('no-report');
  assert.equal(existsSync(join(noReport, 'report.html')), false);
  const r = writeStaticDashboard(root, noReport, site);
  assert.equal(r.files, tree(join(noReport, 'dashboard')).size + entries.length);
  assert.equal(existsSync(join(site, 'dashboard', 'report.html')), false);
  assert.ok(existsSync(join(site, 'dashboard', 'index.html')));
});

test('viewer.js and the generator refuse the same ids, as the server does', () => {
  const ids = ['corpus/../x', 'corpus/a/..', 'other/x/1.', 'corpus\\x\\1.', 'C:/corpus/x', 'corpus/x/1.\n', 'corpus/x/\u007f1.', '/corpus/x/1.', 'corpus/x/1.'];
  for (const id of ids) {
    const viewerRefuses = ((): boolean => {
      try {
        viewer.staticMessagePath(id);
        return false;
      } catch (e) {
        return e instanceof Error && e.message === 'not a message id';
      }
    })();
    assert.equal(viewerRefuses, !isMessageIdShape(id), JSON.stringify(id));
    if (viewerRefuses) assert.throws(() => staticMessagePath(id), /^Error: not a message id: /, JSON.stringify(id));
  }
});

test('viewer.js and the generator name the same file for every id', () => {
  const ids = [...entries.map((e) => e.id), 'corpus/farmer-d/logistics/1.', 'corpus/lokay-m/all_documents/312.'];
  for (const id of ids) {
    assert.equal(viewer.staticMessagePath(id).split('/').map(decodeURIComponent).join('/'), staticMessagePath(id), id);
  }
  assert.equal(staticMessagePath('corpus/farmer-d/logistics/1.'), 'm/farmer-d/logistics/1.json');
  assert.equal(viewer.staticMessagePath('corpus/a b/1.'), 'm/a%20b/1.json');
  assert.equal(staticMessagePath('corpus/a b/1.'), 'm/a b/1.json');
});
