// The run ledger: which batches are pending, running, done, failed or exhausted, which extractor
// is working on which batch, and why a finished batch can be trusted on the next run.
//
// Concurrency by construction. Up to 20 extractor subagents can finish at once, each firing a hook
// process, so there is no shared ledger file that several processes rewrite. Each batch has its own
// state file, out/ledger/<batch_id>.json, each extractor its binding, out/ledger/agents/<id>.json,
// and a run has out/ledger/run.json. In normal operation a batch file has one writer at a time
// (dispatch, then its own extractor's gate or validate), but every read-modify-write still takes a
// per-file lock, so even two writers on one batch can't lose an update. Every file is written whole
// to a temporary name and renamed into place, so a reader never sees half a file.
//
// A batch is done only if its state says done, the cache key recorded when it was dispatched equals
// the current one (the batch's content, the extractor definition and the taxonomy), and its
// validated output carries the batch's content_sha. Change any of them and the batch is pending
// again; change none and a rerun repeats no finished work. Only a running batch (one handed out by
// dispatch) can be stamped done or failed, and a running batch is never handed out again until it
// is stamped. A failed batch is retried with a fix prompt until MAX_DISPATCHES under one key are
// used; after that it is exhausted and only `dispatch --force` sends it out again. Nothing here
// reads what a model replied: the ledger, the files and the bindings are the only control state.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { sha256 } from '../util/hash.ts';
import { normalizeNewlines } from '../util/text.ts';
import { utcMs } from '../util/time.ts';
import type { BatchEntry, ExtractionCheck, ValidatedExtraction } from '../types.ts';

export const BATCH_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
// What a recorded status means now: a failed batch with no dispatches left is exhausted.
export type EffectiveStatus = BatchStatus | 'exhausted';
export type QuoteStats = ValidatedExtraction['quote_stats'];
export type TaxonomyFreshness = 'fresh' | 'stale' | 'missing';

export const MAX_DISPATCHES = 4; // counted dispatches per cache key: first pass + 3 fix rounds
export const DEFAULT_IN_FLIGHT = 12;
export const MAX_IN_FLIGHT = 20; // Claude Code's default limit on concurrent subagents
export const MAX_PROBLEMS_KEPT = 20; // problems kept in the batch's state file
export const MAX_FIX_LINES = 200; // problems written to a fix file; past that, one line says how many more
// The longest line a problem is kept as: the validator's longest (its coverage problem's budget);
// every other problem is at most 500 characters at the source.
const LINE_MAX_CHARS = 800;
// A running batch with no output file is still starting, not dead, for this long after its
// dispatch: validate and run start leave it running. The Stop hook waits on the same constant.
export const ORPHAN_GRACE_S = 180;
// Circuit breaker: this many batches ending with no output file within this window means the
// extractors are being cut off (a usage limit, say), and the run should stop rather than burn
// dispatches.
export const HALT_NO_OUTPUT = 6;
export const HALT_WINDOW_S = 600;

// Extractors in flight at once: OBS_IN_FLIGHT clamped to 1..MAX_IN_FLIGHT, else DEFAULT_IN_FLIGHT.
export function inFlight(): number {
  const raw = (process.env.OBS_IN_FLIGHT ?? '').trim();
  if (!/^\d{1,6}$/.test(raw)) return DEFAULT_IN_FLIGHT;
  return Math.min(MAX_IN_FLIGHT, Math.max(1, Number(raw)));
}

// out/ledger/<batch_id>.json
export type BatchState = {
  batch_id: string;
  status: BatchStatus;
  dispatches: number; // dispatches under cache_key: 1 for the first, +1 for each after; back to 1 when the key changes
  cache_key: string | null; // the inputs at the last dispatch; the recorded status belongs to them
  dispatched_utc: string | null;
  finished_utc: string | null;
  quote_stats: QuoteStats | null;
  // Problems found by the last check. A fix-round dispatch keeps them (they describe the output
  // being fixed, which it keeps too); any other dispatch clears them. All of them are in the fix
  // file, out/fix/<batch_id>.txt, while the batch is failed or in its fix round.
  problems: number | null;
  last_problems: string[]; // the first MAX_PROBLEMS_KEPT, one line each, with the project folder cut out
  // Dispatches that ended with no output file and were the first such in a row: they don't count
  // toward MAX_DISPATCHES (an extractor cut off is not a failed extraction; two in a row are).
  uncounted_dispatches: number;
  no_output_streak: number; // consecutive stamps with no output file; 0 after any stamp with one
  no_output_utc: string | null; // the last stamp with no output file, for the circuit breaker
};

// out/ledger/agents/<agent_id>.json: the batch an extractor subagent is working on, fixed by its
// first batch-file read, with that dispatch's count, cache key and time. A later dispatch of the
// same batch changes at least one of them, so the binding's holder is recognisably superseded.
export type AgentBinding = { agent_id: string; batch_id: string; dispatches: number; cache_key: string; dispatched_utc: string; bound_utc: string };

// out/ledger/run.json. While a run is active the corpus guard applies to every session tool call.
export type RunState = { active: boolean; run_id: string | null; started_utc: string | null };

export class LedgerError extends Error {
  override name = 'LedgerError';
}

// Batch and agent IDs come from index.json, but also from what is typed and from tool inputs, so
// they are checked before they become part of a file name.
const BATCH_ID = /^batch-\d{3,6}$/;
export const isBatchId = (s: string): boolean => BATCH_ID.test(s);
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const isAgentId = (s: string): boolean => AGENT_ID.test(s);

// What a person or the orchestrator types: "batch-074", or just "74" / "074".
export function normalizeBatchId(arg: string): string {
  return /^\d{1,6}$/.test(arg) ? `batch-${arg.padStart(3, '0')}` : arg;
}

export const outDir = (root: string): string => join(root, 'out');
const ledgerDir = (root: string): string => join(root, 'out', 'ledger');
export const runFile = (root: string): string => join(root, 'out', 'ledger', 'run.json');
export const indexFile = (root: string): string => join(root, 'out', 'batches', 'index.json');
export const taxonomyFile = (root: string): string => join(root, 'out', 'taxonomy.json');
export const taxonomyProposedFile = (root: string): string => join(root, 'out', 'taxonomy-proposed.json');
export const taxonomyStateFile = (root: string): string => join(root, 'out', 'ledger', 'taxonomy.json');
export const digestFile = (root: string): string => join(root, 'out', 'taxonomy-digest.md');
export const stopGateFile = (root: string): string => join(root, 'out', 'ledger', 'stop-gate.json');
export const agentsDir = (root: string): string => join(root, 'out', 'ledger', 'agents');
export const agentFile = (root: string): string => join(root, '.claude', 'agents', 'extractor.md');
export const taxonomistFile = (root: string): string => join(root, '.claude', 'agents', 'taxonomist.md');

function batchPath(root: string, dir: string, batchId: string, ext: string): string {
  if (!isBatchId(batchId)) throw new LedgerError(`"${batchId}" is not a batch ID (expected batch-NNN, or just the number).`);
  return join(root, 'out', dir, `${batchId}${ext}`);
}
export const batchFile = (root: string, batchId: string): string => batchPath(root, 'batches', batchId, '.md');
export const batchStateFile = (root: string, batchId: string): string => batchPath(root, 'ledger', batchId, '.json');
export const extractFile = (root: string, batchId: string): string => batchPath(root, 'extract', batchId, '.json');
export const validatedFile = (root: string, batchId: string): string => batchPath(root, 'validated', batchId, '.json');
export const fixFile = (root: string, batchId: string): string => batchPath(root, 'fix', batchId, '.txt');

export function agentBindingFile(root: string, agentId: string): string {
  if (!isAgentId(agentId)) throw new LedgerError(`"${agentId.slice(0, 80)}" is not an agent ID (letters, digits, - and _ only).`);
  return join(agentsDir(root), `${agentId}.json`);
}

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
export function readText(file: string): string | null {
  try {
    return retrying(() => readFileSync(file, 'utf8'));
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return null;
    throw err;
  }
}

// Remove a file or a whole folder; nothing to remove is fine.
export const removeFile = (file: string): void => retrying(() => rmSync(file, { recursive: true, force: true }));

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
export function withLock<T>(file: string, label: string, fn: () => T): T {
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
    cache_key: null,
    dispatched_utc: null,
    finished_utc: null,
    quote_stats: null,
    problems: null,
    last_problems: [],
    uncounted_dispatches: 0,
    no_output_streak: 0,
    no_output_utc: null,
  };
}

// The dispatches under the current key that count toward MAX_DISPATCHES.
export const countedDispatches = (state: BatchState): number => Math.max(0, state.dispatches - state.uncounted_dispatches);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

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
    cache_key: strOrNull(raw.cache_key),
    dispatched_utc: strOrNull(raw.dispatched_utc),
    finished_utc: strOrNull(raw.finished_utc),
    quote_stats: isRecord(qs) ? { exact: count(qs.exact), repaired: count(qs.repaired), rejected: count(qs.rejected) } : null,
    problems: raw.problems === null || raw.problems === undefined ? null : count(raw.problems),
    last_problems: strings(raw.last_problems),
    uncounted_dispatches: count(raw.uncounted_dispatches),
    no_output_streak: count(raw.no_output_streak),
    no_output_utc: strOrNull(raw.no_output_utc),
  };
}

// Seconds since the epoch for a stored "YYYY-MM-DDTHH:MM:SSZ" time, or null for anything else
// (never parsed loosely).
const STORED_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const utcSeconds = (utc: string | null): number | null => (utc !== null && STORED_UTC.test(utc) ? utcMs(utc) / 1000 : null);

// A running batch with no output file yet, dispatched less than ORPHAN_GRACE_S ago: its extractor
// may still be reading. Validate and run start leave it running.
export function stillStarting(root: string, state: BatchState, nowS: number = utcSeconds(nowUtc()) as number): boolean {
  const dispatched = utcSeconds(state.dispatched_utc);
  return state.status === 'running' && dispatched !== null && nowS - dispatched < ORPHAN_GRACE_S && !existsSync(extractFile(root, state.batch_id));
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

// The batches whose recorded state is running, by name: what run start must stamp. Read from the
// ledger folder, not the index, so it works before prepare has rebuilt out/batches/.
export function recordedRunning(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(ledgerDir(root));
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((n) => /^batch-\d{3,6}\.json$/.test(n))
    .map((n) => n.slice(0, -'.json'.length))
    .sort()
    .filter((id) => readBatchState(root, id).status === 'running');
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

// The newline-normalised hash of a text file, or null when it doesn't exist.
function fileSha(file: string): string | null {
  const text = readText(file);
  return text === null ? null : sha256(normalizeNewlines(text));
}

export const sharedKeyParts = (root: string): SharedKeyParts => ({
  agent_sha: fileSha(agentFile(root)) ?? sha256('none'),
  taxonomy_sha: fileSha(taxonomyFile(root)) ?? sha256('none'),
});

export const cacheKey = (contentSha: string, parts: SharedKeyParts): string =>
  sha256(`batch ${contentSha}\nagent ${parts.agent_sha}\ntaxonomy ${parts.taxonomy_sha}\n`);

// The validated output exists, parses, and was made from this batch's content.
function validatedMatches(root: string, entry: BatchEntry): boolean {
  try {
    const text = readText(validatedFile(root, entry.batch_id));
    if (text === null) return false;
    const value: unknown = JSON.parse(text);
    return isRecord(value) && value.content_sha === entry.content_sha;
  } catch {
    return false;
  }
}

// What a batch's recorded state means now. A running batch stays running whatever changed since
// its dispatch: its extractor may still be writing, so only a stamp (gate, validate, run start)
// moves it on, and dispatch refuses it until then. Otherwise a changed key makes any recorded
// status pending; done also needs the validated file for this content; and a failed batch whose
// counted dispatches under this key are used up is exhausted.
export function effectiveStatus(root: string, state: BatchState, entry: BatchEntry, currentKey: string): EffectiveStatus {
  if (state.status === 'running') return 'running';
  if (state.status === 'pending' || state.cache_key !== currentKey) return 'pending';
  if (state.status === 'done') return validatedMatches(root, entry) ? 'done' : 'pending';
  return countedDispatches(state) >= MAX_DISPATCHES ? 'exhausted' : 'failed';
}

export type BatchView = { entry: BatchEntry; state: BatchState; status: EffectiveStatus; cache_key: string };

export function batchViews(root: string): BatchView[] {
  const index = loadIndex(root);
  const parts = sharedKeyParts(root);
  return index.map((entry) => {
    const state = readBatchState(root, entry.batch_id);
    const key = cacheKey(entry.content_sha, parts);
    return { entry, state, status: effectiveStatus(root, state, entry, key), cache_key: key };
  });
}

// What the orchestrator dispatches next: failed batches with dispatches left (fix rounds), then
// pending ones, in index order, up to `cap` minus what is running. Nothing until the taxonomy is
// fresh: every extraction depends on it.
export function nextToDispatch(
  views: readonly BatchView[],
  taxonomyFresh: boolean,
  cap: number = inFlight(),
): { next: string[]; retryable: string[]; exhausted: string[] } {
  const ids = (status: EffectiveStatus) => views.filter((v) => v.status === status).map((v) => v.entry.batch_id);
  const retryable = ids('failed');
  const exhausted = ids('exhausted');
  const slots = Math.max(0, cap - ids('running').length);
  const next = taxonomyFresh ? [...retryable, ...ids('pending')].slice(0, slots) : [];
  return { next, retryable, exhausted };
}

// out/taxonomy.json is fresh when its digest_sha and agent_sha equal the newline-normalised hashes
// of the current out/taxonomy-digest.md and .claude/agents/taxonomist.md (ARCHITECTURE.md 5.5).
// A file that can't be read, or a digest or agent definition that is missing, is stale.
export function taxonomyFreshness(root: string): TaxonomyFreshness {
  try {
    const text = readText(taxonomyFile(root));
    if (text === null) return 'missing';
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return 'stale';
    const digest = fileSha(digestFile(root));
    const agent = fileSha(taxonomistFile(root));
    return digest !== null && agent !== null && value.digest_sha === digest && value.agent_sha === agent ? 'fresh' : 'stale';
  } catch {
    return 'stale';
  }
}

// ---- Transitions ----

// CR, LF and the other characters some editors and models treat as line breaks (NEL, LS, PS).
const LINE_BREAKS = new RegExp(`[${String.fromCharCode(0x0d, 0x0a, 0x85, 0x2028, 0x2029)}]+`, 'g');

// A problem as the ledger keeps it: one line, with the project folder cut out, at most
// LINE_MAX_CHARS. Problems may carry (escaped, cut) model text, and they are handed to a model.
export function problemLine(problem: string, root: string): string {
  const flat = withoutRoot(problem, root).replace(LINE_BREAKS, ' ');
  const points = Array.from(flat);
  return points.length > LINE_MAX_CHARS ? `${points.slice(0, LINE_MAX_CHARS).join('')}...` : flat;
}

// The fix file's text: one problem per line, at most MAX_FIX_LINES of them, then how many more.
function fixText(lines: readonly string[], total: number): string {
  const shown = lines.slice(0, MAX_FIX_LINES);
  const more = Math.max(total, lines.length) - shown.length;
  return [...shown, ...(more > 0 ? [`(${more} more problems not listed here: fix these first)`] : [])].map((l) => `${l}\n`).join('');
}

// The problems in a fix file, or [] when there is none.
function readFixLines(root: string, batchId: string): string[] {
  try {
    return (readText(fixFile(root, batchId)) ?? '').split('\n').filter((l) => l.trim() !== '');
  } catch {
    return [];
  }
}

const BOM = String.fromCharCode(0xfeff);

// The file parses as a JSON object: a previous output there is something a fix round can edit.
function holdsJsonObject(file: string): boolean {
  try {
    const text = readText(file);
    return text !== null && isRecord(JSON.parse(text.startsWith(BOM) ? text.slice(1) : text));
  } catch {
    return false;
  }
}

// Hand a batch to an extractor. The batch file must be the one the index describes (prepare may
// have rerun since). Refused while the batch is running (validate it first), and when it is done
// or exhausted unless forced. A failed (or forced exhausted) batch whose previous output is a JSON
// object goes out as a fix round: its problems are in its fix file, out/fix/<batch_id>.txt (written
// when it was stamped; rebuilt here from the state's first problems if it has gone), `fix` is the
// lines of that file, and the output stays for the extractor to edit. Otherwise `fix` is null, the
// previous output and any fix file are removed (a stale file must never be validated in place of
// the new one) and the prompt is the fresh one. The validated file always goes. The cache key of
// the inputs it is handed out with is recorded now and kept; the dispatch count goes up under the
// same key and restarts at 1 under a new one, as do the uncounted dispatches and the no-output
// streak.
export function markDispatched(root: string, entry: BatchEntry, opts: { force?: boolean } = {}): { state: BatchState; fix: string[] | null } {
  const id = entry.batch_id;
  const text = readText(batchFile(root, id));
  if (text === null) throw new LedgerError(`out/batches/${id}.md is missing. Run node obs.mjs prepare again.`);
  if (sha256(text) !== entry.content_sha) {
    throw new LedgerError(`out/batches/${id}.md does not match out/batches/index.json (changed since prepare ran). Run node obs.mjs prepare again.`);
  }
  const key = cacheKey(entry.content_sha, sharedKeyParts(root));
  let fix: string[] | null = null;
  const state = updateBatchState(root, id, (s) => {
    const status = effectiveStatus(root, s, entry, key);
    if (status === 'running') {
      throw new LedgerError(`${id} is running: its extractor may still be working on it. Run node obs.mjs validate ${id} first.`);
    }
    if (status === 'done' && opts.force !== true) {
      throw new LedgerError(`${id} is already done. To extract it again anyway: node obs.mjs dispatch ${id} --force`);
    }
    if (status === 'exhausted' && opts.force !== true) {
      throw new LedgerError(
        `${id} is exhausted: all ${countedDispatches(s)} counted dispatches under its current inputs failed. To try once more: node obs.mjs dispatch ${id} --force`,
      );
    }
    let lines = readFixLines(root, id);
    const fixRound = (status === 'failed' || status === 'exhausted') && (lines.length > 0 || s.last_problems.length > 0) && holdsJsonObject(extractFile(root, id));
    if (fixRound) {
      if (lines.length === 0) {
        writeFileAtomic(fixFile(root, id), fixText(s.last_problems, s.problems ?? s.last_problems.length));
        lines = readFixLines(root, id);
      }
      fix = lines;
    } else {
      fix = null;
      removeFile(extractFile(root, id));
      removeFile(fixFile(root, id));
    }
    removeFile(validatedFile(root, id));
    const sameKey = s.cache_key === key;
    return {
      batch_id: id,
      status: 'running',
      dispatches: sameKey ? s.dispatches + 1 : 1,
      cache_key: key,
      dispatched_utc: nowUtc(),
      finished_utc: null,
      quote_stats: null,
      problems: fixRound ? s.problems : null,
      last_problems: fixRound ? s.last_problems : [],
      uncounted_dispatches: sameKey ? s.uncounted_dispatches : 0,
      no_output_streak: sameKey ? s.no_output_streak : 0,
      no_output_utc: s.no_output_utc,
    };
  });
  return { state, fix };
}

export function requireRunning(root: string, batchId: string): BatchState {
  const state = readBatchState(root, batchId);
  if (state.status !== 'running') {
    throw new LedgerError(`${batchId} is ${state.status}, not running: only a dispatched batch can be validated. Run node obs.mjs dispatch ${batchId} first.`);
  }
  return state;
}

// The outcome of a validation, recorded the same way by `obs validate`, run start and the
// SubagentStop gate. Only a running batch is stamped, under the cache key recorded at its
// dispatch; a setup failure (nothing the model can fix) is never recorded.
// - done: the validated file is written, under the batch's lock, before the state says done, so a
//   crash in between leaves the batch unfinished, never done without its output, and a second
//   stamp can't overwrite the first. The fix file goes.
// - failed: no validated file (only a passing check makes one), and every problem goes to the fix
//   file for the next round. With no output file at all, the stamp counts toward the circuit
//   breaker, and the dispatch toward MAX_DISPATCHES only if the previous stamp had no output too.
export function recordValidation(root: string, entry: BatchEntry, check: ExtractionCheck): BatchState {
  const id = entry.batch_id;
  if (check.setup !== null) throw new LedgerError(`${id} could not be checked: ${withoutRoot(check.setup, root)}`);
  requireRunning(root, id);
  const lines = check.problems.map((p) => problemLine(p, root));
  return updateBatchState(root, id, (s) => {
    if (s.status !== 'running') throw new LedgerError(`${id} stopped being running while it was validated (it is now ${s.status}).`);
    const now = nowUtc();
    const noOutput = !check.ok && !existsSync(extractFile(root, id));
    const streak = noOutput ? s.no_output_streak + 1 : 0;
    if (check.ok && check.validated !== null) {
      writeJsonAtomic(validatedFile(root, id), check.validated);
      removeFile(fixFile(root, id));
    } else {
      removeFile(validatedFile(root, id));
      writeFileAtomic(fixFile(root, id), fixText(lines, lines.length));
    }
    return {
      ...s,
      status: check.ok && check.validated !== null ? 'done' : 'failed',
      finished_utc: now,
      quote_stats: check.validated?.quote_stats ?? null,
      problems: check.problems.length,
      last_problems: lines.slice(0, MAX_PROBLEMS_KEPT),
      uncounted_dispatches: s.uncounted_dispatches + (noOutput && streak === 1 ? 1 : 0),
      no_output_streak: streak,
      no_output_utc: noOutput ? now : s.no_output_utc,
    };
  });
}

// ---- Agent bindings ----

function parseBinding(agentId: string, text: string | null): AgentBinding | null {
  if (text === null) return null;
  const shown = `out/ledger/agents/${agentId}.json`;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LedgerError(`${shown} is not valid JSON.`);
  }
  if (
    !isRecord(raw) ||
    raw.agent_id !== agentId ||
    typeof raw.batch_id !== 'string' ||
    !isBatchId(raw.batch_id) ||
    !Number.isInteger(raw.dispatches) ||
    typeof raw.cache_key !== 'string' ||
    typeof raw.dispatched_utc !== 'string' ||
    typeof raw.bound_utc !== 'string'
  ) {
    throw new LedgerError(`${shown} is not a binding for agent ${agentId}.`);
  }
  return {
    agent_id: agentId,
    batch_id: raw.batch_id,
    dispatches: raw.dispatches as number,
    cache_key: raw.cache_key,
    dispatched_utc: raw.dispatched_utc,
    bound_utc: raw.bound_utc,
  };
}

// The binding belongs to the batch's current dispatch: same count, key and dispatch time. Any
// re-dispatch changes at least one of them (the count restarts under a new key, so it alone can't
// tell), and then the binding's holder may no longer write or stamp the batch.
export function bindingIsCurrent(binding: AgentBinding, state: BatchState): boolean {
  return binding.dispatches === state.dispatches && binding.cache_key === state.cache_key && binding.dispatched_utc === state.dispatched_utc;
}

export type BindResult = { ok: true; binding: AgentBinding } | { ok: false; reason: string };

// Bind an extractor to a batch, on its first batch-file read. The first binding wins: binding
// again to the same batch returns it unchanged, to another batch is refused. Only a running batch
// can be bound, and the binding copies its dispatch count, cache key and dispatch time, so a
// re-dispatch supersedes it (bindingIsCurrent).
export function bindAgent(root: string, agentId: string, batchId: string): BindResult {
  if (!isAgentId(agentId)) return { ok: false, reason: `agent ID ${JSON.stringify(agentId.slice(0, 80))} can't be bound (letters, digits, - and _ only)` };
  if (!isBatchId(batchId)) return { ok: false, reason: `${JSON.stringify(batchId.slice(0, 80))} is not a batch ID` };
  const file = agentBindingFile(root, agentId);
  return withLock(file, `out/ledger/agents/${agentId}.json`, (): BindResult => {
    const existing = parseBinding(agentId, readText(file));
    if (existing !== null) {
      return existing.batch_id === batchId
        ? { ok: true, binding: existing }
        : { ok: false, reason: `this extractor is bound to ${existing.batch_id}, the first batch it read; ${batchId} is not its batch` };
    }
    const state = readBatchState(root, batchId);
    if (state.status !== 'running') return { ok: false, reason: `${batchId} is ${state.status}, not running: it has not been handed to an extractor` };
    if (state.cache_key === null || state.dispatched_utc === null) return { ok: false, reason: `${batchId} has no dispatch record to bind to` };
    const binding: AgentBinding = {
      agent_id: agentId,
      batch_id: batchId,
      dispatches: state.dispatches,
      cache_key: state.cache_key,
      dispatched_utc: state.dispatched_utc,
      bound_utc: nowUtc(),
    };
    writeJsonAtomic(file, binding);
    return { ok: true, binding };
  });
}

// The agent's binding, or null when it has none (or its ID can't name a file).
export function boundBatch(root: string, agentId: string): AgentBinding | null {
  if (!isAgentId(agentId)) return null;
  return parseBinding(agentId, readText(agentBindingFile(root, agentId)));
}

// ---- Run state ----

// --force: every model output and the state that refers to it: batch states, extractor bindings,
// the taxonomy (canonical, proposed, and its attempt count), the validated extractions and the fix
// files. The raw extractions stay: a fresh dispatch removes its batch's file, and until then they
// are evidence of what the previous run produced.
export function clearModelOutputs(root: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(ledgerDir(root));
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') throw err;
  }
  for (const name of names) if (/^batch-\d{3,6}\.json$/.test(name)) removeFile(join(ledgerDir(root), name));
  const out = join(root, 'out');
  for (const path of [agentsDir(root), join(out, 'validated'), join(out, 'fix'), taxonomyFile(root), taxonomyProposedFile(root), taxonomyStateFile(root)]) {
    removeFile(path);
  }
}

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
