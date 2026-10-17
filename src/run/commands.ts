// The ledger commands the orchestrator (and a person) runs: status, dispatch, validate, verify, run.
// Output is short on purpose: the orchestrator reads `status --json` after every subagent
// completion and passes each dispatch prompt on unchanged. No command reads what a subagent
// replied; the ledger and the files on disk are the only state.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkExtraction } from '../model/validate-extraction.ts';
import { normalizeNewlines } from '../util/text.ts';
import {
  LedgerError,
  HALT_NO_OUTPUT,
  HALT_WINDOW_S,
  MAX_DISPATCHES,
  ORPHAN_GRACE_S,
  batchViews,
  clearModelOutputs,
  countedDispatches,
  findBatch,
  inFlight,
  loadIndex,
  markDispatched,
  newRunId,
  nextToDispatch,
  normalizeBatchId,
  nowUtc,
  outDir,
  problemLine,
  readBatchState,
  readRun,
  readText,
  recordValidation,
  recordedRunning,
  removeFile,
  requireRunning,
  stillStarting,
  stopGateFile,
  taxonomyFile,
  taxonomyFreshness,
  utcSeconds,
  validatedFile,
  withoutRoot,
  writeRun,
  type BatchState,
  type BatchStatus,
  type BatchView,
  type EffectiveStatus,
  type RunState,
  type TaxonomyFreshness,
} from './ledger.ts';
import type { BatchEntry } from '../types.ts';

// Absolute, forward slashes on every OS: the form the subagent's file tools take everywhere.
const absolute = (root: string, rel: string): string => resolve(root, rel).replaceAll('\\', '/');

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const REPLY = 'Reply with one short sentence and no email content.';

// The prompt an extractor gets. The agent definition holds the instructions; this names the files.
// On a fix round (`fix` = the lines of the batch's fix file) it also names the previous output and
// the problems file, and says how many problems there are. The problems themselves go only through
// that file, never through this prompt, which the orchestrator passes on and so reads. The round
// number is the batch's counted dispatches, read from the ledger after dispatch.
export function extractorPrompt(root: string, batchId: string, fix: string[] | null): string {
  const batch = `Batch file: ${absolute(root, `out/batches/${batchId}.md`)}`;
  const taxonomy = existsSync(taxonomyFile(root))
    ? `Taxonomy file: ${absolute(root, 'out/taxonomy.json')}`
    : 'Taxonomy file: none yet. Every process key must be new:<slug>, each defined in new_processes.';
  const output = `Output file: ${absolute(root, `out/extract/${batchId}.json`)}`;
  if (fix === null) return [`Extract batch ${batchId}.`, batch, taxonomy, output, REPLY].join('\n');

  const state = readBatchState(root, batchId);
  const round = Math.max(1, countedDispatches(state) - 1);
  const of = round <= MAX_DISPATCHES - 1 ? ` of ${MAX_DISPATCHES - 1}` : '';
  const total = state.problems ?? fix.length;
  return [
    `Extract batch ${batchId} (fix round ${round}${of}).`,
    batch,
    taxonomy,
    `Previous output: ${absolute(root, `out/extract/${batchId}.json`)}`,
    `Problems file: ${absolute(root, `out/fix/${batchId}.txt`)}`,
    `The pipeline checked the previous output and found ${plural(total, 'problem')}, listed in the problems file. ` +
      'Read the batch file, the previous output and the problems file, fix only those problems, keep every other entry exactly as it was, and Write the whole file to:',
    output,
    REPLY,
  ].join('\n');
}

// "batch-000, batch-002..batch-005": consecutive batch numbers collapse into a range.
export function compactIds(ids: readonly string[]): string {
  const nums = ids.map((id) => ({ id, n: Number(id.slice(id.lastIndexOf('-') + 1)) }));
  const parts: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && (nums[j + 1] as { n: number }).n === (nums[j] as { n: number }).n + 1) j++;
    const first = (nums[i] as { id: string }).id;
    const last = (nums[j] as { id: string }).id;
    parts.push(j === i ? first : j === i + 1 ? `${first}, ${last}` : `${first}..${last}`);
    i = j + 1;
  }
  return parts.join(', ');
}

// ---- Timing ----

// From the ledger alone, for the batches dispatched since the run started (an orphan dispatched by
// an earlier session is no sample). The ledger keeps each batch's last dispatch and stamp, so a fix
// round's earlier attempt is counted in fix_rounds but not timed.
export type Timing = {
  started_utc: string | null; // the run's
  wall_s: number | null; // run start to the last stamp
  done: number; // batches dispatched and done in this run: the samples below
  batch_s_p50: number | null; // dispatch to stamp, nearest rank
  batch_s_p90: number | null;
  fix_rounds: number; // counted dispatches beyond the first, for the batches dispatched in this run
  slot_idle_s_mean: number | null; // from a stamp to the next dispatch
};

const seconds = utcSeconds;
const percentile = (sorted: readonly number[], p: number): number | null =>
  sorted.length === 0 ? null : (sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] as number);

export function timingFrom(states: readonly BatchState[], run: RunState): Timing | null {
  const start = seconds(run.started_utc);
  if (start === null) return null;
  const inRun: Array<{ state: BatchState; dispatched: number; finished: number | null }> = [];
  for (const state of states) {
    const dispatched = seconds(state.dispatched_utc);
    const finished = seconds(state.finished_utc);
    if (dispatched !== null && dispatched >= start) inRun.push({ state, dispatched, finished: finished !== null && finished >= dispatched ? finished : null });
  }
  const finished = inRun.filter((x) => x.finished !== null) as Array<{ state: BatchState; dispatched: number; finished: number }>;
  const done = finished.filter((x) => x.state.status === 'done');
  const durations = done.map((x) => x.finished - x.dispatched).sort((a, b) => a - b);
  const dispatches = inRun.map((x) => x.dispatched).sort((a, b) => a - b);
  const idle = finished.flatMap((x) => {
    const next = dispatches.find((d) => d >= x.finished);
    return next === undefined ? [] : [next - x.finished];
  });
  const last = finished.reduce<number | null>((m, x) => (m === null || x.finished > m ? x.finished : m), null);
  return {
    started_utc: run.started_utc,
    wall_s: last === null ? null : last - start,
    done: done.length,
    batch_s_p50: percentile(durations, 0.5),
    batch_s_p90: percentile(durations, 0.9),
    fix_rounds: inRun.reduce((n, x) => n + Math.max(0, countedDispatches(x.state) - 1), 0),
    slot_idle_s_mean: idle.length === 0 ? null : Math.round((idle.reduce((a, b) => a + b, 0) / idle.length) * 10) / 10,
  };
}

// ---- Status ----

// What `status --json` prints: counts and the short lists the loop acts on, never the done list.
// extraction: complete = nothing pending, running or retryable (exhausted batches are reported,
// not waited for); blocked = not complete and the taxonomy is not fresh, so nothing can be
// dispatched until the taxonomy stage runs; incomplete otherwise. halt: the circuit breaker
// (haltFrom); while it is on, `next` is empty and the loop stops with halt_reason.
export type StatusReport = {
  batches: number;
  counts: Record<EffectiveStatus, number>;
  taxonomy: TaxonomyFreshness;
  in_flight: number;
  next: string[];
  running: string[];
  retryable: string[];
  exhausted: string[];
  extraction: 'complete' | 'incomplete' | 'blocked';
  halt: boolean;
  halt_reason: string | null;
  timing: Timing | null;
  run: RunState;
};

// The circuit breaker: HALT_NO_OUTPUT or more batches stamped with no output file during this run
// and within the last HALT_WINDOW_S. Extractors that end without writing anything, many at once,
// are being cut off (a usage limit, say); dispatching more only burns attempts.
export function haltFrom(states: readonly BatchState[], run: RunState, nowS: number = utcSeconds(nowUtc()) as number): string | null {
  const start = utcSeconds(run.started_utc);
  if (start === null) return null;
  const recent = states
    .filter((s) => {
      const t = utcSeconds(s.no_output_utc);
      return t !== null && t >= start && nowS - t <= HALT_WINDOW_S;
    })
    .map((s) => s.batch_id);
  if (recent.length < HALT_NO_OUTPUT) return null;
  return (
    `${recent.length} batches ended with no output file in the last ${HALT_WINDOW_S / 60} minutes (${compactIds(recent)}): ` +
    'extractors are being stopped before they write, perhaps by a usage limit. Stop the run now; run /observe again later to resume.'
  );
}

export function statusReport(root: string, views: readonly BatchView[] = batchViews(root)): StatusReport {
  const counts: Record<EffectiveStatus, number> = { pending: 0, running: 0, done: 0, failed: 0, exhausted: 0 };
  for (const v of views) counts[v.status]++;
  const taxonomy = taxonomyFreshness(root);
  const in_flight = inFlight();
  const { next, retryable, exhausted } = nextToDispatch(views, taxonomy === 'fresh', in_flight);
  const run = readRun(root);
  const states = views.map((v) => v.state);
  const halt_reason = haltFrom(states, run);
  const complete = counts.pending + counts.running + counts.failed === 0;
  return {
    batches: views.length,
    counts,
    taxonomy,
    in_flight,
    next: halt_reason === null ? next : [],
    running: views.filter((v) => v.status === 'running').map((v) => v.entry.batch_id),
    retryable,
    exhausted,
    extraction: complete ? 'complete' : taxonomy === 'fresh' ? 'incomplete' : 'blocked',
    halt: halt_reason !== null,
    halt_reason,
    timing: timingFrom(states, run),
    run,
  };
}

// Commands report a LedgerError as one line and exit 1; anything else is a bug and is thrown.
function guarded(name: string, run: () => number): number {
  try {
    return run();
  } catch (err) {
    if (err instanceof LedgerError) {
      console.error(`${name}: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

const duration = (s: number): string => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

function timingLine(t: Timing): string {
  const parts = [`${plural(t.done, 'batch', 'batches')} done in this run`];
  if (t.wall_s !== null) parts.push(`wall ${duration(t.wall_s)}`);
  if (t.batch_s_p50 !== null && t.batch_s_p90 !== null) parts.push(`per batch p50 ${t.batch_s_p50}s, p90 ${t.batch_s_p90}s`);
  parts.push(plural(t.fix_rounds, 'fix round'));
  if (t.slot_idle_s_mean !== null) parts.push(`slot idle ${t.slot_idle_s_mean}s mean`);
  return `  timing: ${parts.join('; ')}.`;
}

export function statusCommand(root: string, args: readonly string[]): number {
  return guarded('status', () => {
    const json = args.includes('--json');
    const unknown = args.filter((a) => a !== '--json');
    if (unknown.length > 0) throw new LedgerError(`unexpected argument "${unknown[0]}". Usage: node obs.mjs status [--json]`);
    const views = batchViews(root);
    const report = statusReport(root, views);
    if (json) {
      console.log(JSON.stringify(report));
      return 0;
    }
    const c = report.counts;
    const run = report.run.active ? `run ${report.run.run_id} active` : 'no run active';
    const extraction = report.extraction === 'blocked' ? `blocked until the taxonomy is fresh (node obs.mjs taxonomy)` : report.extraction;
    console.log(
      `status: ${report.batches} batches: ${c.done} done, ${c.running} running, ${c.pending} pending, ${c.failed} failed, ${c.exhausted} exhausted; ` +
        `taxonomy ${report.taxonomy}; extraction ${extraction}; ${run}.`,
    );
    for (const status of ['running', 'pending', 'failed', 'exhausted', 'done'] as const) {
      const ids = views.filter((v) => v.status === status).map((v) => v.entry.batch_id);
      if (ids.length > 0) console.log(`  ${status}: ${compactIds(ids)}`);
    }
    if (report.halt_reason !== null) console.log(`  halt: ${report.halt_reason}`);
    if (report.next.length > 0) console.log(`  next: ${compactIds(report.next)}`);
    for (const v of views) {
      const s = v.state;
      const counted = countedDispatches(s);
      if (v.status === 'failed') {
        console.log(`  ${v.entry.batch_id} failed: ${plural(s.problems ?? 0, 'problem')}; ${counted} of ${MAX_DISPATCHES} dispatches used.`);
      } else if (v.status === 'exhausted') {
        console.log(
          `  ${v.entry.batch_id} exhausted: ${plural(s.problems ?? 0, 'problem')} after ${plural(counted, 'dispatch', 'dispatches')}; ` +
            `node obs.mjs dispatch ${v.entry.batch_id} --force tries once more.`,
        );
      }
    }
    if (report.timing !== null) console.log(timingLine(report.timing));
    return 0;
  });
}

// ---- dispatch, validate ----

// One batch ID: "batch-074", or just "74".
function oneBatchArg(command: string, args: readonly string[], options = ''): string {
  if (args.length !== 1 || (args[0] as string).startsWith('-')) {
    throw new LedgerError(`expected one batch ID. Usage: node obs.mjs ${command} <batch_id>${options} (batch-074, or just 74)`);
  }
  return normalizeBatchId(args[0] as string);
}

export function dispatchCommand(root: string, args: readonly string[]): number {
  return guarded('dispatch', () => {
    const force = args.includes('--force');
    const batchId = oneBatchArg('dispatch', args.filter((a) => a !== '--force'), ' [--force]');
    const entry = findBatch(loadIndex(root), batchId);
    const { fix } = markDispatched(root, entry, { force });
    // Only the prompt goes to stdout, so the orchestrator can pass it on unchanged.
    console.log(extractorPrompt(root, entry.batch_id, fix));
    return 0;
  });
}

// validate prints the counts and only this many problems: its output reaches the orchestrator,
// and the problems carry (escaped, cut) model text. All of them are in the batch's fix file.
export const MAX_PROBLEMS_SHOWN = 3;

// Check a running batch's output and stamp it done or failed, as its extractor's gate would have.
// Exit 0 whenever a result is recorded, or was already recorded (by the gate, while this ran or
// before): a failed batch is a normal step of the loop, which re-dispatches it. Exit 0 too, with
// nothing recorded, for a batch still starting (no output file yet, dispatched under
// ORPHAN_GRACE_S ago): its extractor may still be reading. Exit 1 when nothing could be recorded:
// not dispatched, or a setup failure (the batch then stays running).
export function validateCommand(root: string, args: readonly string[]): number {
  return guarded('validate', () => {
    const entry = findBatch(loadIndex(root), oneBatchArg('validate', args));
    const id = entry.batch_id;
    const already = (status: BatchStatus, when: string) => {
      console.log(`validate: ${id} is already ${status} (${when}); nothing to do.`);
      return 0;
    };
    const before = readBatchState(root, id);
    if (before.status === 'done' || before.status === 'failed') return already(before.status, 'recorded when its extractor finished');
    requireRunning(root, id);
    if (stillStarting(root, before)) {
      console.log(`validate: ${id} is still starting (no output file yet, dispatched under ${ORPHAN_GRACE_S} seconds ago); it stays running.`);
      return 0;
    }
    const check = checkExtraction(root, id, { outDir: outDir(root) });
    if (check.setup !== null) {
      console.log(`validate: ${id} could not be checked, so it stays running: ${withoutRoot(check.setup, root)}`);
      return 1;
    }
    let state: BatchState;
    try {
      state = recordValidation(root, entry, check);
    } catch (err) {
      const now = readBatchState(root, id);
      if (err instanceof LedgerError && (now.status === 'done' || now.status === 'failed')) return already(now.status, 'recorded while this check ran');
      throw err;
    }
    const q = state.quote_stats;
    const quotes = q === null ? 'no quotes checked' : `quotes ${q.exact} exact, ${q.repaired} repaired, ${q.rejected} rejected`;
    console.log(`validate: ${id} ${state.status}: ${plural(check.problems.length, 'problem')}, ${quotes}.`);
    for (const p of check.problems.slice(0, MAX_PROBLEMS_SHOWN)) console.log(`  - ${problemLine(p, root)}`);
    if (check.problems.length > MAX_PROBLEMS_SHOWN) console.log(`  (${check.problems.length - MAX_PROBLEMS_SHOWN} more; all are in out/fix/${id}.txt)`);
    return 0;
  });
}

// ---- run start / end ----

// Run start: stamp every batch whose state is running. A run has just begun, so no extractor should
// be alive: whatever file each left is checked as validate would check it, a missing or bad one is
// failed (with attempts left), a good one done. Left running, with the reason: a batch still
// starting (no output file yet, dispatched under ORPHAN_GRACE_S ago, as validate leaves it), and
// one that can't be checked yet (no batch index before prepare, or a setup failure).
export type Orphan = { batch_id: string; status: BatchStatus; reason?: 'starting' | 'unchecked' };

export function stampOrphans(root: string): Orphan[] {
  const ids = recordedRunning(root);
  if (ids.length === 0) return [];
  let index: BatchEntry[] = [];
  try {
    index = loadIndex(root);
  } catch (err) {
    if (!(err instanceof LedgerError)) throw err;
  }
  return ids.map((batch_id): Orphan => {
    if (stillStarting(root, readBatchState(root, batch_id))) return { batch_id, status: 'running', reason: 'starting' };
    const entry = index.find((b) => b.batch_id === batch_id);
    if (entry === undefined) return { batch_id, status: 'running', reason: 'unchecked' };
    const check = checkExtraction(root, batch_id, { outDir: outDir(root) });
    if (check.setup !== null) return { batch_id, status: 'running', reason: 'unchecked' };
    return { batch_id, status: recordValidation(root, entry, check).status };
  });
}

export function runCommand(root: string, args: readonly string[]): number {
  return guarded('run', () => {
    const [sub, ...rest] = args;
    const force = rest.length === 1 && rest[0] === '--force';
    if (!((sub === 'start' && (rest.length === 0 || force)) || (sub === 'end' && rest.length === 0))) {
      throw new LedgerError('Usage: node obs.mjs run start [--force] | run end');
    }
    if (sub === 'start') {
      let previous: RunState | null = null;
      try {
        previous = readRun(root);
      } catch {
        // an unreadable run file is replaced
      }
      if (force) clearModelOutputs(root);
      const stamped = stampOrphans(root);
      // The Stop hook's repeat guard belongs to one session's loop; a new run starts it afresh.
      removeFile(stopGateFile(root));
      const started_utc = nowUtc();
      const run: RunState = { active: true, run_id: newRunId(started_utc), started_utc };
      writeRun(root, run);
      const replaced = previous?.active ? ` (replaces run ${previous.run_id}, which never ended)` : '';
      console.log(`run: started ${run.run_id}${replaced}. The corpus guard now applies to every tool call.`);
      if (force) console.log('run: --force cleared the model outputs: batch states, extractor bindings, the taxonomy, the validated extractions and the fix files.');
      const recorded = stamped.filter((s) => s.status !== 'running');
      if (recorded.length > 0) {
        console.log(
          `run: ${plural(recorded.length, 'batch was', 'batches were')} left running by an earlier session: ` +
            `${recorded.map((s) => `${s.batch_id} ${s.status}`).join(', ')}.`,
        );
      }
      for (const s of stamped.filter((x) => x.status === 'running')) {
        console.log(
          s.reason === 'starting'
            ? `run: ${s.batch_id} was dispatched under ${ORPHAN_GRACE_S} seconds ago and has no output yet; it stays running.`
            : `run: ${s.batch_id} was left running and can't be checked yet; after node obs.mjs prepare, run node obs.mjs validate ${s.batch_id}.`,
        );
      }
      return 0;
    }
    let current: RunState = { active: false, run_id: null, started_utc: null };
    try {
      current = readRun(root);
    } catch {
      // reset below
    }
    writeRun(root, { ...current, active: false });
    console.log(current.active ? `run: ended ${current.run_id}.` : 'run: no run was active; marked inactive.');
    return 0;
  });
}

// ---- verify ----

// Every done batch re-checked from its committed extraction against the corpus bytes: it must
// still pass and validate to exactly its committed validated file. Read-only. Exit 1 on any
// difference, so CI catches a stale or hand-edited output.
export function verifyCommand(root: string, args: string[]): number {
  return guarded('verify', () => {
    if (args.length > 0) throw new LedgerError(`unexpected argument "${args[0]}". Usage: node obs.mjs verify`);
    const views = batchViews(root);
    const done = views.filter((v) => v.status === 'done');
    if (done.length === 0) {
      console.log('verify: nothing to verify: no batch is done.');
      return 0;
    }
    const failures: string[] = [];
    for (const v of done) {
      const id = v.entry.batch_id;
      const check = checkExtraction(root, id, { outDir: outDir(root) });
      if (check.setup !== null) {
        failures.push(`${id}: could not be checked: ${check.setup}`);
      } else if (!check.ok || check.validated === null) {
        failures.push(`${id}: out/extract/${id}.json no longer passes validation (${plural(check.problems.length, 'problem')}; first: ${check.problems[0] ?? 'none'})`);
      } else {
        const committed = readText(validatedFile(root, id));
        if (committed === null || normalizeNewlines(committed) !== `${JSON.stringify(check.validated, null, 2)}\n`) {
          failures.push(`${id}: out/validated/${id}.json differs from what out/extract/${id}.json validates to now`);
        }
      }
    }
    const unchecked = views.length - done.length;
    const rest = unchecked > 0 ? ` (${plural(unchecked, 'batch', 'batches')} not done, not verified)` : '';
    if (failures.length === 0) {
      console.log(`verify: ${plural(done.length, 'done batch', 'done batches')} re-checked against the corpus; every validated file matches${rest}.`);
      return 0;
    }
    console.log(`verify: ${failures.length} of ${plural(done.length, 'done batch', 'done batches')} fail${rest}:`);
    for (const f of failures) console.log(`  - ${withoutRoot(f, root)}`);
    return 1;
  });
}
