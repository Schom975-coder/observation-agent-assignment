// The gold set commands (ARCHITECTURE.md 6.18):
//   node obs.mjs gold sample  writes out/gold-sample.md, and config/gold-labels.json with empty,
//                             unconfirmed entries if that file does not exist yet (never overwritten)
//   node obs.mjs gold score   scores the tags of the batches the ledger counts as done against
//                             the confirmed labels and writes out/gold-score.json
// The labels are human input tied to one taxonomy: the file records the taxonomy_sha it was
// labelled against, and score refuses another.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CorpusError, openCorpus } from '../corpus/reader.ts';
import { goldSample, labelsSkeleton, renderGoldSample, type GoldLabels } from '../gold/sample.ts';
import { checkLabels, scoreGold, type Tagging } from '../gold/score.ts';
import type { Taxonomy } from '../model/taxonomy.ts';
import { gitBlobSha, sha256 } from '../util/hash.ts';
import { writeJson } from '../util/json.ts';
import { normalizeNewlines } from '../util/text.ts';
import { LedgerError, batchViews, readText, taxonomyFile, validatedFile, withoutRoot, writeFileAtomic } from './ledger.ts';
import type { DuplicateGroup, ParsedMessage } from '../types.ts';

export const goldLabelsFile = (root: string): string => join(root, 'config', 'gold-labels.json');
export const goldSampleFile = (root: string): string => join(root, 'out', 'gold-sample.md');
export const goldScoreFile = (root: string): string => join(root, 'out', 'gold-score.json');

export class GoldError extends Error {
  override name = 'GoldError';
}

function readJson(root: string, file: string, missing: string): unknown {
  const text = readText(file);
  const rel = withoutRoot(file, root).replaceAll('\\', '/');
  if (text === null) throw new GoldError(`${rel} is missing: ${missing}`);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new GoldError(`${rel} is not valid JSON (${(err as Error).message})`);
  }
}

// The taxonomy, and its hash as the extraction cache keys compute it (newlines normalised).
function loadTaxonomy(root: string): { taxonomy: Taxonomy; sha: string } {
  const text = readText(taxonomyFile(root));
  if (text === null) throw new GoldError('out/taxonomy.json is missing: the labels use its keys, so run the taxonomy stage first.');
  let taxonomy: Taxonomy;
  try {
    taxonomy = JSON.parse(text) as Taxonomy;
  } catch (err) {
    throw new GoldError(`out/taxonomy.json is not valid JSON (${(err as Error).message})`);
  }
  if (typeof taxonomy !== 'object' || taxonomy === null || !Array.isArray(taxonomy.processes)) {
    throw new GoldError('out/taxonomy.json has no process list: run the taxonomy stage again.');
  }
  return { taxonomy, sha: sha256(normalizeNewlines(text)) };
}

function uniqueMessages(root: string): ParsedMessage[] {
  const text = readText(join(root, 'out', 'messages.jsonl'));
  if (text === null) throw new GoldError('out/messages.jsonl is missing: run node obs.mjs prepare first.');
  const messages = text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as ParsedMessage);
  const dedup = readJson(root, join(root, 'out', 'dedup.json'), 'run node obs.mjs prepare first.') as { groups?: DuplicateGroup[] };
  const duplicates = new Set((dedup.groups ?? []).flatMap((g) => g.duplicates.map((d) => d.id)));
  return messages.filter((m) => !duplicates.has(m.id));
}

function sampleCommand(root: string): number {
  const { taxonomy, sha } = loadTaxonomy(root);
  const sample = goldSample(uniqueMessages(root));
  if (sample.length === 0) throw new GoldError('no messages to sample: run node obs.mjs prepare first.');
  const bytes = openCorpus(root).readMany(sample.map((m) => m.id));
  const texts = new Map<string, string>();
  for (const m of sample) {
    const data = bytes.get(m.id) as Buffer;
    if (gitBlobSha(data) !== m.blob_sha) throw new GoldError(`${m.id} has changed since prepare: run node obs.mjs prepare again.`);
    texts.set(m.id, data.toString('utf8'));
  }
  writeFileAtomic(goldSampleFile(root), renderGoldSample(sample, texts, taxonomy, sha));
  const mailboxes = new Set(sample.map((m) => m.mailbox)).size;
  console.log(`gold: sampled ${sample.length} messages from ${mailboxes} mailboxes into out/gold-sample.md.`);

  const labels = goldLabelsFile(root);
  if (!existsSync(labels)) {
    writeJson(labels, labelsSkeleton(sample, sha));
    console.log(`gold: wrote config/gold-labels.json with ${sample.length} empty, unconfirmed entries.`);
    return 0;
  }
  // Human input: never overwritten. Say so when it no longer matches.
  let recorded: unknown = null;
  try {
    recorded = (JSON.parse(readText(labels) ?? 'null') as { taxonomy_sha?: unknown } | null)?.taxonomy_sha;
  } catch {
    // reported by gold score
  }
  console.log(
    recorded === sha
      ? 'gold: config/gold-labels.json already exists; left as it is.'
      : 'gold: config/gold-labels.json already exists and was labelled against another taxonomy; left as it is. To relabel, delete it and run gold sample again.',
  );
  return 0;
}

// Every message's tags in the batches the ledger counts as done: a validated file under the current
// cache key (batch content, extractor definition, taxonomy) made from this batch's content. A file
// left in out/validated/ by a failed, stale or re-dispatched batch is not an extraction to score.
function extractedTags(root: string): Map<string, Tagging> {
  const tags = new Map<string, Tagging>();
  for (const v of batchViews(root)) {
    if (v.status !== 'done') continue;
    const file = validatedFile(root, v.entry.batch_id);
    const value = readJson(root, file, 'the ledger says this batch is done; run node obs.mjs verify') as { messages?: Array<{ id: string; processes: string[]; role: string }> };
    for (const m of value.messages ?? []) tags.set(m.id, { processes: m.processes, role: m.role });
  }
  return tags;
}

function scoreCommand(root: string): number {
  const { taxonomy, sha } = loadTaxonomy(root);
  const value = readJson(root, goldLabelsFile(root), 'run node obs.mjs gold sample first, then label the entries.');
  const recorded = (value as { taxonomy_sha?: unknown } | null)?.taxonomy_sha;
  if (typeof recorded === 'string' && recorded !== sha) {
    throw new GoldError(
      `config/gold-labels.json was labelled against taxonomy ${recorded.slice(0, 12)}, not the current ${sha.slice(0, 12)}: ` +
        'labels depend on the taxonomy keys, so label again (delete the file, run gold sample, label the new entries).',
    );
  }
  const check = checkLabels(value, new Set(taxonomy.processes.map((p) => p.key)));
  if (check.labels === null) {
    console.error(`gold: config/gold-labels.json has ${check.problems.length} problem${check.problems.length === 1 ? '' : 's'}:`);
    for (const p of check.problems) console.error(`  - ${p}`);
    return 1;
  }
  const labels: GoldLabels = check.labels;
  const score = scoreGold(labels, extractedTags(root));
  writeJson(goldScoreFile(root), score);
  const pct = (a: { pct: number | null }) => (a.pct === null ? 'n/a' : `${a.pct.toFixed(1)}%`);
  console.log(
    `gold: ${score.scored} of ${score.confirmed} confirmed labels scored (${score.labels} in the file); ` +
      `exact ${pct(score.exact)}, overlap ${pct(score.overlap)}, role ${pct(score.role)}; ` +
      `${score.mismatches.length} mismatches in out/gold-score.json.`,
  );
  const n = score.missing.length;
  if (n > 0) console.log(`gold: ${n} confirmed label${n === 1 ? ' is' : 's are'} in no batch the ledger counts as done yet.`);
  return 0;
}

export function goldCommand(root: string, args: string[]): number {
  try {
    if (args.length === 1 && args[0] === 'sample') return sampleCommand(root);
    if (args.length === 1 && args[0] === 'score') return scoreCommand(root);
    throw new GoldError(`expected "sample" or "score". Usage: node obs.mjs gold sample|score`);
  } catch (err) {
    if (err instanceof GoldError || err instanceof CorpusError || err instanceof LedgerError) {
      console.error(`gold: ${err.message.replace(/\s*\n\s*/g, ' ')}`);
      return 1;
    }
    throw err;
  }
}
