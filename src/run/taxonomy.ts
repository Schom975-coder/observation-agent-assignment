// The taxonomy stage (ARCHITECTURE.md 4 stage 5, 5.5, 7.2 step 2), driven by the orchestrator:
//   node obs.mjs taxonomy         prints "taxonomy: fresh", or the prompt for one taxonomist run
//   node obs.mjs taxonomy accept  checks out/taxonomy-proposed.json and writes out/taxonomy.json
// A proposal never becomes part of the extractors' cache keys until code has checked it. A failed
// check is recorded in out/ledger/taxonomy.json; the next `taxonomy` prints a fix prompt with the
// problems, and after TAXONOMY_MAX_DISPATCHES prompts for the same digest and taxonomist definition
// the stage stops and says why. The attempt count starts again when either of those changes (the
// remedy for a bad taxonomy is to change one of them, never to edit the file) or after an accepted
// taxonomy is cleared (run start --force removes the state file too). During a run, `advance` takes
// the same step through taxonomyStep: it accepts the proposal the last taxonomist left, or hands out
// the next prompt.
//
// Freshness is the ledger's taxonomyFreshness, the same answer `status` and the Stop hook get:
// taxonomy.json's digest_sha and agent_sha equal the hashes, newlines normalised, of
// out/taxonomy-digest.md and .claude/agents/taxonomist.md as they are now.
import { join } from 'node:path';
import { checkTaxonomyProposal, canonicalTaxonomy, subjectStats, type SubjectStats, type Taxonomy, type TaxonomyProcess } from '../model/taxonomy.ts';
import { sha256 } from '../util/hash.ts';
import { normalizeNewlines } from '../util/text.ts';
import {
  digestFile,
  logStage,
  nowUtc,
  projectFolder,
  readText,
  removeFile,
  taxonomistFile,
  taxonomyFile,
  taxonomyFreshness,
  taxonomyProposedFile,
  taxonomyStateFile,
  withoutRoot,
  writeJsonAtomic,
  type StageStep,
} from './ledger.ts';
import type { Thread } from '../types.ts';

export type { StageStep };

export const TAXONOMY_MAX_DISPATCHES = 4;
export const TAXONOMY_MAX_PROBLEMS = 20; // kept in the state file and shown in a fix prompt

const threadsFile = (root: string): string => join(root, 'out', 'threads.json');
const prepareStatsFile = (root: string): string => join(root, 'out', 'prepare-stats.json');

export class TaxonomyError extends Error {
  override name = 'TaxonomyError';
}

// out/ledger/taxonomy.json: the attempts made for one digest and taxonomist definition.
export type TaxonomyState = {
  digest_sha: string;
  agent_sha: string;
  status: 'dispatched' | 'failed' | 'accepted';
  dispatches: number; // prompts printed for this digest and definition since the last accepted taxonomy
  problems: number; // found by the last check
  last_problems: string[]; // the first TAXONOMY_MAX_PROBLEMS of them
  dispatched_utc: string | null; // the last prompt
  finished_utc: string | null; // the last accept
};

const textSha = (text: string): string => sha256(normalizeNewlines(text));

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    // One line, bounded: the parser's message can quote the file.
    return { ok: false, error: (err as Error).message.replace(/\s+/g, ' ').slice(0, 200) };
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// The hashes a taxonomy built now would record. Both files must exist.
export function currentShas(root: string): { digest_sha: string; agent_sha: string } {
  const digest = readText(digestFile(root));
  if (digest === null) throw new TaxonomyError('out/taxonomy-digest.md is missing: run node obs.mjs prepare first.');
  const agent = readText(taxonomistFile(root));
  if (agent === null) throw new TaxonomyError('.claude/agents/taxonomist.md is missing: the taxonomist definition is part of the repo; restore it.');
  return { digest_sha: textSha(digest), agent_sha: textSha(agent) };
}

function readState(root: string): TaxonomyState | null {
  const text = readText(taxonomyStateFile(root));
  if (text === null) return null;
  const parsed = parseJson(text);
  if (!parsed.ok || !isObject(parsed.value)) return null; // unreadable: start over
  const v = parsed.value;
  const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
  const status = v.status === 'dispatched' || v.status === 'failed' || v.status === 'accepted' ? v.status : null;
  if (str(v.digest_sha) === null || str(v.agent_sha) === null || status === null) return null;
  const count = (x: unknown): number => (Number.isInteger(x) && (x as number) >= 0 ? (x as number) : 0);
  return {
    digest_sha: v.digest_sha as string,
    agent_sha: v.agent_sha as string,
    status,
    dispatches: count(v.dispatches),
    problems: count(v.problems),
    last_problems: Array.isArray(v.last_problems) ? v.last_problems.filter((p): p is string => typeof p === 'string') : [],
    dispatched_utc: str(v.dispatched_utc),
    finished_utc: str(v.finished_utc),
  };
}

// The recorded state if it belongs to this digest and definition and to the current round of
// attempts, else a new one with no attempts.
function currentState(root: string, shas: { digest_sha: string; agent_sha: string }): TaxonomyState {
  const s = readState(root);
  if (s !== null && s.digest_sha === shas.digest_sha && s.agent_sha === shas.agent_sha && s.status !== 'accepted') return s;
  return { ...shas, status: 'dispatched', dispatches: 0, problems: 0, last_problems: [], dispatched_utc: null, finished_utc: null };
}

// The prompt for one taxonomist run (ARCHITECTURE.md 15.5): the task and the project folder; the
// agent definition names the files under it. On a fix round the problems the last check found
// follow (`total` of them, the first ones listed): one call and no fix file, so they go inline.
export function taxonomistPrompt(root: string, fix: string[] | null, total: number = fix?.length ?? 0): string {
  const folder = `Project folder: ${projectFolder(root)}`;
  if (fix === null) return ['Propose the process taxonomy.', folder].join('\n');
  const shown = fix.slice(0, TAXONOMY_MAX_PROBLEMS);
  return [
    'Fix the process taxonomy proposal.',
    folder,
    `The pipeline checked the previous proposal and found ${total} problem${total === 1 ? '' : 's'}${total > shown.length ? `; the first ${shown.length} are listed` : ''}:`,
    ...shown.map((p) => `- ${p}`),
    'Read the digest and the previous proposal, fix only these problems, keep every other entry exactly as it was, and Write the whole file again.',
  ].join('\n');
}

// What threads.json says about each subject, with the messages prepare flagged left out: the
// recurrence and flagged-subject checks need both.
function loadSubjects(root: string): Map<string, SubjectStats> {
  const text = readText(threadsFile(root));
  if (text === null) throw new TaxonomyError('out/threads.json is missing: run node obs.mjs prepare first.');
  const parsed = parseJson(text);
  if (!parsed.ok || !Array.isArray(parsed.value)) throw new TaxonomyError('out/threads.json is not a list of threads: run node obs.mjs prepare again.');
  const threads = (parsed.value as unknown[]).filter(
    (t): t is Thread => isObject(t) && typeof t.subject_norm === 'string' && Array.isArray(t.message_ids) && Array.isArray(t.occurrences),
  );
  const statsText = readText(prepareStatsFile(root));
  const stats = statsText === null ? null : parseJson(statsText);
  if (stats === null || !stats.ok || !isObject(stats.value)) throw new TaxonomyError('out/prepare-stats.json is missing or unreadable: run node obs.mjs prepare first.');
  const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const flagged = new Set([...ids(stats.value.suspected_injection), ...ids(stats.value.oversize)]);
  return subjectStats(threads, flagged);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Check the proposal text and record the outcome: on success write out/taxonomy.json, remove the
// proposal and mark the state accepted; otherwise mark it failed with the problems, for the next
// fix prompt.
function checkAndRecord(root: string, shas: { digest_sha: string; agent_sha: string }, text: string): { taxonomy: Taxonomy | null; problems: string[]; state: TaxonomyState } {
  const subjects = loadSubjects(root);
  let problems: string[];
  let accepted: TaxonomyProcess[] | null = null;
  const parsed = parseJson(text);
  if (!parsed.ok) {
    problems = [`the proposal is not valid JSON (${parsed.error}). Write the whole file again as strict JSON.`];
  } else {
    const check = checkTaxonomyProposal(parsed.value, subjects);
    problems = check.problems.map((p) => withoutRoot(p, root));
    accepted = check.processes;
  }
  const before = currentState(root, shas);
  if (accepted === null) {
    const state: TaxonomyState = { ...before, status: 'failed', problems: problems.length, last_problems: problems.slice(0, TAXONOMY_MAX_PROBLEMS), finished_utc: nowUtc() };
    writeJsonAtomic(taxonomyStateFile(root), state);
    return { taxonomy: null, problems, state };
  }
  const taxonomy = canonicalTaxonomy(accepted, shas.digest_sha, shas.agent_sha);
  writeJsonAtomic(taxonomyFile(root), taxonomy);
  removeFile(taxonomyProposedFile(root));
  const state: TaxonomyState = { ...before, status: 'accepted', problems: 0, last_problems: [], finished_utc: nowUtc() };
  writeJsonAtomic(taxonomyStateFile(root), state);
  return { taxonomy, problems: [], state };
}

// The taxonomy stage's next step, as `taxonomy` and `advance` take it (ARCHITECTURE.md 15.2):
// fresh, or a proposal left waiting by the last taxonomist checked and accepted now; else the
// prompt for one more attempt (counted, and the state recorded as dispatched); else stopped, its
// attempts for this digest and taxonomist definition used up. Setup failures throw TaxonomyError.
export function taxonomyStep(root: string): StageStep {
  const shas = currentShas(root);
  if (taxonomyFreshness(root) === 'fresh') return { kind: 'fresh', notes: [] };
  let state = currentState(root, shas);
  const notes: string[] = [];
  // A proposal from the last prompt may be waiting unchecked: its taxonomist finished but `accept`
  // never ran (the orchestrator's next call is `advance`, which takes it here; or the session
  // ended). Check it rather than throw a finished run away.
  const waitingText = state.status === 'dispatched' && state.dispatches > 0 ? readText(taxonomyProposedFile(root)) : null;
  if (waitingText !== null) {
    const started = performance.now();
    const waiting = checkAndRecord(root, shas, waitingText);
    if (waiting.taxonomy !== null) {
      const note = `taxonomy: accepted the proposal the last taxonomist run left: ${plural(waiting.taxonomy.processes.length, 'process', 'processes')}; wrote out/taxonomy.json.`;
      logStage(root, 'taxonomy accept', started, note, waiting.state.dispatches);
      return { kind: 'fresh', notes: [note] };
    }
    const note = `taxonomy: the proposal the last taxonomist run left was not accepted: ${plural(waiting.problems.length, 'problem')}.`;
    logStage(root, 'taxonomy accept', started, note, waiting.state.dispatches);
    notes.push(note);
    state = waiting.state;
  }
  if (state.dispatches >= TAXONOMY_MAX_DISPATCHES) {
    const failed = `${state.dispatches} proposals for this digest and taxonomist definition failed the check; the last had ${plural(state.problems, 'problem')}`;
    const remedy = 'change the taxonomist definition (.claude/agents/taxonomist.md) or the digest builder, then run the stage again; never edit the taxonomy by hand.';
    const details = [
      `taxonomy: stopped: ${failed}:`,
      ...state.last_problems.map((p) => `  - ${p}`),
      ...(state.problems > state.last_problems.length ? [`  (${state.problems - state.last_problems.length} more)`] : []),
      `taxonomy: ${remedy}`,
    ];
    return { kind: 'stopped', reason: `taxonomy: stopped: ${failed} (node obs.mjs taxonomy lists them); ${remedy}`, details, notes };
  }
  // A fix round needs something to fix: a recorded failure and a previous proposal that is at least
  // a JSON object. Otherwise the prompt is the fresh one, and a stale proposal is removed so that
  // `accept` can only ever see what this run's taxonomist writes.
  const started = performance.now();
  let fix: string[] | null = null;
  if (state.status === 'failed' && state.last_problems.length > 0) {
    const text = readText(taxonomyProposedFile(root));
    const parsed = text === null ? null : parseJson(text);
    if (parsed?.ok && isObject(parsed.value)) fix = state.last_problems;
  }
  if (fix === null) removeFile(taxonomyProposedFile(root));
  const attempt = state.dispatches + 1;
  writeJsonAtomic(taxonomyStateFile(root), { ...state, status: 'dispatched', dispatches: attempt, dispatched_utc: nowUtc() } satisfies TaxonomyState);
  const prompt = taxonomistPrompt(root, fix, state.problems);
  logStage(root, 'taxonomy prompt', started, `attempt ${attempt} of ${TAXONOMY_MAX_DISPATCHES}${fix === null ? '' : `, a fix round for ${plural(state.problems, 'problem')}`}`, attempt);
  return { kind: 'prompt', prompt, attempt, notes };
}

// The attempts made for the current digest and taxonomist definition (0 with no such state, after
// an accepted taxonomy, or when either file is missing): what the Stop hook uses to tell one
// taxonomy round from the next. A state left by other inputs counts as none, so its count can
// never equal the first attempt under the new ones.
export function taxonomyAttempts(root: string): number {
  try {
    return currentState(root, currentShas(root)).dispatches;
  } catch {
    return 0;
  }
}

function nextCommand(root: string): number {
  const step = taxonomyStep(root);
  // Notes go to stderr; stdout stays the answer alone, so the prompt can be passed on unchanged.
  for (const note of step.notes) console.error(note);
  if (step.kind === 'stopped') {
    for (const line of step.details) console.error(line);
    return 1;
  }
  console.log(step.kind === 'fresh' ? 'taxonomy: fresh' : step.prompt);
  return 0;
}

// Exit 0 whenever a result was recorded: accepted, or problems recorded for the fix round (the
// orchestrator's next step is `taxonomy` either way). Exit 1 only when there was nothing to record:
// no proposal on disk, or a setup failure.
function acceptCommand(root: string): number {
  const shas = currentShas(root);
  const text = readText(taxonomyProposedFile(root));
  if (text === null) {
    if (taxonomyFreshness(root) === 'fresh') {
      console.log('taxonomy: fresh; no proposal to accept.');
      return 0;
    }
    console.error('taxonomy: no proposal to check: out/taxonomy-proposed.json was not written. Run node obs.mjs taxonomy for a new prompt.');
    return 1;
  }
  const started = performance.now();
  const { taxonomy, problems, state } = checkAndRecord(root, shas, text);
  logStage(
    root,
    'taxonomy accept',
    started,
    taxonomy === null ? `not accepted: ${plural(problems.length, 'problem')}` : `accepted ${plural(taxonomy.processes.length, 'process', 'processes')}`,
    state.dispatches,
  );
  if (taxonomy === null) {
    console.log(`taxonomy: the proposal was not accepted: ${plural(problems.length, 'problem')}.`);
    for (const p of problems.slice(0, TAXONOMY_MAX_PROBLEMS)) console.log(`  - ${p}`);
    if (problems.length > TAXONOMY_MAX_PROBLEMS) console.log(`  (${problems.length - TAXONOMY_MAX_PROBLEMS} more)`);
    console.log(
      state.dispatches >= TAXONOMY_MAX_DISPATCHES
        ? `taxonomy: that was attempt ${state.dispatches} of ${TAXONOMY_MAX_DISPATCHES}; node obs.mjs taxonomy will say why the stage stopped.`
        : 'taxonomy: problems recorded; run node obs.mjs taxonomy for the fix prompt.',
    );
    return 0;
  }
  const attempt = state.dispatches > 0 ? ` on attempt ${state.dispatches}` : '';
  console.log(`taxonomy: accepted ${plural(taxonomy.processes.length, 'process', 'processes')}${attempt}; wrote out/taxonomy.json.`);
  return 0;
}

export function taxonomyCommand(root: string, args: string[]): number {
  try {
    if (args.length === 0) return nextCommand(root);
    if (args.length === 1 && args[0] === 'accept') return acceptCommand(root);
    throw new TaxonomyError(`unexpected argument "${args.join(' ')}". Usage: node obs.mjs taxonomy [accept]`);
  } catch (err) {
    if (err instanceof TaxonomyError) {
      console.error(`taxonomy: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
