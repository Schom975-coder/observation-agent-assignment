// The ledger commands the orchestrator (and a person) runs: status, dispatch, validate, refill,
// verify, run. Each takes a job of either kind: an extraction batch ("batch-NNN", or just the
// number) or a synthesis group ("synth-NNN"). Output is short on purpose: the orchestrator reads
// `status --json` (or one `refill`) after every subagent completion and passes each prompt on
// unchanged. No command reads what a subagent replied; the ledger and the files on disk are the
// only state.
import { existsSync } from 'node:fs';
import { normalizeNewlines } from '../util/text.ts';
import { checkJob, descriptionFor, extractorPrompt, jobPrompt } from './jobs.ts';
import {
  LedgerError,
  HALT_NO_OUTPUT,
  HALT_WINDOW_S,
  JOB_KINDS,
  MAX_DISPATCHES,
  ORPHAN_GRACE_S,
  appendRunLog,
  batchViews,
  clearModelOutputs,
  consumeClaim,
  countedDispatches,
  findJob,
  inFlight,
  kindOf,
  loadJobs,
  markDispatched,
  newRunId,
  nextToDispatch,
  normalizeJobId,
  nowUtc,
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
  synthIndexFile,
  taxonomyFreshness,
  utcSeconds,
  validatedFile,
  withoutRoot,
  writeJsonAtomic,
  writeRun,
  type BatchState,
  type BatchStatus,
  type BatchView,
  type EffectiveStatus,
  type RunState,
  type TaxonomyFreshness,
} from './ledger.ts';
import { extractionsSha, mergeFreshness, type MergeFreshness } from './merge.ts';
import { rollupFreshness, type RollupFreshness } from './rollup.ts';
import { scoreFreshness, synthesisSha, type ScoreFreshness } from './score.ts';
import type { JobEntry, JobKind } from '../types.ts';

export { extractorPrompt };

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// "batch-000, batch-002..batch-005": consecutive numbers of the same kind collapse into a range.
export function compactIds(ids: readonly string[]): string {
  const nums = ids.map((id) => ({ id, kind: id.slice(0, id.lastIndexOf('-')), n: Number(id.slice(id.lastIndexOf('-') + 1)) }));
  const parts: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1]?.kind === nums[j]?.kind && (nums[j + 1] as { n: number }).n === (nums[j] as { n: number }).n + 1) j++;
    const first = (nums[i] as { id: string }).id;
    const last = (nums[j] as { id: string }).id;
    parts.push(j === i ? first : j === i + 1 ? `${first}, ${last}` : `${first}..${last}`);
    i = j + 1;
  }
  return parts.join(', ');
}

// ---- Timing ----

// From the ledger alone, for the jobs of one kind dispatched since the run started (an orphan
// dispatched by an earlier session is no sample). The ledger keeps each job's last dispatch and
// stamp, so a fix round's earlier attempt is counted in fix_rounds but not timed. The field names
// say batch; the same record times synthesis groups.
export type Timing = {
  started_utc: string | null; // the run's
  wall_s: number | null; // run start to the last stamp
  done: number; // jobs dispatched and done in this run: the samples below
  batch_s_p50: number | null; // dispatch to stamp, nearest rank
  batch_s_p90: number | null;
  fix_rounds: number; // counted dispatches beyond the first, for the jobs dispatched in this run
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

// Where the run is: the first stage whose output is not yet current (ARCHITECTURE.md 7.2).
export type Stage = 'taxonomy' | 'extraction' | 'merge' | 'rollup' | 'synthesis' | 'score' | 'done';

export type SynthesisStatus = {
  counts: Record<EffectiveStatus, number>;
  next: string[];
  running: string[];
  retryable: string[];
  exhausted: string[];
  complete: boolean; // the rollup is current, its groups are indexed, and none is pending, running or retryable
};

// What `status --json` prints: counts and the short lists the loop acts on, never the done list.
// The top-level lists are the extraction batches'; `synthesis` has the groups'. extraction:
// complete = nothing pending, running or retryable (exhausted batches are reported, not waited
// for); blocked = not complete and the taxonomy is not fresh, so nothing can be dispatched until
// the taxonomy stage runs; incomplete otherwise. Synthesis groups are dispatched only once
// extraction is complete, the merge fresh and the rollup current. halt: the circuit breaker
// (haltFrom, over both kinds); while it is on, both `next` lists are empty and the loop stops with
// halt_reason. Both kinds share the in-flight cap.
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
  merge: MergeFreshness;
  rollup: RollupFreshness;
  synthesis: SynthesisStatus;
  score: ScoreFreshness;
  stage: Stage;
  halt: boolean;
  halt_reason: string | null;
  timing: Timing | null;
  run: RunState;
};

// The circuit breaker: HALT_NO_OUTPUT or more jobs stamped with no output file under this run
// (no_output_run_id, so an orphan that run start stamped, in whatever second, never counts) and
// within the last HALT_WINDOW_S. Agents that end without writing anything, many at once, are being
// cut off (a usage limit, say); dispatching more only burns attempts.
export function haltFrom(states: readonly BatchState[], run: RunState, nowS: number = utcSeconds(nowUtc()) as number): string | null {
  if (run.run_id === null) return null;
  const recent = states
    .filter((s) => {
      const t = utcSeconds(s.no_output_utc);
      return s.no_output_run_id === run.run_id && t !== null && nowS - t <= HALT_WINDOW_S;
    })
    .map((s) => s.batch_id);
  if (recent.length < HALT_NO_OUTPUT) return null;
  const kinds = new Set(recent.map(kindOf));
  const what = kinds.size === 1 && kinds.has('batch') ? 'batches' : kinds.size === 1 ? 'synthesis groups' : 'jobs';
  const who = kinds.size === 1 && kinds.has('batch') ? 'extractors' : kinds.size === 1 ? 'synthesizers' : 'subagents';
  return (
    `${recent.length} ${what} ended with no output file in the last ${HALT_WINDOW_S / 60} minutes (${compactIds(recent)}): ` +
    `${who} are being stopped before they write, perhaps by a usage limit. Stop the run now; run /observe again later to resume.`
  );
}

const countsOf = (views: readonly BatchView[]): Record<EffectiveStatus, number> => {
  const counts: Record<EffectiveStatus, number> = { pending: 0, running: 0, done: 0, failed: 0, exhausted: 0 };
  for (const v of views) counts[v.status]++;
  return counts;
};
const idsWith = (views: readonly BatchView[], status: EffectiveStatus): string[] => views.filter((v) => v.status === status).map((v) => v.entry.id);

// The synthesis groups' views, or null when there is no synthesis index yet.
export function synthViews(root: string): BatchView[] | null {
  if (!existsSync(synthIndexFile(root))) return null;
  return batchViews(root, 'synth');
}

export function statusReport(root: string, views: readonly BatchView[] = batchViews(root), groups: readonly BatchView[] | null = synthViews(root)): StatusReport {
  const counts = countsOf(views);
  const sCounts = countsOf(groups ?? []);
  const taxonomy = taxonomyFreshness(root);
  const in_flight = inFlight();
  const run = readRun(root);
  const halt_reason = haltFrom([...views, ...(groups ?? [])].map((v) => v.state), run);
  const batch = nextToDispatch(views, taxonomy === 'fresh', in_flight - sCounts.running);
  const complete = counts.pending + counts.running + counts.failed === 0;
  const extraction = complete ? 'complete' : taxonomy === 'fresh' ? 'incomplete' : 'blocked';
  const extractions = extractionsSha(root, views);
  const merge = mergeFreshness(root, extractions);
  const rollup = rollupFreshness(root, extractions);
  const synthReady = extraction === 'complete' && merge === 'fresh' && rollup === 'current';
  const synth = nextToDispatch(groups ?? [], synthReady, in_flight - counts.running);
  const synthesis: SynthesisStatus = {
    counts: sCounts,
    next: halt_reason === null ? synth.next : [],
    running: idsWith(groups ?? [], 'running'),
    retryable: synth.retryable,
    exhausted: synth.exhausted,
    complete: rollup === 'current' && groups !== null && sCounts.pending + sCounts.running + sCounts.failed === 0,
  };
  const score = scoreFreshness(root, synthesisSha(root, groups));
  const stage: Stage =
    taxonomy !== 'fresh'
      ? 'taxonomy'
      : extraction !== 'complete'
        ? 'extraction'
        : merge !== 'fresh'
          ? 'merge'
          : rollup !== 'current'
            ? 'rollup'
            : !synthesis.complete
              ? 'synthesis'
              : score !== 'current'
                ? 'score'
                : 'done';
  return {
    batches: views.length,
    counts,
    taxonomy,
    in_flight,
    next: halt_reason === null ? batch.next : [],
    running: idsWith(views, 'running'),
    retryable: batch.retryable,
    exhausted: batch.exhausted,
    extraction,
    merge,
    rollup,
    synthesis,
    score,
    stage,
    halt: halt_reason !== null,
    halt_reason,
    timing: timingFrom(views.map((v) => v.state), run),
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

function timingLine(t: Timing, label: string, one: string, many: string): string {
  const parts = [`${plural(t.done, one, many)} done in this run`];
  if (t.wall_s !== null) parts.push(`wall ${duration(t.wall_s)}`);
  if (t.batch_s_p50 !== null && t.batch_s_p90 !== null) parts.push(`per ${one} p50 ${t.batch_s_p50}s, p90 ${t.batch_s_p90}s`);
  parts.push(plural(t.fix_rounds, 'fix round'));
  if (t.slot_idle_s_mean !== null) parts.push(`slot idle ${t.slot_idle_s_mean}s mean`);
  return `  ${label}: ${parts.join('; ')}.`;
}

// The stage line of the human status.
function stageLine(r: StatusReport, groups: number | null): string {
  const s = r.synthesis.counts;
  const extra = [s.running > 0 ? `${s.running} running` : '', s.failed > 0 ? `${s.failed} failed` : '', s.exhausted > 0 ? `${s.exhausted} exhausted` : ''].filter((x) => x !== '');
  const synthesis = groups === null ? 'no groups yet' : `${s.done} of ${plural(groups, 'group')} done${extra.length > 0 ? ` (${extra.join(', ')})` : ''}`;
  return `  stage: ${r.stage} (merge ${r.merge}; rollup ${r.rollup}; synthesis ${synthesis}; score ${r.score}).`;
}

function failureLines(views: readonly BatchView[]): string[] {
  const lines: string[] = [];
  for (const v of views) {
    const s = v.state;
    const counted = countedDispatches(s);
    if (v.status === 'failed') {
      lines.push(`  ${v.entry.id} failed: ${plural(s.problems ?? 0, 'problem')}; ${counted} of ${MAX_DISPATCHES} dispatches used.`);
    } else if (v.status === 'exhausted') {
      lines.push(
        `  ${v.entry.id} exhausted: ${plural(s.problems ?? 0, 'problem')} after ${plural(counted, 'dispatch', 'dispatches')}; ` +
          `node obs.mjs dispatch ${v.entry.id} --force tries once more.`,
      );
    }
  }
  return lines;
}

export function statusCommand(root: string, args: readonly string[]): number {
  return guarded('status', () => {
    const json = args.includes('--json');
    const unknown = args.filter((a) => a !== '--json');
    if (unknown.length > 0) throw new LedgerError(`unexpected argument "${unknown[0]}". Usage: node obs.mjs status [--json]`);
    const views = batchViews(root);
    const groups = synthViews(root);
    const report = statusReport(root, views, groups);
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
    console.log(stageLine(report, groups === null ? null : groups.length));
    const all = [...views, ...(groups ?? [])];
    for (const status of ['running', 'pending', 'failed', 'exhausted', 'done'] as const) {
      const ids = idsWith(all, status);
      if (ids.length > 0) console.log(`  ${status}: ${compactIds(ids)}`);
    }
    if (report.halt_reason !== null) console.log(`  halt: ${report.halt_reason}`);
    const next = [...report.next, ...report.synthesis.next];
    if (next.length > 0) console.log(`  next: ${compactIds(next)}`);
    for (const line of failureLines(all)) console.log(line);
    if (report.timing !== null) console.log(timingLine(report.timing, 'timing', 'batch', 'batches'));
    const synthTiming = groups === null ? null : timingFrom(groups.map((v) => v.state), report.run);
    if (synthTiming !== null && synthTiming.done + synthTiming.fix_rounds > 0) console.log(timingLine(synthTiming, 'synthesis timing', 'group', 'groups'));
    return 0;
  });
}

// ---- dispatch, validate ----

// One job ID: "batch-074", just "74", or "synth-003".
function oneJobArg(command: string, args: readonly string[], options = ''): string {
  if (args.length !== 1 || (args[0] as string).startsWith('-')) {
    throw new LedgerError(`expected one job ID. Usage: node obs.mjs ${command} <job_id>${options} (batch-074, or just 74; or synth-003)`);
  }
  return normalizeJobId(args[0] as string);
}

const jobOf = (root: string, id: string): JobEntry => findJob(loadJobs(root, kindOf(id)), id);

export function dispatchCommand(root: string, args: readonly string[]): number {
  return guarded('dispatch', () => {
    const force = args.includes('--force');
    const id = oneJobArg('dispatch', args.filter((a) => a !== '--force'), ' [--force]');
    const job = jobOf(root, id);
    const { fix } = markDispatched(root, job, { force });
    // Only the prompt goes to stdout, so the orchestrator can pass it on unchanged.
    console.log(jobPrompt(root, job.id, fix));
    return 0;
  });
}

// validate prints the counts and only this many problems: its output reaches the orchestrator,
// and the problems carry (escaped, cut) model text. All of them are in the job's fix file.
export const MAX_PROBLEMS_SHOWN = 3;

// The outcome of validating one running job, as validate and refill report it.
type Validated =
  | { kind: 'recorded'; state: BatchState; problems: string[] }
  | { kind: 'already'; status: BatchStatus; when: string }
  | { kind: 'starting' }
  | { kind: 'setup'; setup: string };

// Check a running job's output and stamp it done or failed, as its agent's gate would have. A job
// with no output file dispatched under ORPHAN_GRACE_S ago is left running (its agent may still be
// reading) unless `gone`: the orchestrator saw its Agent call fail or be refused, so no agent will
// ever write it, and it is recorded at once.
function validateJob(root: string, job: JobEntry, opts: { gone?: boolean } = {}): Validated {
  const id = job.id;
  const before = readBatchState(root, id);
  if (before.status === 'done' || before.status === 'failed') return { kind: 'already', status: before.status, when: `recorded when its ${JOB_KINDS[kindOf(id)].worker} finished` };
  requireRunning(root, id);
  if (opts.gone !== true && stillStarting(root, before)) return { kind: 'starting' };
  const check = checkJob(root, id);
  if (check.setup !== null) return { kind: 'setup', setup: withoutRoot(check.setup, root) };
  try {
    return { kind: 'recorded', state: recordValidation(root, job, check), problems: check.problems };
  } catch (err) {
    const now = readBatchState(root, id);
    if (err instanceof LedgerError && (now.status === 'done' || now.status === 'failed')) return { kind: 'already', status: now.status, when: 'recorded while this check ran' };
    throw err;
  }
}

// Check a running job's output and stamp it done or failed, as its agent's gate would have. Exit 0
// whenever a result is recorded, or was already recorded (by the gate, while this ran or before): a
// failed job is a normal step of the loop, which re-dispatches it. Exit 0 too, with nothing
// recorded, for a job still starting (no output file yet, dispatched under ORPHAN_GRACE_S ago): its
// agent may still be reading. Exit 1 when nothing could be recorded: not dispatched, or a setup
// failure (the job then stays running).
export function validateCommand(root: string, args: readonly string[]): number {
  return guarded('validate', () => {
    const job = jobOf(root, oneJobArg('validate', args));
    const id = job.id;
    const result = validateJob(root, job);
    switch (result.kind) {
      case 'already':
        console.log(`validate: ${id} is already ${result.status} (${result.when}); nothing to do.`);
        return 0;
      case 'starting':
        console.log(`validate: ${id} is still starting (no output file yet, dispatched under ${ORPHAN_GRACE_S} seconds ago); it stays running.`);
        return 0;
      case 'setup':
        console.log(`validate: ${id} could not be checked, so it stays running: ${result.setup}`);
        return 1;
      case 'recorded': {
        const { state, problems } = result;
        const q = state.quote_stats;
        const quotes = kindOf(id) !== 'batch' ? '' : q === null ? ', no quotes checked' : `, quotes ${q.exact} exact, ${q.repaired} repaired, ${q.rejected} rejected`;
        console.log(`validate: ${id} ${state.status}: ${plural(problems.length, 'problem')}${quotes}.`);
        for (const p of problems.slice(0, MAX_PROBLEMS_SHOWN)) console.log(`  - ${problemLine(p, root)}`);
        if (problems.length > MAX_PROBLEMS_SHOWN) console.log(`  (${problems.length - MAX_PROBLEMS_SHOWN} more; all are in out/fix/${id}.txt)`);
        return 0;
      }
    }
  });
}

// ---- refill: the orchestrator's one call per completion wave (ARCHITECTURE.md 6.6, 14.2) ----

export type RefillReport = {
  halt: boolean;
  halt_reason: string | null;
  stage: Stage;
  extraction: StatusReport['extraction'];
  // The named jobs: recorded now, already recorded (by the gate), still starting, or not checkable.
  // A job named after --failed is never "still starting": its Agent call failed, so it is recorded.
  validated: Array<{ id: string; status: BatchStatus; note: 'recorded' | 'already recorded' | 'still starting' | 'could not be checked' }>;
  jobs: Array<{ id: string; description: string; prompt: string }>; // dispatched now: one Agent call each
  refused: Array<{ id: string; reason: string }>; // listed in next but refused by dispatch
  running: string[];
  exhausted: string[];
};

export const REFILL_MAX_BYTES = 64_000;

// `node obs.mjs refill [<id> ...] [--failed <id> ...] [--json]`: validate each named job still
// running exactly as `validate <id>` does (a job already stamped is reported, not re-checked), then
// dispatch every job `status --json` lists in `next` (both kinds) exactly as `dispatch <id>` does,
// and print one JSON object: the prompts to start, and what the loop needs to know. Nothing is
// dispatched while the breaker is on. The same ledger end state as the separate commands, in one
// call. The jobs after --failed are those whose Agent call failed or was refused: no agent will
// write their output, so they are recorded now rather than left "still starting" for
// ORPHAN_GRACE_S (when that was the last running job, nothing would wake the orchestrator again).
// Recorded exactly as `validate` records a job with no output: failed, the first such dispatch in
// a row not counted toward MAX_DISPATCHES, and the stamp counted toward this run's circuit breaker.
export const REFILL_USAGE = 'Usage: node obs.mjs refill [<job_id> ...] [--failed <job_id> ...] --json';

export function refillCommand(root: string, args: readonly string[]): number {
  return guarded('refill', () => {
    const rest = args.filter((a) => a !== '--json');
    const cut = rest.indexOf('--failed');
    const completed = (cut === -1 ? rest : rest.slice(0, cut)).map(normalizeJobId);
    const gone = cut === -1 ? [] : rest.slice(cut + 1).map(normalizeJobId);
    for (const a of [...completed, ...gone]) {
      if (a.startsWith('-')) throw new LedgerError(`unexpected option "${a}". ${REFILL_USAGE}`);
    }
    if (cut !== -1 && gone.length === 0) throw new LedgerError(`--failed needs the jobs whose Agent call failed. ${REFILL_USAGE}`);
    const validated: RefillReport['validated'] = [];
    for (const id of [...new Set([...completed, ...gone])]) {
      const job = jobOf(root, id);
      if (readBatchState(root, id).status === 'pending') {
        validated.push({ id, status: 'pending', note: 'already recorded' });
        continue;
      }
      const r = validateJob(root, job, { gone: gone.includes(id) });
      if (r.kind === 'recorded') validated.push({ id, status: r.state.status, note: 'recorded' });
      else if (r.kind === 'already') validated.push({ id, status: r.status, note: 'already recorded' });
      else validated.push({ id, status: 'running', note: r.kind === 'starting' ? 'still starting' : 'could not be checked' });
    }
    const report = statusReport(root);
    const jobs: RefillReport['jobs'] = [];
    const refused: RefillReport['refused'] = [];
    if (!report.halt) {
      for (const id of [...report.next, ...report.synthesis.next]) {
        try {
          const { fix } = markDispatched(root, jobOf(root, id));
          jobs.push({ id, description: descriptionFor(id), prompt: jobPrompt(root, id, fix) });
        } catch (err) {
          if (!(err instanceof LedgerError)) throw err;
          refused.push({ id, reason: err.message });
        }
      }
    }
    const out: RefillReport = {
      halt: report.halt,
      halt_reason: report.halt_reason,
      stage: report.stage,
      extraction: report.extraction,
      validated,
      jobs,
      refused,
      running: [...report.running, ...report.synthesis.running, ...jobs.map((j) => j.id)],
      exhausted: [...report.exhausted, ...report.synthesis.exhausted],
    };
    const text = JSON.stringify(out);
    if (Buffer.byteLength(text) > REFILL_MAX_BYTES) throw new LedgerError(`the refill report is ${Buffer.byteLength(text)} bytes, over ${REFILL_MAX_BYTES}: lower OBS_IN_FLIGHT.`);
    console.log(text);
    return 0;
  });
}

// ---- run start / end ----

// Run start: stamp every job whose state is running. A run has just begun, so no agent should be
// alive: whatever file each left is checked as validate would check it, a missing or bad one is
// failed (with attempts left), a good one done. Left running, with the reason: a job still starting
// (no output file yet, dispatched under ORPHAN_GRACE_S ago, as validate leaves it), and one that
// can't be checked yet (no index before prepare or rollup, or a setup failure).
export type Orphan = { batch_id: string; status: BatchStatus; reason?: 'starting' | 'unchecked' };

export function stampOrphans(root: string): Orphan[] {
  const ids = recordedRunning(root);
  if (ids.length === 0) return [];
  const indexes = new Map<JobKind, JobEntry[]>();
  const jobsOf = (kind: JobKind): JobEntry[] => {
    let jobs = indexes.get(kind);
    if (jobs === undefined) {
      try {
        jobs = loadJobs(root, kind);
      } catch (err) {
        if (!(err instanceof LedgerError)) throw err;
        jobs = [];
      }
      indexes.set(kind, jobs);
    }
    return jobs;
  };
  return ids.map((batch_id): Orphan => {
    if (stillStarting(root, readBatchState(root, batch_id))) return { batch_id, status: 'running', reason: 'starting' };
    const entry = jobsOf(kindOf(batch_id)).find((j) => j.id === batch_id);
    if (entry === undefined) return { batch_id, status: 'running', reason: 'unchecked' };
    const check = checkJob(root, batch_id);
    if (check.setup !== null) return { batch_id, status: 'running', reason: 'unchecked' };
    // Stamped under no run: what a dead session left never counts toward a run's circuit breaker.
    return { batch_id, status: recordValidation(root, entry, check, { runId: null }).status };
  });
}

// "batch"/"batches" when every ID is a batch, the same for groups, else "job"/"jobs".
function nounFor(ids: readonly string[]): [string, string] {
  const kinds = new Set(ids.map(kindOf));
  if (kinds.size !== 1) return ['job', 'jobs'];
  const k = JOB_KINDS[[...kinds][0] as JobKind];
  return [k.noun, k.nouns];
}

export function runCommand(root: string, args: readonly string[]): number {
  return guarded('run', () => {
    const [sub, ...rest] = args;
    const force = rest.length === 1 && rest[0] === '--force';
    if (!((sub === 'start' && (rest.length === 0 || force)) || (sub === 'end' && rest.length === 0))) {
      throw new LedgerError('Usage: node obs.mjs run start [--force] | run end');
    }
    if (sub === 'start') {
      // First, before anything else can steer: the session whose Bash call started this command
      // (the corpus guard wrote its claim just before) becomes the run's orchestrator, the one
      // session the Stop hook steers. No fresh claim (hooks off, a run started by hand): the Stop
      // hook's repeat guard is cleared and the guard records the session that starts the first
      // pipeline subagent instead. Either way the repeat guard starts afresh with the run.
      const orchestrator = consumeClaim(root);
      const started_utc = nowUtc();
      const run: RunState = { active: true, run_id: newRunId(started_utc), started_utc };
      if (orchestrator !== null) writeJsonAtomic(stopGateFile(root), { run_id: run.run_id, session_id: orchestrator, last_block: null });
      else removeFile(stopGateFile(root));
      let previous: RunState | null = null;
      try {
        previous = readRun(root);
      } catch {
        // an unreadable run file is replaced
      }
      if (force) clearModelOutputs(root);
      const stamped = stampOrphans(root);
      writeRun(root, run);
      appendRunLog(root, { event: 'run_start', orchestrator: orchestrator === null ? 'unclaimed' : 'claimed', force, stamped: stamped.length });
      const replaced = previous?.active ? ` (replaces run ${previous.run_id}, which never ended)` : '';
      console.log(`run: started ${run.run_id}${replaced}. The corpus guard now applies to every tool call.`);
      if (orchestrator !== null) console.log("run: the session that started it is the run's orchestrator.");
      if (force) {
        console.log(
          'run: --force cleared the model outputs: job states, agent bindings, the taxonomy, the merge, the validated extractions, ' +
            'the rollup and the synthesis inputs, the validated syntheses, the opportunities and the fix files.',
        );
      }
      const recorded = stamped.filter((s) => s.status !== 'running');
      if (recorded.length > 0) {
        const [one, many] = nounFor(recorded.map((s) => s.batch_id));
        console.log(
          `run: ${plural(recorded.length, `${one} was`, `${many} were`)} left running by an earlier session: ` +
            `${recorded.map((s) => `${s.batch_id} ${s.status}`).join(', ')}.`,
        );
      }
      for (const s of stamped.filter((x) => x.status === 'running')) {
        console.log(
          s.reason === 'starting'
            ? `run: ${s.batch_id} was dispatched under ${ORPHAN_GRACE_S} seconds ago and has no output yet; it stays running.`
            : `run: ${s.batch_id} was left running and can't be checked yet; after node obs.mjs ${JOB_KINDS[kindOf(s.batch_id)].rebuild}, run node obs.mjs validate ${s.batch_id}.`,
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

// Every done job of a kind re-checked from its committed output: it must still pass and validate to
// exactly its committed validated file. Returns the failures and how many were checked.
function verifyKind(root: string, views: readonly BatchView[]): { done: number; notDone: number; failures: string[] } {
  const done = views.filter((v) => v.status === 'done');
  const failures: string[] = [];
  for (const v of done) {
    const id = v.entry.id;
    const paths = JOB_KINDS[kindOf(id)];
    const output = `out/${paths.dirs.output}/${id}.json`;
    const validated = `out/${paths.dirs.validated}/${id}.json`;
    const check = checkJob(root, id);
    if (check.setup !== null) {
      failures.push(`${id}: could not be checked: ${check.setup}`);
    } else if (!check.ok || check.validated === null) {
      failures.push(`${id}: ${output} no longer passes validation (${plural(check.problems.length, 'problem')}; first: ${check.problems[0] ?? 'none'})`);
    } else {
      const committed = readText(validatedFile(root, id));
      if (committed === null || normalizeNewlines(committed) !== `${JSON.stringify(check.validated, null, 2)}\n`) {
        failures.push(`${id}: ${validated} differs from what ${output} validates to now`);
      }
    }
  }
  return { done: done.length, notDone: views.length - done.length, failures };
}

// Every done batch re-checked from its committed extraction against the corpus bytes, and every
// done synthesis group from its committed output against its input's sidecar: each must still pass
// and validate to exactly its committed validated file. Read-only. Exit 1 on any difference, so CI
// catches a stale or hand-edited output.
export function verifyCommand(root: string, args: string[]): number {
  return guarded('verify', () => {
    if (args.length > 0) throw new LedgerError(`unexpected argument "${args[0]}". Usage: node obs.mjs verify`);
    const batches = verifyKind(root, batchViews(root));
    const groupViews = synthViews(root);
    const groups = groupViews === null ? null : verifyKind(root, groupViews);
    if (batches.done === 0 && (groups === null || groups.done === 0)) {
      console.log('verify: nothing to verify: no batch is done.');
      return 0;
    }
    const failures = [...batches.failures, ...(groups?.failures ?? [])];
    const notDone = [
      ...(batches.notDone > 0 ? [plural(batches.notDone, 'batch', 'batches')] : []),
      ...(groups !== null && groups.notDone > 0 ? [plural(groups.notDone, 'synthesis group')] : []),
    ];
    const rest = notDone.length > 0 ? ` (${notDone.join(' and ')} not done, not verified)` : '';
    const what =
      groups === null || groups.done === 0
        ? `${plural(batches.done, 'done batch', 'done batches')}`
        : `${plural(batches.done, 'done batch', 'done batches')} and ${plural(groups.done, 'done synthesis group')}`;
    if (failures.length === 0) {
      const how = groups === null || groups.done === 0 ? 're-checked against the corpus' : 're-checked against the corpus and their inputs';
      console.log(`verify: ${what} ${how}; every validated file matches${rest}.`);
      return 0;
    }
    console.log(`verify: ${failures.length} of ${what} fail${rest}:`);
    for (const f of failures) console.log(`  - ${withoutRoot(f, root)}`);
    return 1;
  });
}
