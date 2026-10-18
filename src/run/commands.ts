// The ledger commands the orchestrator (and a person) runs: status, dispatch, validate, refill,
// advance, verify, run. Each takes a job of any kind: an extraction batch ("batch-NNN", or just the
// number), a synthesis group ("synth-NNN") or an artifact draft ("draft-NNN"). Output is short on purpose: during a run the
// orchestrator calls one `advance` per turn, which records the completions, runs every
// deterministic stage step that is ready and hands out the next subagents, whose Agent calls it
// makes unchanged. No command reads what a subagent replied; the ledger and the files on disk are
// the only state.
import { existsSync } from 'node:fs';
import { ConfigError } from '../config.ts';
import { normalizeNewlines } from '../util/text.ts';
import { ArtifactError, artifactsCollectStep, artifactsCollected, artifactsFreshness, artifactsPrepareStep, verifyArtifacts, type ArtifactsFreshness } from './artifacts.ts';
import { checkJob, descriptionFor, jobPrompt } from './jobs.ts';
import {
  LedgerError,
  HALT_NO_OUTPUT,
  HALT_WINDOW_S,
  JOB_KINDS,
  ORPHAN_GRACE_S,
  activeRunId,
  artifactIndexFile,
  appendRunLog,
  batchViews,
  clearModelOutputs,
  consumeClaim,
  countedDispatches,
  findJob,
  inFlight,
  kindOf,
  loadJobs,
  logRunEvent,
  logStage,
  markDispatched,
  maxDispatches,
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
  type StageStep,
  type TaxonomyFreshness,
} from './ledger.ts';
import { MergeError, extractionsSha, mergeFreshness, mergeStep, type MergeFreshness } from './merge.ts';
import { RollupError, rollupFreshness, rollupStep, type RollupFreshness } from './rollup.ts';
import { ScoreError, scoreFreshness, scoreStep, synthesisSha, type ScoreFreshness } from './score.ts';
import { TaxonomyError, taxonomyStep } from './taxonomy.ts';
import type { JobEntry, JobKind } from '../types.ts';

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

// Where the run is: the first stage whose output is not yet current (ARCHITECTURE.md 7.2, 15.2).
// artifacts: the briefs are missing or stale; drafting: drafts to finish, or done drafts not yet
// collected into their artifacts.
export type Stage = 'taxonomy' | 'extraction' | 'merge' | 'rollup' | 'synthesis' | 'score' | 'artifacts' | 'drafting' | 'done';

// The jobs of the synthesis groups or of the drafts.
export type SynthesisStatus = {
  counts: Record<EffectiveStatus, number>;
  next: string[];
  running: string[];
  retryable: string[];
  exhausted: string[];
  // Groups: the rollup is current, its groups are indexed, and none is pending, running or
  // retryable. Drafts: the same with the briefs for the rollup.
  complete: boolean;
};
export type DraftingStatus = SynthesisStatus;

// What `status --json` prints: counts and the short lists the loop acts on, never the done list.
// The top-level lists are the extraction batches'; `synthesis` has the groups'. extraction:
// complete = nothing pending, running or retryable (exhausted batches are reported, not waited
// for); blocked = not complete and the taxonomy is not fresh, so nothing can be dispatched until
// the taxonomy stage runs; incomplete otherwise. Synthesis groups are dispatched only once
// extraction is complete, the merge fresh and the rollup current; drafts only once synthesis is
// complete, the score current and the briefs current (`artifacts`). halt: the circuit breaker
// (haltFrom, over every kind); while it is on, every `next` list is empty and the loop stops with
// halt_reason. All kinds share the in-flight cap.
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
  artifacts: ArtifactsFreshness;
  drafting: DraftingStatus;
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
  const only = kinds.size === 1 ? JOB_KINDS[[...kinds][0] as JobKind] : null;
  const what = only === null ? 'jobs' : only.nouns;
  const who = only === null ? 'subagents' : `${only.worker}s`;
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

// The drafts' views, or null when there is no artifact index yet.
export function draftViews(root: string): BatchView[] | null {
  if (!existsSync(artifactIndexFile(root))) return null;
  return batchViews(root, 'draft');
}

export function statusReport(
  root: string,
  views: readonly BatchView[] = batchViews(root),
  groups: readonly BatchView[] | null = synthViews(root),
  drafts: readonly BatchView[] | null = draftViews(root),
): StatusReport {
  const counts = countsOf(views);
  const sCounts = countsOf(groups ?? []);
  const dCounts = countsOf(drafts ?? []);
  const taxonomy = taxonomyFreshness(root);
  const in_flight = inFlight();
  const run = readRun(root);
  const halt_reason = haltFrom([...views, ...(groups ?? []), ...(drafts ?? [])].map((v) => v.state), run);
  const batch = nextToDispatch(views, taxonomy === 'fresh', in_flight - sCounts.running - dCounts.running);
  const complete = counts.pending + counts.running + counts.failed === 0;
  const extraction = complete ? 'complete' : taxonomy === 'fresh' ? 'incomplete' : 'blocked';
  const extractions = extractionsSha(root, views);
  const merge = mergeFreshness(root, extractions);
  const rollup = rollupFreshness(root, extractions);
  const synthReady = extraction === 'complete' && merge === 'fresh' && rollup === 'current';
  const synth = nextToDispatch(groups ?? [], synthReady, in_flight - counts.running - dCounts.running);
  const synthesis: SynthesisStatus = {
    counts: sCounts,
    next: halt_reason === null ? synth.next : [],
    running: idsWith(groups ?? [], 'running'),
    retryable: synth.retryable,
    exhausted: synth.exhausted,
    complete: rollup === 'current' && groups !== null && sCounts.pending + sCounts.running + sCounts.failed === 0,
  };
  const score = scoreFreshness(root, synthesisSha(root, groups));
  const artifacts = synthReady && synthesis.complete && score === 'current' ? artifactsFreshness(root) : existsSync(artifactIndexFile(root)) ? 'stale' : 'missing';
  const draft = nextToDispatch(drafts ?? [], synthReady && synthesis.complete && score === 'current' && artifacts === 'current', in_flight - counts.running - sCounts.running);
  const drafting: DraftingStatus = {
    counts: dCounts,
    next: halt_reason === null ? draft.next : [],
    running: idsWith(drafts ?? [], 'running'),
    retryable: draft.retryable,
    exhausted: draft.exhausted,
    complete: artifacts === 'current' && drafts !== null && dCounts.pending + dCounts.running + dCounts.failed === 0,
  };
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
                : artifacts !== 'current'
                  ? 'artifacts'
                  : !drafting.complete || !artifactsCollected(root, drafts ?? [])
                    ? 'drafting'
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
    artifacts,
    drafting,
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

// "2 of 3 groups done (1 exhausted)": a job kind's progress for the stage line.
function progress(c: Record<EffectiveStatus, number>, total: number | null, one: string, none: string): string {
  const extra = [c.running > 0 ? `${c.running} running` : '', c.failed > 0 ? `${c.failed} failed` : '', c.exhausted > 0 ? `${c.exhausted} exhausted` : ''].filter((x) => x !== '');
  return total === null ? none : `${c.done} of ${plural(total, one)} done${extra.length > 0 ? ` (${extra.join(', ')})` : ''}`;
}

// The stage line of the human status.
function stageLine(r: StatusReport, groups: number | null, drafts: number | null): string {
  const synthesis = progress(r.synthesis.counts, groups, 'group', 'no groups yet');
  const drafting = progress(r.drafting.counts, drafts, 'draft', 'no drafts yet');
  return `  stage: ${r.stage} (merge ${r.merge}; rollup ${r.rollup}; synthesis ${synthesis}; score ${r.score}; artifacts ${r.artifacts}; drafting ${drafting}).`;
}

function failureLines(views: readonly BatchView[]): string[] {
  const lines: string[] = [];
  for (const v of views) {
    const s = v.state;
    const counted = countedDispatches(s);
    if (v.status === 'failed') {
      lines.push(`  ${v.entry.id} failed: ${plural(s.problems ?? 0, 'problem')}; ${counted} of ${maxDispatches(kindOf(v.entry.id))} dispatches used.`);
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
    const drafts = draftViews(root);
    const report = statusReport(root, views, groups, drafts);
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
    console.log(stageLine(report, groups === null ? null : groups.length, drafts === null ? null : drafts.length));
    const all = [...views, ...(groups ?? []), ...(drafts ?? [])];
    for (const status of ['running', 'pending', 'failed', 'exhausted', 'done'] as const) {
      const ids = idsWith(all, status);
      if (ids.length > 0) console.log(`  ${status}: ${compactIds(ids)}`);
    }
    if (report.halt_reason !== null) console.log(`  halt: ${report.halt_reason}`);
    const next = [...report.next, ...report.synthesis.next, ...report.drafting.next];
    if (next.length > 0) console.log(`  next: ${compactIds(next)}`);
    for (const line of failureLines(all)) console.log(line);
    if (report.timing !== null) console.log(timingLine(report.timing, 'timing', 'batch', 'batches'));
    const synthTiming = groups === null ? null : timingFrom(groups.map((v) => v.state), report.run);
    if (synthTiming !== null && synthTiming.done + synthTiming.fix_rounds > 0) console.log(timingLine(synthTiming, 'synthesis timing', 'group', 'groups'));
    return 0;
  });
}

// ---- dispatch, validate ----

// One job ID: "batch-074", just "74", "synth-003" or "draft-002".
function oneJobArg(command: string, args: readonly string[], options = ''): string {
  if (args.length !== 1 || (args[0] as string).startsWith('-')) {
    throw new LedgerError(`expected one job ID. Usage: node obs.mjs ${command} <job_id>${options} (batch-074, or just 74; synth-003; draft-002)`);
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

// The jobs a refill or an advance names: completions, then after --failed the jobs whose Agent call
// failed or was refused. `--json` is accepted anywhere (the output is JSON either way).
function namedJobs(args: readonly string[], usage: string): { completed: string[]; gone: string[] } {
  const rest = args.filter((a) => a !== '--json');
  const cut = rest.indexOf('--failed');
  const completed = (cut === -1 ? rest : rest.slice(0, cut)).map(normalizeJobId);
  const gone = cut === -1 ? [] : rest.slice(cut + 1).map(normalizeJobId);
  for (const a of [...completed, ...gone]) {
    if (a.startsWith('-')) throw new LedgerError(`unexpected option "${a}". ${usage}`);
  }
  if (cut !== -1 && gone.length === 0) throw new LedgerError(`--failed needs the jobs whose Agent call failed. ${usage}`);
  return { completed, gone };
}

// Record each named job exactly as `validate <id>` does (a job already stamped is reported, not
// re-checked); a job named after --failed is recorded at once, never left "still starting". An ID
// named twice is recorded once.
function recordNamed(root: string, completed: readonly string[], gone: readonly string[]): RefillReport['validated'] {
  const recorded: RefillReport['validated'] = [];
  for (const id of [...new Set([...completed, ...gone])]) {
    const job = jobOf(root, id);
    if (readBatchState(root, id).status === 'pending') {
      recorded.push({ id, status: 'pending', note: 'already recorded' });
      continue;
    }
    const r = validateJob(root, job, { gone: gone.includes(id) });
    if (r.kind === 'recorded') recorded.push({ id, status: r.state.status, note: 'recorded' });
    else if (r.kind === 'already') recorded.push({ id, status: r.status, note: 'already recorded' });
    else recorded.push({ id, status: 'running', note: r.kind === 'starting' ? 'still starting' : 'could not be checked' });
  }
  return recorded;
}

// Hand out each job exactly as `dispatch <id>` does; a refusal (an input changed since its stage
// ran, say) is reported with its reason, not thrown.
function dispatchAll(root: string, ids: readonly string[]): { jobs: RefillReport['jobs']; refused: RefillReport['refused'] } {
  const jobs: RefillReport['jobs'] = [];
  const refused: RefillReport['refused'] = [];
  for (const id of ids) {
    try {
      const { fix } = markDispatched(root, jobOf(root, id));
      jobs.push({ id, description: descriptionFor(id), prompt: jobPrompt(root, id, fix) });
    } catch (err) {
      if (!(err instanceof LedgerError)) throw err;
      refused.push({ id, reason: err.message });
    }
  }
  return { jobs, refused };
}

export function refillCommand(root: string, args: readonly string[]): number {
  return guarded('refill', () => {
    const { completed, gone } = namedJobs(args, REFILL_USAGE);
    const validated = recordNamed(root, completed, gone);
    const report = statusReport(root);
    const { jobs, refused } = report.halt ? { jobs: [], refused: [] } : dispatchAll(root, [...report.next, ...report.synthesis.next, ...report.drafting.next]);
    const out: RefillReport = {
      halt: report.halt,
      halt_reason: report.halt_reason,
      stage: report.stage,
      extraction: report.extraction,
      validated,
      jobs,
      refused,
      running: [...report.running, ...report.synthesis.running, ...report.drafting.running, ...jobs.map((j) => j.id)],
      exhausted: [...report.exhausted, ...report.synthesis.exhausted, ...report.drafting.exhausted],
    };
    const text = JSON.stringify(out);
    if (Buffer.byteLength(text) > REFILL_MAX_BYTES) throw new LedgerError(`the refill report is ${Buffer.byteLength(text)} bytes, over ${REFILL_MAX_BYTES}: lower OBS_IN_FLIGHT.`);
    console.log(text);
    return 0;
  });
}

// ---- advance: the orchestrator's one command per turn (ARCHITECTURE.md 6.7, 15.3) ----

// One Agent call, its fields named as the Agent tool names them, so the orchestrator copies them
// over as they are.
export type AgentCall = { subagent_type: 'taxonomist' | 'extractor' | 'merger' | 'synthesizer' | 'drafter'; description: string; prompt: string; run_in_background: boolean };

// What `advance --json` prints. halt: the circuit breaker, or a stage that cannot go on without a
// person (its attempts used up), with the reason; done: every stage is done (and the run ended);
// wait: nothing to start and subagents still running, so the turn ends; steps: the summary line of
// every deterministic step this call ran, in order; recorded: the named jobs, as refill reports
// them; agents: the subagents to start now, in one message; refused: jobs listed as next but
// refused by dispatch.
export type AdvanceReport = {
  stage: Stage;
  halt: boolean;
  halt_reason: string | null;
  done: boolean;
  wait: boolean;
  steps: string[];
  recorded: Array<{ id: string; status: BatchStatus; note: 'recorded' | 'already recorded' | 'still starting' | 'could not be checked' }>;
  agents: AgentCall[];
  refused: Array<{ id: string; reason: string }>;
  running: string[];
  exhausted: string[];
};

export const ADVANCE_USAGE = 'Usage: node obs.mjs advance [<job_id> ...] [--failed <job_id> ...] --json';

// One pass per stage at most: a step that does not move its stage on is a bug, not a reason to spin.
const ADVANCE_MAX_PASSES = 12;

// The errors a stage reports as one line: advance prints `advance: <line>` and exits 1, and the
// skill stops there.
const isStageError = (err: unknown): err is Error =>
  err instanceof LedgerError ||
  err instanceof TaxonomyError ||
  err instanceof MergeError ||
  err instanceof RollupError ||
  err instanceof ScoreError ||
  err instanceof ArtifactError ||
  err instanceof ConfigError;

// `node obs.mjs advance [<id> ...] [--failed <id> ...] --json`: record the named jobs exactly as
// `refill` does, then run every deterministic step that is ready, in stage order, until a model is
// needed or the run is done:
//   taxonomy   accept a waiting proposal and go on, or hand out the taxonomist (in the foreground),
//              or halt when its attempts are used up;
//   extraction hand out `next` as refill does;
//   merge      as the taxonomy, with the merger;
//   rollup     run it and go on;
//   synthesis  hand out the groups' `next`;
//   score      run it and go on;
//   artifacts  write the briefs (artifacts prepare) and go on;
//   drafting   hand out the drafts' `next`; once every draft is done or exhausted, render the
//              artifacts and record them (artifacts collect) and go on;
//   done       end the run if it is active.
// It prints one JSON object (AdvanceReport): every Agent call to make now, with its parameters as
// the Agent tool names them. A cycle is one Bash call and one message of Agent calls, and no stage
// hand-off costs a turn of its own. Each call logs an `advance` event (and each step its `stage`
// event) with its duration in the run's log.
export function advanceCommand(root: string, args: readonly string[]): number {
  const started = performance.now();
  // The run this call belongs to, fixed now: the call that ends the run still logs to it.
  const runId = activeRunId(root);
  const event: Record<string, unknown> = { event: 'advance', named: [], recorded: [], stage_before: null, stage_after: null, dispatched: [], agents: 0 };
  try {
    const { completed, gone } = namedJobs(args, ADVANCE_USAGE);
    event.named = [...new Set([...completed, ...gone])];
    const recorded = recordNamed(root, completed, gone);
    event.recorded = recorded.map(({ id, status }) => ({ id, status }));
    const steps: string[] = [];
    const agents: AgentCall[] = [];
    const refused: AdvanceReport['refused'] = [];
    const dispatched: string[] = [];
    let halt_reason: string | null = null;
    let done = false;
    const passed = new Set<Stage>();
    let report = statusReport(root);
    event.stage_before = report.stage;
    // A single-call stage's step: on to the next stage, or its agent in the foreground, or a halt.
    const single = (step: StageStep, agent: AgentCall['subagent_type'], description: string): boolean => {
      steps.push(...step.notes);
      if (step.kind === 'prompt') agents.push({ subagent_type: agent, description, prompt: step.prompt, run_in_background: false });
      if (step.kind === 'stopped') halt_reason = step.reason;
      return step.kind === 'fresh';
    };
    const handOut = (ids: readonly string[]): void => {
      const r = dispatchAll(root, ids);
      for (const j of r.jobs) agents.push({ subagent_type: JOB_KINDS[kindOf(j.id)].worker as AgentCall['subagent_type'], description: j.description, prompt: j.prompt, run_in_background: true });
      dispatched.push(...r.jobs.map((j) => j.id));
      refused.push(...r.refused);
    };
    for (let pass = 0; ; pass++) {
      if (report.halt) {
        halt_reason = report.halt_reason;
        break;
      }
      if (pass >= ADVANCE_MAX_PASSES || passed.has(report.stage)) {
        throw new LedgerError(`the ${report.stage} stage did not move on after its step; this is a bug in the pipeline, not a problem with the run. Stop and report it.`);
      }
      passed.add(report.stage);
      // true: the step is done and the next stage may have one too; false: this call's answer is ready.
      const goOn = ((stage: Stage): boolean => {
        switch (stage) {
          case 'taxonomy':
            return single(taxonomyStep(root), 'taxonomist', 'Build taxonomy');
          case 'extraction':
            handOut(report.next);
            return false;
          case 'merge':
            return single(mergeStep(root), 'merger', 'Merge process keys');
          case 'rollup':
            steps.push(rollupStep(root));
            return true;
          case 'synthesis':
            handOut(report.synthesis.next);
            return false;
          case 'score': {
            const { summary, notes } = scoreStep(root);
            steps.push(...notes, summary);
            return true;
          }
          case 'artifacts':
            steps.push(artifactsPrepareStep(root));
            return true;
          case 'drafting':
            if (report.drafting.complete) {
              steps.push(artifactsCollectStep(root));
              return true;
            }
            handOut(report.drafting.next);
            return false;
          case 'done':
            if (readRun(root).active) steps.push(endRun(root));
            done = true;
            return false;
          default: {
            // Every stage has its case: a new stage fails to compile here.
            const unhandled: never = stage;
            throw new LedgerError(`advance has no step for the stage ${String(unhandled)}`);
          }
        }
      })(report.stage);
      if (!goOn) break;
      report = statusReport(root);
    }
    const running = [...report.running, ...report.synthesis.running, ...report.drafting.running, ...dispatched];
    const out: AdvanceReport = {
      stage: report.stage,
      halt: halt_reason !== null,
      halt_reason,
      done,
      wait: agents.length === 0 && running.length > 0,
      steps,
      recorded,
      agents,
      refused,
      running,
      exhausted: [...report.exhausted, ...report.synthesis.exhausted, ...report.drafting.exhausted],
    };
    Object.assign(event, { stage_after: report.stage, dispatched, agents: agents.length });
    const text = JSON.stringify(out);
    if (Buffer.byteLength(text) > REFILL_MAX_BYTES) throw new LedgerError(`the advance report is ${Buffer.byteLength(text)} bytes, over ${REFILL_MAX_BYTES}: lower OBS_IN_FLIGHT.`);
    logRunEvent(root, { ...event, ms: Math.round(performance.now() - started) }, runId);
    console.log(text);
    return 0;
  } catch (err) {
    if (!isStageError(err)) throw err;
    const line = withoutRoot(err.message, root).replace(/\s*\n\s*/g, ' ');
    logRunEvent(root, { ...event, ms: Math.round(performance.now() - started), error: line }, runId);
    console.error(`advance: ${line}`);
    return 1;
  }
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
            'the rollup and the synthesis inputs, the validated syntheses, the opportunities, the artifact briefs, drafts and artifacts (not the raw drafts) and the fix files.',
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
    console.log(endRun(root));
    return 0;
  });
}

// What `run end` does, as `run end` and `advance` take it: mark the run inactive (an unreadable run
// state is reset) and return the line that says so. The `run end` stage event goes into the run's
// log first, while the run is still active: the run's total is from its run_start to this event.
export function endRun(root: string): string {
  const started = performance.now();
  let current: RunState = { active: false, run_id: null, started_utc: null };
  try {
    current = readRun(root);
  } catch {
    // reset below
  }
  const line = current.active ? `run: ended ${current.run_id}.` : 'run: no run was active; marked inactive.';
  if (current.active) logStage(root, 'run end', started, line);
  writeRun(root, { ...current, active: false });
  return line;
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
    const output = `out/${paths.dirs.output}/${id}${paths.outputExt}`;
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

// Every done batch re-checked from its committed extraction against the corpus bytes, every done
// synthesis group from its committed output against its input's sidecar, and every done draft from
// its committed body against its brief: each must still pass and validate to exactly its committed
// validated file. Read-only. Exit 1 on any difference, so CI catches a stale or hand-edited output.
// Jobs whose state says done under a cache key that is no longer the current one: an agent
// definition, the taxonomy or an input changed since. They count as pending, so verify does not
// check them; it says how many there are, so a verify with little or nothing to check is visible.
const staleDone = (views: readonly BatchView[]): number => views.filter((v) => v.state.status === 'done' && v.state.cache_key !== v.cache_key).length;

export function verifyCommand(root: string, args: string[]): number {
  return guarded('verify', () => {
    if (args.length > 0) throw new LedgerError(`unexpected argument "${args[0]}". Usage: node obs.mjs verify`);
    const views = batchViews(root);
    const batches = verifyKind(root, views);
    const groupViews = synthViews(root);
    const groups = groupViews === null ? null : verifyKind(root, groupViews);
    const draftViewList = draftViews(root);
    const drafts = draftViewList === null ? null : verifyKind(root, draftViewList);
    const stale = staleDone(views) + staleDone(groupViews ?? []) + staleDone(draftViewList ?? []);
    // The collected artifacts and the briefs, checked apart from the jobs (N1).
    const artifacts = verifyArtifacts(root);
    const artifactLines = (): void => {
      if (artifacts.failures.length === 0) return;
      console.log(`verify: the artifacts do not match (${plural(artifacts.failures.length, 'problem')}):`);
      for (const f of artifacts.failures) console.log(`  - ${withoutRoot(f, root)}`);
    };
    const staleLine = (): void => {
      if (stale === 0) return;
      console.log(
        `verify: ${plural(stale, 'job is', 'jobs are')} recorded done under an older agent definition or older inputs ` +
          `(stale, not verified): the next run redoes ${stale === 1 ? 'it' : 'them'}.`,
      );
    };
    if (batches.done === 0 && (groups === null || groups.done === 0) && (drafts === null || drafts.done === 0)) {
      console.log('verify: nothing to verify: no batch is done.');
      staleLine();
      artifactLines();
      return artifacts.failures.length === 0 ? 0 : 1;
    }
    const failures = [...batches.failures, ...(groups?.failures ?? []), ...(drafts?.failures ?? [])];
    const notDone = [
      ...(batches.notDone > 0 ? [plural(batches.notDone, 'batch', 'batches')] : []),
      ...(groups !== null && groups.notDone > 0 ? [plural(groups.notDone, 'synthesis group')] : []),
      ...(drafts !== null && drafts.notDone > 0 ? [plural(drafts.notDone, 'draft')] : []),
    ];
    const rest = notDone.length > 0 ? ` (${notDone.join(' and ')} not done, not verified)` : '';
    const doneParts = [
      plural(batches.done, 'done batch', 'done batches'),
      ...(groups !== null && groups.done > 0 ? [plural(groups.done, 'done synthesis group')] : []),
      ...(drafts !== null && drafts.done > 0 ? [plural(drafts.done, 'done draft')] : []),
    ];
    const what = doneParts.length <= 2 ? doneParts.join(' and ') : `${doneParts.slice(0, -1).join(', ')} and ${doneParts.at(-1)}`;
    const collected = artifacts.collected && artifacts.failures.length === 0 ? '; the collected artifacts match what collect writes' : '';
    if (failures.length === 0 && artifacts.failures.length === 0) {
      const how = doneParts.length === 1 ? 're-checked against the corpus' : 're-checked against the corpus and their inputs';
      console.log(`verify: ${what} ${how}; every validated file matches${collected}${rest}.`);
      staleLine();
      return 0;
    }
    if (failures.length > 0) {
      console.log(`verify: ${failures.length} of ${what} fail${rest}:`);
      for (const f of failures) console.log(`  - ${withoutRoot(f, root)}`);
    }
    artifactLines();
    staleLine();
    return 1;
  });
}
