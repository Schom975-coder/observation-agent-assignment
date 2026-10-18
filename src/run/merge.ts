// The merge stage (ARCHITECTURE.md 4 stage 8, 5.6, 6.19, 7.2 step 5), driven by the orchestrator:
//   node obs.mjs merge         builds out/merge-input.md, then prints "merge: fresh" or the merger prompt
//   node obs.mjs merge accept  checks out/merge-proposed.json and writes out/merge.json
// The same loop as the taxonomy stage: a proposal never counts anything until code has checked it;
// a failed check is recorded in out/ledger/merge.json and the next `merge` prints a fix prompt with
// the problems; after MERGE_MAX_DISPATCHES prompts for the same inputs (the done extractions, the
// taxonomy and the merger definition) the stage stops and says why. An input too large for one
// merger stops it at once. A promotion too small to be recurring work is demoted by code when the
// table is written: that changes the table, never the attempt count.
//
// Freshness (also what `status` and the Stop hook see): out/merge.json records the hashes of the
// done batches' validated extractions, out/taxonomy.json and .claude/agents/merger.md as they are now.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, loadScoring } from '../config.ts';
import { MERGE_PROPOSAL_MAX_BYTES, MergeInputError, buildMergeInput, canonicalMergeTable, checkMergeProposal, duplicateKeyProblems, slugFacts, type SlugFacts } from '../model/merge.ts';
import type { Taxonomy } from '../model/taxonomy.ts';
import { sha256 } from '../util/hash.ts';
import { normalizeNewlines } from '../util/text.ts';
import {
  LedgerError,
  batchViews,
  fileSha,
  logStage,
  mergeFile,
  mergeInputFile,
  mergeProposedFile,
  mergeStateFile,
  mergerFile,
  nowUtc,
  prepareStatsFile,
  projectFolder,
  readText,
  removeFile,
  taxonomyFile,
  validatedFile,
  withoutRoot,
  writeFileAtomic,
  writeJsonAtomic,
  type BatchView,
  type StageStep,
} from './ledger.ts';
import type { MergeTable, ParsedMessage, Thread, ValidatedExtraction } from '../types.ts';

export const MERGE_MAX_DISPATCHES = 4;
export const MERGE_MAX_PROBLEMS = 20; // kept in the state file and shown in a fix prompt

export type MergeFreshness = 'fresh' | 'stale' | 'missing' | 'stopped';

export class MergeError extends Error {
  override name = 'MergeError';
}
// The merge input could not be built (too large for one merger): the stage stops for these inputs.
class MergeStoppedError extends MergeError {
  override name = 'MergeStoppedError';
}

const BOM = String.fromCharCode(0xfeff);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- Freshness ----

// What the merge is built from: every done batch's validated extraction, in ID order, each hashed
// with newlines normalised. `views`: the batch views when the caller has them already.
export function extractionsSha(root: string, views: readonly BatchView[] = batchViews(root, 'batch')): string {
  const lines = views
    .filter((v) => v.status === 'done')
    .map((v) => `${v.entry.id}\n${sha256(normalizeNewlines(readText(validatedFile(root, v.entry.id)) ?? ''))}\n`);
  return sha256(lines.join(''));
}

export type MergeShas = { extractions_sha: string; taxonomy_sha: string; agent_sha: string };

// The three hashes a merge table built now would record.
export function currentMergeShas(root: string, extractions: string = extractionsSha(root)): MergeShas {
  return {
    extractions_sha: extractions,
    taxonomy_sha: fileSha(taxonomyFile(root)) ?? sha256('none'),
    agent_sha: fileSha(mergerFile(root)) ?? sha256('none'),
  };
}

const sameShas = (a: Record<string, unknown>, b: MergeShas): boolean =>
  a.extractions_sha === b.extractions_sha && a.taxonomy_sha === b.taxonomy_sha && a.agent_sha === b.agent_sha;

type PromoteMin = MergeTable['promote_min'];
// config/scoring.json merge.promote_min now, or null when the file cannot be loaded.
function currentPromoteMin(root: string): PromoteMin | null {
  try {
    return promoteMin(root);
  } catch {
    return null;
  }
}
const samePromoteMin = (a: unknown, b: PromoteMin | null): boolean =>
  b !== null && isRecord(a) && a.messages === b.messages && a.occurrences === b.occurrences && a.threads === b.threads && a.active_months === b.active_months;

// What a fresh out/merge.json records: the three hashes and the promotion minimum it was sized with.
export function currentMergeStamp(root: string, extractions?: string): MergeShas & { promote_min: PromoteMin | null } {
  return { ...currentMergeShas(root, extractions), promote_min: currentPromoteMin(root) };
}

// fresh: out/merge.json records the hashes of the done extractions, the taxonomy and the merger
// definition as they are now, and the promotion minimum in config/scoring.json (the demotions
// depend on it). stopped: not fresh, and for these inputs the attempts are used up or the input
// could not be built. Otherwise stale, or missing when there is no table.
export function mergeFreshness(root: string, extractions?: string): MergeFreshness {
  try {
    const shas = currentMergeShas(root, extractions ?? extractionsSha(root));
    const text = readText(mergeFile(root));
    if (text !== null) {
      const table: unknown = JSON.parse(text);
      if (isRecord(table) && sameShas(table, shas) && samePromoteMin(table.promote_min, currentPromoteMin(root))) return 'fresh';
    }
    const state = readState(root);
    if (state !== null && sameShas(state, shas) && (state.status === 'stopped' || (state.status === 'failed' && state.dispatches >= MERGE_MAX_DISPATCHES))) {
      return 'stopped';
    }
    return text === null ? 'missing' : 'stale';
  } catch {
    return 'stale';
  }
}

// ---- State: out/ledger/merge.json, the attempts made for one set of inputs ----

export type MergeState = MergeShas & {
  status: 'dispatched' | 'failed' | 'accepted' | 'stopped';
  dispatches: number; // prompts printed for these inputs since the last accepted table
  problems: number; // found by the last check
  last_problems: string[]; // the first MERGE_MAX_PROBLEMS of them
  reason: string | null; // why the stage stopped without an attempt (the input was too large)
  dispatched_utc: string | null;
  finished_utc: string | null;
};

const STATUSES = ['dispatched', 'failed', 'accepted', 'stopped'] as const;

function readState(root: string): MergeState | null {
  try {
    const text = readText(mergeStateFile(root));
    if (text === null) return null;
    const v: unknown = JSON.parse(text);
    if (!isRecord(v) || !(STATUSES as readonly unknown[]).includes(v.status)) return null;
    const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
    const count = (x: unknown): number => (Number.isInteger(x) && (x as number) >= 0 ? (x as number) : 0);
    if (str(v.extractions_sha) === null || str(v.taxonomy_sha) === null || str(v.agent_sha) === null) return null;
    return {
      extractions_sha: v.extractions_sha as string,
      taxonomy_sha: v.taxonomy_sha as string,
      agent_sha: v.agent_sha as string,
      status: v.status as MergeState['status'],
      dispatches: count(v.dispatches),
      problems: count(v.problems),
      last_problems: Array.isArray(v.last_problems) ? v.last_problems.filter((p): p is string => typeof p === 'string') : [],
      reason: str(v.reason),
      dispatched_utc: str(v.dispatched_utc),
      finished_utc: str(v.finished_utc),
    };
  } catch {
    return null; // unreadable: start over
  }
}

// The recorded state if it belongs to these inputs and to the current round of attempts, else a
// new one with no attempts.
function currentState(root: string, shas: MergeShas): MergeState {
  const s = readState(root);
  if (s !== null && sameShas(s, shas) && s.status !== 'accepted') return s;
  return { ...shas, status: 'dispatched', dispatches: 0, problems: 0, last_problems: [], reason: null, dispatched_utc: null, finished_utc: null };
}

const writeState = (root: string, state: MergeState): void => writeJsonAtomic(mergeStateFile(root), state);

// ---- Prompt ----

// A file under the project folder as the merger's fix prompt names it: repo-relative, "/" separators.
const relative = (root: string, file: string): string => withoutRoot(file, root).replaceAll('\\', '/');

// The prompt for one merger run (ARCHITECTURE.md 15.5): the task and the project folder; the agent
// definition names the files under it. On a fix round the problems the last check found follow
// (`total` of them, the first ones listed: they are the pipeline's text, model text in them escaped
// and cut, and no email content), then which files to read, by their paths under the folder.
export function mergerPrompt(root: string, fix: string[] | null, total: number = fix?.length ?? 0): string {
  const folder = `Project folder: ${projectFolder(root)}`;
  if (fix === null) return ['Merge the proposed process keys into the taxonomy.', folder].join('\n');
  const shown = fix.slice(0, MERGE_MAX_PROBLEMS);
  return [
    'Fix the process-key merge proposal.',
    folder,
    `The pipeline checked the previous proposal and found ${plural(total, 'problem')}${total > shown.length ? `; the first ${shown.length} are listed` : ''}:`,
    ...shown.map((p) => `- ${p}`),
    `Read the merge input ${relative(root, mergeInputFile(root))}, the taxonomy ${relative(root, taxonomyFile(root))} and the previous proposal ${relative(root, mergeProposedFile(root))}, ` +
      'fix only these problems, keep every other entry exactly as it was, and Write the whole file again.',
  ].join('\n');
}

// ---- Inputs ----

function readJsonFile(root: string, file: string, missing: string): unknown {
  const text = readText(file);
  const rel = withoutRoot(file, root).replaceAll('\\', '/');
  if (text === null) throw new MergeError(`${rel} is missing: ${missing}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new MergeError(`${rel} is not valid JSON: ${missing}`);
  }
}

export type MergeInputs = {
  views: BatchView[];
  validated: ValidatedExtraction[];
  threads: Thread[];
  messages: Map<string, ParsedMessage>;
  taxonomy: Taxonomy;
  flagged: Set<string>; // suspected injections, from out/prepare-stats.json
  facts: SlugFacts[];
};

// Everything the merge reads, once extraction is complete (exhausted batches are reported, not
// waited for): a merge over part of the batches would only be redone.
export function loadMergeInputs(root: string): MergeInputs {
  const views = batchViews(root, 'batch');
  const open = views.filter((v) => v.status === 'pending' || v.status === 'running' || v.status === 'failed');
  if (open.length > 0) {
    throw new MergeError(`extraction is not complete (${plural(open.length, 'batch is', 'batches are')} pending, running or retryable): finish the extraction first`);
  }
  const validated = views
    .filter((v) => v.status === 'done')
    .map((v) => readJsonFile(root, validatedFile(root, v.entry.id), 'the ledger says this batch is done; run node obs.mjs verify') as ValidatedExtraction);
  const threads = readJsonFile(root, join(root, 'out', 'threads.json'), 'run node obs.mjs prepare first.') as Thread[];
  const text = readText(join(root, 'out', 'messages.jsonl'));
  if (text === null) throw new MergeError('out/messages.jsonl is missing: run node obs.mjs prepare first.');
  const messages = new Map<string, ParsedMessage>();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const m = JSON.parse(line) as ParsedMessage;
    messages.set(m.id, m);
  }
  const taxonomy = readJsonFile(root, taxonomyFile(root), 'run the taxonomy stage first.') as Taxonomy;
  if (!isRecord(taxonomy) || !Array.isArray(taxonomy.processes)) throw new MergeError('out/taxonomy.json has no process list: run the taxonomy stage again.');
  const stats = readJsonFile(root, prepareStatsFile(root), 'run node obs.mjs prepare first.');
  const flagged = new Set(isRecord(stats) && Array.isArray(stats.suspected_injection) ? (stats.suspected_injection as unknown[]).filter((x): x is string => typeof x === 'string') : []);
  return { views, validated, threads, messages, taxonomy, flagged, facts: slugFacts(validated, threads, messages) };
}

const promoteMin = (root: string) => loadScoring(join(root, 'config', 'scoring.json')).merge.promote_min;

// ---- Check and record ----

// Check the proposal text and record the outcome: on success write out/merge.json (promotions
// sized by code), remove the proposal and mark the state accepted; otherwise mark it failed with
// the problems, for the next fix prompt.
// The proposal as written, or null when there is none. A file over MERGE_PROPOSAL_MAX_BYTES is not
// read at all (text null): its size is the problem.
type Proposal = { text: string | null; bytes: number };
function readProposal(root: string): Proposal | null {
  let bytes: number;
  try {
    bytes = statSync(mergeProposedFile(root)).size;
  } catch {
    return null;
  }
  if (bytes > MERGE_PROPOSAL_MAX_BYTES) return { text: null, bytes };
  const text = readText(mergeProposedFile(root));
  return text === null ? null : { text, bytes: Buffer.byteLength(text, 'utf8') };
}

function checkAndRecord(root: string, inputs: MergeInputs, shas: MergeShas, proposal: Proposal): { table: MergeTable | null; problems: string[]; state: MergeState } {
  let problems: string[] = [];
  let table: MergeTable | null = null;
  const { text, bytes } = proposal;
  if (text === null || bytes > MERGE_PROPOSAL_MAX_BYTES) {
    problems = [`the proposal is ${bytes} bytes, over the cap of ${MERGE_PROPOSAL_MAX_BYTES}: write it in the compact layout, without indentation, and shorten the definitions (the input is not repeated in it)`];
  } else {
    const json = text.startsWith(BOM) ? text.slice(1) : text;
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch (err) {
      problems = [`the proposal is not valid JSON (${(err as Error).message.replace(/\s+/g, ' ').slice(0, 200)}). Write the whole file again as strict JSON.`];
    }
    if (problems.length === 0) {
      // A repeated key first: JSON.parse dropped all but its last copy, which may be why keys are missing.
      const repeated = duplicateKeyProblems(json);
      const check = checkMergeProposal(value, new Set(inputs.facts.map((f) => f.slug)), new Set(inputs.taxonomy.processes.map((p) => p.key)));
      problems = [...repeated, ...check.problems].map((p) => withoutRoot(p, root));
      if (repeated.length === 0 && check.proposal !== null) table = canonicalMergeTable(check.proposal, inputs.facts, promoteMin(root), inputs.flagged, shas);
    }
  }
  const before = currentState(root, shas);
  if (table === null) {
    const state: MergeState = { ...before, status: 'failed', problems: problems.length, last_problems: problems.slice(0, MERGE_MAX_PROBLEMS), finished_utc: nowUtc() };
    writeState(root, state);
    return { table: null, problems, state };
  }
  writeJsonAtomic(mergeFile(root), table);
  removeFile(mergeProposedFile(root));
  const state: MergeState = { ...before, status: 'accepted', problems: 0, last_problems: [], reason: null, finished_utc: nowUtc() };
  writeState(root, state);
  return { table, problems: [], state };
}

function summary(table: MergeTable): string {
  const c = table.counts;
  return (
    `${plural(c.slugs, 'proposed key')}: ${c.mapped} mapped, ${c.aliases} in ${plural(c.promoted, 'promoted process', 'promoted processes')}, ` +
    `${c.unassigned} unassigned, ${c.demoted} demoted; ${plural(c.messages_unassigned, 'message')} left unassigned`
  );
}

// Build the input, and check what the agent definition must exist for.
function prepareInput(root: string): { inputs: MergeInputs; shas: MergeShas } {
  const inputs = loadMergeInputs(root);
  const shas = currentMergeShas(root, extractionsSha(root, inputs.views));
  let text: string;
  try {
    text = buildMergeInput(inputs.facts, inputs.taxonomy);
  } catch (err) {
    if (!(err instanceof MergeInputError)) throw err;
    const state = currentState(root, shas);
    writeState(root, { ...state, status: 'stopped', reason: err.message, finished_utc: nowUtc() });
    throw new MergeStoppedError(`stopped: ${err.message}.`);
  }
  writeFileAtomic(mergeInputFile(root), text);
  if (readText(mergerFile(root)) === null) throw new MergeError('.claude/agents/merger.md is missing: the merger definition is part of the repo; restore it.');
  return { inputs, shas };
}

// A MergeError as the merge command prints it: one line, the project folder cut out.
const oneLine = (root: string, message: string): string => withoutRoot(message, root).replace(/\s*\n\s*/g, ' ');

// The merge stage's next step, as `merge` and `advance` take it (ARCHITECTURE.md 15.2): the input
// built, then fresh (already, or with no proposed keys an empty table, or a proposal left waiting by
// the last merger checked and accepted now); else the prompt for one more attempt (counted, and the
// state recorded as dispatched); else stopped, its attempts for these inputs used up or its input
// too large for one merger. Setup failures throw MergeError (or LedgerError, ConfigError).
export function mergeStep(root: string): StageStep {
  let prepared: { inputs: MergeInputs; shas: MergeShas };
  try {
    prepared = prepareInput(root);
  } catch (err) {
    if (!(err instanceof MergeStoppedError)) throw err;
    const line = `merge: ${oneLine(root, err.message)}`;
    return { kind: 'stopped', reason: line, details: [line], notes: [] };
  }
  const { inputs, shas } = prepared;
  if (mergeFreshness(root, shas.extractions_sha) === 'fresh') return { kind: 'fresh', notes: [] };
  // Nothing proposed: the table is empty and no merger is needed.
  if (inputs.facts.length === 0) {
    const started = performance.now();
    const table = canonicalMergeTable({ mapped: {}, unassigned: [], promoted: [] }, [], promoteMin(root), inputs.flagged, shas);
    writeJsonAtomic(mergeFile(root), table);
    writeState(root, { ...currentState(root, shas), status: 'accepted', problems: 0, last_problems: [], reason: null, finished_utc: nowUtc() });
    const note = 'merge: the extractors proposed no new keys; wrote an empty out/merge.json.';
    logStage(root, 'merge accept', started, note);
    return { kind: 'fresh', notes: [note] };
  }
  let state = currentState(root, shas);
  const notes: string[] = [];
  // Stopped only because the input could not be built; it just was, so the attempts start afresh.
  if (state.status === 'stopped') state = { ...state, status: 'dispatched', dispatches: 0, reason: null };
  // A proposal from the last prompt may be waiting unchecked (the merger finished but `accept`
  // never ran: the orchestrator's next call is `advance`, which takes it here): check it rather
  // than throw a finished run away.
  const waitingText = state.status === 'dispatched' && state.dispatches > 0 ? readProposal(root) : null;
  if (waitingText !== null) {
    const started = performance.now();
    const waiting = checkAndRecord(root, inputs, shas, waitingText);
    if (waiting.table !== null) {
      const note = `merge: accepted the proposal the last merger run left: ${summary(waiting.table)}; wrote out/merge.json.`;
      logStage(root, 'merge accept', started, note, waiting.state.dispatches);
      return { kind: 'fresh', notes: [note] };
    }
    const note = `merge: the proposal the last merger run left was not accepted: ${plural(waiting.problems.length, 'problem')}.`;
    logStage(root, 'merge accept', started, note, waiting.state.dispatches);
    notes.push(note);
    state = waiting.state;
  }
  if (state.dispatches >= MERGE_MAX_DISPATCHES) {
    const failed = `${state.dispatches} proposals for these extractions, taxonomy and merger definition failed the check; the last had ${plural(state.problems, 'problem')}`;
    const remedy = 'change the merger definition (.claude/agents/merger.md), then run the stage again; never edit the merge table by hand.';
    const details = [
      `merge: stopped: ${failed}:`,
      ...state.last_problems.map((p) => `  - ${p}`),
      ...(state.problems > state.last_problems.length ? [`  (${state.problems - state.last_problems.length} more)`] : []),
      `merge: ${remedy}`,
    ];
    return { kind: 'stopped', reason: `merge: stopped: ${failed} (node obs.mjs merge lists them); ${remedy}`, details, notes };
  }
  // A fix round needs something to fix: a recorded failure and a previous proposal that is at least
  // a JSON object. Otherwise the prompt is the fresh one and a stale proposal is removed, so that
  // `accept` only ever sees what this run's merger writes.
  const started = performance.now();
  let fix: string[] | null = null;
  if (state.status === 'failed' && state.last_problems.length > 0) {
    try {
      const prev = readProposal(root);
      if (prev !== null && prev.text !== null && isRecord(JSON.parse(prev.text))) fix = state.last_problems;
    } catch {
      // not JSON: nothing to fix
    }
  }
  if (fix === null) removeFile(mergeProposedFile(root));
  const attempt = state.dispatches + 1;
  writeState(root, { ...state, status: 'dispatched', dispatches: attempt, dispatched_utc: nowUtc() });
  const prompt = mergerPrompt(root, fix, state.problems);
  logStage(root, 'merge prompt', started, `attempt ${attempt} of ${MERGE_MAX_DISPATCHES}${fix === null ? '' : `, a fix round for ${plural(state.problems, 'problem')}`}`, attempt);
  return { kind: 'prompt', prompt, attempt, notes };
}

// The attempts made for the current extractions, taxonomy and merger definition (0 with no such
// state, after an accepted table, or when an input cannot be read): what the Stop hook uses to tell
// one merge round from the next. A state left by other inputs counts as none, so its count can
// never equal the first attempt under the new ones.
export function mergeAttempts(root: string): number {
  try {
    return currentState(root, currentMergeShas(root)).dispatches;
  } catch {
    return 0;
  }
}

function nextCommand(root: string): number {
  const step = mergeStep(root);
  // Notes go to stderr; stdout stays the answer alone, so the prompt can be passed on unchanged.
  for (const note of step.notes) console.error(note);
  if (step.kind === 'stopped') {
    for (const line of step.details) console.error(line);
    return 1;
  }
  console.log(step.kind === 'fresh' ? 'merge: fresh' : step.prompt);
  return 0;
}

// Exit 0 whenever a result was recorded: accepted, or problems recorded for the fix round (the
// orchestrator's next step is `merge` either way). Exit 1 only when there was nothing to record.
function acceptCommand(root: string): number {
  const text = readProposal(root);
  if (text === null) {
    if (mergeFreshness(root) === 'fresh') {
      console.log('merge: fresh; no proposal to accept.');
      return 0;
    }
    console.error('merge: no proposal to check: out/merge-proposed.json was not written. Run node obs.mjs merge for a new prompt.');
    return 1;
  }
  const { inputs, shas } = prepareInput(root);
  const started = performance.now();
  const { table, problems, state } = checkAndRecord(root, inputs, shas, text);
  logStage(root, 'merge accept', started, table === null ? `not accepted: ${plural(problems.length, 'problem')}` : `accepted: ${summary(table)}`, state.dispatches);
  if (table === null) {
    console.log(`merge: the proposal was not accepted: ${plural(problems.length, 'problem')}.`);
    for (const p of problems.slice(0, MERGE_MAX_PROBLEMS)) console.log(`  - ${p}`);
    if (problems.length > MERGE_MAX_PROBLEMS) console.log(`  (${problems.length - MERGE_MAX_PROBLEMS} more)`);
    console.log(
      state.dispatches >= MERGE_MAX_DISPATCHES
        ? `merge: that was attempt ${state.dispatches} of ${MERGE_MAX_DISPATCHES}; node obs.mjs merge will say why the stage stopped.`
        : 'merge: problems recorded; run node obs.mjs merge for the fix prompt.',
    );
    return 0;
  }
  const attempt = state.dispatches > 0 ? ` on attempt ${state.dispatches}` : '';
  console.log(`merge: accepted${attempt}: ${summary(table)}; wrote out/merge.json.`);
  return 0;
}

export function mergeCommand(root: string, args: string[]): number {
  try {
    if (args.length === 0) return nextCommand(root);
    if (args.length === 1 && args[0] === 'accept') return acceptCommand(root);
    throw new MergeError(`unexpected argument "${args.join(' ')}". Usage: node obs.mjs merge [accept]`);
  } catch (err) {
    if (err instanceof MergeError || err instanceof LedgerError || err instanceof ConfigError) {
      console.error(`merge: ${oneLine(root, err.message)}`);
      return 1;
    }
    throw err;
  }
}
