// The run ledger: which jobs are pending, running, done, failed or exhausted, which agent is
// working on which job, and why a finished job can be trusted on the next run. A job is an
// extraction batch ("batch-NNN", one extractor) or a synthesis group ("synth-NNN", one
// synthesizer); the two kinds go through the same states, refusals, fix rounds, bindings and
// orphan stamping, and differ only in their files, agent definition and checker (ARCHITECTURE.md
// 6.21: JOB_KINDS below, and src/run/jobs.ts for the checkers and prompts).
//
// Concurrency by construction. Up to 20 subagents can finish at once, each firing a hook process,
// so there is no shared ledger file that several processes rewrite. Each job has its own state
// file, out/ledger/<job_id>.json (its `batch_id` field holds the job ID, whatever the kind, so the
// committed batch files keep their shape), each agent its binding, out/ledger/agents/<id>.json, and
// a run has out/ledger/run.json. In normal operation a job's file has one writer at a time
// (dispatch, then its own agent's gate or validate), but every read-modify-write still takes a
// per-file lock, so even two writers on one job can't lose an update. Every file is written whole
// to a temporary name and renamed into place, so a reader never sees half a file.
//
// A job is done only if its state says done, the cache key recorded when it was dispatched equals
// the current one (the job's input content, its agent definition, and for a batch the taxonomy),
// and its validated output carries the input's content_sha. Change any of them and the job is
// pending again; change none and a rerun repeats no finished work. Only a running job (one handed
// out by dispatch) can be stamped done or failed, and a running job is never handed out again until
// it is stamped. A failed job is retried with a fix prompt until MAX_DISPATCHES under one key are
// used; after that it is exhausted and only `dispatch --force` sends it out again. Nothing here
// reads what a model replied: the ledger, the files and the bindings are the only control state.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { sha256 } from '../util/hash.ts';
import { normalizeNewlines } from '../util/text.ts';
import { utcMs } from '../util/time.ts';
import type { BatchEntry, JobCheck, JobEntry, JobKind, ValidatedExtraction, ValidatedSynthesis } from '../types.ts';

export const BATCH_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
// What a recorded status means now: a failed job with no dispatches left is exhausted.
export type EffectiveStatus = BatchStatus | 'exhausted';
export type QuoteStats = ValidatedExtraction['quote_stats'];
export type TaxonomyFreshness = 'fresh' | 'stale' | 'missing';

export const MAX_DISPATCHES = 4; // counted dispatches per cache key: first pass + 3 fix rounds
export const DEFAULT_IN_FLIGHT = 20; // the platform's concurrent-subagent limit (ARCHITECTURE.md 6.6)
export const MAX_IN_FLIGHT = 20; // Claude Code's default limit on concurrent subagents
export const MAX_PROBLEMS_KEPT = 20; // problems kept in the job's state file
export const MAX_FIX_LINES = 200; // problems written to a fix file; past that, one line says how many more
// The longest line a problem is kept as: the validator's longest (its coverage problem's budget);
// every other problem is at most 500 characters at the source.
const LINE_MAX_CHARS = 800;
// A running job with no output file is still starting, not dead, for this long after its
// dispatch: validate and run start leave it running. The Stop hook waits on the same constant.
export const ORPHAN_GRACE_S = 180;
// Circuit breaker: this many jobs ending with no output file within this window means the agents
// are being cut off (a usage limit, say), and the run should stop rather than burn dispatches.
export const HALT_NO_OUTPUT = 6;
export const HALT_WINDOW_S = 600;

// Agents in flight at once: OBS_IN_FLIGHT clamped to 1..MAX_IN_FLIGHT, else DEFAULT_IN_FLIGHT.
export function inFlight(): number {
  const raw = (process.env.OBS_IN_FLIGHT ?? '').trim();
  if (!/^\d{1,6}$/.test(raw)) return DEFAULT_IN_FLIGHT;
  return Math.min(MAX_IN_FLIGHT, Math.max(1, Number(raw)));
}

// out/ledger/<job_id>.json. The name and the `batch_id` field predate synthesis groups; both kinds
// use this shape.
export type BatchState = {
  batch_id: string; // the job ID: "batch-017" or "synth-003"
  status: BatchStatus;
  dispatches: number; // dispatches under cache_key: 1 for the first, +1 for each after; back to 1 when the key changes
  cache_key: string | null; // the inputs at the last dispatch; the recorded status belongs to them
  dispatched_utc: string | null;
  finished_utc: string | null;
  quote_stats: QuoteStats | null; // batches only
  // Problems found by the last check. A fix-round dispatch keeps them (they describe the output
  // being fixed, which it keeps too); any other dispatch clears them. All of them are in the fix
  // file, out/fix/<job_id>.txt, while the job is failed or in its fix round.
  problems: number | null;
  last_problems: string[]; // the first MAX_PROBLEMS_KEPT, one line each, with the project folder cut out
  // Dispatches that ended with no output file and were the first such in a row: they don't count
  // toward MAX_DISPATCHES (an agent cut off is not a failed output; two in a row are).
  uncounted_dispatches: number;
  no_output_streak: number; // consecutive stamps with no output file; 0 after any stamp with one
  no_output_utc: string | null; // the last stamp with no output file, for the circuit breaker
  // The run that stamp was made under (the active run when it was made, else null): the breaker
  // counts only this run's stamps, so an orphan stamped by run start never trips the new run's.
  no_output_run_id: string | null;
};
export type JobState = BatchState;

// out/ledger/agents/<agent_id>.json: the job an extractor or synthesizer is working on, fixed by its
// first read of a job file, with that dispatch's count, cache key and time. A later dispatch of the
// same job changes at least one of them, so the binding's holder is recognisably superseded.
export type AgentBinding = { agent_id: string; batch_id: string; dispatches: number; cache_key: string; dispatched_utc: string; bound_utc: string };

// out/ledger/run.json. While a run is active the corpus guard applies to every session tool call.
export type RunState = { active: boolean; run_id: string | null; started_utc: string | null };

export class LedgerError extends Error {
  override name = 'LedgerError';
}

// ---- Job kinds: everything that differs between a batch and a synthesis group ----

type KindInfo = {
  dirs: { input: string; output: string; validated: string }; // under out/
  inputExt: string;
  index: string; // repo-relative
  agent: string; // repo-relative agent definition: its hash is part of every cache key of the kind
  worker: string; // the agent's name, for messages
  noun: string;
  nouns: string;
  short: string; // as a binding message names it
  verb: string; // what dispatching does, for the --force hint
  rebuild: string; // the stage that writes the inputs and the index
};

export const JOB_KINDS: Record<JobKind, KindInfo> = {
  batch: {
    dirs: { input: 'batches', output: 'extract', validated: 'validated' },
    inputExt: '.md',
    index: 'out/batches/index.json',
    agent: '.claude/agents/extractor.md',
    worker: 'extractor',
    noun: 'batch',
    nouns: 'batches',
    short: 'batch',
    verb: 'extract',
    rebuild: 'prepare',
  },
  synth: {
    dirs: { input: 'synthesis/input', output: 'synthesis/raw', validated: 'synthesis/validated' },
    inputExt: '.md',
    index: 'out/synthesis/index.json',
    agent: '.claude/agents/synthesizer.md',
    worker: 'synthesizer',
    noun: 'synthesis group',
    nouns: 'synthesis groups',
    short: 'group',
    verb: 'synthesize',
    rebuild: 'rollup',
  },
};

// Job and agent IDs come from index files, but also from what is typed and from tool inputs, so
// they are checked before they become part of a file name.
const BATCH_ID = /^batch-\d{3,6}$/;
const SYNTH_ID = /^synth-\d{3,6}$/;
export const isBatchId = (s: string): boolean => BATCH_ID.test(s);
export const isSynthId = (s: string): boolean => SYNTH_ID.test(s);
export const isJobId = (s: string): boolean => BATCH_ID.test(s) || SYNTH_ID.test(s);
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const isAgentId = (s: string): boolean => AGENT_ID.test(s);

// A job's kind, from its ID prefix.
export function kindOf(id: string): JobKind {
  if (BATCH_ID.test(id)) return 'batch';
  if (SYNTH_ID.test(id)) return 'synth';
  throw new LedgerError(`"${id.slice(0, 80)}" is not a job ID (expected batch-NNN or synth-NNN; a bare number means a batch).`);
}

// What a person or the orchestrator types: "batch-074", or just "74" / "074".
export function normalizeBatchId(arg: string): string {
  return /^\d{1,6}$/.test(arg) ? `batch-${arg.padStart(3, '0')}` : arg;
}
export const normalizeJobId = normalizeBatchId;

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
export const mergerFile = (root: string): string => join(root, '.claude', 'agents', 'merger.md');
export const synthesizerFile = (root: string): string => join(root, '.claude', 'agents', 'synthesizer.md');
// The M5 stages' files (ARCHITECTURE.md 14.1).
export const mergeInputFile = (root: string): string => join(root, 'out', 'merge-input.md');
export const mergeProposedFile = (root: string): string => join(root, 'out', 'merge-proposed.json');
export const mergeFile = (root: string): string => join(root, 'out', 'merge.json');
export const mergeStateFile = (root: string): string => join(root, 'out', 'ledger', 'merge.json');
export const rollupFile = (root: string): string => join(root, 'out', 'rollup.json');
export const coverageFile = (root: string): string => join(root, 'out', 'coverage.json');
export const validationReportFile = (root: string): string => join(root, 'out', 'validation-report.json');
export const synthesisDir = (root: string): string => join(root, 'out', 'synthesis');
export const synthIndexFile = (root: string): string => join(root, 'out', 'synthesis', 'index.json');
export const opportunitiesFile = (root: string): string => join(root, 'out', 'opportunities.json');
export const prepareStatsFile = (root: string): string => join(root, 'out', 'prepare-stats.json');

// Where a job's files are, by kind. Batch paths are as they were before synthesis groups existed.
export type JobPaths = { input: string; output: string; validated: string; fix: string; index: string; agent: string; state: string };

export function jobPaths(root: string, id: string): JobPaths {
  const k = JOB_KINDS[kindOf(id)];
  return {
    input: join(root, 'out', k.dirs.input, `${id}${k.inputExt}`),
    output: join(root, 'out', k.dirs.output, `${id}.json`),
    validated: join(root, 'out', k.dirs.validated, `${id}.json`),
    fix: join(root, 'out', 'fix', `${id}.txt`),
    index: join(root, k.index),
    agent: join(root, k.agent),
    state: join(root, 'out', 'ledger', `${id}.json`),
  };
}

// A batch's own files: refused for any other ID.
function batchPath(root: string, dir: string, batchId: string, ext: string): string {
  if (!isBatchId(batchId)) throw new LedgerError(`"${batchId}" is not a batch ID (expected batch-NNN, or just the number).`);
  return join(root, 'out', dir, `${batchId}${ext}`);
}
export const batchFile = (root: string, batchId: string): string => batchPath(root, 'batches', batchId, '.md');
export const extractFile = (root: string, batchId: string): string => batchPath(root, 'extract', batchId, '.json');
// Any job's ledger state, validated output and fix file.
export const jobStateFile = (root: string, id: string): string => jobPaths(root, id).state;
export const batchStateFile = jobStateFile;
export const validatedFile = (root: string, id: string): string => jobPaths(root, id).validated;
export const fixFile = (root: string, id: string): string => jobPaths(root, id).fix;

export function agentBindingFile(root: string, agentId: string): string {
  if (!isAgentId(agentId)) throw new LedgerError(`"${agentId.slice(0, 80)}" is not an agent ID (letters, digits, - and _ only).`);
  return join(agentsDir(root), `${agentId}.json`);
}

// A repo-relative path as messages show it, "/" separators.
const rel = (root: string, file: string): string => withoutRoot(file, root).replaceAll('\\', '/');

// The project folder as every prompt prints it (ARCHITECTURE.md 6.22): absolute, forward slashes on
// every OS, no trailing separator. It is the one absolute path a prompt carries; each agent
// definition names its files relative to it.
export function projectFolder(root: string): string {
  const folder = resolve(root).replaceAll('\\', '/').replace(/\/+$/, '');
  return folder === '' ? '/' : folder;
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

// ---- Job state ----

export function freshState(id: string): BatchState {
  return {
    batch_id: id,
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
    no_output_run_id: null,
  };
}

// The dispatches under the current key that count toward MAX_DISPATCHES.
export const countedDispatches = (state: BatchState): number => Math.max(0, state.dispatches - state.uncounted_dispatches);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function parseState(id: string, text: string): BatchState {
  const shown = `out/ledger/${id}.json`;
  const noun = JOB_KINDS[kindOf(id)].noun;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LedgerError(`${shown} is not valid JSON; delete it to reset ${id} to pending.`);
  }
  if (!isRecord(raw) || raw.batch_id !== id || !(BATCH_STATUSES as readonly unknown[]).includes(raw.status)) {
    throw new LedgerError(`${shown} is not a ledger entry for ${id}; delete it to reset the ${noun} to pending.`);
  }
  const qs = raw.quote_stats;
  return {
    batch_id: id,
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
    no_output_run_id: strOrNull(raw.no_output_run_id),
  };
}

// Seconds since the epoch for a stored "YYYY-MM-DDTHH:MM:SSZ" time, or null for anything else
// (never parsed loosely).
const STORED_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const utcSeconds = (utc: string | null): number | null => (utc !== null && STORED_UTC.test(utc) ? utcMs(utc) / 1000 : null);

// A running job with no output file yet, dispatched less than ORPHAN_GRACE_S ago: its agent may
// still be reading. Validate and run start leave it running.
export function stillStarting(root: string, state: BatchState, nowS: number = utcSeconds(nowUtc()) as number): boolean {
  const dispatched = utcSeconds(state.dispatched_utc);
  return state.status === 'running' && dispatched !== null && nowS - dispatched < ORPHAN_GRACE_S && !existsSync(jobPaths(root, state.batch_id).output);
}

export function readBatchState(root: string, id: string): BatchState {
  const text = readText(jobStateFile(root, id));
  return text === null ? freshState(id) : parseState(id, text);
}
export const readJobState = readBatchState;

// Read, change and write one job's state under its lock. Returns what was written.
export function updateBatchState(root: string, id: string, change: (state: BatchState) => BatchState): BatchState {
  const file = jobStateFile(root, id);
  return withLock(file, `out/ledger/${id}.json`, () => {
    const next = { ...change(readBatchState(root, id)), batch_id: id };
    writeJsonAtomic(file, next);
    return next;
  });
}

// The job IDs with a state file, by name: batches first, then synthesis groups. Read from the
// ledger folder, not the indexes, so it works before prepare or rollup has rebuilt them.
function recordedJobs(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(ledgerDir(root));
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return [];
    throw err;
  }
  const ids = names.filter((n) => /^(?:batch|synth)-\d{3,6}\.json$/.test(n)).map((n) => n.slice(0, -'.json'.length));
  return [...ids.filter(isBatchId).sort(), ...ids.filter(isSynthId).sort()];
}

// The jobs whose recorded state is running: what run start must stamp.
export const recordedRunning = (root: string): string[] => recordedJobs(root).filter((id) => readBatchState(root, id).status === 'running');

// ---- Indexes and cache keys ----

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

// A batch index entry as a job.
export const batchJob = (b: BatchEntry): JobEntry => ({ id: b.batch_id, file: b.file, content_sha: b.content_sha });

// The jobs of one kind, in index order: out/batches/index.json or out/synthesis/index.json.
export function loadJobs(root: string, kind: JobKind): JobEntry[] {
  if (kind === 'batch') return loadIndex(root).map(batchJob);
  const text = readText(synthIndexFile(root));
  if (text === null) throw new LedgerError('No synthesis groups yet: out/synthesis/index.json is missing. Run node obs.mjs rollup first.');
  let index: unknown;
  try {
    index = JSON.parse(text);
  } catch {
    throw new LedgerError('out/synthesis/index.json is not valid JSON. Run node obs.mjs rollup again.');
  }
  if (
    !Array.isArray(index) ||
    !index.every((g) => isRecord(g) && typeof g.group_id === 'string' && isSynthId(g.group_id) && typeof g.file === 'string' && typeof g.content_sha === 'string')
  ) {
    throw new LedgerError('out/synthesis/index.json is not a synthesis index. Run node obs.mjs rollup again.');
  }
  return (index as Array<{ group_id: string; file: string; content_sha: string }>).map((g) => ({ id: g.group_id, file: g.file, content_sha: g.content_sha }));
}

export function findJob(jobs: readonly JobEntry[], id: string): JobEntry {
  const entry = jobs.find((j) => j.id === id);
  if (entry === undefined) {
    const k = JOB_KINDS[kindOf(id)];
    const range = jobs.length === 0 ? 'there are none' : `${jobs[0]?.id} to ${jobs.at(-1)?.id}`;
    throw new LedgerError(`Unknown ${k.noun} "${id}" (${k.nouns} in ${k.index}: ${range}).`);
  }
  return entry;
}

// The job entry of batch `batchId` in the batch index.
export const findBatch = (index: readonly BatchEntry[], batchId: string): JobEntry => findJob(index.map(batchJob), batchId);

// The parts of the cache key every job of a kind shares. Line endings are normalized first, so a
// checkout that converted them doesn't invalidate finished work. A missing file hashes as "none".
// A synthesis group has no taxonomy part: its input embeds the merged membership it was built from.
export type SharedKeyParts = { agent_sha: string; taxonomy_sha: string };

// The newline-normalised hash of a text file, or null when it doesn't exist.
export function fileSha(file: string): string | null {
  const text = readText(file);
  return text === null ? null : sha256(normalizeNewlines(text));
}

export function sharedKeyParts(root: string, kind: JobKind = 'batch'): SharedKeyParts {
  return {
    agent_sha: fileSha(join(root, JOB_KINDS[kind].agent)) ?? sha256('none'),
    taxonomy_sha: kind === 'batch' ? (fileSha(taxonomyFile(root)) ?? sha256('none')) : sha256('none'),
  };
}

// Unchanged since M3 (the 99 committed batch keys depend on it, and a test pins it to its hex); a
// synthesis group's key uses the same formula with its own parts.
export const cacheKey = (contentSha: string, parts: SharedKeyParts): string =>
  sha256(`batch ${contentSha}\nagent ${parts.agent_sha}\ntaxonomy ${parts.taxonomy_sha}\n`);

// The validated output exists, parses, and was made from this job's input.
function validatedMatches(root: string, job: JobEntry): boolean {
  try {
    const text = readText(jobPaths(root, job.id).validated);
    if (text === null) return false;
    const value: unknown = JSON.parse(text);
    return isRecord(value) && value.content_sha === job.content_sha;
  } catch {
    return false;
  }
}

// What a job's recorded state means now. A running job stays running whatever changed since its
// dispatch: its agent may still be writing, so only a stamp (gate, validate, run start) moves it
// on, and dispatch refuses it until then. Otherwise a changed key makes any recorded status
// pending; done also needs the validated file for this input; and a failed job whose counted
// dispatches under this key are used up is exhausted.
export function effectiveStatus(root: string, state: BatchState, job: JobEntry, currentKey: string): EffectiveStatus {
  if (state.status === 'running') return 'running';
  if (state.status === 'pending' || state.cache_key !== currentKey) return 'pending';
  if (state.status === 'done') return validatedMatches(root, job) ? 'done' : 'pending';
  return countedDispatches(state) >= MAX_DISPATCHES ? 'exhausted' : 'failed';
}

export type BatchView = { entry: JobEntry; state: BatchState; status: EffectiveStatus; cache_key: string };
export type JobView = BatchView;

// Every job of a kind with its state, current key and what that state means now.
export function batchViews(root: string, kind: JobKind = 'batch'): BatchView[] {
  const jobs = loadJobs(root, kind);
  const parts = sharedKeyParts(root, kind);
  return jobs.map((entry) => {
    const state = readBatchState(root, entry.id);
    const key = cacheKey(entry.content_sha, parts);
    return { entry, state, status: effectiveStatus(root, state, entry, key), cache_key: key };
  });
}
export const jobViews = batchViews;

// What the orchestrator dispatches next: failed jobs with dispatches left (fix rounds), then
// pending ones, in index order, up to `cap` minus what is running. Nothing until the kind is
// `ready`: for batches the taxonomy is fresh (every extraction depends on it), for synthesis
// groups the rollup is current.
export function nextToDispatch(
  views: readonly BatchView[],
  ready: boolean,
  cap: number = inFlight(),
): { next: string[]; retryable: string[]; exhausted: string[] } {
  const ids = (status: EffectiveStatus) => views.filter((v) => v.status === status).map((v) => v.entry.id);
  const retryable = ids('failed');
  const exhausted = ids('exhausted');
  const slots = Math.max(0, cap - ids('running').length);
  const next = ready ? [...retryable, ...ids('pending')].slice(0, slots) : [];
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
function readFixLines(root: string, id: string): string[] {
  try {
    return (readText(fixFile(root, id)) ?? '').split('\n').filter((l) => l.trim() !== '');
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

// Hand a job to its agent. The input file must be the one the index describes (prepare or rollup
// may have rerun since). Refused while the job is running (validate it first), and when it is done
// or exhausted unless forced. A failed (or forced exhausted) job whose previous output is a JSON
// object goes out as a fix round: its problems are in its fix file, out/fix/<job_id>.txt (written
// when it was stamped; rebuilt here from the state's first problems if it has gone), `fix` is the
// lines of that file, and the output stays for the agent to edit. Otherwise `fix` is null, the
// previous output and any fix file are removed (a stale file must never be validated in place of
// the new one) and the prompt is the fresh one. The validated file always goes. The cache key of
// the inputs it is handed out with is recorded now and kept; the dispatch count goes up under the
// same key and restarts at 1 under a new one, as do the uncounted dispatches and the no-output
// streak.
export function markDispatched(root: string, job: JobEntry, opts: { force?: boolean } = {}): { state: BatchState; fix: string[] | null } {
  const id = job.id;
  const kind = kindOf(id);
  const k = JOB_KINDS[kind];
  const paths = jobPaths(root, id);
  const text = readText(paths.input);
  if (text === null) throw new LedgerError(`${rel(root, paths.input)} is missing. Run node obs.mjs ${k.rebuild} again.`);
  if (sha256(text) !== job.content_sha) {
    throw new LedgerError(`${rel(root, paths.input)} does not match ${k.index} (changed since ${k.rebuild} ran). Run node obs.mjs ${k.rebuild} again.`);
  }
  const key = cacheKey(job.content_sha, sharedKeyParts(root, kind));
  let fix: string[] | null = null;
  const state = updateBatchState(root, id, (s) => {
    const status = effectiveStatus(root, s, job, key);
    if (status === 'running') {
      throw new LedgerError(`${id} is running: its ${k.worker} may still be working on it. Run node obs.mjs validate ${id} first.`);
    }
    if (status === 'done' && opts.force !== true) {
      throw new LedgerError(`${id} is already done. To ${k.verb} it again anyway: node obs.mjs dispatch ${id} --force`);
    }
    if (status === 'exhausted' && opts.force !== true) {
      throw new LedgerError(
        `${id} is exhausted: all ${countedDispatches(s)} counted dispatches under its current inputs failed. To try once more: node obs.mjs dispatch ${id} --force`,
      );
    }
    let lines = readFixLines(root, id);
    const fixRound = (status === 'failed' || status === 'exhausted') && (lines.length > 0 || s.last_problems.length > 0) && holdsJsonObject(paths.output);
    if (fixRound) {
      if (lines.length === 0) {
        writeFileAtomic(paths.fix, fixText(s.last_problems, s.problems ?? s.last_problems.length));
        lines = readFixLines(root, id);
      }
      fix = lines;
    } else {
      fix = null;
      removeFile(paths.output);
      removeFile(paths.fix);
    }
    removeFile(paths.validated);
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
      no_output_run_id: s.no_output_run_id,
    };
  });
  return { state, fix };
}

export function requireRunning(root: string, id: string): BatchState {
  const state = readBatchState(root, id);
  if (state.status !== 'running') {
    const noun = JOB_KINDS[kindOf(id)].noun;
    throw new LedgerError(`${id} is ${state.status}, not running: only a dispatched ${noun} can be validated. Run node obs.mjs dispatch ${id} first.`);
  }
  return state;
}

// The quote statistics of a validated extraction; a synthesis has none.
const quoteStatsOf = (v: ValidatedExtraction | ValidatedSynthesis | null): QuoteStats | null => (v !== null && 'quote_stats' in v ? v.quote_stats : null);

// The outcome of a validation, recorded the same way by `obs validate`, run start and the
// SubagentStop gate. Only a running job is stamped, under the cache key recorded at its dispatch;
// a setup failure (nothing the model can fix) is never recorded.
// - done: the validated file is written, under the job's lock, before the state says done, so a
//   crash in between leaves the job unfinished, never done without its output, and a second stamp
//   can't overwrite the first. The fix file goes.
// - failed: no validated file (only a passing check makes one), and every problem goes to the fix
//   file for the next round. With no output file at all, the stamp counts toward the circuit
//   breaker, and the dispatch toward MAX_DISPATCHES only if the previous stamp had no output too.
//   The no-output stamp records the run it was made under: the active run's ID unless `runId` says
//   otherwise (run start passes null: what a dead session left belongs to no run's breaker).
export function recordValidation(
  root: string,
  job: JobEntry,
  check: JobCheck<ValidatedExtraction | ValidatedSynthesis>,
  opts: { runId?: string | null } = {},
): BatchState {
  const id = job.id;
  if (check.setup !== null) throw new LedgerError(`${id} could not be checked: ${withoutRoot(check.setup, root)}`);
  requireRunning(root, id);
  const paths = jobPaths(root, id);
  const lines = check.problems.map((p) => problemLine(p, root));
  const runId = opts.runId !== undefined ? opts.runId : activeRunId(root);
  return updateBatchState(root, id, (s) => {
    if (s.status !== 'running') throw new LedgerError(`${id} stopped being running while it was validated (it is now ${s.status}).`);
    const now = nowUtc();
    const noOutput = !check.ok && !existsSync(paths.output);
    const streak = noOutput ? s.no_output_streak + 1 : 0;
    if (check.ok && check.validated !== null) {
      writeJsonAtomic(paths.validated, check.validated);
      removeFile(paths.fix);
    } else {
      removeFile(paths.validated);
      writeFileAtomic(paths.fix, fixText(lines, lines.length));
    }
    return {
      ...s,
      status: check.ok && check.validated !== null ? 'done' : 'failed',
      finished_utc: now,
      quote_stats: quoteStatsOf(check.validated),
      problems: check.problems.length,
      last_problems: lines.slice(0, MAX_PROBLEMS_KEPT),
      uncounted_dispatches: s.uncounted_dispatches + (noOutput && streak === 1 ? 1 : 0),
      no_output_streak: streak,
      no_output_utc: noOutput ? now : s.no_output_utc,
      no_output_run_id: noOutput ? runId : s.no_output_run_id,
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
    !isJobId(raw.batch_id) ||
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

// The binding belongs to the job's current dispatch: same count, key and dispatch time. Any
// re-dispatch changes at least one of them (the count restarts under a new key, so it alone can't
// tell), and then the binding's holder may no longer write or stamp the job.
export function bindingIsCurrent(binding: AgentBinding, state: BatchState): boolean {
  return binding.dispatches === state.dispatches && binding.cache_key === state.cache_key && binding.dispatched_utc === state.dispatched_utc;
}

export type BindResult = { ok: true; binding: AgentBinding } | { ok: false; reason: string };

// out/ledger/agents/jobs/<job_id>.json: the agent holding the job's current dispatch, so that one
// dispatch is worked on by one agent. `dispatch` and `refill` never hand out a running job, so
// there is never a second agent for a dispatch legitimately; a second one is refused.
type JobHolder = { agent_id: string; dispatches: number; cache_key: string; dispatched_utc: string };
const jobHolderFile = (root: string, jobId: string): string => join(agentsDir(root), 'jobs', `${jobId}.json`);

// The recorded holder, or null when there is none or the file can't be read (it only ever
// excludes, and is rewritten by the next binding).
function readHolder(file: string): JobHolder | null {
  try {
    const raw: unknown = JSON.parse(readText(file) ?? 'null');
    if (!isRecord(raw) || typeof raw.agent_id !== 'string' || !Number.isInteger(raw.dispatches) || typeof raw.cache_key !== 'string' || typeof raw.dispatched_utc !== 'string') return null;
    return { agent_id: raw.agent_id, dispatches: raw.dispatches as number, cache_key: raw.cache_key, dispatched_utc: raw.dispatched_utc };
  } catch {
    return null;
  }
}

// Bind an agent to a job, on its first read of a job file. The first binding wins: binding again to
// the same job returns it unchanged, to another job is refused. Only a running job can be bound,
// and only by one agent per dispatch: a second agent reading a job another agent already holds
// under the same dispatch is refused. The binding copies the dispatch count, cache key and
// dispatch time, so a re-dispatch supersedes it (bindingIsCurrent) and frees the job for the next
// agent. Which kind of job an agent type may bind to is the guard's business (its allowlists);
// this records whatever it allowed.
export function bindAgent(root: string, agentId: string, jobId: string): BindResult {
  if (!isAgentId(agentId)) return { ok: false, reason: `agent ID ${JSON.stringify(agentId.slice(0, 80))} can't be bound (letters, digits, - and _ only)` };
  if (!isJobId(jobId)) return { ok: false, reason: `${JSON.stringify(jobId.slice(0, 80))} is not a job ID` };
  const k = JOB_KINDS[kindOf(jobId)];
  const file = agentBindingFile(root, agentId);
  return withLock(file, `out/ledger/agents/${agentId}.json`, (): BindResult => {
    const existing = parseBinding(agentId, readText(file));
    if (existing !== null) {
      return existing.batch_id === jobId
        ? { ok: true, binding: existing }
        : { ok: false, reason: `this ${k.worker} is bound to ${existing.batch_id}, the first ${k.short} it read; ${jobId} is not its ${k.short}` };
    }
    const state = readBatchState(root, jobId);
    if (state.status !== 'running') return { ok: false, reason: `${jobId} is ${state.status}, not running: it has not been handed to ${k.worker === 'extractor' ? 'an' : 'a'} ${k.worker}` };
    if (state.cache_key === null || state.dispatched_utc === null) return { ok: false, reason: `${jobId} has no dispatch record to bind to` };
    const dispatch = { dispatches: state.dispatches, cache_key: state.cache_key, dispatched_utc: state.dispatched_utc };
    // Agent lock, then job-holder lock: always in this order, so two agents can't deadlock.
    const holderFile = jobHolderFile(root, jobId);
    const heldBy = withLock(holderFile, `out/ledger/agents/jobs/${jobId}.json`, (): string | null => {
      const h = readHolder(holderFile);
      if (h !== null && h.agent_id !== agentId && h.dispatches === dispatch.dispatches && h.cache_key === dispatch.cache_key && h.dispatched_utc === dispatch.dispatched_utc) {
        return h.agent_id;
      }
      writeJsonAtomic(holderFile, { agent_id: agentId, ...dispatch });
      return null;
    });
    if (heldBy !== null) {
      return { ok: false, reason: `${jobId} is already being worked on by another ${k.worker} under its current dispatch; one ${k.short} has one ${k.worker} at a time` };
    }
    const binding: AgentBinding = {
      agent_id: agentId,
      batch_id: jobId,
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
export const boundJob = boundBatch;

// ---- Run state ----

// --force: every model output and the state that refers to it: job states of both kinds, agent
// bindings, the taxonomy (canonical, proposed, and its attempt count), the merge (table, proposal,
// input and attempt count), the validated extractions, the rollup and everything built from it
// (coverage, validation report, synthesis inputs and validated syntheses), the opportunities, and
// the fix files. The raw model outputs stay (out/extract/, out/synthesis/raw/): a fresh dispatch
// removes its job's file, and until then they are evidence of what the previous run produced.
export function clearModelOutputs(root: string): void {
  for (const id of recordedJobs(root)) removeFile(jobStateFile(root, id));
  const out = join(root, 'out');
  for (const path of [
    agentsDir(root),
    join(out, 'validated'),
    join(out, 'fix'),
    taxonomyFile(root),
    taxonomyProposedFile(root),
    taxonomyStateFile(root),
    mergeFile(root),
    mergeProposedFile(root),
    mergeInputFile(root),
    mergeStateFile(root),
    rollupFile(root),
    coverageFile(root),
    validationReportFile(root),
    synthIndexFile(root),
    join(synthesisDir(root), 'input'),
    join(synthesisDir(root), 'validated'),
  ]) {
    removeFile(path);
  }
  let names: string[] = [];
  try {
    names = readdirSync(out);
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') throw err;
  }
  for (const name of names) if (/^opportunities(?:\.[^/\\]+)?\.json$/.test(name)) removeFile(join(out, name));
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

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

// Append one record to the active run's log, out/runs/<run_id>.jsonl, or out/runs/adhoc.jsonl when
// no run is active. `forRun` names the run instead (a command that ended the run it started in
// still logs to it). One short line per append, so concurrent writers (the hooks) don't interleave
// inside a line. The log is committed, so the project folder is cut out of everything in it.
export function appendRunLog(root: string, record: Record<string, unknown>, forRun?: string): void {
  let runId = 'adhoc';
  if (forRun !== undefined && RUN_ID.test(forRun)) {
    runId = forRun;
  } else {
    try {
      const run = readRun(root);
      if (run.active && run.run_id !== null && RUN_ID.test(run.run_id)) runId = run.run_id;
    } catch {
      // an unreadable run state still gets its events logged, as adhoc
    }
  }
  const dir = join(root, 'out', 'runs');
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }, (_key, value: unknown) =>
    typeof value === 'string' ? withoutRoot(value, root) : value,
  );
  appendFileSync(join(dir, `${runId}.jsonl`), `${line}\n`);
}

// The active run's ID, or null when no run is active or the run state can't be read.
export function activeRunId(root: string): string | null {
  try {
    const run = readRun(root);
    return run.active ? run.run_id : null;
  } catch {
    return null;
  }
}

// ---- Timing events of the pipeline's own commands (ARCHITECTURE.md 7.4, 15.3) ----
//
// `advance`, every deterministic stage step and `prepare` log one event each with its duration in
// milliseconds, so a run's time breaks down from its log alone: a stage's hand-off is the gap
// between its `stage` event and the next SubagentStart, a cycle's cost the gap between an `advance`
// and the SubagentStarts it dispatched. Logged only during a run (to `runId`, the active run by
// default): a command typed outside one leaves no file behind. Never in the way: a failure to log
// is ignored, the step's result stands.
export function logRunEvent(root: string, record: Record<string, unknown>, runId: string | null = activeRunId(root)): void {
  if (runId === null) return;
  try {
    appendRunLog(root, record, runId);
  } catch {
    // the step's outcome matters more than its log line
  }
}

// One deterministic step done: `{ event: 'stage', name, attempt?, ms, summary }`. `startedMs` is
// performance.now() when the step began.
export type StageName =
  | 'taxonomy prompt'
  | 'taxonomy accept'
  | 'merge prompt'
  | 'merge accept'
  | 'rollup'
  | 'score'
  | 'artifacts prepare'
  | 'artifacts collect'
  | 'run end';
export function logStage(root: string, name: StageName, startedMs: number, summary: string, attempt?: number): void {
  logRunEvent(root, { event: 'stage', name, ...(attempt === undefined ? {} : { attempt }), ms: Math.round(performance.now() - startedMs), summary });
}

// What a single-call stage (the taxonomy, the merge) needs next, as `advance` and the stage's own
// command read it (ARCHITECTURE.md 15.2): nothing (fresh: accepted now or before), one agent run
// with this prompt (attempt: the prompts printed for these inputs, this one included), or nothing
// more without a person (stopped: one line for advance's halt_reason; `details`: the lines the
// stage's command prints). `notes`: what happened on the way (a waiting proposal accepted or not),
// one line each, which the command prints to stderr and advance lists in its steps.
export type StageStep =
  | { kind: 'fresh'; notes: string[] }
  | { kind: 'prompt'; prompt: string; attempt: number; notes: string[] }
  | { kind: 'stopped'; reason: string; details: string[]; notes: string[] };

// ---- The run claim ----
//
// out/ledger/claim.json: {session_id, utc}, written by the corpus guard when a session's Bash call
// starts `node obs.mjs run start`, before the command runs. Run start consumes it: a claim under
// CLAIM_MAX_AGE_S old names the session that started the run, which becomes the run's orchestrator
// (the only session the Stop hook steers). Git-ignored.
export const claimFile = (root: string): string => join(root, 'out', 'ledger', 'claim.json');
export const CLAIM_MAX_AGE_S = 120;

// The claiming session, or null when there is no claim, it can't be read, or it is too old (or
// dated in the future). The claim is removed either way, so it is used once.
export function consumeClaim(root: string, maxAgeS: number = CLAIM_MAX_AGE_S, nowS: number = utcSeconds(nowUtc()) as number): string | null {
  const file = claimFile(root);
  let text: string | null;
  try {
    text = readText(file);
  } catch {
    text = null;
  }
  removeFile(file);
  if (text === null) return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || typeof raw.session_id !== 'string' || raw.session_id === '') return null;
    const at = utcSeconds(strOrNull(raw.utc));
    if (at === null) return null;
    const age = nowS - at;
    return age >= 0 && age < maxAgeS ? raw.session_id : null;
  } catch {
    return null;
  }
}
