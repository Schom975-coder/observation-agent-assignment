// Publishes the built site as one commit on the gh-pages branch, without a checkout:
//   node site/publish.ts [--dist site/dist] [--branch gh-pages] [--message <text>]
//
// Git plumbing only, spawned with argv arrays (never a shell): `git hash-object -w --no-filters
// --stdin-paths` stores every file of the dist in batches (thousands of small files, one process
// per batch, bytes exactly as on disk, fonts and PNGs included); `git mktree --batch` builds the
// trees bottom-up, one process per depth; `git commit-tree` makes the commit with the branch's
// current commit as its parent (the local branch, or origin's copy of it in a fresh clone), so its
// history continues and no force is ever needed; `git update-ref` moves the branch only if it still
// points where it did. It prints the new commit and the push command, and never pushes.
//
// Refuses: a missing or empty dist; a dist that still shows placeholder markers or the "not
// committed yet" banner, or whose index names no run (a lenient build: publish a --strict one); a
// detached HEAD; a branch name Git would refuse, one written as a full ref, main or master, or a
// branch checked out in any worktree (moving it would change that checkout). Warns, without
// refusing, when site/ has uncommitted changes. Whether HEAD's branch holds the commit the dist was
// built from is not checked: the dist records the run it shows (its obs-run meta tag), not the
// commit of its sources.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class PublishError extends Error {
  override name = 'PublishError';
}

export type PublishOptions = { repo?: string; dist?: string; branch?: string; message?: string; log?: (line: string) => void };
export type PublishResult = { commit: string; tree: string; parent: string | null; files: number; unchanged: boolean; warnings: string[] };

const HERE = dirname(fileURLToPath(import.meta.url));
const BATCH = 1000;
const PROTECTED = ['main', 'master'];

function git(repo: string, args: string[], input?: string): string {
  const r = spawnSync('git', args, { cwd: repo, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error !== undefined) throw new PublishError(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) throw new PublishError(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim().split('\n')[0] ?? `exit ${r.status}`}`);
  return r.stdout;
}

function tryGit(repo: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Every file under `dir`, as "/" paths relative to it, sorted. A name Git's tree format cannot carry
// as written (a line break, a tab, a quote, a backslash, a control character) is refused before
// anything is read.
function listFiles(dir: string): string[] {
  const names = (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[]).map((p) => p.split(sep).join('/'));
  for (const f of names) {
    if (/[\u0000-\u001f\u007f"\\]/.test(f)) throw new PublishError(`cannot publish a file named ${JSON.stringify(f)}`);
  }
  return names.filter((p) => statSync(join(dir, ...p.split('/'))).isFile()).sort();
}

// A lenient build shows its gaps; the site published is a --strict one.
function checkFinished(dist: string, files: readonly string[]): void {
  const index = join(dist, 'index.html');
  if (!existsSync(index) || !/<meta name="obs-run" content="[^"]+">/.test(readFileSync(index, 'utf8'))) {
    throw new PublishError('the site names no run (its index.html has no obs-run tag): build it with node site/build.ts --strict');
  }
  const unfinished = files.filter((f) => f.endsWith('.html') && !f.startsWith('dashboard/') && /<mark class="fill">|<p class="banner">/.test(readFileSync(join(dist, ...f.split('/')), 'utf8')));
  if (unfinished.length > 0) throw new PublishError(`${unfinished.length} pages still show placeholders (${unfinished.slice(0, 3).join(', ')}): build the site with node site/build.ts --strict`);
}

function checkBranch(repo: string, branch: string, head: string): void {
  if (branch.startsWith('refs/') || tryGit(repo, ['check-ref-format', '--branch', branch]) === null) throw new PublishError(`not a usable branch name: ${branch} (give the short name, such as gh-pages)`);
  if (PROTECTED.includes(branch)) throw new PublishError(`refusing to publish onto ${branch}`);
  if (branch === head) throw new PublishError(`refusing to publish onto ${branch}: it is the branch checked out here`);
  const worktrees = tryGit(repo, ['worktree', 'list', '--porcelain']) ?? '';
  if (worktrees.split('\n').includes(`branch refs/heads/${branch}`)) throw new PublishError(`refusing to publish onto ${branch}: it is checked out in a worktree`);
}

export function publish(opts: PublishOptions = {}): PublishResult {
  const repo = resolve(opts.repo ?? dirname(HERE));
  const dist = resolve(opts.dist ?? join(repo, 'site', 'dist'));
  const branch = opts.branch ?? 'gh-pages';
  const log = opts.log ?? (() => {});
  const warnings: string[] = [];
  if (!existsSync(dist) || !statSync(dist).isDirectory()) throw new PublishError(`${dist} is missing: run node site/build.ts --strict first`);
  const files = listFiles(dist);
  if (files.length === 0) throw new PublishError(`${dist} is empty: run node site/build.ts --strict first`);
  checkFinished(dist, files);
  const head = tryGit(repo, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (head === null) throw new PublishError('HEAD is detached: check out the branch the site was built from');
  checkBranch(repo, branch, head);
  const dirty = tryGit(repo, ['status', '--porcelain', '--', 'site']);
  if (dirty !== null && dirty !== '') {
    warnings.push('site/ has uncommitted changes: the published site may not match a commit');
    log('warning: site/ has uncommitted changes: the published site may not match a commit');
  }

  // Blobs, in batches: one hash-object process per BATCH paths.
  const blobs = new Map<string, string>();
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const paths = batch.map((f) => join(dist, ...f.split('/')).split(sep).join('/'));
    const out = git(repo, ['hash-object', '-w', '--no-filters', '--stdin-paths'], `${paths.join('\n')}\n`).trim().split('\n');
    if (out.length !== batch.length) throw new PublishError(`git hash-object returned ${out.length} ids for ${batch.length} files`);
    batch.forEach((f, k) => blobs.set(f, (out[k] as string).trim()));
  }

  // Trees, bottom-up: every folder's entries, then one mktree --batch per depth, deepest first.
  const entries = new Map<string, string[]>([['', []]]);
  const addDir = (d: string): void => {
    if (entries.has(d)) return;
    entries.set(d, []);
    addDir(d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '');
  };
  for (const f of files) {
    const d = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    addDir(d);
    (entries.get(d) as string[]).push(`100644 blob ${blobs.get(f) as string}\t${f.slice(d === '' ? 0 : d.length + 1)}`);
  }
  const depth = (d: string): number => (d === '' ? 0 : d.split('/').length);
  const trees = new Map<string, string>();
  const dirs = [...entries.keys()];
  for (let level = Math.max(...dirs.map(depth)); level >= 0; level--) {
    const here = dirs.filter((d) => depth(d) === level).sort();
    for (const d of dirs.filter((x) => depth(x) === level + 1)) {
      const parent = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
      (entries.get(parent) as string[]).push(`040000 tree ${trees.get(d) as string}\t${d.slice(parent === '' ? 0 : parent.length + 1)}`);
    }
    const input = here.map((d) => `${(entries.get(d) as string[]).join('\n')}\n`).join('\n');
    const out = git(repo, ['mktree', '--batch'], input).trim().split('\n');
    if (out.length !== here.length) throw new PublishError(`git mktree returned ${out.length} trees for ${here.length} folders`);
    here.forEach((d, k) => trees.set(d, (out[k] as string).trim()));
  }
  const tree = trees.get('') as string;

  // The parent: the local branch, else origin's copy of it (a fresh clone has no local gh-pages,
  // and a commit without a parent there would need a force push).
  const ref = `refs/heads/${branch}`;
  const local = tryGit(repo, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]);
  const remote = local === null ? tryGit(repo, ['rev-parse', '-q', '--verify', `refs/remotes/origin/${branch}^{commit}`]) : null;
  const parent = local ?? remote;
  if (parent !== null && tryGit(repo, ['rev-parse', `${parent}^{tree}`]) === tree) {
    if (local === null) git(repo, ['update-ref', '-m', 'publish: from origin', ref, parent, '']);
    log(`${branch} already holds this site (commit ${parent.slice(0, 12)}): nothing to publish`);
    return { commit: parent, tree, parent, files: files.length, unchanged: true, warnings };
  }
  let message = opts.message;
  if (message === undefined) {
    const short = tryGit(repo, ['rev-parse', '--short', 'HEAD']) ?? 'HEAD';
    const run = /<meta name="obs-run" content="([^"]+)">/.exec(readFileSync(join(dist, 'index.html'), 'utf8'))?.[1];
    message = `Site from ${short}${run === undefined ? '' : `, run ${run}`}`;
  }
  const commit = git(repo, ['commit-tree', tree, ...(parent === null ? [] : ['-p', parent]), '-m', message]).trim();
  git(repo, ['update-ref', '-m', `publish: ${message}`, ref, commit, local ?? '']);
  const from = parent === null ? 'none: a new branch' : `${parent.slice(0, 12)}${local === null ? ` (origin/${branch})` : ''}`;
  log(`${branch}: ${commit} (${files.length} files, tree ${tree.slice(0, 12)}, parent ${from})`);
  log(`To publish it: git push origin ${branch}`);
  return { commit, tree, parent, files: files.length, unchanged: false, warnings };
}

const USAGE = 'Usage: node site/publish.ts [--dist site/dist] [--branch gh-pages] [--message <text>]';

function main(argv: string[]): number {
  const opts: PublishOptions = { log: (line) => console.log(line) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const v = argv[i + 1];
    if (a === '--help' || a === '-h') {
      console.log(USAGE);
      return 0;
    }
    if (!['--dist', '--branch', '--message'].includes(a) || v === undefined) {
      console.error(`${a.startsWith('--') && v === undefined ? `${a} needs a value` : `unknown argument ${a}`}. ${USAGE}`);
      return 1;
    }
    i++;
    if (a === '--dist') opts.dist = v;
    else if (a === '--branch') opts.branch = v;
    else opts.message = v;
  }
  try {
    publish(opts);
    return 0;
  } catch (err) {
    console.error(`publish: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// Run as a command: this file is the script Node was given (compared as real paths, so a checkout
// reached through a symlink or a junction runs too).
function invokedDirectly(): boolean {
  try {
    return process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
