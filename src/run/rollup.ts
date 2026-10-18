// The rollup stage (ARCHITECTURE.md 4 stage 9, 5.7, 5.8, 7.2 step 6): `node obs.mjs rollup` counts
// every merged process on the merged membership and writes, from the done extractions, the merge
// table, the prepared messages and threads and the published rates:
//   out/rollup.json             per process the counted record (src/metrics/rollup.ts)
//   out/coverage.json           how every message ended: classified, tagged, counted, unassigned
//   out/validation-report.json  quote statistics, every rejection with the model's text, the
//                               flagged messages and where their tags went, quarantined processes
//   out/synthesis/index.json and out/synthesis/input/synth-NNN.md + .json, the synthesis groups
// Deterministic and quick, so it always reruns; rollup.json records its input hashes so `status`
// can tell whether it is current. Byte-identical on unchanged inputs.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, loadEffortRates } from '../config.ts';
import { rollupWithNotes, type RollupNotes } from '../metrics/rollup.ts';
import { SynthesisInputError, buildSynthesisInputs } from '../model/synthesis-input.ts';
import { sha256 } from '../util/hash.ts';
import {
  LedgerError,
  coverageFile,
  fileSha,
  logStage,
  mergeFile,
  prepareStatsFile,
  readText,
  removeFile,
  rollupFile,
  synthesisDir,
  synthIndexFile,
  validationReportFile,
  withoutRoot,
  writeFileAtomic,
  writeJsonAtomic,
} from './ledger.ts';
import { MergeError, extractionsSha, loadMergeInputs, mergeFreshness, type MergeInputs } from './merge.ts';
import type { MergeTable, Person, Rollup, ValidatedExtraction } from '../types.ts';

export type RollupFreshness = 'current' | 'stale' | 'missing';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export const ratesFile = (root: string): string => join(root, 'config', 'effort-rates.json');
const inputDir = (root: string): string => join(synthesisDir(root), 'input');

export class RollupError extends Error {
  override name = 'RollupError';
}

// ---- Freshness ----

// The input hashes a rollup built now would record (Rollup['inputs']).
export function currentRollupInputs(root: string, extractions: string = extractionsSha(root)): Rollup['inputs'] {
  const statsText = readText(prepareStatsFile(root));
  let stats: unknown = null;
  try {
    stats = statsText === null ? null : JSON.parse(statsText);
  } catch {
    throw new RollupError('out/prepare-stats.json is not valid JSON: run node obs.mjs prepare again.');
  }
  return {
    extractions_sha: extractions,
    merge_sha: fileSha(mergeFile(root)) ?? sha256('none'),
    corpus_hash: isRecord(stats) && typeof stats.corpus_hash === 'string' ? stats.corpus_hash : 'none',
    rates_sha: fileSha(ratesFile(root)) ?? sha256('none'),
  };
}

// current: out/rollup.json records the inputs as they are now, and every synthesis group input it
// wrote is still there, unchanged (the Markdown is git-ignored, so a fresh clone rebuilds it).
export function rollupFreshness(root: string, extractions?: string): RollupFreshness {
  try {
    const text = readText(rollupFile(root));
    if (text === null) return 'missing';
    const rollup: unknown = JSON.parse(text);
    if (!isRecord(rollup) || !isRecord(rollup.inputs)) return 'stale';
    const now = currentRollupInputs(root, extractions ?? extractionsSha(root));
    for (const [k, v] of Object.entries(now)) if (rollup.inputs[k] !== v) return 'stale';
    const indexText = readText(synthIndexFile(root));
    if (indexText === null) return 'stale';
    const index: unknown = JSON.parse(indexText);
    if (!Array.isArray(index)) return 'stale';
    for (const g of index) {
      if (!isRecord(g) || typeof g.group_id !== 'string' || !/^synth-\d{3,6}$/.test(g.group_id)) return 'stale';
      const md = readText(join(inputDir(root), `${g.group_id}.md`));
      if (md === null || sha256(md) !== g.content_sha) return 'stale';
      if (readText(join(inputDir(root), `${g.group_id}.json`)) === null) return 'stale';
    }
    return 'current';
  } catch {
    return 'stale';
  }
}

// ---- The validation report ----

type Counts = { exact: number; repaired: number; rejected: number };
const zero = (): Counts => ({ exact: 0, repaired: 0, rejected: 0 });

export type ValidationReport = {
  version: 1;
  quotes: { evidence: Counts; stall: Counts; ownership: Counts; total: Counts };
  // Every rejected quote of a done batch, with the text the model wrote: none of them ships.
  rejections: Array<{ batch_id: string; kind: 'evidence' | 'stall' | 'ownership'; id: string | null; message_id: string; process: string | null; quote: string; reason: string | null }>;
  // The messages the scanner flagged as suspected injections, and where their tags went.
  flagged: Array<{ message_id: string; markers: string[]; role: string | null; tags: string[]; merged_keys: string[] }>;
  quarantined: RollupNotes['quarantined']; // processes backed only by flagged messages: never counted
  empty_processes: string[]; // processes no counted message belongs to
};

export function validationReport(validated: readonly ValidatedExtraction[], inputs: MergeInputs, rollup: Rollup, notes: RollupNotes): ValidationReport {
  const quotes = { evidence: zero(), stall: zero(), ownership: zero(), total: zero() };
  const rejections: ValidationReport['rejections'] = [];
  for (const v of validated) {
    const byId = new Map(v.messages.map((m) => [m.id, m]));
    for (const e of v.evidence) {
      quotes.evidence[e.match]++;
      if (e.match === 'rejected') rejections.push({ batch_id: v.batch_id, kind: 'evidence', id: e.evidence_id, message_id: e.message_id, process: e.process, quote: e.quote, reason: e.reason });
    }
    for (const c of v.stall_checks) {
      quotes.stall[c.match]++;
      if (c.match === 'rejected') rejections.push({ batch_id: v.batch_id, kind: 'stall', id: null, message_id: c.message_id, process: null, quote: byId.get(c.message_id)?.stall?.quote ?? '', reason: c.reason });
    }
    for (const c of v.ownership_checks) {
      quotes.ownership[c.match]++;
      if (c.match === 'rejected') rejections.push({ batch_id: v.batch_id, kind: 'ownership', id: null, message_id: c.message_id, process: null, quote: byId.get(c.message_id)?.ownership_claim?.quote ?? '', reason: c.reason });
    }
  }
  for (const k of ['exact', 'repaired', 'rejected'] as const) quotes.total[k] = quotes.evidence[k] + quotes.stall[k] + quotes.ownership[k];
  const entries = new Map(validated.flatMap((v) => v.messages.map((m) => [m.id, m] as const)));
  const counted = new Map<string, string[]>();
  for (const p of rollup.processes) for (const id of p.message_ids) counted.set(id, [...(counted.get(id) ?? []), p.key]);
  const flagged = [...inputs.messages.values()]
    .filter((m) => m.flags.suspected_injection)
    .map((m) => ({ message_id: m.id, markers: [...m.flags.injection_markers], role: entries.get(m.id)?.role ?? null, tags: [...(entries.get(m.id)?.processes ?? [])], merged_keys: counted.get(m.id) ?? [] }))
    .sort((a, b) => (a.message_id < b.message_id ? -1 : a.message_id > b.message_id ? 1 : 0));
  return { version: 1, quotes, rejections, flagged, quarantined: notes.quarantined, empty_processes: notes.empty };
}

// ---- The command ----

// The rollup stage's one step, as `rollup` and `advance` take it: count, write every output, and
// return the summary line. Throws RollupError (a synthesis input that cannot be built is one too),
// MergeError, LedgerError or ConfigError, each one line for the caller to print.
export function rollupStep(root: string): string {
  const started = performance.now();
  const merge = mergeFreshness(root);
  if (merge !== 'fresh') throw new RollupError(`out/merge.json is ${merge === 'missing' ? 'missing' : `not fresh (${merge})`}: run node obs.mjs merge first.`);
  const inputs = loadMergeInputs(root);
  const table = JSON.parse(readText(mergeFile(root)) as string) as MergeTable;
  const peopleText = readText(join(root, 'out', 'people.json'));
  if (peopleText === null) throw new RollupError('out/people.json is missing: run node obs.mjs prepare first.');
  const people = JSON.parse(peopleText) as Person[];
  const rates = loadEffortRates(ratesFile(root));
  const shas = currentRollupInputs(root, extractionsSha(root, inputs.views));
  const { rollup, notes } = rollupWithNotes({
    validated: inputs.validated,
    merge: table,
    threads: inputs.threads,
    messages: inputs.messages,
    people,
    rates,
    taxonomy: inputs.taxonomy,
    flagged: inputs.flagged,
    shas,
  });
  let groups: ReturnType<typeof buildSynthesisInputs>;
  try {
    groups = buildSynthesisInputs(rollup, inputs.validated, inputs.messages, people, inputs.threads);
  } catch (err) {
    if (err instanceof SynthesisInputError) throw new RollupError(err.message);
    throw err;
  }

  writeJsonAtomic(rollupFile(root), rollup);
  writeJsonAtomic(coverageFile(root), { version: 1, ...rollup.coverage });
  writeJsonAtomic(validationReportFile(root), validationReport(inputs.validated, inputs, rollup, notes));
  // The group inputs, then the index that names them; a group no longer in the index goes.
  const keep = new Set<string>();
  for (const g of groups) {
    writeFileAtomic(join(inputDir(root), `${g.entry.group_id}.md`), g.markdown);
    writeJsonAtomic(join(inputDir(root), `${g.entry.group_id}.json`), g.sidecar);
    keep.add(`${g.entry.group_id}.md`).add(`${g.entry.group_id}.json`);
  }
  let names: string[] = [];
  try {
    names = readdirSync(inputDir(root));
  } catch {
    // nothing written before
  }
  for (const name of names) if (/^synth-\d{3,6}\.(?:md|json)$/.test(name) && !keep.has(name)) removeFile(join(inputDir(root), name));
  writeJsonAtomic(synthIndexFile(root), groups.map((g) => g.entry));

  const promoted = rollup.processes.filter((p) => p.origin === 'promoted').length;
  const occurrences = rollup.processes.reduce((n, p) => n + p.occurrences, 0);
  const line =
    `rollup: ${plural(rollup.processes.length, 'process', 'processes')} (${promoted} promoted), ${plural(rollup.coverage.counted, 'counted message')} ` +
    `in ${plural(occurrences, 'occurrence')}; ${plural(rollup.unassigned.messages, 'tagged message')} unassigned; ${plural(groups.length, 'synthesis group')}.`;
  logStage(root, 'rollup', started, line);
  return line;
}

export function rollupCommand(root: string, args: string[]): number {
  try {
    if (args.length > 0) throw new RollupError(`unexpected argument "${args[0]}". Usage: node obs.mjs rollup`);
    console.log(rollupStep(root));
    return 0;
  } catch (err) {
    if (err instanceof RollupError || err instanceof MergeError || err instanceof LedgerError || err instanceof ConfigError) {
      console.error(`rollup: ${withoutRoot(err.message, root).replace(/\s*\n\s*/g, ' ')}`);
      return 1;
    }
    throw err;
  }
}
