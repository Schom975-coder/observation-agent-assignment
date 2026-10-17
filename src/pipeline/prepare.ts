// The deterministic front half of a run: ingest, parse, de-duplicate, thread, batch.
// Same corpus in, same files out, byte for byte, on every OS; it takes seconds, so it simply
// reruns rather than caching. Later model stages key their caches on what it writes.
// Everything is built in memory first: if anything fails, the previous run's files (manifest
// included) are left as they were rather than half-replaced. Writing starts by deleting
// prepare-stats.json and ends by writing it, so its presence means a run finished.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BatchError, packBatches } from '../batch/build.ts';
import { ConfigError, loadEffortRates } from '../config.ts';
import { ingest } from '../corpus/ingest.ts';
import { CorpusError } from '../corpus/reader.ts';
import { bodyKey, findDuplicates } from '../normalize/dedup.ts';
import { buildPeople } from '../normalize/people.ts';
import { buildThreads } from '../normalize/threads.ts';
import { parseMessage } from '../parse/message.ts';
import { writeJson } from '../util/json.ts';
import type { BatchEntry, ParsedMessage } from '../types.ts';

export type PrepareStats = {
  corpus_hash: string; // the manifest's: which corpus this complete set of files was built from
  messages: number;
  date_status: Record<string, number>;
  duplicates: number;
  duplicate_groups: number;
  unique: number;
  threads: number;
  occurrences: number;
  people: number;
  staff: number;
  batches: number;
  largest_batch_bytes: number;
  largest_batch_est_tokens: number;
  suspected_injection: string[];
  oversize: string[];
};

// The same advice ingestCommand gives for a byte mismatch.
const RESTORE_HINT = 'Restore them with "git checkout -- corpus" and check that nothing rewrote their line endings.';

export function prepare(root: string, outDir: string): { stats: PrepareStats; batches: BatchEntry[] } {
  const ing = ingest(root, outDir, { write: false });
  if (ing.mismatches.length > 0) {
    throw new CorpusError(
      `${ing.mismatches.length} messages do not match the bytes Git holds (first: ${ing.mismatches[0]}). ${RESTORE_HINT}`,
    );
  }
  const rates = loadEffortRates(join(root, 'config', 'effort-rates.json'));

  const texts = new Map<string, string>();
  const messages: ParsedMessage[] = [];
  for (const entry of ing.manifest.entries) {
    const data = ing.bytes.get(entry.id) as Buffer;
    texts.set(entry.id, data.toString('utf8'));
    messages.push(parseMessage(entry.id, entry.blob_sha, data));
  }
  const bodies = new Map(messages.map((m) => [m.id, bodyKey(texts.get(m.id) as string, m.body_start)]));
  const dedup = findDuplicates(messages, bodies);
  const unique = messages.filter((m) => !dedup.duplicateOf.has(m.id));
  const threads = buildThreads(unique);
  const people = buildPeople(unique, rates.priced_domains);
  const batches = packBatches(threads, new Map(unique.map((m) => [m.id, m])), texts);
  const index = batches.map((b) => b.entry);

  mkdirSync(outDir, { recursive: true });
  rmSync(join(outDir, 'prepare-stats.json'), { force: true });
  writeJson(join(outDir, 'manifest.json'), ing.manifest);
  writeFileSync(join(outDir, 'messages.jsonl'), messages.map((m) => `${JSON.stringify(m)}\n`).join(''));
  writeJson(join(outDir, 'dedup.json'), { duplicates: dedup.duplicateOf.size, groups: dedup.groups });
  writeJson(join(outDir, 'threads.json'), threads);
  writeJson(join(outDir, 'people.json'), people);
  const batchDir = join(outDir, 'batches');
  rmSync(batchDir, { recursive: true, force: true });
  mkdirSync(batchDir, { recursive: true });
  for (const b of batches) writeFileSync(join(batchDir, `${b.entry.batch_id}.md`), b.content);
  writeJson(join(batchDir, 'index.json'), index);

  const date_status: Record<string, number> = { usable: 0, missing: 0, unparseable: 0, out_of_range: 0 };
  for (const m of messages) date_status[m.date_status] = (date_status[m.date_status] ?? 0) + 1;
  const stats: PrepareStats = {
    corpus_hash: ing.manifest.corpus_hash,
    messages: messages.length,
    date_status,
    duplicates: dedup.duplicateOf.size,
    duplicate_groups: dedup.groups.length,
    unique: unique.length,
    threads: threads.length,
    occurrences: threads.reduce((n, t) => n + t.occurrences.length, 0),
    people: people.length,
    staff: people.filter((p) => p.priced).length,
    batches: batches.length,
    largest_batch_bytes: Math.max(0, ...index.map((b) => b.bytes)),
    largest_batch_est_tokens: Math.max(0, ...index.map((b) => b.est_tokens)),
    suspected_injection: messages.filter((m) => m.flags.suspected_injection).map((m) => m.id),
    oversize: messages.filter((m) => m.flags.oversize).map((m) => m.id),
  };
  writeJson(join(outDir, 'prepare-stats.json'), stats);
  return { stats, batches: index };
}

export function prepareCommand(root: string): number {
  let stats: PrepareStats;
  try {
    ({ stats } = prepare(root, join(root, 'out')));
  } catch (err) {
    if (err instanceof CorpusError || err instanceof ConfigError || err instanceof BatchError) {
      console.error(`prepare: ${err.message.replace(/\s*\n\s*/g, ' ')}`);
      return 1;
    }
    throw err;
  }
  const n = (x: number) => x.toLocaleString('en-US');
  const d = stats.date_status;
  console.log(
    `prepare: ${n(stats.messages)} messages parsed; dates ${n(d.usable ?? 0)} usable, ${d.missing} missing, ` +
      `${d.unparseable} unparseable, ${d.out_of_range} out of range.`,
  );
  console.log(`prepare: ${stats.duplicates} duplicates in ${stats.duplicate_groups} groups; ${n(stats.unique)} unique messages.`);
  console.log(`prepare: ${n(stats.threads)} threads, ${n(stats.occurrences)} occurrences, ${n(stats.people)} people (${n(stats.staff)} staff).`);
  console.log(
    `prepare: ${stats.batches} batches in out/batches/, largest ${(stats.largest_batch_bytes / 1000).toFixed(1)} KB, ` +
      `largest ~${n(stats.largest_batch_est_tokens)} tokens.`,
  );
  console.log(`prepare: flagged ${stats.suspected_injection.length} suspected injection, ${stats.oversize.length} oversize.`);
  return 0;
}
