// SubagentStop (matcher: extractor|synthesizer|drafter): check a finished agent's output and record
// the result in the ledger. The same gate for every kind of ledger job: an extractor's batch, a
// synthesizer's synthesis group and a drafter's artifact draft (ARCHITECTURE.md 6.21, 7.4).
//
// The gate records; it never blocks. In auto mode a subagent delivers its reply through its
// hand-back tool before it stops, so a block could not reach it anyway; fix rounds are new
// dispatches driven by the orchestrator from the ledger (ARCHITECTURE.md 6.7).
//
// Which job to check comes from the agent's binding (out/ledger/agents/<agent_id>.json, made by
// the corpus guard on the agent's first read of a job file), never from the reply or the
// transcript. Then:
// - no binding: log gate_unbound and stop (the orchestrator's `node obs.mjs validate` takes over);
// - a binding to a job of the other kind: log gate_kind_mismatch and stop (the guard's allowlists
//   make this impossible; the gate does not trust that);
// - the job was dispatched again since the binding (dispatch count, cache key or dispatch time
//   moved on): log gate_superseded and stop (that output belongs to the newer agent);
// - the job is no longer running (already validated): log gate_not_running and stop;
// - otherwise run the job's own check, exactly as `node obs.mjs validate` does (checkJob:
//   checkExtraction for a batch, checkSynthesis for a group, checkDraft for a draft), and record
//   done, or failed with the problem list, in the job's ledger file.
// A problem the model cannot fix (unreadable out/, changed corpus bytes, a stale group input)
// stamps nothing: the job stays running for a later validate. If the gate itself fails, it logs
// the error and exits 0. Nothing it logs contains the project's path. Log records name the job in
// `batch_id`, as the ledger's state files do for both kinds.
import { appendRunLog, errorText, parseInput, projectRoot, readStdin, reportFailure, str, type HookInput } from './lib.ts';
import { JOB_KINDS, bindingIsCurrent, boundJob, findJob, kindOf, loadJobs, readJobState, recordValidation, withoutRoot } from '../../src/run/ledger.ts';

// The agents this gate checks: the worker of every job kind.
const WORKERS: readonly string[] = Object.values(JOB_KINDS).map((k) => k.worker);

async function gate(root: string, input: HookInput, agentType: string): Promise<void> {
  const agentId = str(input.agent_id);
  const agent = { agent_type: agentType, agent_id: agentId };
  const binding = agentId === null || agentId === '' ? null : boundJob(root, agentId);
  if (binding === null) {
    appendRunLog(root, { event: 'gate_unbound', ...agent });
    return;
  }
  const jobId = binding.batch_id;
  const kind = kindOf(jobId);
  if (JOB_KINDS[kind].worker !== agentType) {
    appendRunLog(root, { event: 'gate_kind_mismatch', ...agent, batch_id: jobId });
    return;
  }
  const state = readJobState(root, jobId);
  if (!bindingIsCurrent(binding, state)) {
    appendRunLog(root, { event: 'gate_superseded', ...agent, batch_id: jobId, bound_dispatch: binding.dispatches, dispatches: state.dispatches });
    return;
  }
  if (state.status !== 'running') {
    appendRunLog(root, { event: 'gate_not_running', ...agent, batch_id: jobId, status: state.status });
    return;
  }
  const job = findJob(loadJobs(root, kind), jobId);

  // Loaded here rather than at the top, so that even a checker that fails to load is caught below.
  const { checkJob } = await import('../../src/run/jobs.ts');
  const check = checkJob(root, jobId);
  if (check.setup !== null) {
    // Nothing the model can fix: stamp nothing, leave the job running.
    appendRunLog(root, { event: 'gate_setup_error', ...agent, batch_id: jobId, setup: withoutRoot(check.setup, root) });
    return;
  }
  const recorded = recordValidation(root, job, check);
  appendRunLog(root, {
    event: 'gate',
    ...agent,
    batch_id: jobId,
    dispatches: recorded.dispatches,
    status: recorded.status,
    problems: check.problems.length,
    ...(kind === 'batch' ? { quote_stats: recorded.quote_stats } : {}),
  });
}

let root: string | null = null;
try {
  const input = parseInput(await readStdin());
  if (input !== null) {
    const agentType = str(input.agent_type);
    if (agentType !== null && WORKERS.includes(agentType)) {
      root = projectRoot(input);
      await gate(root, input, agentType);
    } else if (agentType === null) {
      // The matcher fired but the input names no agent: nothing to gate, but worth knowing.
      root = projectRoot(input);
      appendRunLog(root, { event: 'gate_skipped', reason: 'no agent_type in the SubagentStop input', agent_id: str(input.agent_id) });
    }
  }
} catch (err) {
  try {
    reportFailure('gate-subagent', err, root ?? projectRoot(null));
    if (root !== null) appendRunLog(root, { event: 'gate_error', error: errorText(err) });
  } catch {
    // nowhere left to report; the subagent still finishes
  }
}
process.exitCode = 0;
