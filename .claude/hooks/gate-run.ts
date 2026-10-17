// Stop: keep the orchestrator in the loop while a pipeline run is active (ARCHITECTURE.md 6.7, 7.4).
//
// Silent unless out/ledger/run.json says a run is active, and silent for any session other than
// the run's orchestrator (the session the corpus guard saw start a pipeline subagent in this run,
// recorded in out/ledger/stop-gate.json), so other Claude Code sessions in this folder are not
// steered. Before the first subagent starts, whichever session stops is steered.
//
// When status reports a halt, the turn may end: the orchestrator prints why and stops. Otherwise
// live work comes from the Stop input's `background_tasks`: an extractor is a subagent task with
// agent_type extractor (or, untyped, a description starting "Extract") whose status is not a
// finished one; its batch is the number in its description ("Extract batch-017"). Then, in order:
//   1. orphans (below): block, naming `node obs.mjs validate <id>` for each;
//   2. the taxonomy is not fresh and no taxonomist is live: block, naming `node obs.mjs taxonomy`;
//   3. `next` is not empty: block, naming `node obs.mjs dispatch <id>` for each;
//   4. anything live: let the turn end (each completion wakes the orchestrator again);
//   5. extraction complete (exhausted batches are reported, not waited for): block, naming
//      `node obs.mjs run end`. Anything else lets the turn end.
// The registry is not trusted blindly. A running batch is an orphan when no live extractor names it
// and it was dispatched at least ORPHAN_GRACE_S ago (so a batch is never validated just after its
// dispatch, before its extractor shows up), or when it was dispatched at least ORPHAN_MAX_S ago,
// whatever the registry says. When `background_tasks` is absent, a live subagent task has an
// unrecognised shape, or a live extractor's description names no batch, only the second rule
// applies (logged). An unknown status counts as live. A batch wrongly taken for an orphan costs
// one re-dispatch, never a wrong result: its old extractor's binding is superseded.
//
// Every reason quotes the commands of the /observe skill word for word. The reason key (kind and
// IDs) is kept in out/ledger/stop-gate.json; the same key twice in a row lets the turn end instead
// (gate_run_gave_up), so the stop-hook block cap is never reached and a confused orchestrator stops
// rather than loops. Reads only the input and the ledger; every decision is logged with the raw
// task statuses it saw. Any failure lets the turn end.
import { appendRunLog, emit, errorText, isRecord, parseInput, projectRoot, readStdin, readStopGate, reportFailure, str, writeStopGate, type HookInput } from './lib.ts';
import { ORPHAN_GRACE_S, batchViews, readRun, type BatchView } from '../../src/run/ledger.ts';
import { utcMs } from '../../src/util/time.ts';
import type { StatusReport } from '../../src/run/commands.ts';

// A running batch this old is validated whatever the task registry says: no extractor runs this
// long (65-95 s measured, at most 16 turns), and the registry's status values are undocumented.
const ORPHAN_MAX_S = 900;

// Statuses that mean a background task has ended. Anything else counts as still running.
const FINISHED = new Set(['completed', 'done', 'failed', 'stopped', 'killed', 'cancelled', 'canceled']);

type Task = { type: string | null; agent_type: string | null; status: string | null; description: string | null };

function readTasks(value: unknown): Task[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(isRecord).map((t) => ({ type: str(t.type), agent_type: str(t.agent_type), status: str(t.status), description: str(t.description) }));
}

const isLive = (t: Task): boolean => !FINISHED.has((t.status ?? '').trim().toLowerCase());
const isSubagent = (t: Task): boolean => t.type === 'subagent' || (t.agent_type ?? '') !== '';
const untyped = (t: Task): boolean => (t.agent_type ?? '') === '';
// By its type; a subagent task without one counts by the description /observe gives it.
const isExtractor = (t: Task): boolean => isSubagent(t) && (t.agent_type === 'extractor' || (untyped(t) && /^\s*Extract\b/i.test(t.description ?? '')));
const isTaxonomist = (t: Task): boolean => isSubagent(t) && (t.agent_type === 'taxonomist' || (untyped(t) && /\btaxonomy\b/i.test(t.description ?? '')));
// A subagent task neither typed nor described as a pipeline agent: the registry can't be read.
const unrecognised = (t: Task): boolean => isSubagent(t) && untyped(t) && !isExtractor(t) && !isTaxonomist(t);

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// Seconds since the batch was dispatched, or null when its state records no usable time.
const ageOf = (view: BatchView | undefined, nowMs: number): number | null => {
  const at = view?.state.dispatched_utc ?? null;
  return at !== null && UTC.test(at) ? (nowMs - utcMs(at)) / 1000 : null;
};

// The batch number a description names ("Extract batch-017", "batch 17"), or null.
function batchNumber(description: string | null): number | null {
  const m = /\bbatch[-_ ]?(\d{1,6})\b/i.exec(description ?? '');
  return m === null ? null : Number(m[1]);
}
const numberOf = (batchId: string): number => Number(batchId.slice(batchId.lastIndexOf('-') + 1));

type Block = { kind: 'validate' | 'taxonomy' | 'dispatch' | 'run_end'; ids: string[]; reason: string };
type Decision = { block: Block | null; orphan_check: string };

const cmd = (command: string): string => `\`${command}\``;
const are = (ids: readonly string[]): string => (ids.length === 1 ? 'is' : 'are');

// A running batch is an orphan when no live extractor task names it and it was dispatched at least
// ORPHAN_GRACE_S ago, or, whatever the registry says, when it was dispatched ORPHAN_MAX_S ago. The
// registry is trusted only when present and fully recognised; a batch with no usable dispatch
// time is never taken for an orphan.
function decide(report: StatusReport, views: readonly BatchView[], tasks: Task[] | null, nowMs: number): Decision {
  const live = tasks?.filter(isLive) ?? null;
  const extractors = live?.filter(isExtractor) ?? null;
  let orphanCheck = 'checked';
  if (live === null || extractors === null) orphanCheck = 'skipped: no background_tasks in the Stop input';
  else if (live.some(unrecognised)) orphanCheck = 'skipped: a live subagent task of unrecognised shape';
  else if (extractors.some((t) => batchNumber(t.description) === null)) orphanCheck = 'skipped: a live extractor description names no batch';
  const working = new Set((extractors ?? []).map((t) => batchNumber(t.description)));
  const byId = new Map(views.map((v) => [v.entry.batch_id, v]));
  const orphans = report.running.filter((id) => {
    const age = ageOf(byId.get(id), nowMs);
    if (age === null) return false;
    if (age >= ORPHAN_MAX_S) return true;
    return orphanCheck === 'checked' && age >= ORPHAN_GRACE_S && !working.has(numberOf(id));
  });
  if (orphans.length > 0) {
    const reason =
      `Pipeline run: ${orphans.join(', ')} ${are(orphans)} still running, but no extractor is working on ${orphans.length === 1 ? 'it' : 'them'}. ` +
      `Run ${orphans.map((id) => cmd(`node obs.mjs validate ${id}`)).join(', ')}, then ${cmd('node obs.mjs status --json')}, ` +
      'and carry on with step 4 of /observe.';
    return { block: { kind: 'validate', ids: orphans, reason }, orphan_check: orphanCheck };
  }
  if (report.taxonomy !== 'fresh' && !(live?.some(isTaxonomist) ?? false)) {
    const reason =
      `Pipeline run: the taxonomy is ${report.taxonomy === 'missing' ? 'missing' : 'out of date'}. ` +
      `Run ${cmd('node obs.mjs taxonomy')} and carry on with step 2 of /observe.`;
    return { block: { kind: 'taxonomy', ids: [], reason }, orphan_check: orphanCheck };
  }
  if (report.next.length > 0) {
    const ids = report.next;
    const reason =
      `Pipeline run: ${ids.join(', ')} ${are(ids)} ready to dispatch. ` +
      `Run ${ids.map((id) => cmd(`node obs.mjs dispatch ${id}`)).join(', ')}, then start one extractor per dispatched batch, ` +
      'all in one message, as in step 3 of /observe, and end your turn.';
    return { block: { kind: 'dispatch', ids, reason }, orphan_check: orphanCheck };
  }
  const anyLive = live === null ? report.running.length > 0 : live.some((t) => isExtractor(t) || isTaxonomist(t));
  if (anyLive || report.extraction !== 'complete') return { block: null, orphan_check: orphanCheck };
  const reason = `Pipeline run: extraction is complete. Run ${cmd('node obs.mjs run end')}, then ${cmd('node obs.mjs status')}, and print its output (step 5 of /observe).`;
  return { block: { kind: 'run_end', ids: [], reason }, orphan_check: orphanCheck };
}

async function gateRun(root: string, input: HookInput): Promise<void> {
  const run = readRun(root);
  if (!run.active) return;
  const gate = readStopGate(root, run.run_id);
  const session = str(input.session_id);
  if (gate.session_id !== null && session !== null && session !== gate.session_id) {
    appendRunLog(root, { event: 'gate_run', decision: 'other_session' });
    return;
  }
  const tasks = readTasks(input.background_tasks);
  const { statusReport } = await import('../../src/run/commands.ts');
  const views = batchViews(root);
  const report = statusReport(root, views);
  const rawTasks = tasks?.map((t) => ({ type: t.type, agent_type: t.agent_type, status: t.status, description: (t.description ?? '').slice(0, 60) })) ?? null;
  if (report.halt) {
    // The run has stopped itself (status says why); the orchestrator prints the reason and stops.
    writeStopGate(root, { ...gate, last_block: null });
    appendRunLog(root, { event: 'gate_run', decision: 'halt', tasks: rawTasks });
    return;
  }
  const { block, orphan_check } = decide(report, views, tasks, Date.now());
  const logged = { event: 'gate_run', stop_hook_active: input.stop_hook_active === true, orphan_check, tasks: rawTasks };
  if (block === null) {
    writeStopGate(root, { ...gate, last_block: null });
    appendRunLog(root, { ...logged, decision: 'wait' });
    return;
  }
  const key = `${block.kind}:${block.ids.join(',')}`;
  if (gate.last_block === key) {
    writeStopGate(root, { ...gate, last_block: null });
    appendRunLog(root, { ...logged, event: 'gate_run_gave_up', kind: block.kind, ids: block.ids });
    return;
  }
  writeStopGate(root, { ...gate, last_block: key });
  emit({ decision: 'block', reason: block.reason });
  appendRunLog(root, { ...logged, decision: 'block', kind: block.kind, ids: block.ids });
}

let root: string | null = null;
try {
  const input = parseInput(await readStdin());
  if (input !== null) {
    root = projectRoot(input);
    await gateRun(root, input);
  }
} catch (err) {
  try {
    reportFailure('gate-run', err, root ?? projectRoot(null));
    if (root !== null) appendRunLog(root, { event: 'gate_run_error', error: errorText(err) });
  } catch {
    // nowhere left to report; the turn still ends
  }
}
process.exitCode = 0;
