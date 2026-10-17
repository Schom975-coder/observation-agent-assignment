// The taxonomy stage (ARCHITECTURE.md 4 stage 5, 5.5, 7.2 step 2), driven by the orchestrator:
//   node obs.mjs taxonomy         prints "taxonomy: fresh", or the prompt for one taxonomist run
//   node obs.mjs taxonomy accept  checks out/taxonomy-proposed.json and writes out/taxonomy.json
// A proposal never becomes part of the extractors' cache keys until code has checked it. A failed
// check is recorded in out/ledger/taxonomy.json; the next `taxonomy` prints a fix prompt with the
// problems, and after TAXONOMY_MAX_DISPATCHES prompts for the same digest and taxonomist definition
// the stage stops and says why. The attempt count starts again when either of those changes (the
// remedy for a bad taxonomy is to change one of them, never to edit the file) or after an accepted
// taxonomy is cleared (run start --force removes the state file too).
//
// Freshness is the ledger's taxonomyFreshness, the same answer `status` and the Stop hook get:
// taxonomy.json's digest_sha and agent_sha equal the hashes, newlines normalised, of
// out/taxonomy-digest.md and .claude/agents/taxonomist.md as they are now.
import { join, resolve } from 'node:path';
import { checkTaxonomyProposal, canonicalTaxonomy, subjectStats, type SubjectStats, type Taxonomy, type TaxonomyProcess } from '../model/taxonomy.ts';
import { sha256 } from '../util/hash.ts';
import { normalizeNewlines } from '../util/text.ts';
import {
  digestFile,
  nowUtc,
  readText,
  removeFile,
  taxonomistFile,
  taxonomyFile,
  taxonomyFreshness,
  taxonomyProposedFile,
  taxonomyStateFile,
  withoutRoot,
  writeJsonAtomic,
} from './ledger.ts';
import type { Thread } from '../types.ts';

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

// Absolute, forward slashes on every OS: the form the subagent's file tools take everywhere.
const absolute = (root: string, rel: string): string => resolve(root, rel).replaceAll('\\', '/');

// The prompt for one taxonomist run. The agent definition holds the instructions; this names the
// files and, on a fix round, the problems the last check found (`total` of them, the first ones listed).
export function taxonomistPrompt(root: string, fix: string[] | null, total: number = fix?.length ?? 0): string {
  const digest = `Digest file: ${absolute(root, 'out/taxonomy-digest.md')}`;
  const output = `Output file: ${absolute(root, 'out/taxonomy-proposed.json')}`;
  const reply = 'Reply with one short sentence and no email content.';
  if (fix === null) return ['Propose the process taxonomy.', digest, output, reply].join('\n');
  const shown = fix.slice(0, TAXONOMY_MAX_PROBLEMS);
  return [
    'Fix the process taxonomy proposal.',
    digest,
    `Previous proposal: ${absolute(root, 'out/taxonomy-proposed.json')}`,
    `The pipeline checked the previous proposal and found ${total} problem${total === 1 ? '' : 's'}${total > shown.length ? `; the first ${shown.length} are listed` : ''}:`,
    ...shown.map((p) => `- ${p}`),
    'Read the digest and the previous proposal, fix only these problems, keep every other entry exactly as it was, and Write the whole file to:',
    output,
    reply,
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

function nextCommand(root: string): number {
  const shas = currentShas(root);
  if (taxonomyFreshness(root) === 'fresh') {
    console.log('taxonomy: fresh');
    return 0;
  }
  let state = currentState(root, shas);
  // A proposal from the last prompt may be waiting unchecked: its taxonomist finished but `accept`
  // never ran (the session ended, or the Stop hook sent the orchestrator here first). Check it
  // rather than throw a finished run away. Notes go to stderr; stdout stays the answer alone.
  const waitingText = state.status === 'dispatched' && state.dispatches > 0 ? readText(taxonomyProposedFile(root)) : null;
  if (waitingText !== null) {
    const waiting = checkAndRecord(root, shas, waitingText);
    if (waiting.taxonomy !== null) {
      console.error(`taxonomy: accepted the proposal the last taxonomist run left: ${plural(waiting.taxonomy.processes.length, 'process', 'processes')}; wrote out/taxonomy.json.`);
      console.log('taxonomy: fresh');
      return 0;
    }
    console.error(`taxonomy: the proposal the last taxonomist run left was not accepted: ${plural(waiting.problems.length, 'problem')}.`);
    state = waiting.state;
  }
  if (state.dispatches >= TAXONOMY_MAX_DISPATCHES) {
    console.error(
      `taxonomy: stopped: ${state.dispatches} proposals for this digest and taxonomist definition failed the check; the last had ${plural(state.problems, 'problem')}:`,
    );
    for (const p of state.last_problems) console.error(`  - ${p}`);
    if (state.problems > state.last_problems.length) console.error(`  (${state.problems - state.last_problems.length} more)`);
    console.error('taxonomy: change the taxonomist definition (.claude/agents/taxonomist.md) or the digest builder, then run the stage again; never edit the taxonomy by hand.');
    return 1;
  }
  // A fix round needs something to fix: a recorded failure and a previous proposal that is at least
  // a JSON object. Otherwise the prompt is the fresh one, and a stale proposal is removed so that
  // `accept` can only ever see what this run's taxonomist writes.
  let fix: string[] | null = null;
  if (state.status === 'failed' && state.last_problems.length > 0) {
    const text = readText(taxonomyProposedFile(root));
    const parsed = text === null ? null : parseJson(text);
    if (parsed?.ok && isObject(parsed.value)) fix = state.last_problems;
  }
  if (fix === null) removeFile(taxonomyProposedFile(root));
  writeJsonAtomic(taxonomyStateFile(root), {
    ...state,
    status: 'dispatched',
    dispatches: state.dispatches + 1,
    dispatched_utc: nowUtc(),
  } satisfies TaxonomyState);
  // Only the prompt goes to stdout, so the orchestrator can pass it on unchanged.
  console.log(taxonomistPrompt(root, fix, state.problems));
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
  const { taxonomy, problems, state } = checkAndRecord(root, shas, text);
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
