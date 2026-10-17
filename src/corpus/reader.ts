// The one place that reads corpus bytes; nothing else opens corpus/ paths.
//
// Listing: from Git HEAD when the folder is a Git checkout, otherwise by walking corpus/ on disk.
// Reading: from disk when every listed file is there (macOS, Linux), from Git objects when none
// are (Windows, where names ending in a dot cannot exist on disk).
// Either way a message's ID is its exact Git path, e.g. "corpus/farmer-d/logistics/1.".
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gitBlobSha } from '../util/hash.ts';

export type CorpusEntry = { id: string; blob_sha: string; size: number };
export type Source = 'git' | 'disk';

export class CorpusError extends Error {
  override name = 'CorpusError';
}

const CLONE_HINT =
  'On Windows, clone with the recipe in README.md: the corpus file names end in a dot, which Windows cannot create, ' +
  'so the corpus stays in Git objects and is read from there.';

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function git(root: string, args: string[], input?: string) {
  return spawnSync('git', args, { cwd: root, input, maxBuffer: 512 * 1024 * 1024 });
}

// True only when `root` itself is the top of a Git checkout (not some parent repo).
function isGitCheckout(root: string): boolean {
  const r = git(root, ['rev-parse', '--show-toplevel']);
  if (r.status !== 0) return false;
  const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return norm(r.stdout.toString().trim()) === norm(root);
}

function listFromGit(root: string): CorpusEntry[] {
  const r = git(root, ['ls-tree', '-r', '-l', '-z', 'HEAD', '--', 'corpus']);
  if (r.status !== 0) throw new CorpusError(`git ls-tree failed: ${r.stderr.toString().trim()}`);
  const entries: CorpusEntry[] = [];
  for (const record of r.stdout.toString('utf8').split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [, type, oid, size] = record.slice(0, tab).trim().split(/\s+/);
    if (type !== 'blob' || oid === undefined || size === undefined) continue;
    entries.push({ id: record.slice(tab + 1), blob_sha: oid, size: Number(size) });
  }
  return entries.sort(byId);
}

// Without Git: every file under corpus/, skipping hidden names such as .DS_Store.
function listFromDisk(root: string): CorpusEntry[] {
  const dir = join(root, 'corpus');
  if (!existsSync(dir)) {
    throw new CorpusError(`No corpus found: corpus/ is not on disk and this folder is not a Git checkout. ${CLONE_HINT}`);
  }
  const entries: CorpusEntry[] = [];
  for (const rel of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const parts = rel.split(/[\\/]/);
    if (parts.some((p) => p.startsWith('.'))) continue;
    const abs = join(dir, rel);
    if (!statSync(abs).isFile()) continue;
    const bytes = readFileSync(abs);
    entries.push({ id: `corpus/${parts.join('/')}`, blob_sha: gitBlobSha(bytes), size: bytes.length });
  }
  return entries.sort(byId);
}

// Parse `git cat-file --batch` output: "<oid> blob <size>\n<bytes>\n" repeated.
function catFileBatch(root: string, oids: string[]): Buffer[] {
  if (oids.length === 0) return [];
  const r = git(root, ['cat-file', '--batch'], `${oids.join('\n')}\n`);
  if (r.status !== 0) throw new CorpusError(`git cat-file failed: ${r.stderr.toString().trim()}`);
  const out = r.stdout;
  const blobs: Buffer[] = [];
  let pos = 0;
  for (const oid of oids) {
    const eol = out.indexOf(0x0a, pos);
    const header = out.subarray(pos, eol).toString();
    const [gotOid, type, size] = header.split(' ');
    if (gotOid !== oid || type !== 'blob' || size === undefined) {
      throw new CorpusError(`git cat-file returned "${header}" for ${oid}`);
    }
    const start = eol + 1;
    blobs.push(out.subarray(start, start + Number(size)));
    pos = start + Number(size) + 1;
  }
  return blobs;
}

export class Corpus {
  readonly root: string;
  readonly entries: readonly CorpusEntry[];
  readonly listedFrom: Source;
  readonly readFrom: Source;
  readonly #byId: Map<string, CorpusEntry>;

  constructor(root: string, entries: CorpusEntry[], listedFrom: Source, readFrom: Source) {
    this.root = root;
    this.entries = entries;
    this.listedFrom = listedFrom;
    this.readFrom = readFrom;
    this.#byId = new Map(entries.map((e) => [e.id, e]));
  }

  #entry(id: string): CorpusEntry {
    const entry = this.#byId.get(id);
    if (entry === undefined) throw new CorpusError(`Unknown message ID: ${id}`);
    return entry;
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  read(id: string): Buffer {
    const entry = this.#entry(id);
    if (this.readFrom === 'disk') return readFileSync(join(this.root, entry.id));
    const [bytes] = catFileBatch(this.root, [entry.blob_sha]);
    return bytes as Buffer;
  }

  // All messages in ID order. One git process on Windows instead of 3,240.
  readAll(): Map<string, Buffer> {
    const blobs =
      this.readFrom === 'disk'
        ? this.entries.map((e) => readFileSync(join(this.root, e.id)))
        : catFileBatch(this.root, this.entries.map((e) => e.blob_sha));
    return new Map(this.entries.map((e, i) => [e.id, blobs[i] as Buffer]));
  }

  // Do the bytes we read hash to the blob IDs Git lists? Only meaningful when listed from Git.
  verify(): { checkedAgainstGit: boolean; mismatches: string[] } {
    const mismatches: string[] = [];
    for (const [id, bytes] of this.readAll()) {
      if (gitBlobSha(bytes) !== this.#entry(id).blob_sha) mismatches.push(id);
    }
    return { checkedAgainstGit: this.listedFrom === 'git', mismatches };
  }
}

export function openCorpus(root: string, options: { readFrom?: Source } = {}): Corpus {
  const listedFrom: Source = isGitCheckout(root) ? 'git' : 'disk';
  const entries = listedFrom === 'git' ? listFromGit(root) : listFromDisk(root);
  if (entries.length === 0) throw new CorpusError(`The corpus is empty: no files under corpus/ in ${listedFrom}.`);
  if (listedFrom === 'disk') {
    if (options.readFrom === 'git') throw new CorpusError('Cannot read from Git: this folder is not a Git checkout.');
    return new Corpus(root, entries, 'disk', 'disk');
  }
  const onDisk = entries.filter((e) => existsSync(join(root, e.id))).length;
  let readFrom: Source;
  if (options.readFrom !== undefined) readFrom = options.readFrom;
  else if (onDisk === entries.length) readFrom = 'disk';
  else if (onDisk === 0) readFrom = 'git';
  else {
    throw new CorpusError(
      `${entries.length - onDisk} of ${entries.length} corpus files are missing from disk. ` +
        `Restore them with "git checkout -- corpus", or on Windows remove the partial copy and use the clone recipe in README.md.`,
    );
  }
  if (readFrom === 'disk' && onDisk !== entries.length) {
    throw new CorpusError(`Cannot read from disk: ${entries.length - onDisk} corpus files are not there. ${CLONE_HINT}`);
  }
  return new Corpus(root, entries, 'git', readFrom);
}
