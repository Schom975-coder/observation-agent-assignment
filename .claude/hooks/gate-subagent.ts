// SubagentStop (matcher: extractor): check an extractor's output before it is accepted.
//
// The reply must end with "OUTPUT: out/extract/<batch_id>.json", naming the batch the extractor was
// given (its task prompt, from `node obs.mjs dispatch`, says which) and that batch must be running.
// The file then goes through the same check as `node obs.mjs validate`. If it fails and the batch
// has gate blocks left (3 per dispatch), the hook prints {"decision":"block","reason":...}: Claude
// Code keeps the subagent running and hands it the reason as its next instruction. Otherwise (it
// passed, or the blocks are used up) the result is recorded exactly as `validate` records it and
// the subagent may finish. The ledger's counters bound every loop; stop_hook_active is not used.
//
// Problems the model can't fix ("setup: ..." from the validator) never block and never stamp the
// batch: it stays running for a later `node obs.mjs validate`. If the gate itself fails, it logs
// the error and lets the subagent finish: `validate` is the authority, and a broken gate must never
// trap a subagent in a loop. Nothing it logs or sends to the model contains the project's path.
import { readFileSync, statSync } from 'node:fs';
import { appendRunLog, emit, errorText, parseInput, projectRoot, readStdin, reportFailure, str, type HookInput } from './lib.ts';
import {
  GATE_MAX_BLOCKS,
  batchViews,
  isSetupProblem,
  outDir,
  parseOutputLine,
  recordValidation,
  takeAgentBlock,
  takeGateBlock,
  withoutRoot,
  type OutputLine,
} from '../../src/run/ledger.ts';

const MAX_PROBLEMS_SENT = 20;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

// The subagent's transcript (JSONL), if readable: it holds the task prompt it was given and, in
// auto mode, the SubagentHandback call that carries its final reply.
function readTranscript(path: string | null): string | null {
  if (path === null || path === '') return null;
  try {
    if (statSync(path).size > MAX_TRANSCRIPT_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// The batch named in the task prompt ("Extract batch batch-017."), the first thing in the transcript.
const assignedBatch = (transcript: string | null): string | null =>
  transcript === null ? null : (/Extract batch (batch-\d{3,6})\./.exec(transcript)?.[1] ?? null);

// An OUTPUT line in the last SubagentHandback call, for a reply delivered that way rather than as
// final text. Only text after that call counts: the task prompt itself contains an OUTPUT line.
function handbackOutputLine(transcript: string | null): OutputLine {
  if (transcript === null) return { kind: 'missing' };
  const at = transcript.lastIndexOf('"SubagentHandback"');
  if (at < 0) return { kind: 'missing' };
  const matches = [...transcript.slice(at).matchAll(/OUTPUT:[ \t]*[^\s"]*?out(?:\/|\\\\)extract(?:\/|\\\\)(batch-\d{3,6})\.json/g)];
  const last = matches.at(-1);
  return last === undefined ? { kind: 'missing' } : { kind: 'named', batchId: last[1] as string };
}

const fixLine = 'Fix only these problems in the same file, then reply again ending with the OUTPUT line.';

function problemsReason(batchId: string, problems: readonly string[], block: number): string {
  const shown = problems.slice(0, MAX_PROBLEMS_SENT);
  const more = problems.length - shown.length;
  return [
    `The pipeline checked out/extract/${batchId}.json and found ${problems.length} problem${problems.length === 1 ? '' : 's'} ` +
      `(round ${block} of at most ${GATE_MAX_BLOCKS}):`,
    ...shown.map((p) => `- ${p}`),
    ...(more > 0 ? [`- (${more} more not shown; fix these first)`] : []),
    `First Read your output file, using the absolute "Output file:" path from your task. ${fixLine}`,
  ].join('\n');
}

async function gate(root: string, input: HookInput): Promise<void> {
  const agent = { agent_type: str(input.agent_type), agent_id: str(input.agent_id) };
  const transcript = readTranscript(str(input.agent_transcript_path));
  const assigned = assignedBatch(transcript);
  let line = parseOutputLine(str(input.last_assistant_message) ?? '');
  if (line.kind === 'missing') line = handbackOutputLine(transcript);

  const views = batchViews(root);
  const view = line.kind === 'named' ? views.find((v) => v.entry.batch_id === line.batchId) : undefined;
  const expected = assigned === null ? 'OUTPUT: out/extract/<batch_id>.json (the exact line given in your task)' : `OUTPUT: out/extract/${assigned}.json`;
  let wrong: string | null = null;
  if (line.kind === 'missing') {
    wrong = `Your reply did not end with the line ${expected}. If you have not written the output file yet, write it first. Then reply again ending with that line.`;
  } else if (line.kind === 'unrecognised' || view === undefined) {
    const text = line.kind === 'unrecognised' ? line.text.slice(0, 200) : `out/extract/${line.kind === 'named' ? line.batchId : ''}.json`;
    wrong = `Your OUTPUT line names "${withoutRoot(text, root)}", which is not an output file of this run. Reply again ending with the line ${expected}.`;
  } else if (assigned !== null && assigned !== view.entry.batch_id) {
    wrong = `Your OUTPUT line names ${view.entry.batch_id}, but your task is ${assigned}. Reply again ending with the line ${expected}.`;
  } else if (view.state.status !== 'running') {
    const running = views.filter((v) => v.state.status === 'running').map((v) => v.entry.batch_id);
    const which = assigned !== null ? `Your task is ${assigned}` : `Batches being extracted now: ${running.join(', ') || 'none'}`;
    wrong = `${view.entry.batch_id} is not being extracted (it is ${view.state.status}). ${which}. Reply again ending with the line ${expected}.`;
  }
  if (wrong !== null) {
    const block = takeAgentBlock(root, agent.agent_id);
    appendRunLog(root, { event: 'gate', ...agent, batch_id: assigned, decision: block === null ? 'allow' : 'block', reason: 'output_line' });
    if (block !== null) emit({ decision: 'block', reason: wrong });
    return;
  }
  const entry = (view as NonNullable<typeof view>).entry;

  // Loaded here rather than at the top, so that even a validator that fails to load is caught below.
  const { checkExtraction } = await import('../../src/model/validate-extraction.ts');
  const check = checkExtraction(root, entry.batch_id, { outDir: outDir(root) });
  const problems = check.problems.map((p) => withoutRoot(p, root));
  const logged = { event: 'gate', ...agent, batch_id: entry.batch_id, problems: problems.length };
  if (check.problems.some(isSetupProblem)) {
    // Nothing the model can fix: let it finish, stamp nothing, leave the batch running.
    appendRunLog(root, { ...logged, event: 'gate_setup_error', setup: problems.filter(isSetupProblem).slice(0, 5) });
    return;
  }
  if (!check.ok) {
    const block = takeGateBlock(root, entry.batch_id);
    if (block !== null) {
      appendRunLog(root, { ...logged, decision: 'block', gate_blocks: block });
      emit({ decision: 'block', reason: problemsReason(entry.batch_id, problems, block) });
      return;
    }
  }
  const state = recordValidation(root, entry, check);
  appendRunLog(root, { ...logged, decision: state.status, gate_blocks: state.gate_blocks, quote_stats: state.quote_stats });
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
