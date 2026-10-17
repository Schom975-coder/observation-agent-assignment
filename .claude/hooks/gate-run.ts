// Stop: keep the orchestrator in the loop while a pipeline run is active, stage by stage
// (ARCHITECTURE.md 6.7, 7.4).
//
// Silent unless out/ledger/run.json says a run is active, and silent for any session other than
// the run's orchestrator (recorded in out/ledger/stop-gate.json: by `run start` from the claim of
// the session that typed it, or by the corpus guard when a session starts a pipeline subagent), so
// other Claude Code sessions in this folder are not steered. With no orchestrator recorded,
// whichever session stops is steered.
//
// When status reports a halt (the circuit breaker), the turn may end: the orchestrator prints why
// and stops. Otherwise live work comes from the Stop input's `background_tasks`: a pipeline agent
// is a subagent task with agent_type extractor, synthesizer, taxonomist or merger (or, untyped, a
// description that names it the way /observe does: "Extract batch-017", "Synthesize synth-003",
// "Build taxonomy", "Merge process keys") whose status is not a finished one. An extractor's or a
// synthesizer's job is the number in its description, matched loosely on the kind. Then, in order:
//   1. orphans (below) of either kind: block, naming `node obs.mjs validate <id>` for each;
//   2. the taxonomy is not fresh and no taxonomist is live: block, naming `node obs.mjs taxonomy`;
//   3. extraction `next` is not empty: block, naming `node obs.mjs dispatch <id>` for each;
//   4. extraction is not complete: let the turn end (each completion wakes the orchestrator);
//   5. the merge is stopped (its attempts used up): let the turn end, the run stays active; the
//      merge is not fresh and no merger is live: block, naming `node obs.mjs merge`;
//   6. the rollup is not current: block, naming `node obs.mjs rollup`;
//   7. synthesis `next` is not empty: block, naming `node obs.mjs dispatch <id>` for each;
//   8. synthesis is not complete: let the turn end;
//   9. the score is not current: block, naming `node obs.mjs score`;
//  10. otherwise the run is still active: block, naming `node obs.mjs run end`.
// Exhausted jobs are reported by status, not waited for. The registry is not trusted blindly. A
// running job is an orphan when no live agent of its kind names it and it was dispatched at least
// ORPHAN_GRACE_S ago (so a job is never validated just after its dispatch, before its agent shows
// up), or when it was dispatched at least ORPHAN_MAX_S ago, whatever the registry says. When
// `background_tasks` is absent, a live subagent task has an unrecognised shape, or a live
// extractor's or synthesizer's description names no job, only the second rule applies (logged).
// An unknown status counts as live. A job wrongly taken for an orphan costs one re-dispatch, never
// a wrong result: its old agent's binding is superseded.
//
// Every reason quotes the commands of the /observe skill word for word. The reason key (kind and
// IDs) is kept in out/ledger/stop-gate.json; the same key twice in a row lets the turn end instead
// (gate_run_gave_up), so the stop-hook block cap is never reached and a confused orchestrator stops
// rather than loops. Reads only the input and the ledger; every decision is logged with the stage
// and the raw task statuses it saw. Any failure lets the turn end.
import { appendRunLog, emit, errorText, isRecord, parseInput, projectRoot, readStdin, readStopGate, reportFailure, str, writeStopGate, type HookInput } from './lib.ts';
import { JOB_KINDS, ORPHAN_GRACE_S, batchViews, kindOf, readRun, type BatchView } from '../../src/run/ledger.ts';
import { utcMs } from '../../src/util/time.ts';
import type { StatusReport } from '../../src/run/commands.ts';
import type { JobKind } from '../../src/types.ts';

// A running job this old is validated whatever the task registry says: no extractor or
// synthesizer runs this long (minutes at most, and a capped number of turns), and the registry's
// status values are undocumented.
const ORPHAN_MAX_S = 900;

// Statuses that mean a background task has ended. Anything else counts as still running.
const FINISHED = new Set(['completed', 'done', 'failed', 'stopped', 'killed', 'cancelled', 'canceled']);

type Agent = 'extractor' | 'synthesizer' | 'taxonomist' | 'merger';
const AGENTS: readonly Agent[] = ['extractor', 'synthesizer', 'taxonomist', 'merger'];
// The two agents that work on ledger jobs (JOB_KINDS[kind].worker), and their job kind.
const KIND_OF_AGENT: Partial<Record<Agent, JobKind>> = { extractor: 'batch', synthesizer: 'synth' };

type Task = { type: string | null; agent_type: string | null; status: string | null; description: string | null };

function readTasks(value: unknown): Task[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(isRecord).map((t) => ({ type: str(t.type), agent_type: str(t.agent_type), status: str(t.status), description: str(t.description) }));
}

const isLive = (t: Task): boolean => !FINISHED.has((t.status ?? '').trim().toLowerCase());
const isSubagent = (t: Task): boolean => t.type === 'subagent' || (t.agent_type ?? '') !== '';
const untyped = (t: Task): boolean => (t.agent_type ?? '') === '';

// How /observe describes each agent's Agent call: the job agents by the verb their
// descriptionFor() starts with ("Extract", "Synthesize", with -ise accepted too), the two
// single-call stages by what the skill names them ("Build taxonomy", "Merge process keys").
type Recognisers = Record<Agent, RegExp>;
function recognisers(descriptionFor: (id: string) => string): Recognisers {
  const verb = (id: string) => (/^[A-Za-z]+/.exec(descriptionFor(id))?.[0] ?? id).replace(/i[sz]e$/i, 'i[sz]e');
  return {
    extractor: new RegExp(`^\\s*${verb('batch-000')}\\b`, 'i'),
    synthesizer: new RegExp(`^\\s*${verb('synth-000')}\\b`, 'i'),
    taxonomist: /\btaxonomy\b/i,
    merger: /\bmerge\b/i,
  };
}

// The pipeline agent a task is: by its type; a subagent task without one by its description.
function agentOf(t: Task, r: Recognisers): Agent | null {
  if (!isSubagent(t)) return null;
  if (!untyped(t)) return (AGENTS as readonly string[]).includes(t.agent_type as string) ? (t.agent_type as Agent) : null;
  return AGENTS.find((a) => r[a].test(t.description ?? '')) ?? null;
}

// The job number a description names, loosely, for the kind of job its agent works on: "Extract
// batch-017", "batch 17"; "Synthesize synth-003", "group 3". Null when it names none.
const JOB_NUMBER: Record<JobKind, RegExp> = { batch: /\bbatch[-_ ]?(\d{1,6})\b/i, synth: /\b(?:synth|group)[-_ ]?(\d{1,6})\b/i };
function jobNumber(kind: JobKind, description: string | null): number | null {
  const m = JOB_NUMBER[kind].exec(description ?? '');
  return m === null ? null : Number(m[1]);
}
const jobKey = (kind: JobKind, n: number): string => `${kind}:${n}`;
const keyOf = (id: string): string => jobKey(kindOf(id), Number(id.slice(id.lastIndexOf('-') + 1)));

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// Seconds since the job was dispatched, or null when its state records no usable time.
const ageOf = (view: BatchView | undefined, nowMs: number): number | null => {
  const at = view?.state.dispatched_utc ?? null;
  return at !== null && UTC.test(at) ? (nowMs - utcMs(at)) / 1000 : null;
};

type BlockKind = 'validate' | 'taxonomy' | 'dispatch' | 'merge' | 'rollup' | 'score' | 'run_end';
type Block = { kind: BlockKind; ids: string[]; reason: string };
// block null: the turn may end, for the reason in `decision`.
type Decision = { block: Block | null; decision: 'wait' | 'merge_stopped'; orphan_check: string };

const cmd = (command: string): string => `\`${command}\``;
const are = (ids: readonly string[]): string => (ids.length === 1 ? 'is' : 'are');
const state = (freshness: string): string => (freshness === 'missing' ? 'missing' : 'out of date');

// Who works on these jobs, for the orphan reason: one kind's agent, or "subagent" for a mix.
function workerOf(ids: readonly string[]): string {
  const kinds = new Set(ids.map(kindOf));
  return kinds.size === 1 ? JOB_KINDS[[...kinds][0] as JobKind].worker : 'subagent';
}

// Batches are dispatched in step 3 of /observe, synthesis groups in step 7.
function dispatchBlock(ids: string[], kind: JobKind): Block {
  const { worker, short } = JOB_KINDS[kind];
  const reason =
    `Pipeline run: ${ids.join(', ')} ${are(ids)} ready to dispatch. ` +
    `Run ${ids.map((id) => cmd(`node obs.mjs dispatch ${id}`)).join(', ')}, then start one ${worker} per dispatched ${short}, ` +
    `all in one message, as in step ${kind === 'batch' ? 3 : 7} of /observe, and end your turn.`;
  return { kind: 'dispatch', ids, reason };
}

function decide(report: StatusReport, views: readonly BatchView[], tasks: Task[] | null, nowMs: number, r: Recognisers): Decision {
  const live = tasks?.filter(isLive) ?? null;
  const agents = live?.map((t) => ({ t, agent: agentOf(t, r) })) ?? null;
  const liveAgent = (a: Agent): boolean => agents?.some((x) => x.agent === a) ?? false;
  let orphanCheck = 'checked';
  if (agents === null) orphanCheck = 'skipped: no background_tasks in the Stop input';
  else if (agents.some((x) => x.agent === null && isSubagent(x.t) && untyped(x.t))) orphanCheck = 'skipped: a live subagent task of unrecognised shape';
  else {
    for (const [agent, kind] of Object.entries(KIND_OF_AGENT) as Array<[Agent, JobKind]>) {
      if (agents.some((x) => x.agent === agent && jobNumber(kind, x.t.description) === null)) {
        orphanCheck = `skipped: a live ${agent} description names no ${JOB_KINDS[kind].short}`;
        break;
      }
    }
  }
  const working = new Set<string>();
  for (const x of agents ?? []) {
    const kind = x.agent === null ? undefined : KIND_OF_AGENT[x.agent];
    const n = kind === undefined ? null : jobNumber(kind, x.t.description);
    if (kind !== undefined && n !== null) working.add(jobKey(kind, n));
  }
  const byId = new Map(views.map((v) => [v.entry.id, v]));
  const running = [...report.running, ...report.synthesis.running];
  const orphans = running.filter((id) => {
    const age = ageOf(byId.get(id), nowMs);
    if (age === null) return false;
    if (age >= ORPHAN_MAX_S) return true;
    return orphanCheck === 'checked' && age >= ORPHAN_GRACE_S && !working.has(keyOf(id));
  });
  const decided = (block: Block): Decision => ({ block, decision: 'wait', orphan_check: orphanCheck });
  const endTurn = (decision: Decision['decision'] = 'wait'): Decision => ({ block: null, decision, orphan_check: orphanCheck });

  // 1. Jobs no agent is working on.
  if (orphans.length > 0) {
    const reason =
      `Pipeline run: ${orphans.join(', ')} ${are(orphans)} still running, but no ${workerOf(orphans)} is working on ${orphans.length === 1 ? 'it' : 'them'}. ` +
      `Run ${orphans.map((id) => cmd(`node obs.mjs validate ${id}`)).join(', ')}, then ${cmd('node obs.mjs status --json')}, ` +
      'and carry on with step 4 of /observe.';
    return decided({ kind: 'validate', ids: orphans, reason });
  }
  // 2-4. The taxonomy, then extraction.
  if (report.taxonomy !== 'fresh' && !liveAgent('taxonomist')) {
    const reason = `Pipeline run: the taxonomy is ${state(report.taxonomy)}. Run ${cmd('node obs.mjs taxonomy')} and carry on with step 2 of /observe.`;
    return decided({ kind: 'taxonomy', ids: [], reason });
  }
  if (report.next.length > 0) return decided(dispatchBlock(report.next, 'batch'));
  if (report.extraction !== 'complete') return endTurn();
  // 5. The merge. Stopped: its attempts for these inputs are used up, and the merger definition
  // has to change before it can run again, which is the person's call, not the orchestrator's.
  if (report.merge === 'stopped') return endTurn('merge_stopped');
  if (report.merge !== 'fresh') {
    if (liveAgent('merger')) return endTurn();
    const reason = `Pipeline run: extraction is complete and the merge is ${state(report.merge)}. Run ${cmd('node obs.mjs merge')} and carry on with step 5 of /observe.`;
    return decided({ kind: 'merge', ids: [], reason });
  }
  // 6. The rollup.
  if (report.rollup !== 'current') {
    const reason = `Pipeline run: the merge is done and the rollup is ${state(report.rollup)}. Run ${cmd('node obs.mjs rollup')} and carry on with step 6 of /observe.`;
    return decided({ kind: 'rollup', ids: [], reason });
  }
  // 7-8. Synthesis.
  if (report.synthesis.next.length > 0) return decided(dispatchBlock(report.synthesis.next, 'synth'));
  if (!report.synthesis.complete) return endTurn();
  // 9. The score.
  if (report.score !== 'current') {
    const reason = `Pipeline run: synthesis is complete and the score is ${state(report.score)}. Run ${cmd('node obs.mjs score')} and carry on with step 8 of /observe.`;
    return decided({ kind: 'score', ids: [], reason });
  }
  // 10. Every stage is done and the run is still marked active.
  const reason = `Pipeline run: every stage is done. Run ${cmd('node obs.mjs run end')}, then ${cmd('node obs.mjs status')}, and print its output (step 9 of /observe).`;
  return decided({ kind: 'run_end', ids: [], reason });
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
  const { statusReport, synthViews } = await import('../../src/run/commands.ts');
  const { descriptionFor } = await import('../../src/run/jobs.ts');
  const views = batchViews(root);
  const groups = synthViews(root);
  const report = statusReport(root, views, groups);
  const rawTasks = tasks?.map((t) => ({ type: t.type, agent_type: t.agent_type, status: t.status, description: (t.description ?? '').slice(0, 60) })) ?? null;
  if (report.halt) {
    // The run has stopped itself (status says why); the orchestrator prints the reason and stops.
    writeStopGate(root, { ...gate, last_block: null });
    appendRunLog(root, { event: 'gate_run', decision: 'halt', stage: report.stage, tasks: rawTasks });
    return;
  }
  const { block, decision, orphan_check } = decide(report, [...views, ...(groups ?? [])], tasks, Date.now(), recognisers(descriptionFor));
  const logged = { event: 'gate_run', stage: report.stage, stop_hook_active: input.stop_hook_active === true, orphan_check, tasks: rawTasks };
  if (block === null) {
    writeStopGate(root, { ...gate, last_block: null });
    appendRunLog(root, { ...logged, decision });
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
