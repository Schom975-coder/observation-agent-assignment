// SubagentStop (matcher: extractor): check a finished extractor's output and record the result.
//
// The gate records; it never blocks. In auto mode a subagent delivers its reply through its
// hand-back tool before it stops, so a block could not reach it anyway; fix rounds are new
// dispatches driven by the orchestrator from the ledger (ARCHITECTURE.md 6.7).
//
// Which batch to check comes from the agent's binding (out/ledger/agents/<agent_id>.json, made by
// the corpus guard on the agent's first batch read), never from the reply or the transcript. Then:
// - no binding: log gate_unbound and stop (the orchestrator's `node obs.mjs validate` takes over);
// - the batch was dispatched again since the binding (dispatch count, cache key or dispatch time
//   moved on): log gate_superseded and stop (that output belongs to the newer extractor);
// - the batch is no longer running (already validated): log gate_not_running and stop;
// - otherwise run the same check as `node obs.mjs validate` and record done, or failed with the
//   problem list, in the batch's ledger file.
// A problem the model cannot fix (unreadable out/, changed corpus bytes) stamps nothing: the batch
// stays running for a later validate. If the gate itself fails, it logs the error and exits 0.
// Nothing it logs contains the project's path.
import { appendRunLog, errorText, parseInput, projectRoot, readStdin, reportFailure, str, type HookInput } from './lib.ts';
import { bindingIsCurrent, boundBatch, findBatch, loadIndex, outDir, readBatchState, recordValidation, withoutRoot } from '../../src/run/ledger.ts';

async function gate(root: string, input: HookInput): Promise<void> {
  const agentId = str(input.agent_id);
  const agent = { agent_type: 'extractor', agent_id: agentId };
  const binding = agentId === null || agentId === '' ? null : boundBatch(root, agentId);
  if (binding === null) {
    appendRunLog(root, { event: 'gate_unbound', ...agent });
    return;
  }
  const batchId = binding.batch_id;
  const state = readBatchState(root, batchId);
  if (!bindingIsCurrent(binding, state)) {
    appendRunLog(root, { event: 'gate_superseded', ...agent, batch_id: batchId, bound_dispatch: binding.dispatches, dispatches: state.dispatches });
    return;
  }
  if (state.status !== 'running') {
    appendRunLog(root, { event: 'gate_not_running', ...agent, batch_id: batchId, status: state.status });
    return;
  }
  const entry = findBatch(loadIndex(root), batchId);

  // Loaded here rather than at the top, so that even a validator that fails to load is caught below.
  const { checkExtraction } = await import('../../src/model/validate-extraction.ts');
  const check = checkExtraction(root, batchId, { outDir: outDir(root) });
  if (check.setup !== null) {
    // Nothing the model can fix: stamp nothing, leave the batch running.
    appendRunLog(root, { event: 'gate_setup_error', ...agent, batch_id: batchId, setup: withoutRoot(check.setup, root) });
    return;
  }
  const recorded = recordValidation(root, entry, check);
  appendRunLog(root, {
    event: 'gate',
    ...agent,
    batch_id: batchId,
    dispatches: recorded.dispatches,
    status: recorded.status,
    problems: check.problems.length,
    quote_stats: recorded.quote_stats,
  });
}

let root: string | null = null;
try {
  const input = parseInput(await readStdin());
  if (input !== null) {
    const agentType = str(input.agent_type);
    if (agentType === 'extractor') {
      root = projectRoot(input);
      await gate(root, input);
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
