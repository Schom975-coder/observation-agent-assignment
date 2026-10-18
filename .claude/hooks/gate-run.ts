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
// is a subagent task with agent_type extractor, synthesizer, taxonomist, merger or drafter (or,
// untyped, a description that names it the way /observe does: "Extract batch-017", "Synthesize
// synth-003", "Draft draft-003", "Build taxonomy", "Merge process keys") whose status is not a
// finished one. A job agent's job is the number in its description, matched loosely on the kind.
// Then, in order (ARCHITECTURE.md 6.7, 7.4), every block naming the one command of the run,
// `node obs.mjs advance`:
//   1. orphans (below) of any kind: block, naming `node obs.mjs advance <id> ... --json` with
//      them (step 3 of /observe: it records whatever each left);
//   2. jobs to hand out (`next` of any kind not empty): block, naming `node obs.mjs advance --json`
//      (step 2);
//   3. any live pipeline agent, or a running job whose agent may not have shown up yet (inside the
//      grace period, or the registry unreadable): let the turn end (each completion wakes the
//      orchestrator; a `-p` run waits for background subagents);
//   4. the merge is stopped (its attempts used up): let the turn end, the run stays active;
//   5. otherwise (a stage step to run, or the run still active after every stage is done): block,
//      naming `node obs.mjs advance --json` (step 2).
// Exhausted jobs are reported by status, not waited for. A stopped taxonomy ends through the repeat
// guard below: advance halts on it, and the key does not change. The registry is not trusted
// blindly. A running job is an orphan when no live agent of its kind names it and it was dispatched
// at least ORPHAN_GRACE_S ago (so a job is never recorded just after its dispatch, before its agent
// shows up), or when it was dispatched at least ORPHAN_MAX_S ago, whatever the registry says. When
// `background_tasks` is absent, a live subagent task has an unrecognised shape, or a live job
// agent's description names no job, only the second rule applies (logged). An unknown status counts
// as live. A job wrongly taken for an orphan costs one re-dispatch, never a wrong result: its old
// agent's binding is superseded.
//
// Every reason quotes the commands of the /observe skill word for word. The reason key is
// `advance:<stage>:<generation>`, the generation being the IDs named (rules 1 and 2) or, at the
// taxonomy and merge stages, that stage's attempt count for the current inputs (rule 5): a second
// legitimate block (the next wave, the next attempt) differs from the first, while a block the
// orchestrator did not act on repeats it. The key is kept in out/ledger/stop-gate.json; the same key twice in a row lets the
// turn end instead (gate_run_gave_up), so the stop-hook block cap is never reached and a confused
// orchestrator stops rather than loops. Reads only the input and the ledger; every decision is
// logged with the stage and the raw task statuses it saw. Any failure lets the turn end.
import { appendRunLog, emit, errorText, isRecord, parseInput, projectRoot, readStdin, readStopGate, reportFailure, str, writeStopGate, type HookInput } from './lib.ts';
import { JOB_KINDS, ORPHAN_GRACE_S, batchViews, kindOf, readRun, type BatchView } from '../../src/run/ledger.ts';
import { utcMs } from '../../src/util/time.ts';
import type { StatusReport } from '../../src/run/commands.ts';
import type { JobKind } from '../../src/types.ts';

// A running job this old is recorded whatever the task registry says: no job agent runs this long
// (minutes at most, and a capped number of turns), and the registry's status values are
// undocumented.
const ORPHAN_MAX_S = 900;

// Statuses that mean a background task has ended. Anything else counts as still running.
const FINISHED = new Set(['completed', 'done', 'failed', 'stopped', 'killed', 'cancelled', 'canceled']);

type Agent = 'extractor' | 'synthesizer' | 'taxonomist' | 'merger' | 'drafter';
const AGENTS: readonly Agent[] = ['extractor', 'synthesizer', 'taxonomist', 'merger', 'drafter'];
// The agents that work on ledger jobs (JOB_KINDS[kind].worker), and their job kind. The drafter
// gets its kind with the draft jobs (M6); until then a live drafter is a live pipeline agent only.
const KIND_OF_AGENT: Partial<Record<Agent, JobKind>> = { extractor: 'batch', synthesizer: 'synth' };

type Task = { type: string | null; agent_type: string | null; status: string | null; description: string | null };

function readTasks(value: unknown): Task[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(isRecord).map((t) => ({ type: str(t.type), agent_type: str(t.agent_type), status: str(t.status), description: str(t.description) }));
}

const isLive = (t: Task): boolean => !FINISHED.has((t.status ?? '').trim().toLowerCase());
const isSubagent = (t: Task): boolean => t.type === 'subagent' || (t.agent_type ?? '') !== '';
const untyped = (t: Task): boolean => (t.agent_type ?? '') === '';

// How advance describes each agent's Agent call: the job agents by the verb their
// descriptionFor() starts with ("Extract", "Synthesize", with -ise accepted too; "Draft" for the
// drafter, whose job kind arrives with M6), the two single-call stages by their descriptions
// ("Build taxonomy", "Merge process keys").
type Recognisers = Record<Agent, RegExp>;
function recognisers(descriptionFor: (id: string) => string): Recognisers {
  const verb = (id: string) => (/^[A-Za-z]+/.exec(descriptionFor(id))?.[0] ?? id).replace(/i[sz]e$/i, 'i[sz]e');
  return {
    extractor: new RegExp(`^\\s*${verb('batch-000')}\\b`, 'i'),
    synthesizer: new RegExp(`^\\s*${verb('synth-000')}\\b`, 'i'),
    taxonomist: /\btaxonomy\b/i,
    merger: /\bmerge\b/i,
    drafter: /^\s*Draft\b/i,
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

// record: orphans to record (rule 1); hand_out: jobs to hand out (rule 2); stage: a stage step to
// run, or the run to end (rule 5). Every one names `node obs.mjs advance`.
type BlockKind = 'record' | 'hand_out' | 'stage';
type Block = { kind: BlockKind; ids: string[]; key: string; reason: string };
// block null: the turn may end, for the reason in `decision`.
type Decision = { block: Block | null; decision: 'wait' | 'merge_stopped'; orphan_check: string };
// Attempts so far at the single-call stages, which tell one round of them from the next.
type Attempts = { taxonomy: () => number; merge: () => number };

const cmd = (command: string): string => `\`${command}\``;
const are = (ids: readonly string[]): string => (ids.length === 1 ? 'is' : 'are');
const state = (freshness: string): string => (freshness === 'missing' ? 'missing' : 'out of date');
// The one command of the run, and the steps of /observe that act on its output.
const ADVANCE = cmd('node obs.mjs advance --json');
const ACT = 'and act on its output as in step 2 of /observe.';

// Who works on these jobs, for the orphan reason: one kind's agent, or "subagent" for a mix.
function workerOf(ids: readonly string[]): string {
  const kinds = new Set(ids.map(kindOf));
  return kinds.size === 1 ? JOB_KINDS[[...kinds][0] as JobKind].worker : 'subagent';
}

// What a stage with a step to run (rule 5) says it is waiting for.
function stageReason(report: StatusReport): string {
  switch (report.stage) {
    case 'taxonomy':
      return `the taxonomy is ${state(report.taxonomy)}`;
    case 'merge':
      return `extraction is complete and the merge is ${state(report.merge)}`;
    case 'rollup':
      return `the merge is done and the rollup is ${state(report.rollup)}`;
    case 'score':
      return `synthesis is complete and the score is ${state(report.score)}`;
    case 'done':
      return 'every stage is done and the run is still active';
    default:
      return `the ${report.stage} stage has a step to run`;
  }
}

function decide(report: StatusReport, views: readonly BatchView[], tasks: Task[] | null, nowMs: number, r: Recognisers, attempts: Attempts): Decision {
  const live = tasks?.filter(isLive) ?? null;
  const agents = live?.map((t) => ({ t, agent: agentOf(t, r) })) ?? null;
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
  const decided = (block: Omit<Block, 'key'>, generation: string): Decision => ({
    block: { ...block, key: `advance:${report.stage}:${generation}` },
    decision: 'wait',
    orphan_check: orphanCheck,
  });
  const endTurn = (decision: Decision['decision'] = 'wait'): Decision => ({ block: null, decision, orphan_check: orphanCheck });

  // 1. Jobs no agent is working on: advance records whatever each left, then hands out what is next.
  if (orphans.length > 0) {
    const reason =
      `Pipeline run: ${orphans.join(', ')} ${are(orphans)} still running, but no ${workerOf(orphans)} is working on ${orphans.length === 1 ? 'it' : 'them'}. ` +
      `Run ${cmd(`node obs.mjs advance ${orphans.join(' ')} --json`)} and act on its output as in step 3 of /observe.`;
    return decided({ kind: 'record', ids: orphans, reason }, orphans.join(','));
  }
  // 2. Free slots and jobs to hand out, of any kind.
  const next = [...report.next, ...report.synthesis.next];
  if (next.length > 0) {
    const reason = `Pipeline run: ${next.join(', ')} ${are(next)} ready to hand out. Run ${ADVANCE} ${ACT}`;
    return decided({ kind: 'hand_out', ids: next, reason }, next.join(','));
  }
  // 3. Work in flight: a live pipeline agent, or a running job not taken for an orphan (its agent
  // may not be in the registry yet, or the registry could not be read). Each completion wakes the
  // orchestrator.
  if ((agents ?? []).some((x) => x.agent !== null) || running.some((id) => !orphans.includes(id))) return endTurn();
  // 4. A stopped merge: its attempts for these inputs are used up, and the merger definition has to
  // change before it can run again, which is the person's call, not the orchestrator's.
  if (report.stage === 'merge' && report.merge === 'stopped') return endTurn('merge_stopped');
  // 5. A stage step to run, or the run to end. At the taxonomy and the merge, the attempt count for
  // the current inputs is the generation: the next attempt is a new block, a halted stage (no new
  // attempt) a repeat, and attempts made for older inputs count as none.
  const generation = report.stage === 'taxonomy' ? String(attempts.taxonomy()) : report.stage === 'merge' ? String(attempts.merge()) : '';
  return decided({ kind: 'stage', ids: [], reason: `Pipeline run: ${stageReason(report)}. Run ${ADVANCE} ${ACT}` }, generation);
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
  const { taxonomyAttempts } = await import('../../src/run/taxonomy.ts');
  const { mergeAttempts } = await import('../../src/run/merge.ts');
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
  const attempts: Attempts = { taxonomy: () => taxonomyAttempts(root), merge: () => mergeAttempts(root) };
  const { block, decision, orphan_check } = decide(report, [...views, ...(groups ?? [])], tasks, Date.now(), recognisers(descriptionFor), attempts);
  const logged = { event: 'gate_run', stage: report.stage, stop_hook_active: input.stop_hook_active === true, orphan_check, tasks: rawTasks };
  if (block === null) {
    writeStopGate(root, { ...gate, last_block: null });
    appendRunLog(root, { ...logged, decision });
    return;
  }
  if (gate.last_block === block.key) {
    writeStopGate(root, { ...gate, last_block: null });
    appendRunLog(root, { ...logged, event: 'gate_run_gave_up', kind: block.kind, ids: block.ids, key: block.key });
    return;
  }
  writeStopGate(root, { ...gate, last_block: block.key });
  emit({ decision: 'block', reason: block.reason });
  appendRunLog(root, { ...logged, decision: 'block', kind: block.kind, ids: block.ids, key: block.key });
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
