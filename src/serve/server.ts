// The dashboard server (ARCHITECTURE.md 4 stage 16, 6.13): `node obs.mjs serve` serves the built
// dashboard (out/dashboard/), the report (out/report.html, out/report.md) and one message at a time
// through the corpus reader, on 127.0.0.1 only, with no outbound socket.
//
//   serve                     foreground: listens, writes out/dashboard/.server.json, Ctrl+C stops
//   serve --background        starts the same server as a detached child and returns at once; a
//                             server already up for this folder is reused
//   serve --stop | --status   ends the running server, or prints its address
//   --port N                  that port only (0: the OS picks); default 8765, then 8766 to 8775
//   --ports A-B               another range to try instead of 8765 to 8775 (the tests use it)
//   --open                    also tries once to open the default browser (best effort)
//
// The detached start is the same on every OS: spawn of this Node with an argv array (a folder whose
// path has spaces is one argument), detached, stdio ignored (the caller's pipes are never inherited,
// so a captured `serve --background` returns when it exits), unref'd, its window hidden on Windows.
// The child finds its port, then claims .server.json (only one server per folder can); the parent
// waits for the claim and for /api/health, or reads why the child stopped from its exit code.
import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, linkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer as createHttpServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { CorpusError, openCorpus, type Corpus, type CorpusEntry } from '../corpus/reader.ts';
import { fileSha, nowUtc, readText, removeFile, withoutRoot } from '../run/ledger.ts';
import { sha256 } from '../util/hash.ts';

export class ServeError extends Error {
  override name = 'ServeError';
}
// Every port asked for is in use.
export class PortsTakenError extends ServeError {
  override name = 'PortsTakenError';
}

export const HOST = '127.0.0.1';
export const DEFAULT_PORTS: readonly number[] = Array.from({ length: 11 }, (_, i) => 8765 + i);
export const GZIP_MIN_BYTES = 8 * 1024;
// Every response but the report: the page, its scripts and styles, its data and fonts come from this
// origin only; inline styles are set through the CSSOM, so no 'unsafe-inline'; no form posts and no
// framing by another page.
export const SITE_CSP = "default-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// report.html stands alone (it opens by double-click): one inline <style>, data: fonts, no script.
export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const SERVE_USAGE = 'Usage: node obs.mjs serve [--port N] [--background] [--open] | --stop | --status';
const DATA_MISSING = 'out/dashboard/data.json is missing: run node obs.mjs build (after a complete run) first.';
export const START_WAIT_MS = 10_000;
const STOP_WAIT_MS = 3000;
const POLL_MS = 100;
// How the detached child tells its parent why it stopped (its output goes nowhere).
const EXIT_PORTS_TAKEN = 3;
const EXIT_ALREADY_RUNNING = 4;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};
const typeOf = (file: string): string => TYPES[/\.[^./\\]+$/.exec(file)?.[0]?.toLowerCase() ?? ''] ?? 'application/octet-stream';

export const dashboardDir = (root: string): string => join(root, 'out', 'dashboard');
export const stateFile = (root: string): string => join(dashboardDir(root), '.server.json');
const dataFile = (root: string): string => join(dashboardDir(root), 'data.json');

const gzipAsync = promisify(gzip);
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ');

// A short name for this folder, in the health reply and the state file: a server is reused, reported
// or stopped only by the folder that started it (a copied out/ names another folder's server).
export function projectId(root: string): string {
  let path = resolve(root);
  try {
    path = realpathSync.native(path);
  } catch {
    // the path as resolved
  }
  return sha256(path).slice(0, 12);
}

// ---- What a request may name ----

// A message id as the manifest writes it: a Git path under corpus/, never a way out of it.
export function isMessageIdShape(id: string): boolean {
  return id.startsWith('corpus/') && !id.includes('..') && !id.includes('\\') && !/^[A-Za-z]:/.test(id) && !/[\u0000-\u001f\u007f]/.test(id);
}

// Windows device names, with or without an extension: never a file of ours, and on Windows a read
// of one would open the device.
const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;

// The file under `dir` a URL path names, or null: decoded, split on "/", every segment a plain name
// (not empty, no "." or ".." or other dot-name such as .server.json, no "\", ":" or control
// character, no Windows device name, no trailing dot or space), "/" for index.html, and the joined
// path inside `dir`.
export function staticPath(dir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/')) return null;
  const rest = decoded.slice(1);
  const segments = rest === '' ? ['index.html'] : rest.split('/');
  for (const s of segments) {
    if (s === '' || s.startsWith('.') || /[\\:\u0000-\u001f\u007f]/.test(s) || RESERVED.test(s) || /[. ]$/.test(s)) return null;
  }
  const file = join(dir, ...segments);
  return file.startsWith(dir + sep) ? file : null;
}

// Only this machine's names for this server: a page on another site that rebinds its own name to
// 127.0.0.1 sends its own Host and is refused.
const hostAllowed = (host: string | undefined, port: number): boolean =>
  host === undefined || [`${HOST}:${port}`, `localhost:${port}`].includes(host.toLowerCase());

// Whether an Accept-Encoding header accepts gzip: listed, with no q=0.
export function acceptsGzip(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header.join(',') : (header ?? '');
  for (const part of value.split(',')) {
    const [name = '', ...params] = part.split(';').map((p) => p.trim());
    if (name.toLowerCase() !== 'gzip') continue;
    const q = params.find((p) => /^q=/i.test(p));
    return q === undefined || Number(q.slice(2)) > 0;
  }
  return false;
}

// ---- The server ----

export type Running = { server: Server; port: number; url: string; corpus: Corpus; close: () => Promise<void> };

type Context = { root: string; dir: string; project: string; corpus: Corpus; entries: Map<string, CorpusEntry>; port: number; health: HealthCache };
type HealthCache = { key: string; run_id: string | null; data_sha: string | null };
type Reply = { status: number; type: string; body: Buffer; cache: 'no-cache' | 'no-store'; csp?: string; headers?: Record<string, string> };

const jsonReply = (status: number, value: unknown): Reply => ({ status, type: 'application/json', body: Buffer.from(JSON.stringify(value), 'utf8'), cache: 'no-store' });
const textReply = (status: number, text: string, cache: 'no-cache' | 'no-store' = 'no-cache'): Reply => ({ status, type: 'text/plain; charset=utf-8', body: Buffer.from(`${text}\n`, 'utf8'), cache });

async function send(req: IncomingMessage, res: ServerResponse, reply: Reply): Promise<void> {
  let body = reply.body;
  const headers: Record<string, string | number> = {
    'Content-Type': reply.type,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': reply.csp ?? SITE_CSP,
    'Cache-Control': reply.cache,
    'Referrer-Policy': 'no-referrer',
    ...reply.headers,
  };
  if (reply.type === 'application/json') {
    headers.Vary = 'Accept-Encoding';
    if (body.length > GZIP_MIN_BYTES && acceptsGzip(req.headers['accept-encoding'])) {
      body = await gzipAsync(body);
      headers['Content-Encoding'] = 'gzip';
    }
  }
  headers['Content-Length'] = body.length;
  res.writeHead(reply.status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function fileReply(file: string, csp?: string): Promise<Reply> {
  try {
    const s = await stat(file);
    if (!s.isFile()) return textReply(404, 'Not found');
    return { status: 200, type: typeOf(file), body: await readFile(file), cache: 'no-cache', ...(csp === undefined ? {} : { csp }) };
  } catch {
    return textReply(404, 'Not found');
  }
}

// The run id and the hash of data.json, read again only when the file changes.
function healthFacts(ctx: Context): { run_id: string | null; data_sha: string | null } {
  let key = 'none';
  try {
    const s = statSync(dataFile(ctx.root));
    key = `${s.size}:${s.mtimeMs}`;
  } catch {
    key = 'none';
  }
  if (key !== ctx.health.key) ctx.health = { key, run_id: runIdOf(ctx.root), data_sha: fileSha(dataFile(ctx.root)) };
  return { run_id: ctx.health.run_id, data_sha: ctx.health.data_sha };
}

function runIdOf(root: string): string | null {
  try {
    const data = JSON.parse(readText(dataFile(root)) ?? 'null') as { run?: { id?: unknown } } | null;
    return typeof data?.run?.id === 'string' ? data.run.id : null;
  } catch {
    return null;
  }
}

function apiReply(ctx: Context, url: URL): Reply {
  if (url.pathname === '/api/health') {
    return jsonReply(200, { ok: true, pid: process.pid, port: ctx.port, project: ctx.project, ...healthFacts(ctx), source: ctx.corpus.readFrom });
  }
  if (url.pathname !== '/api/message') return jsonReply(404, { error: 'not found' });
  const id = url.searchParams.get('id') ?? '';
  if (!isMessageIdShape(id)) return jsonReply(400, { error: 'not a message id' });
  const entry = ctx.entries.get(id);
  if (entry === undefined) return jsonReply(404, { error: 'no message with this id' });
  let bytes: Buffer;
  try {
    bytes = ctx.corpus.read(id);
  } catch {
    return jsonReply(500, { error: 'the message could not be read' });
  }
  return jsonReply(200, { id, size: bytes.length, blob_sha: entry.blob_sha, text: bytes.toString('utf8'), source: ctx.corpus.readFrom });
}

async function route(ctx: Context, req: IncomingMessage): Promise<Reply> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return { ...textReply(405, 'Method not allowed'), headers: { Allow: 'GET, HEAD' } };
  if (!hostAllowed(req.headers.host, ctx.port)) return textReply(403, 'Forbidden');
  const target = req.url ?? '';
  if (!target.startsWith('/')) return textReply(400, 'Bad request');
  let url: URL;
  try {
    url = new URL(`http://${HOST}${target}`);
  } catch {
    return textReply(400, 'Bad request');
  }
  if (url.pathname.startsWith('/api/')) return apiReply(ctx, url);
  if (url.pathname === '/report.html') return fileReply(join(ctx.root, 'out', 'report.html'), REPORT_CSP);
  if (url.pathname === '/report.md') return fileReply(join(ctx.root, 'out', 'report.md'));
  const file = staticPath(ctx.dir, url.pathname);
  return file === null ? textReply(404, 'Not found') : fileReply(file);
}

const portsTaken = (ports: readonly number[]): string =>
  ports.length === 1
    ? `port ${ports[0]} is in use on ${HOST}; choose another with --port N.`
    : `ports ${ports[0]} to ${ports[ports.length - 1]} are all in use on ${HOST}; choose another with --port N.`;

// Listen on 127.0.0.1 at the first free port of `ports`.
function listen(server: Server, ports: readonly number[]): Promise<number> {
  return new Promise((resolve, reject) => {
    let i = 0;
    const next = (): void => {
      const port = ports[i] as number;
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off('listening', onListening);
        const taken = err.code === 'EADDRINUSE' || err.code === 'EACCES';
        if (taken && i + 1 < ports.length) {
          i++;
          next();
        } else reject(taken ? new PortsTakenError(portsTaken(ports)) : err);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve((server.address() as AddressInfo).port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, HOST);
    };
    next();
  });
}

// Checks the built data and opens the corpus once (the one reader: disk on a macOS or Linux clone,
// Git objects on Windows). Throws ServeError, one line.
function openFor(root: string): Corpus {
  if (!existsSync(dataFile(root))) throw new ServeError(DATA_MISSING);
  try {
    return openCorpus(root);
  } catch (err) {
    if (err instanceof CorpusError) throw new ServeError(oneLine(err.message));
    throw err;
  }
}

// The server, listening. `port` (0: the OS picks) or `ports` in order; default 8765 to 8775. Writes
// no state file: the command claims it (claimState).
export async function createServer(root: string, opts: { port?: number; ports?: readonly number[] } = {}): Promise<Running> {
  const corpus = openFor(root);
  const ctx: Context = {
    root,
    dir: dashboardDir(root),
    project: projectId(root),
    corpus,
    entries: new Map(corpus.entries.map((e) => [e.id, e])),
    port: 0,
    health: { key: '', run_id: null, data_sha: null },
  };
  const server = createHttpServer((req, res) => {
    route(ctx, req)
      .then((reply) => send(req, res, reply))
      .catch(() => {
        if (!res.headersSent) void send(req, res, textReply(500, 'Server error', 'no-store'));
        else res.destroy();
      });
  });
  ctx.port = await listen(server, opts.port !== undefined ? [opts.port] : (opts.ports ?? DEFAULT_PORTS));
  const url = `http://${HOST}:${ctx.port}/`;
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return { server, port: ctx.port, url, corpus, close };
}

// ---- The state file and the health check ----

export type ServerState = { pid: number; port: number; url: string; project: string | null; run_id: string | null; started_utc: string };

export function readState(root: string): ServerState | null {
  try {
    const s = JSON.parse(readText(stateFile(root)) ?? 'null') as Partial<ServerState> | null;
    if (s === null || typeof s !== 'object') return null;
    const { pid, port } = s;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return {
      pid,
      port,
      url: `http://${HOST}:${port}/`,
      project: typeof s.project === 'string' ? s.project : null,
      run_id: typeof s.run_id === 'string' ? s.run_id : null,
      started_utc: String(s.started_utc ?? ''),
    };
  } catch {
    return null;
  }
}

export type Health = { ok: true; pid: number; port: number; project: string; run_id: string | null; data_sha: string | null; source: string };

// GET /api/health on 127.0.0.1:<port>; null when nothing answers within the timeout. A fresh
// connection, closed after, so the caller's process can exit at once.
export function health(port: number, timeoutMs = 1000): Promise<Health | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: Health | null): void => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(v);
      }
    };
    const req = request({ host: HOST, port, path: '/api/health', method: 'GET', agent: false, headers: { connection: 'close' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Health;
          finish(res.statusCode === 200 && v?.ok === true && typeof v.pid === 'number' ? v : null);
        } catch {
          finish(null);
        }
      });
      res.on('error', () => finish(null));
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(null);
    }, timeoutMs);
    req.on('error', () => finish(null));
    req.end();
  });
}

// Whether a process with this pid exists (one we may not signal counts).
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Whether the server a state file names answers as itself for this folder: its health names the
// recorded pid and this folder's project id. A slow answer is asked again, with a longer wait, while
// the process is alive, so one busy moment does not lose a live server.
async function answers(s: ServerState, project: string): Promise<boolean> {
  if (s.project !== project) return false;
  const ok = (h: Health | null): boolean => h !== null && h.pid === s.pid && h.project === project;
  if (ok(await health(s.port, 1000))) return true;
  return alive(s.pid) && ok(await health(s.port, 3000));
}

// The server this folder's state file names, when it answers as itself.
export async function runningServer(root: string): Promise<ServerState | null> {
  const s = readState(root);
  return s !== null && (await answers(s, projectId(root))) ? s : null;
}

// Removes the state file if it still holds what was judged stale: the same pid, or nothing readable.
function removeIfStill(root: string, judged: ServerState | null): void {
  if (!existsSync(stateFile(root))) return;
  const now = readState(root);
  if (judged === null ? now === null : now?.pid === judged.pid) removeFile(stateFile(root));
}

// Records this server in .server.json unless another live server of this folder holds it. The file
// is linked into place, which fails when one exists, so two servers started at once cannot both
// claim it: the later one finds the earlier answering and steps aside (false). A file naming a
// server that is gone or does not answer as this folder's is stale and replaced.
export async function claimState(root: string, running: Running): Promise<boolean> {
  const file = stateFile(root);
  const project = projectId(root);
  const state: ServerState = { pid: process.pid, port: running.port, url: running.url, project, run_id: runIdOf(root), started_utc: nowUtc() };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        linkSync(tmp, file);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          // A file system without hard links: replaced in one step instead.
          renameSync(tmp, file);
          return true;
        }
      }
      const other = readState(root);
      if (other !== null && other.pid !== process.pid && (await answers(other, project))) return false;
      removeIfStill(root, other);
    }
    throw new ServeError('could not record the server in out/dashboard/.server.json');
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Removes the state file only while it names this process (a newer server's file stays).
function removeOwnState(root: string): void {
  if (readState(root)?.pid === process.pid) removeFile(stateFile(root));
}

// ---- Opening the browser (best effort; the printed URL is the contract) ----

export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => { on?: (event: 'error', listener: () => void) => unknown; unref?: () => void };

export function browserCommand(url: string, platform: string): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

// Tries once, detached and silent; every error is swallowed (a headless Linux has no xdg-open).
export function openBrowser(url: string, spawnFn: SpawnLike = spawn, platform: string = process.platform): void {
  try {
    const { command, args } = browserCommand(url, platform);
    const child = spawnFn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on?.('error', () => {});
    child.unref?.();
  } catch {
    // best effort: the URL is printed either way
  }
}

// ---- The command ----

type ServeArgs = { port?: number; ports?: [number, number]; background: boolean; open: boolean; stop: boolean; status: boolean; child: boolean };

export function parseServeArgs(args: readonly string[]): ServeArgs {
  const o: ServeArgs = { background: false, open: false, stop: false, status: false, child: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--background') o.background = true;
    else if (a === '--open') o.open = true;
    else if (a === '--stop') o.stop = true;
    else if (a === '--status') o.status = true;
    else if (a === '--child') o.child = true;
    else if (a === '--port') {
      const v = args[++i];
      if (v === undefined || !/^\d{1,5}$/.test(v) || Number(v) > 65535) throw new ServeError(`--port takes a number from 0 to 65535. ${SERVE_USAGE}`);
      o.port = Number(v);
    } else if (a === '--ports') {
      const m = /^(\d{1,5})-(\d{1,5})$/.exec(args[++i] ?? '');
      const [first, last] = m === null ? [0, 0] : [Number(m[1]), Number(m[2])];
      if (first < 1 || last < first || last > 65535 || last - first > 100) throw new ServeError(`--ports takes a range such as 8765-8775 (at most 101 ports). ${SERVE_USAGE}`);
      o.ports = [first, last];
    } else throw new ServeError(`unexpected argument "${a}". ${SERVE_USAGE}`);
  }
  if (o.port !== undefined && o.ports !== undefined) throw new ServeError(`--port and --ports cannot go together. ${SERVE_USAGE}`);
  const others = o.background || o.open || o.child || o.port !== undefined || o.ports !== undefined;
  if ((o.stop || o.status) && ((o.stop && o.status) || others)) throw new ServeError(`--stop and --status take no other option. ${SERVE_USAGE}`);
  if (o.child && (o.background || o.open)) throw new ServeError(`--child is the background server itself and takes only --port or --ports. ${SERVE_USAGE}`);
  return o;
}

const portsOf = (o: ServeArgs): readonly number[] =>
  o.port !== undefined ? [o.port] : o.ports !== undefined ? Array.from({ length: o.ports[1] - o.ports[0] + 1 }, (_, i) => (o.ports as [number, number])[0] + i) : DEFAULT_PORTS;
const portArgs = (o: ServeArgs): string[] =>
  o.port !== undefined ? ['--port', String(o.port)] : o.ports !== undefined ? ['--ports', `${o.ports[0]}-${o.ports[1]}`] : [];

// Removes the state file on Ctrl+C, a termination signal or exit.
function cleanUpOnExit(root: string, running: Running): void {
  process.once('exit', () => removeOwnState(root));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      removeOwnState(root);
      running.server.closeAllConnections();
      running.server.close();
      process.exit(0);
    });
  }
}

// The detached child: listen (scanning the ports itself), claim the state file, keep serving. Its
// exit code tells the parent why it stopped: every port taken, or another server already up.
async function runChild(root: string, o: ServeArgs): Promise<number> {
  let running: Running;
  try {
    running = await createServer(root, { ports: portsOf(o) });
  } catch (err) {
    if (err instanceof PortsTakenError) return EXIT_PORTS_TAKEN;
    throw err;
  }
  if (!(await claimState(root, running))) {
    await running.close();
    return EXIT_ALREADY_RUNNING;
  }
  cleanUpOnExit(root, running);
  return 0;
}

const announce = (url: string, o: ServeArgs, already: boolean): number => {
  console.log(`Dashboard: ${url}${already ? ' (already running)' : ''}`);
  if (o.open) openBrowser(url);
  return 0;
};

async function startBackground(root: string, o: ServeArgs): Promise<number> {
  const up = await runningServer(root);
  if (up !== null) return announce(up.url, o, true);
  openFor(root);
  const child = spawn(process.execPath, [join(root, 'obs.mjs'), 'serve', '--child', ...portArgs(o)], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  let exitCode: number | null = null;
  child.once('exit', (code) => (exitCode = code ?? 1));
  child.once('error', () => (exitCode = 1));
  child.unref();
  const deadline = performance.now() + START_WAIT_MS;
  while (performance.now() < deadline) {
    if (exitCode !== null) {
      // Another start may have won the race for this folder: then the dashboard is up.
      const other = await runningServer(root);
      if (other !== null) return announce(other.url, o, true);
      console.error(exitCode === EXIT_PORTS_TAKEN ? `serve: ${portsTaken(portsOf(o))}` : 'serve: the server stopped as it started; run node obs.mjs serve to see why.');
      return 1;
    }
    const s = readState(root);
    if (s !== null && s.pid === child.pid) {
      const h = await health(s.port, 1000);
      if (h !== null && h.pid === child.pid) return announce(s.url, o, false);
    }
    await delay(POLL_MS);
  }
  if (child.pid !== undefined) {
    try {
      process.kill(child.pid);
    } catch {
      // already gone
    }
  }
  console.error(`serve: the server did not answer within ${START_WAIT_MS / 1000} s`);
  return 1;
}

async function stopServer(root: string): Promise<number> {
  const s = readState(root);
  if (s === null || !(await answers(s, projectId(root)))) {
    // Nothing of this folder's answers there: a stale file is removed, and no process is signalled
    // (its pid may belong to something else by now, or to another folder's server).
    removeIfStill(root, s);
    console.log('serve: not running');
    return 0;
  }
  try {
    process.kill(s.pid);
  } catch {
    // already gone
  }
  const deadline = performance.now() + STOP_WAIT_MS;
  let answering = true;
  while (performance.now() < deadline) {
    const again = await health(s.port, 300);
    if (again === null || again.pid !== s.pid) {
      answering = false;
      break;
    }
    await delay(POLL_MS);
  }
  // On Windows the kill runs no handler in the server, so the file is removed here on every OS.
  if (!answering) removeIfStill(root, s);
  if (answering) {
    console.error(`serve: the server (process ${s.pid}) did not stop within ${STOP_WAIT_MS / 1000} s`);
    return 1;
  }
  console.log('serve: stopped');
  return 0;
}

export async function serveCommand(root: string, args: readonly string[]): Promise<number> {
  try {
    const o = parseServeArgs(args);
    if (o.stop) return await stopServer(root);
    if (o.status) {
      const up = await runningServer(root);
      console.log(up === null ? 'serve: not running' : `Dashboard: ${up.url}`);
      return 0;
    }
    if (o.child) return await runChild(root, o);
    if (o.background) return await startBackground(root, o);
    const up = await runningServer(root);
    if (up !== null) return announce(up.url, o, true);
    const running = await createServer(root, { ports: portsOf(o) });
    if (!(await claimState(root, running))) {
      await running.close();
      const other = await runningServer(root);
      return announce(other?.url ?? running.url, o, true);
    }
    cleanUpOnExit(root, running);
    console.log(`Dashboard: ${running.url}`);
    console.log('Press Ctrl+C to stop.');
    if (o.open) openBrowser(running.url);
    return 0;
  } catch (err) {
    if (err instanceof ServeError) {
      console.error(`serve: ${withoutRoot(oneLine(err.message), root)}`);
      return 1;
    }
    throw err;
  }
}
