// The static copy of the dashboard for the project site (ARCHITECTURE.md 6.13). The dashboard the
// brief asks for is `node obs.mjs serve` on localhost; its pages are static files with relative
// paths, and the one thing they ask the server for is a message's text (GET /api/message). The copy
// answers that from files: the built out/dashboard/ copied byte for byte, its index.html marked with
// data-static="1" (dashboard/viewer.js then reads messages from files instead of the server), and
// every message of out/manifest.json written once as the JSON the server would return, at
// m/<path>.json beside the page. It works on any static host and under any base path.
//
// The message bytes come from the one corpus reader (openCorpus): from disk where the corpus files
// exist, from Git objects where they cannot (Windows). Nothing here opens corpus/ itself.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { openCorpus, type CorpusEntry } from '../src/corpus/reader.ts';
import { isMessageIdShape } from '../src/serve/server.ts';
import { gitBlobSha } from '../src/util/hash.ts';
import { isReservedName } from '../src/util/slug.ts';

export type StaticDashboard = { messages: number; files: number; bytes: number };

// The page's opening tag, and the same tag marked as the static copy.
export const PAGE_TAG = '<html lang="en">';
export const STATIC_PAGE_TAG = '<html lang="en" data-static="1">';
// The folder of the copy that holds the messages, beside the page.
export const MESSAGES_DIR = 'm';

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim();
const reason = (err: unknown): string => oneLine(err instanceof Error ? err.message : String(err));

// The rule of dashboard/viewer.js staticMessagePath, with the segments as they are written to disk
// (the viewer URL-encodes each one): the id after "corpus/", one trailing dot dropped, ".json"
// added, under m/. "corpus/farmer-d/logistics/1." is "m/farmer-d/logistics/1.json".
export function staticMessagePath(id: string): string {
  if (!isMessageIdShape(id)) throw new Error(`not a message id: ${JSON.stringify(id)}`);
  return `${MESSAGES_DIR}/${id.slice('corpus/'.length).replace(/\.$/, '')}.json`;
}

// Windows device names beyond the slug function's list (src/util/slug.ts): COM0, LPT0 and the
// superscript-digit forms.
const MORE_DEVICES = /^(?:com|lpt)[0-9¹²³]$/i;

// A name every OS can write and every static host serves: not empty, not a dot-name (".", "..",
// or hidden), none of \ / : * ? " < > | or a control character, not a Windows device name (with
// or without an extension), no trailing dot or space.
function badSegment(s: string): boolean {
  const stem = s.split('.')[0] ?? '';
  return s === '' || s.startsWith('.') || /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(s) || isReservedName(stem) || MORE_DEVICES.test(stem) || /[. ]$/.test(s);
}

// A folder as the file system names it, for comparing two folders: the nearest part that exists
// resolved through links and short names, the rest appended, and lowercased (Windows and macOS
// compare names without case; on Linux this only refuses more).
function folderKey(p: string): string {
  let head = resolve(p);
  const rest: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  try {
    head = realpathSync.native(head);
  } catch {
    // the path as resolved
  }
  return join(head, ...rest).toLowerCase();
}

// Every file under `dir` as a "/" path relative to it, sorted; hidden names (the server's state
// file .server.json while a server runs) are left out, as the server never serves them.
function filesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[])
    .map((p) => p.replaceAll('\\', '/'))
    .filter((p) => !p.split('/').some((s) => s.startsWith('.')) && statSync(join(dir, ...p.split('/'))).isFile())
    .sort();
}

function readManifest(outDir: string): CorpusEntry[] {
  const file = join(outDir, 'manifest.json');
  if (!existsSync(file)) throw new Error('manifest.json is missing from the output folder: run node obs.mjs prepare (and the run) first.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`manifest.json does not parse: ${reason(err)}`);
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('manifest.json lists no messages.');
  for (const e of entries as Array<Partial<CorpusEntry> | null>) {
    if (e === null || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.blob_sha !== 'string' || typeof e.size !== 'number') {
      throw new Error(`manifest.json has an entry that is not {id, blob_sha, size}: ${JSON.stringify(e)}`);
    }
  }
  return entries as CorpusEntry[];
}

// Each manifest id with the file it is written to. Throws when an id fails the server's shape rule,
// a path has a name some OS or host cannot hold, or two ids would share a file: compared without
// case, as the Windows and macOS file systems compare names, and a file never where another id
// needs a folder.
function messagePaths(entries: readonly CorpusEntry[]): Array<{ entry: CorpusEntry; rel: string }> {
  const files = new Map<string, string>();
  const folders = new Map<string, string>();
  const jobs = entries.map((entry) => {
    if (!isMessageIdShape(entry.id)) throw new Error(`manifest.json lists ${JSON.stringify(entry.id)}, which is not a message id.`);
    const rel = staticMessagePath(entry.id);
    const segments = rel.split('/');
    const bad = segments.find(badSegment);
    if (bad !== undefined) throw new Error(`${entry.id} would be written as ${rel}, and ${JSON.stringify(bad)} is not a name every system can hold.`);
    const key = rel.toLowerCase();
    const other = files.get(key);
    if (other !== undefined) throw new Error(`${other} and ${entry.id} would be written to one file, ${rel}.`);
    files.set(key, entry.id);
    for (let i = 1; i < segments.length; i++) folders.set(segments.slice(0, i).join('/').toLowerCase(), entry.id);
    return { entry, rel };
  });
  for (const [key, id] of files) {
    const other = folders.get(key);
    if (other !== undefined) throw new Error(`${id} would be written as a file where ${other} needs a folder.`);
  }
  return jobs;
}

// The page with its opening tag marked; throws unless the tag is there exactly once, so a changed
// page is noticed instead of copied unmarked.
function markPage(page: Buffer): Buffer {
  const at = page.indexOf(PAGE_TAG);
  if (at === -1 || page.indexOf(PAGE_TAG, at + 1) !== -1) {
    throw new Error(`index.html of the built dashboard must hold ${PAGE_TAG} exactly once, to be marked as the static copy.`);
  }
  return Buffer.concat([page.subarray(0, at), Buffer.from(STATIC_PAGE_TAG, 'utf8'), page.subarray(at + PAGE_TAG.length)]);
}

const inside = (a: string, b: string): boolean => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);

/**
 * Writes the static copy of the built dashboard at <distDir>/dashboard/ and returns what it wrote:
 * the messages, the files (dashboard files, the report and the messages) and their bytes. A copy
 * left there by an earlier call is replaced; any other folder by that name is refused, never
 * removed. <outDir>/report.html, which the page links to as "report.html", is copied beside the
 * page when it exists. Two calls on the same inputs write the same bytes. Throws an Error with a
 * one-line message when <outDir>/dashboard/data.json or <outDir>/manifest.json is missing, when an
 * id fails the shape rule, when two ids map to one path, or when the corpus does not hold the
 * manifest's messages.
 */
export function writeStaticDashboard(root: string, outDir: string, distDir: string): StaticDashboard {
  const src = resolve(outDir, 'dashboard');
  const dest = resolve(distDir, 'dashboard');
  if (!existsSync(join(src, 'data.json'))) throw new Error('dashboard/data.json is missing from the output folder: run node obs.mjs build (after a complete run) first.');
  const [srcKey, destKey] = [folderKey(src), folderKey(dest)];
  if (inside(destKey, srcKey) || inside(srcKey, destKey)) throw new Error('the site folder and the output folder overlap: write the copy somewhere else.');
  const pages = filesUnder(src);
  if (!pages.includes('index.html')) throw new Error('dashboard/index.html is missing from the output folder: run node obs.mjs build first.');
  if (pages.some((p) => p.split('/')[0]?.toLowerCase() === MESSAGES_DIR)) throw new Error(`the built dashboard already has ${MESSAGES_DIR}/, where the copy writes its messages.`);
  // Everything is read before an earlier copy is removed, so a failed read leaves that copy whole.
  const copied = pages.map((p): [string, Buffer] => [p, p === 'index.html' ? markPage(readFileSync(join(src, 'index.html'))) : readFileSync(join(src, ...p.split('/')))]);
  const report = join(resolve(outDir), 'report.html');
  if (existsSync(report) && !pages.includes('report.html')) copied.push(['report.html', readFileSync(report)]);

  const jobs = messagePaths(readManifest(outDir));
  let texts: Map<string, Buffer>;
  try {
    const corpus = openCorpus(root);
    const listed = new Map(corpus.entries.map((e) => [e.id, e]));
    for (const { entry } of jobs) {
      const there = listed.get(entry.id);
      if (there === undefined) throw new Error(`${entry.id} is in manifest.json but not in the corpus: the output folder was built from another archive.`);
      if (there.blob_sha !== entry.blob_sha) throw new Error(`${entry.id} in manifest.json does not match the corpus: run the pipeline again.`);
    }
    texts = corpus.readMany(jobs.map((j) => j.entry.id));
  } catch (err) {
    throw new Error(reason(err));
  }
  for (const { entry } of jobs) {
    if (gitBlobSha(texts.get(entry.id) as Buffer) !== entry.blob_sha) throw new Error(`${entry.id} read from the corpus does not hash to its blob id: the file on disk differs from Git, or the corpus reader is broken.`);
  }

  // Replace only an earlier copy: its page carries the mark.
  if (existsSync(dest)) {
    if (!statSync(dest).isDirectory()) throw new Error('the site folder already has a file named dashboard: remove it or choose another folder.');
    const earlier = join(dest, 'index.html');
    const isCopy = existsSync(earlier) && readFileSync(earlier).includes(STATIC_PAGE_TAG);
    if (!isCopy && readdirSync(dest).length > 0) throw new Error('the site folder already has a dashboard/ that is not a static copy: remove it or choose another folder.');
    rmSync(dest, { recursive: true, force: true });
  }

  const made = new Set<string>();
  let files = 0;
  let bytes = 0;
  const write = (rel: string, data: Buffer | string): void => {
    const file = join(dest, ...rel.split('/'));
    const dir = dirname(file);
    if (!made.has(dir)) {
      mkdirSync(dir, { recursive: true });
      made.add(dir);
    }
    writeFileSync(file, data);
    files++;
    bytes += typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length;
  };
  for (const [p, data] of copied) write(p, data);
  for (const { entry, rel } of jobs) {
    const text = texts.get(entry.id) as Buffer;
    // The server's reply (src/serve/server.ts, /api/message), key for key, with "static" as its source.
    write(rel, JSON.stringify({ id: entry.id, size: text.length, blob_sha: entry.blob_sha, text: text.toString('utf8'), source: 'static' }));
  }
  return { messages: jobs.length, files, bytes };
}
