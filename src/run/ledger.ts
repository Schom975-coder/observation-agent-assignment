// The run ledger: which batches are pending, running, done or failed, and why a finished batch can
// be trusted on the next run.
//
// Concurrency by construction. Up to 12 extractor subagents can finish at once, each firing a hook
// process, so there is no shared ledger file that several processes rewrite. Each batch has its own
// state file, out/ledger/<batch_id>.json, and a run has out/ledger/run.json. In normal operation a
// batch file has one writer at a time (dispatch, then its own extractor's gate, then validate), but
// every read-modify-write still takes a per-file lock, so even two writers on one batch can't lose
// an update. Every file is written whole to a temporary name and renamed into place, so a reader
// never sees half a file.
//
// A batch is done only if its validated output exists, its state says done, and the cache key
// recorded when it was dispatched equals the current one: the batch's content, the extractor
// definition and the taxonomy. Change any of them and the batch is pending again; change none and
// a rerun repeats no finished work. Only a running batch (one handed out by dispatch) can be
// stamped done or failed.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { sha256 } from '../util/hash.ts';
import { normalizeNewlines } from '../util/text.ts';
import type { BatchEntry, ExtractionCheck, ValidatedExtraction } from '../types.ts';

export const BATCH_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
export type QuoteStats = ValidatedExtraction['quote_stats'];

// out/ledger/<batch_id>.json
export type BatchState = {
  batch_id: string;
  status: BatchStatus;
  dispatches: number; // times handed to an extractor
  gate_blocks: number; // SubagentStop blocks since the last dispatch; the gate stops blocking at GATE_MAX_BLOCKS
  cache_key: string | null; // the inputs at the last dispatch; the recorded status belongs to them
  dispatched_utc: string | null;
  finished_utc: string | null;
  quote_stats: QuoteStats | null;
  problems: number | null; // validation problems at the last check
};

// out/ledger/run.json. While a run is active the corpus guard applies to every session tool call.
export type RunState = { active: boolean; run_id: string | null; started_utc: string | null };

export const GATE_MAX_BLOCKS = 3;

export class LedgerError extends Error {
  override name = 'LedgerError';
}

// Batch IDs come from index.json but also from model output (the OUTPUT line), so they are checked
// before they become part of a file name.
const BATCH_ID = /^batch-\d{3,6}$/;
export const isBatchId = (s: string): boolean => BATCH_ID.test(s);

// What a person or the orchestrator types: "batch-074", or just "74" / "074".
export function normalizeBatchId(arg: string): string {
  return /^\d{1,6}$/.test(arg) ? `batch-${arg.padStart(3, '0')}` : arg;
}

export const outDir = (root: string): string => join(root, 'out');
export const runFile = (root: string): string => join(root, 'out', 'ledger', 'run.json');
export const indexFile = (root: string): string => join(root, 'out', 'batches', 'index.json');
export const taxonomyFile = (root: string): string => join(root, 'out', 'taxonomy.json');
export const agentFile = (root: string): string => join(root, '.claude', 'agents', 'extractor.md');

function batchPath(root: string, dir: string, batchId: string, ext: string): string {
  if (!isBatchId(batchId)) throw new LedgerError(`"${batchId}" is not a batch ID (expected batch-NNN, or just the number).`);
  return join(root, 'out', dir, `${batchId}${ext}`);
}
export const batchFile = (root: string, batchId: string): string => batchPath(root, 'batches', batchId, '.md');
export const batchStateFile = (root: string, batchId: string): string => batchPath(root, 'ledger', batchId, '.json');
export const extractFile = (root: string, batchId: string): string => batchPath(root, 'extract', batchId, '.json');
export const validatedFile = (root: string, batchId: string): string => batchPath(root, 'validated', batchId, '.json');

// "YYYY-MM-DDTHH:MM:SSZ", the form every stored time uses.
export const nowUtc = (): string => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// ---- Paths in messages ----

// The ways a tool input or an error message may spell the project folder: as given, with forward
// or back slashes, and the Git Bash / Cygwin / WSL forms of a Windows drive path. Longest first.
export function rootForms(root: string): string[] {
  const slash = root.replaceAll('\\', '/').replace(/\/+$/, '');
  const forms = new Set([root.replace(/[\\/]+$/, ''), slash, slash.replaceAll('/', '\\')]);
  const drive = /^([A-Za-z]):\/(.*)$/.exec(slash);
  if (drive !== null) {
    const letter = (drive[1] as string).toLowerCase();
    for (const prefix of [`/${letter}/`, `/cygdrive/${letter}/`, `/mnt/${letter}/`]) forms.add(`${prefix}${drive[2]}`);
  }
  return [...forms].filter((f) => f.length > 1).sort((a, b) => b.length - a.length);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Text with the project folder removed wherever it appears, so paths read repo-relative. Used on
// everything that is logged to out/ (committed) or shown to a model: no local paths leak.
export function withoutRoot(text: string, root: string): string {
  let out = text;
  // The folder itself, then a separator or the end of the name (so /srv/obs never eats /srv/obsolete).
  for (const form of rootForms(root)) out = out.replace(new RegExp(`${escapeRegExp(form)}(?:[\\\\/]|(?![A-Za-z0-9_.-]))`, 'gi'), '');
  return out;
}

// ---- Files: atomic writes, retried reads, per-file locks ----

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number): void => void Atomics.wait(sleepCell, 0, 0, ms);
// Windows refuses a rename, open or delete for a moment while another process has the file open
// or is deleting it; those errors pass on retry.
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const codeOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;

function retrying<T>(fn: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt < 100 && TRANSIENT.has(codeOf(err) ?? '')) {
        sleep(5 + attempt);
        continue;
      }
      throw err;
    }
  }
}

export function writeFileAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  try {
    retrying(() => renameSync(tmp, file));
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export const writeJsonAtomic = (file: string, value: unknown): void => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

// The file's text, or null when it doesn't exist.
function readText(file: string): string | null {
  try {
    return retrying(() => readFileSync(file, 'utf8'));
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return null;
    throw err;
  }
}

const removeFile = (file: string): void => retrying(() => rmSync(file, { force: true }));

export const LOCK_STALE_MS = 10_000; // a lock is held for milliseconds; one this old was left by a killed process
const LOCK_WAIT_MS = 20_000;

const isStale = (file: string): boolean => {
  try {
    return Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false; // gone, or being removed: just try again
  }
};

// Remove a stale lock without racing another waiter. A plain "it's stale, delete it" lets two
// waiters both see the old lock, one delete it and take a fresh one, and the other then delete
// that fresh lock. So taking over needs a second, short-lived marker: only its holder may delete,
// and it re-checks staleness while holding it, when nobody else can be deleting.
function takeOverStaleLock(lock: string): void {
  const marker = `${lock}.takeover`;
  try {
    closeSync(openSync(marker, 'wx'));
  } catch (err) {
    // Another waiter is taking over; a marker left by a killed process is cleared after a while.
    if (codeOf(err) === 'EEXIST' && isStale(marker)) removeFile(marker);
    return;
  }
  try {
    if (isStale(lock)) removeFile(lock);
  } finally {
    removeFile(marker);
  }
}

// Run `fn` holding `file`'s lock. `label` names the file in messages (repo-relative).
function withLock<T>(file: string, label: string, fn: () => T): T {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (err) {
      const code = codeOf(err);
      if (code !== 'EEXIST' && !TRANSIENT.has(code ?? '')) throw err;
      if (isStale(lock)) takeOverStaleLock(lock);
      if (Date.now() > deadline) throw new LedgerError(`Timed out waiting for the lock on ${label}; if no obs command is running, delete ${label}.lock.`);
      sleep(2 + Math.min(attempt, 20));
    }
  }
  try {
    return fn();
  } finally {
    removeFile(lock);
  }
}

// ---- Batch state ----

export function freshState(batchId: string): BatchState {
  return {
    batch_id: batchId,
    status: 'pending',
    dispatches: 0,
    gate_blocks: 0,
    cache_key: null,
    dispatched_utc: null,
    finished_utc: null,
    quote_stats: null,
    problems: null,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function parseState(batchId: string, text: string): BatchState {
  const shown = `out/ledger/${batchId}.json`;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LedgerError(`${shown} is not valid JSON; delete it to reset ${batchId} to pending.`);
  }
  if (!isRecord(raw) || raw.batch_id !== batchId || !(BATCH_STATUSES as readonly unknown[]).includes(raw.status)) {
    throw new LedgerError(`${shown} is not a ledger entry for ${batchId}; delete it to reset the batch to pending.`);
  }
  const qs = raw.quote_stats;
  return {
    batch_id: batchId,
    status: raw.status as BatchStatus,
    dispatches: count(raw.dispatches),
    gate_blocks: count(raw.gate_blocks),
    cache_key: strOrNull(raw.cache_key),
    dispatched_utc: strOrNull(raw.dispatched_utc),
    finished_utc: strOrNull(raw.finished_utc),
    quote_stats: isRecord(qs) ? { exact: count(qs.exact), repaired: count(qs.repaired), rejected: count(qs.rejected) } : null,
    problems: raw.problems === null || raw.problems === undefined ? null : count(raw.problems),
  };
}

export function readBatchState(root: string, batchId: string): BatchState {
  const text = readText(batchStateFile(root, batchId));
  return text === null ? freshState(batchId) : parseState(batchId, text);
}

// Read, change and write one batch's state under its lock. Returns what was written.
export function updateBatchState(root: string, batchId: string, change: (state: BatchState) => BatchState): BatchState {
  const file = batchStateFile(root, batchId);
  return withLock(file, `out/ledger/${batchId}.json`, () => {
    const next = { ...change(readBatchState(root, batchId)), batch_id: batchId };
    writeJsonAtomic(file, next);
    return next;
  });
}

// ---- Batches and cache keys ----

export function loadIndex(root: string): BatchEntry[] {
  const text = readText(indexFile(root));
  if (text === null) throw new LedgerError('No batches yet: out/batches/index.json is missing. Run node obs.mjs prepare first.');
  let index: unknown;
  try {
    index = JSON.parse(text);
  } catch {
    throw new LedgerError('out/batches/index.json is not valid JSON. Run node obs.mjs prepare again.');
  }
  if (!Array.isArray(index) || !index.every((b) => isRecord(b) && typeof b.batch_id === 'string' && isBatchId(b.batch_id) && typeof b.content_sha === 'string')) {
    throw new LedgerError('out/batches/index.json is not a batch index. Run node obs.mjs prepare again.');
  }
  return index as BatchEntry[];
}

export function findBatch(index: readonly BatchEntry[], batchId: string): BatchEntry {
  const entry = index.find((b) => b.batch_id === batchId);
  if (entry === undefined) {
    const range = index.length === 0 ? 'there are none' : `${index[0]?.batch_id} to ${index.at(-1)?.batch_id}`;
    throw new LedgerError(`Unknown batch "${batchId}" (batches in out/batches/index.json: ${range}).`);
  }
  return entry;
}

// The parts of the cache key every batch shares. Line endings are normalized first, so a checkout
// that converted them doesn't invalidate finished work. A missing file hashes as "none".
export type SharedKeyParts = { agent_sha: string; taxonomy_sha: string };

function textSha(file: string): string {
  const text = readText(file);
  return sha256(text === null ? 'none' : normalizeNewlines(text));
}

export const sharedKeyParts = (root: string): SharedKeyParts => ({
  agent_sha: textSha(agentFile(root)),
  taxonomy_sha: textSha(taxonomyFile(root)),
});

export const cacheKey = (contentSha: string, parts: SharedKeyParts): string =>
  sha256(`batch ${contentSha}\nagent ${parts.agent_sha}\ntaxonomy ${parts.taxonomy_sha}\n`);

// What a batch's recorded state means now. Done needs the validated file and an unchanged key; a
// changed key makes any recorded status pending.
export function effectiveStatus(root: string, state: BatchState, currentKey: string): BatchStatus {
  if (state.status === 'pending' || state.cache_key !== currentKey) return 'pending';
  if (state.status === 'done' && !existsSync(validatedFile(root, state.batch_id))) return 'pending';
  return state.status;
}

export type BatchView = { entry: BatchEntry; state: BatchState; status: BatchStatus; cache_key: string };

export function batchViews(root: string): BatchView[] {
  const index = loadIndex(root);
  const parts = sharedKeyParts(root);
  return index.map((entry) => {
    const state = readBatchState(root, entry.batch_id);
    const key = cacheKey(entry.content_sha, parts);
    return { entry, state, status: effectiveStatus(root, state, key), cache_key: key };
  });
}

// ---- Transitions ----

// Hand a batch to an extractor. The batch file must be the one the index describes (prepare may
// have rerun since). The cache key of the inputs it is handed out with is recorded now and kept.
// Its previous outputs are removed: a stale extraction must not be validated in place of the new
// one, and some models' Write tool will not overwrite a file they have not read.
export function markDispatched(root: string, entry: BatchEntry): BatchState {
  const text = readText(batchFile(root, entry.batch_id));
  if (text === null) throw new LedgerError(`out/batches/${entry.batch_id}.md is missing. Run node obs.mjs prepare again.`);
  if (sha256(text) !== entry.content_sha) {
    throw new LedgerError(`out/batches/${entry.batch_id}.md does not match out/batches/index.json (changed since prepare ran). Run node obs.mjs prepare again.`);
  }
  const key = cacheKey(entry.content_sha, sharedKeyParts(root));
  removeFile(extractFile(root, entry.batch_id));
  removeFile(validatedFile(root, entry.batch_id));
  return updateBatchState(root, entry.batch_id, (s) => ({
    ...s,
    status: 'running',
    dispatches: s.dispatches + 1,
    gate_blocks: 0,
    cache_key: key,
    dispatched_utc: nowUtc(),
    finished_utc: null,
    quote_stats: null,
    problems: null,
  }));
}

export function requireRunning(root: string, batchId: string): BatchState {
  const state = readBatchState(root, batchId);
  if (state.status !== 'running') {
    throw new LedgerError(`${batchId} is ${state.status}, not running: only a dispatched batch can be validated. Run node obs.mjs dispatch ${batchId} first.`);
  }
  return state;
}

// Use one of the batch's gate blocks. Returns the new count, or null when all GATE_MAX_BLOCKS are
// used (the gate must then let the subagent finish). Check and increment happen under one lock.
export function takeGateBlock(root: string, batchId: string): number | null {
  let taken: number | null = null;
  updateBatchState(root, batchId, (s) => {
    if (s.gate_blocks >= GATE_MAX_BLOCKS) return s;
    taken = s.gate_blocks + 1;
    return { ...s, gate_blocks: taken };
  });
  return taken;
}

// The same bound for a reply whose OUTPUT line can't be used (missing, unknown batch, not the
// batch it was given): those blocks are counted per subagent, in out/ledger/agents/<agent_id>.json.
export function takeAgentBlock(root: string, agentId: string | null): number | null {
  const safe = (agentId ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'unknown';
  const file = join(root, 'out', 'ledger', 'agents', `${safe}.json`);
  return withLock(file, `out/ledger/agents/${safe}.json`, () => {
    let blocks = 0;
    try {
      const raw: unknown = JSON.parse(readText(file) ?? '{}');
      if (isRecord(raw)) blocks = count(raw.blocks);
    } catch {
      // unreadable counter: start again
    }
    if (blocks >= GATE_MAX_BLOCKS) return null;
    writeJsonAtomic(file, { agent_id: agentId, blocks: blocks + 1 });
    return blocks + 1;
  });
}

// A problem the model cannot fix (unreadable index, messages or taxonomy): the validator prefixes
// these "setup: ". They never stamp or block a batch; it stays running for a later validate.
export const isSetupProblem = (problem: string): boolean => problem.startsWith('setup: ');

// The outcome of a validation, recorded the same way by `obs validate` and the SubagentStop gate.
// Only a running batch is stamped, under the cache key recorded at its dispatch. The validated
// file is written before the state says done, so a crash in between leaves the batch unfinished,
// never done without its output.
export function recordValidation(root: string, entry: BatchEntry, check: ExtractionCheck): BatchState {
  if (check.problems.some(isSetupProblem)) throw new LedgerError(`${entry.batch_id} could not be checked: ${check.problems[0]}`);
  requireRunning(root, entry.batch_id);
  const file = validatedFile(root, entry.batch_id);
  if (check.validated !== null) writeJsonAtomic(file, check.validated);
  else removeFile(file);
  return updateBatchState(root, entry.batch_id, (s) => {
    if (s.status !== 'running') throw new LedgerError(`${entry.batch_id} stopped being running while it was validated.`);
    return {
      ...s,
      status: check.ok ? 'done' : 'failed',
      finished_utc: nowUtc(),
      quote_stats: check.validated?.quote_stats ?? null,
      problems: check.problems.length,
    };
  });
}

// ---- The extractor's OUTPUT line ----

export type OutputLine = { kind: 'missing' } | { kind: 'named'; batchId: string } | { kind: 'unrecognised'; text: string };

// The last OUTPUT line in a reply. Markdown decoration around it is tolerated, and so is a full
// path: only the batch ID is taken from it, and the file read is always the project's own.
export function parseOutputLine(message: string): OutputLine {
  const lines = [...message.matchAll(/^[ \t>*_`]*OUTPUT:[ \t]*(.*?)[ \t]*$/gm)];
  const last = lines.at(-1);
  if (last === undefined) return { kind: 'missing' };
  const text = (last[1] as string).replace(/^[`'"*_]+|[`'"*_]+$/g, '');
  const m = /(?:^|\/)out\/extract\/(batch-\d{3,6})\.json$/.exec(text.replaceAll('\\', '/'));
  return m === null ? { kind: 'unrecognised', text } : { kind: 'named', batchId: m[1] as string };
}

// ---- Run state ----

// The run state. A missing file means no run; a file that can't be read is an error, which the
// corpus guard treats as an active run (fail closed).
export function readRun(root: string): RunState {
  const text = readText(runFile(root));
  if (text === null) return { active: false, run_id: null, started_utc: null };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LedgerError('out/ledger/run.json is not valid JSON; run node obs.mjs run end to reset it.');
  }
  if (!isRecord(raw) || typeof raw.active !== 'boolean') {
    throw new LedgerError('out/ledger/run.json is not a run state; run node obs.mjs run end to reset it.');
  }
  return { active: raw.active, run_id: strOrNull(raw.run_id), started_utc: strOrNull(raw.started_utc) };
}

export const writeRun = (root: string, run: RunState): void => writeJsonAtomic(runFile(root), run);

// "20261017T010203Z": sortable and safe as a file name on every OS.
export const newRunId = (startedUtc: string): string => startedUtc.replace(/[-:]/g, '');
