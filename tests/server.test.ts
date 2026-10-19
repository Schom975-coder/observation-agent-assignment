// The dashboard server (src/serve/server.ts), on every CI OS: in temp projects whose path holds a
// space, with a minimal built out/dashboard/ and a two-message corpus held as Git objects (and, on
// macOS and Linux, also on disk, where POSIX allows the trailing-dot names, so the reader takes the
// disk path there and Git objects on Windows). In process: the bind address, the static files and
// their headers, gzip, the report's own policy, path refusals, /api/message and /api/health. As a
// child process: `serve --background` returns at once with the server left running (the test's
// spawnSync waits on the command's pipes, as Claude Code's Bash tool does), is reused, reports its
// status, stops, and treats a killed server's file as stale. --open is never passed; openBrowser is
// tested with an injected spawn.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { gitBlobSha } from '../src/util/hash.ts';
import { fileSha } from '../src/run/ledger.ts';
import {
  DEFAULT_PORTS,
  REPORT_CSP,
  SITE_CSP,
  START_WAIT_MS,
  ServeError,
  acceptsGzip,
  browserCommand,
  createServer,
  health,
  openBrowser,
  parseServeArgs,
  projectId,
  readState,
  runningServer,
  serveCommand,
  stateFile,
  staticPath,
  type Running,
} from '../src/serve/server.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'obs serve '));
const POSIX = process.platform !== 'win32'; // where trailing-dot file names can exist on disk
// Every server a test started, by pid, with its port. Cleanup signals a pid only while that server
// still answers on its port with that pid, as `serve --stop` does: Windows reuses pids quickly, and
// an exited server's pid may by then belong to another process (in CI, a hook spawned by another
// test file running alongside this one).
const started = new Map<number, number>();
after(async () => {
  for (const [pid, port] of started) {
    if ((await health(port, 500))?.pid !== pid) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

// Two messages: CRLF headers, an LF body with a quoted-printable soft break, and non-ASCII text.
const MESSAGES: Record<string, string> = {
  'corpus/alpha-a/inbox/1.': 'Message-ID: <1.alpha@example.invalid>\r\nDate: Mon, 15 Jan 2001 10:00:00 -0000\r\nFrom: Ann Lee <ann.lee@enron.com>\r\nSubject: Widget count\r\n\r\nPlease confirm the widget count=\n for June.\n',
  'corpus/alpha-a/sent_items/2.': 'Message-ID: <2.alpha@example.invalid>\r\nDate: Tue, 16 Jan 2001 10:00:00 -0000\r\nFrom: Bob Ray <bob.ray@enron.com>\r\nSubject: Re: Widget count\r\n\r\nConfirmed \u2014 caf\u00e9 at 3\u00a0pm.\n',
};
const [ONE, TWO] = Object.keys(MESSAGES) as [string, string];
const BIG = `${JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: `corpus/alpha-a/inbox/${i}.`, subject: 'widget count' })), null, 2)}\n`;

function git(root: string, args: string[], input?: string): string {
  const config = ['-c', 'core.protectNTFS=false', '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
  const r = spawnSync('git', [...config, ...args], { cwd: root, input, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// A project: the corpus in Git (and on disk on POSIX), a built out/dashboard/ and the report; with
// `code`, the CLI too, so `node obs.mjs serve` resolves this folder as its root.
function project(name: string, code: boolean): string {
  const root = join(tmp, name);
  mkdirSync(join(root, 'out', 'dashboard', 'fonts'), { recursive: true });
  git(root, ['init', '-q']);
  for (const [id, text] of Object.entries(MESSAGES)) {
    const sha = git(root, ['hash-object', '-w', '--no-filters', '--stdin'], text);
    git(root, ['update-index', '--add', '--cacheinfo', `100644,${sha},${id}`]);
    if (POSIX) {
      mkdirSync(dirname(join(root, id)), { recursive: true });
      writeFileSync(join(root, id), text);
    }
  }
  git(root, ['commit', '-q', '--no-verify', '-m', 'fixture']);
  const out = (rel: string, text: string | Buffer) => {
    mkdirSync(dirname(join(root, 'out', rel)), { recursive: true });
    writeFileSync(join(root, 'out', rel), text);
  };
  out('dashboard/data.json', `${JSON.stringify({ version: 1, run: { id: '20261019T000000Z' } }, null, 2)}\n`);
  out('dashboard/index.html', '<!doctype html><meta charset="utf-8"><title>Dashboard</title>\n');
  out('dashboard/app.js', '// @ts-check\nexport {};\n');
  out('dashboard/styles.css', 'body { margin: 0; }\n');
  out('dashboard/messages/index.json', BIG);
  out('dashboard/fonts/face.woff2', Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0xff]));
  out('report.html', '<!doctype html><meta charset="utf-8"><title>Report</title><style>body{}</style>\n');
  out('report.md', '# Report\n');
  out('package.json', '{ "name": "outside the dashboard" }\n');
  if (code) {
    cpSync(join(repo, 'src'), join(root, 'src'), { recursive: true });
    copyFileSync(join(repo, 'obs.mjs'), join(root, 'obs.mjs'));
    copyFileSync(join(repo, 'package.json'), join(root, 'package.json'));
  }
  return root;
}

type Got = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };

// A raw GET (the path sent as written, never normalised by a URL parser).
function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
const json = (g: Got): Record<string, unknown> => JSON.parse(g.body.toString('utf8')) as Record<string, unknown>;
const message = (port: number, id: string) => get(port, `/api/message?id=${encodeURIComponent(id)}`);

// ---- In process ----

let root = '';
let server: Running;
before(async () => {
  root = project('in process', false);
  server = await createServer(root, { port: 0 });
});
after(() => server?.close());

test('binds 127.0.0.1 only, on the port the OS gave', () => {
  const address = server.server.address();
  assert.ok(address !== null && typeof address === 'object');
  assert.equal(address.address, '127.0.0.1');
  assert.equal(server.port, address.port);
  assert.equal(server.url, `http://127.0.0.1:${server.port}/`);
  assert.deepEqual(DEFAULT_PORTS, [8765, 8766, 8767, 8768, 8769, 8770, 8771, 8772, 8773, 8774, 8775]);
});

test('static files: index.html for /, the content types, and the headers on every response', async () => {
  const cases: Array<[string, string, string]> = [
    ['/', 'text/html; charset=utf-8', 'dashboard/index.html'],
    ['/index.html', 'text/html; charset=utf-8', 'dashboard/index.html'],
    ['/app.js', 'text/javascript; charset=utf-8', 'dashboard/app.js'],
    ['/styles.css', 'text/css; charset=utf-8', 'dashboard/styles.css'],
    ['/data.json', 'application/json', 'dashboard/data.json'],
    ['/fonts/face.woff2', 'font/woff2', 'dashboard/fonts/face.woff2'],
  ];
  for (const [path, type, file] of cases) {
    const g = await get(server.port, path);
    assert.equal(g.status, 200, path);
    assert.equal(g.headers['content-type'], type, path);
    assert.ok(g.body.equals(readFileSync(join(root, 'out', ...file.split('/')))), `${path}: the file's bytes`);
    assert.equal(g.headers['x-content-type-options'], 'nosniff');
    assert.equal(g.headers['content-security-policy'], SITE_CSP);
    assert.equal(g.headers['cache-control'], 'no-cache');
    assert.equal(g.headers['referrer-policy'], 'no-referrer');
  }
  const head = await get(server.port, '/app.js', {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal((await get(server.port, '/', {}, 'POST')).status, 405);
});

test('JSON over 8 KB is gzipped when the request accepts gzip', async () => {
  const plain = await get(server.port, '/messages/index.json');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString('utf8'), BIG);
  const zipped = await get(server.port, '/messages/index.json', { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.equal(zipped.headers.vary, 'Accept-Encoding');
  assert.ok(zipped.body.length < BIG.length / 4);
  assert.equal(gunzipSync(zipped.body).toString('utf8'), BIG);
  const small = await get(server.port, '/data.json', { 'accept-encoding': 'gzip' });
  assert.equal(small.headers['content-encoding'], undefined, 'small JSON as it is');
  const refused = await get(server.port, '/messages/index.json', { 'accept-encoding': 'gzip;q=0, identity' });
  assert.equal(refused.headers['content-encoding'], undefined, 'gzip;q=0 means not gzip');
  assert.equal(refused.body.toString('utf8'), BIG);
  for (const [header, yes] of [['gzip', true], ['GZIP;q=0.5', true], ['br, gzip ; q=1', true], ['gzip;q=0', false], ['gzip; q=0.000', false], ['x-gzip', false], ['identity', false], ['', false]] as const) {
    assert.equal(acceptsGzip(header), yes, header);
  }
});

test('report.html stands alone under its own policy (no script source); report.md is Markdown', async () => {
  const html = await get(server.port, '/report.html');
  assert.equal(html.status, 200);
  assert.equal(html.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(html.headers['content-security-policy'], REPORT_CSP);
  assert.equal(REPORT_CSP, "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  assert.doesNotMatch(REPORT_CSP, /script-src/);
  assert.equal(SITE_CSP, "default-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  const md = await get(server.port, '/report.md');
  assert.equal(md.headers['content-type'], 'text/markdown; charset=utf-8');
  assert.equal(md.headers['content-security-policy'], SITE_CSP);
  assert.equal(md.body.toString('utf8'), '# Report\n');
});

test('nothing outside out/dashboard/ is served, no directory is listed, no dot file', async () => {
  for (const path of [
    '/../package.json',
    '/../../package.json',
    '/..%2fpackage.json',
    '/..%2f..%2fpackage.json',
    '/%2e%2e%2fpackage.json',
    '/..%5cpackage.json',
    '/fonts/',
    '/fonts',
    '/messages',
    '/.server.json',
    '/C:%5cWindows%5cwin.ini',
    '/a%00b',
    '/NUL',
    '/con.json',
    '/%ZZ',
    '//evil.example/x',
    '/api',
  ]) {
    const g = await get(server.port, path);
    assert.ok(g.status === 404 || g.status === 400, `${path}: ${g.status}`);
    assert.doesNotMatch(g.body.toString('utf8'), /outside the dashboard/, path);
  }
  const dir = join(root, 'out', 'dashboard');
  assert.equal(staticPath(dir, '/'), join(dir, 'index.html'));
  assert.equal(staticPath(dir, '/fonts/face.woff2'), join(dir, 'fonts', 'face.woff2'));
  for (const p of ['/x/../y', '/x/./y', '/a:b', '/x.', '/x ', '/x\\y', '/.git/config', 'nosl']) assert.equal(staticPath(dir, p), null, p);
});

test('a page on another site cannot read the server through its own host name', async () => {
  assert.equal((await get(server.port, '/data.json', { host: 'evil.example' })).status, 403);
  assert.equal((await get(server.port, '/data.json', { host: `localhost:${server.port}` })).status, 200);
});

test('A3, A12: /api/message returns the message as the reader reads it, from the path the reader takes', async () => {
  for (const [id, text] of Object.entries(MESSAGES)) {
    const g = await message(server.port, id);
    assert.equal(g.status, 200, id);
    assert.equal(g.headers['cache-control'], 'no-store');
    assert.equal(g.headers['content-type'], 'application/json');
    const body = json(g);
    assert.equal(body.id, id);
    assert.equal(body.text, Buffer.from(text, 'utf8').toString('utf8'), 'the bytes decoded as UTF-8, CRLF and the = soft break kept');
    assert.equal(body.size, Buffer.byteLength(text, 'utf8'));
    assert.equal(body.blob_sha, gitBlobSha(Buffer.from(text, 'utf8')));
    assert.equal(body.source, POSIX ? 'disk' : 'git');
  }
  assert.equal(server.corpus.readFrom, POSIX ? 'disk' : 'git');
});

test('A3: on macOS and Linux the API reads the file on disk, not Git', { skip: !POSIX && 'trailing-dot names cannot exist on disk on Windows; the macOS and Linux CI jobs run this' }, async () => {
  const file = join(root, ONE);
  const was = readFileSync(file);
  try {
    writeFileSync(file, 'Rewritten on disk\r\n');
    assert.equal(json(await message(server.port, ONE)).text, 'Rewritten on disk\r\n');
  } finally {
    writeFileSync(file, was);
  }
});

test('A12: /api/message refuses what is not a message id (400) and an id not in the archive (404)', async () => {
  for (const id of ['corpus/alpha-a/../inbox/1.', 'corpus\\alpha-a\\inbox\\1.', '/corpus/alpha-a/inbox/1.', 'C:/corpus/x', 'c:corpus/x', 'corpus/alpha-a/inbox/1.\u0001', 'corpus/a\nb', 'out/people.json', 'alpha-a/inbox/1.', '']) {
    const g = await message(server.port, id);
    assert.equal(g.status, 400, JSON.stringify(id));
    assert.deepEqual(json(g), { error: 'not a message id' });
  }
  assert.equal((await get(server.port, '/api/message')).status, 400);
  const unknown = await message(server.port, 'corpus/nobody/inbox/1.');
  assert.equal(unknown.status, 404);
  assert.deepEqual(json(unknown), { error: 'no message with this id' });
  assert.equal((await message(server.port, ONE.slice(0, -1))).status, 404, 'the trailing dot is part of the id');
  const other = await get(server.port, '/api/other');
  assert.equal(other.status, 404);
  assert.equal(other.headers['cache-control'], 'no-store');
});

test('/api/health names this process, its port, its folder, the run and the data it serves', async () => {
  const h = await health(server.port);
  assert.deepEqual(h, {
    ok: true,
    pid: process.pid,
    port: server.port,
    project: projectId(root),
    run_id: '20261019T000000Z',
    data_sha: fileSha(join(root, 'out', 'dashboard', 'data.json')),
    source: POSIX ? 'disk' : 'git',
  });
  assert.match(projectId(root), /^[0-9a-f]{12}$/);
  assert.equal(projectId(`${root}/`), projectId(root), 'one folder, one id');
  assert.notEqual(projectId(join(tmp, 'empty')), projectId(root));
  assert.equal(await health(1), null, 'nothing answers there');
});

// A server that answers its health check slowly (1.5 s, past the first 1 s wait) is still found:
// the check is asked again with a longer wait while the process is alive.
test('one slow health answer does not lose a live server; a dead one is let go at once', async () => {
  const slow = join(tmp, 'slow');
  mkdirSync(join(slow, 'out', 'dashboard'), { recursive: true });
  const fake = createHttpServer((req, res) => {
    setTimeout(() => res.end(JSON.stringify({ ok: true, pid: process.pid, port: (fake.address() as AddressInfo).port, project: projectId(slow), run_id: null, data_sha: null, source: 'git' })), 1500);
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  try {
    const port = (fake.address() as AddressInfo).port;
    writeFileSync(stateFile(slow), JSON.stringify({ pid: process.pid, port, project: projectId(slow), run_id: null, started_utc: '' }));
    const t0 = performance.now();
    assert.equal((await runningServer(slow))?.port, port, 'found on the second, longer wait');
    assert.ok(performance.now() - t0 >= 1400);
    // Another folder's id in the file (a copied out/): not this folder's server.
    writeFileSync(stateFile(slow), JSON.stringify({ pid: process.pid, port, project: 'aaaaaaaaaaaa', run_id: null, started_utc: '' }));
    assert.equal(await runningServer(slow), null);
  } finally {
    fake.closeAllConnections();
    fake.close();
  }
  const dead = spawnSync(process.execPath, ['-e', '0']).pid as number;
  writeFileSync(stateFile(slow), JSON.stringify({ pid: dead, port: 1, project: projectId(slow), run_id: null, started_utc: '' }));
  const t1 = performance.now();
  assert.equal(await runningServer(slow), null);
  assert.ok(performance.now() - t1 < 2500, 'no second wait for a process that is gone');
});

test('refusals: no built data, a bad argument; --stop and --status with nothing running', async () => {
  const empty = join(tmp, 'empty');
  mkdirSync(empty, { recursive: true });
  await assert.rejects(createServer(empty, { port: 0 }), (e: unknown) => e instanceof ServeError && e.message === 'out/dashboard/data.json is missing: run node obs.mjs build (after a complete run) first.');
  const lines: string[] = [];
  const { log, error } = console;
  console.log = (...a: unknown[]) => void lines.push(a.join(' '));
  console.error = (...a: unknown[]) => void lines.push(a.join(' '));
  try {
    assert.equal(await serveCommand(empty, []), 1);
    assert.equal(await serveCommand(empty, ['--background']), 1);
    assert.equal(await serveCommand(empty, ['--frob']), 1);
    assert.equal(await serveCommand(empty, ['--port', '70000']), 1);
    assert.equal(await serveCommand(empty, ['--stop', '--background']), 1);
    assert.equal(await serveCommand(empty, ['--child', '--background']), 1);
    assert.equal(await serveCommand(empty, ['--port', '1', '--ports', '2-3']), 1);
    assert.equal(await serveCommand(empty, ['--ports', '9-3']), 1);
    assert.equal(await serveCommand(empty, ['--stop']), 0);
    assert.equal(await serveCommand(empty, ['--status']), 0);
  } finally {
    console.log = log;
    console.error = error;
  }
  const expected = [
    /^serve: out\/dashboard\/data\.json is missing: run node obs\.mjs build \(after a complete run\) first\.$/,
    /^serve: out\/dashboard\/data\.json is missing: run node obs\.mjs build \(after a complete run\) first\.$/,
    /^serve: unexpected argument "--frob"\. Usage: node obs\.mjs serve /,
    /^serve: --port takes a number from 0 to 65535/,
    /^serve: --stop and --status take no other option/,
    /^serve: --child is the background server itself/,
    /^serve: --port and --ports cannot go together/,
    /^serve: --ports takes a range such as 8765-8775/,
    /^serve: not running$/,
    /^serve: not running$/,
  ];
  assert.equal(lines.length, expected.length, lines.join('\n'));
  expected.forEach((re, i) => assert.match(lines[i] as string, re));
  assert.deepEqual(parseServeArgs(['--background', '--port', '0', '--open']), { background: true, open: true, stop: false, status: false, child: false, port: 0 });
  assert.deepEqual(parseServeArgs(['--background', '--ports', '40100-40102']).ports, [40100, 40102]);
});

test('A1: --open is best effort: open, xdg-open or start, detached and silent, every error swallowed', () => {
  const url = 'http://127.0.0.1:8765/';
  assert.deepEqual(browserCommand(url, 'darwin'), { command: 'open', args: [url] });
  assert.deepEqual(browserCommand(url, 'linux'), { command: 'xdg-open', args: [url] });
  assert.deepEqual(browserCommand(url, 'win32'), { command: 'cmd', args: ['/c', 'start', '', url] });
  for (const platform of ['darwin', 'linux', 'win32']) {
    const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    let unref = 0;
    const listeners: Array<() => void> = [];
    openBrowser(url, (command, args, options) => {
      calls.push({ command, args, options: options as Record<string, unknown> });
      return { on: (_e, fn) => void listeners.push(fn), unref: () => void unref++ };
    }, platform);
    assert.equal(calls.length, 1);
    assert.deepEqual({ command: calls[0]?.command, args: calls[0]?.args }, browserCommand(url, platform));
    assert.deepEqual(calls[0]?.options, { detached: true, stdio: 'ignore', windowsHide: true });
    assert.equal(unref, 1);
    assert.equal(listeners.length, 1, 'an error listener, so a missing xdg-open raises nothing');
    listeners[0]?.();
  }
  assert.doesNotThrow(() =>
    openBrowser(url, () => {
      throw new Error('spawn ENOENT');
    }, 'linux'),
  );
});

// ---- The detached start, reuse and stop, as child processes ----

let cli = '';
before(() => {
  cli = project('detached', true);
});

const obsIn = (dir: string, ...args: string[]) => {
  const t = performance.now();
  const r = spawnSync(process.execPath, [join(dir, 'obs.mjs'), 'serve', ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim(), ms: performance.now() - t, error: r.error };
};
const obs = (...args: string[]) => obsIn(cli, ...args);
// The same, not waiting: for two starts at once.
const obsAsync = (dir: string, ...args: string[]) =>
  new Promise<{ status: number | null; out: string; err: string }>((resolve) => {
    const c = spawn(process.execPath, [join(dir, 'obs.mjs'), 'serve', ...args], { cwd: dir });
    let out = '';
    let err = '';
    c.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    c.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    const timer = setTimeout(() => c.kill(), 30_000);
    c.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, out: out.trim(), err: err.trim() });
    });
  });
// Ports for the tests that scan or take a port: a run of free ones in a high range, held by the test
// where it needs them taken, so no test depends on 8765 to 8775 being free.
const listenOn = (port: number): Promise<NetServer | null> =>
  new Promise((resolve) => {
    const s = createNetServer();
    s.once('error', () => resolve(null));
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
const closeNet = (s: NetServer): Promise<void> => new Promise((resolve) => s.close(() => resolve()));
async function freeRun(n: number): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 25000);
    const held: NetServer[] = [];
    for (let p = base; p < base + n; p++) {
      const s = await listenOn(p);
      if (s === null) break;
      held.push(s);
    }
    await Promise.all(held.map(closeNet));
    if (held.length === n) return base;
  }
  throw new Error('no run of free ports found');
}
async function taken(base: number, n: number): Promise<number> {
  let count = 0;
  for (let p = base; p < base + n; p++) {
    const s = await listenOn(p);
    if (s === null) count++;
    else await closeNet(s);
  }
  return count;
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}
const LINE = /^Dashboard: http:\/\/127\.0\.0\.1:(\d+)\/$/;

test('A1: serve --background returns at once and leaves the server up; it is reused, reports, and stops', async () => {
  const start = obs('--background', '--port', '0');
  assert.equal(start.error, undefined, 'the command returned: no pipe was left open behind it');
  assert.equal(start.status, 0, start.err);
  assert.ok(start.ms < START_WAIT_MS + 2000, `${Math.round(start.ms)} ms`);
  const m = LINE.exec(start.out);
  assert.ok(m !== null, start.out);
  const port = Number(m[1]);
  const state = readState(cli);
  assert.ok(state !== null);
  started.set(state.pid, state.port);
  assert.equal(state.port, port);
  assert.equal(state.run_id, '20261019T000000Z');
  assert.notEqual(state.pid, process.pid);
  const h = await health(port);
  assert.equal(h?.pid, state.pid, 'the server outlived the command that started it');
  const msg = json(await message(port, TWO));
  assert.equal(msg.text, MESSAGES[TWO]);
  assert.equal(msg.source, POSIX ? 'disk' : 'git');

  const again = obs('--background', '--port', '0');
  assert.equal(again.status, 0, again.err);
  assert.equal(again.out, `Dashboard: http://127.0.0.1:${port}/ (already running)`);
  assert.equal(readState(cli)?.pid, state.pid);
  assert.equal(obs('--status').out, `Dashboard: http://127.0.0.1:${port}/`);

  const stop = obs('--stop');
  assert.equal(stop.status, 0, stop.err);
  assert.equal(stop.out, 'serve: stopped');
  assert.equal(await health(port), null);
  assert.ok(await until(() => !alive(state.pid), 3000), 'the process is gone');
  assert.equal(existsSync(stateFile(cli)), false, 'no state file left');
  assert.equal(obs('--status').out, 'serve: not running');
  assert.equal(obs('--stop').out, 'serve: not running');
});

test('A1: a server killed outright leaves a stale file, and the next start treats it as stale', async () => {
  const first = obs('--background', '--port', '0');
  assert.equal(first.status, 0, first.err);
  const s1 = readState(cli);
  assert.ok(s1 !== null);
  started.set(s1.pid, s1.port);
  process.kill(s1.pid, 'SIGKILL'); // no handler runs: TerminateProcess on Windows, SIGKILL elsewhere
  assert.ok(await until(() => !alive(s1.pid), 3000));
  assert.equal(readState(cli)?.pid, s1.pid, 'the file is left behind');
  assert.equal(obs('--status').out, 'serve: not running');

  const second = obs('--background', '--port', '0');
  assert.equal(second.status, 0, second.err);
  assert.match(second.out, LINE);
  assert.doesNotMatch(second.out, /already running/);
  const s2 = readState(cli);
  assert.ok(s2 !== null && s2.pid !== s1.pid);
  started.set(s2.pid, s2.port);
  assert.equal((await health(s2.port))?.pid, s2.pid);
  assert.equal(obs('--stop').out, 'serve: stopped');
  assert.ok(await until(() => !alive(s2.pid), 3000));
  assert.equal(existsSync(stateFile(cli)), false);

  // A file that is not a server's state is stale too.
  writeFileSync(stateFile(cli), '{ torn');
  assert.equal(obs('--status').out, 'serve: not running');
  assert.equal(obs('--stop').out, 'serve: not running');
  assert.equal(existsSync(stateFile(cli)), false);
});

test('A1: two starts at once leave one server, and both print its address', async () => {
  const base = await freeRun(3);
  const range = `${base}-${base + 2}`;
  const [a, b] = await Promise.all([obsAsync(cli, '--background', '--ports', range), obsAsync(cli, '--background', '--ports', range)]);
  assert.equal(a.status, 0, a.err);
  assert.equal(b.status, 0, b.err);
  const state = readState(cli);
  assert.ok(state !== null);
  started.set(state.pid, state.port);
  assert.deepEqual([a.out, b.out].sort(), [`Dashboard: ${state.url}`, `Dashboard: ${state.url} (already running)`], `${a.out} | ${b.out}`);
  assert.equal(await taken(base, 3), 1, 'one server listens');
  assert.equal((await health(state.port))?.pid, state.pid);
  assert.equal(obs('--stop').out, 'serve: stopped');
  assert.ok(await until(() => !alive(state.pid), 3000));
  assert.equal(await taken(base, 3), 0);
});

test('with no --port the server scans its range, past a port that is taken', async () => {
  const base = await freeRun(3);
  const holder = await listenOn(base);
  assert.ok(holder !== null);
  try {
    const r = obs('--background', '--ports', `${base}-${base + 2}`);
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, `Dashboard: http://127.0.0.1:${base + 1}/`);
    const s = readState(cli);
    assert.ok(s !== null);
    started.set(s.pid, s.port);
    assert.equal(obs('--stop').out, 'serve: stopped');
    assert.ok(await until(() => !alive(s.pid), 3000));
  } finally {
    await closeNet(holder);
  }
});

test('a taken --port, or a range all taken, is refused in one line and leaves nothing behind', async () => {
  const base = await freeRun(2);
  const held = [await listenOn(base), await listenOn(base + 1)];
  try {
    const one = obs('--background', '--port', String(base));
    assert.equal(one.status, 1);
    assert.equal(one.out, '');
    assert.equal(one.err, `serve: port ${base} is in use on 127.0.0.1; choose another with --port N.`);
    const all = obs('--background', '--ports', `${base}-${base + 1}`);
    assert.equal(all.status, 1);
    assert.equal(all.err, `serve: ports ${base} to ${base + 1} are all in use on 127.0.0.1; choose another with --port N.`);
    assert.equal(existsSync(stateFile(cli)), false);
  } finally {
    for (const s of held) if (s !== null) await closeNet(s);
  }
});

test('a copied out/ names another folder’s server: this folder neither reports, stops nor reuses it', async () => {
  const copy = project('copied', true);
  const first = obs('--background', '--port', '0');
  assert.equal(first.status, 0, first.err);
  const s1 = readState(cli);
  assert.ok(s1 !== null);
  started.set(s1.pid, s1.port);
  assert.equal(s1.project, projectId(cli));
  assert.notEqual(projectId(copy), projectId(cli));
  copyFileSync(stateFile(cli), stateFile(copy));
  assert.equal(obsIn(copy, '--status').out, 'serve: not running');
  assert.equal(obsIn(copy, '--stop').out, 'serve: not running');
  assert.equal((await health(s1.port))?.pid, s1.pid, 'the first folder’s server is untouched');
  assert.equal(existsSync(stateFile(copy)), false, 'the copied file was stale here and is gone');
  copyFileSync(stateFile(cli), stateFile(copy));
  const second = obsIn(copy, '--background', '--port', '0');
  assert.equal(second.status, 0, second.err);
  assert.match(second.out, LINE);
  assert.doesNotMatch(second.out, /already running/);
  const s2 = readState(copy);
  assert.ok(s2 !== null && s2.pid !== s1.pid);
  started.set(s2.pid, s2.port);
  assert.equal(s2.project, projectId(copy));
  assert.equal(obsIn(copy, '--stop').out, 'serve: stopped');
  assert.equal((await health(s1.port))?.pid, s1.pid, 'still untouched');
  assert.equal(obs('--stop').out, 'serve: stopped');
  assert.ok(await until(() => !alive(s1.pid) && !alive(s2.pid), 3000));
});
