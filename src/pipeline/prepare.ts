// The deterministic front half of a run: ingest, parse, de-duplicate, thread, batch, and the
// taxonomy digest the taxonomist reads (src/batch/digest.ts).
// Same corpus in, same files out, byte for byte, on every OS. Later model stages key their caches
// on what it writes. Everything is built in memory first: if anything fails, the previous run's
// files (manifest included) are left as they were rather than half-replaced. Writing starts by
// deleting prepare-stats.json and ends by writing it, so its presence means a run finished.
//
// `node obs.mjs prepare` skips itself when nothing it depends on or writes has changed since the
// stats were written (ARCHITECTURE.md 4): the corpus listing (Git's, no message bytes read), the
// code (codeSha: src/**/*.ts and config/effort-rates.json), and every output, present and with the
// recorded hash (each batch file against its content_sha in the batch index). `--force` always
// runs; CI uses it.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BatchError, packBatches } from '../batch/build.ts';
import { DigestError, buildDigest } from '../batch/digest.ts';
import { ConfigError, loadEffortRates } from '../config.ts';
import { buildManifest, ingest } from '../corpus/ingest.ts';
import { CorpusError, openCorpus } from '../corpus/reader.ts';
import { bodyKey, findDuplicates } from '../normalize/dedup.ts';
import { buildPeople } from '../normalize/people.ts';
import { buildThreads } from '../normalize/threads.ts';
import { parseMessage } from '../parse/message.ts';
import { logRunEvent } from '../run/ledger.ts';
import { sha256 } from '../util/hash.ts';
import { normalizeNewlines } from '../util/text.ts';
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
  digest_sha: string; // sha256 of out/taxonomy-digest.md (LF only); taxonomy.json records the one it was built from
  code_sha: string; // codeSha() of the code that built these files
  // sha256 of every other output's bytes, by path under out/ (the digest is digest_sha, and each
  // batch file is in the batch index with its content_sha)
  outputs: Record<string, string>;
};

// The same advice ingestCommand gives for a byte mismatch.
const RESTORE_HINT = 'Restore them with "git checkout -- corpus" and check that nothing rewrote their line endings.';

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// What built the outputs: sha256 over every src/**/*.ts file and config/effort-rates.json (it
// decides who is staff), each as its POSIX path and the hash of its newline-normalised text, in
// sorted path order. A missing file hashes as "none".
export function codeSha(root: string): string {
  const files: string[] = [];
  const src = join(root, 'src');
  if (existsSync(src)) {
    for (const rel of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
      const posix = `src/${rel.replaceAll('\\', '/')}`;
      if (posix.endsWith('.ts') && statSync(join(root, posix)).isFile()) files.push(posix);
    }
  }
  files.sort(byText).push('config/effort-rates.json');
  const lines = files.map((file) => {
    const abs = join(root, file);
    return `${file}\n${existsSync(abs) ? sha256(normalizeNewlines(readFileSync(abs, 'utf8'))) : 'none'}\n`;
  });
  return sha256(lines.join(''));
}

// 2-space JSON and a newline: the form every JSON output is written in.
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

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
  const digest = buildDigest(unique, threads, people, texts);

  // Every output but the batch files and the digest, as the text written.
  const outputs: Array<[string, string]> = [
    ['manifest.json', json(ing.manifest)],
    ['messages.jsonl', messages.map((m) => `${JSON.stringify(m)}\n`).join('')],
    ['dedup.json', json({ duplicates: dedup.duplicateOf.size, groups: dedup.groups })],
    ['threads.json', json(threads)],
    ['people.json', json(people)],
    ['batches/index.json', json(index)],
  ];
  mkdirSync(outDir, { recursive: true });
  rmSync(join(outDir, 'prepare-stats.json'), { force: true });
  for (const [rel, text] of outputs.slice(0, 5)) writeFileSync(join(outDir, rel), text);
  const batchDir = join(outDir, 'batches');
  rmSync(batchDir, { recursive: true, force: true });
  mkdirSync(batchDir, { recursive: true });
  for (const b of batches) writeFileSync(join(batchDir, `${b.entry.batch_id}.md`), b.content);
  for (const [rel, text] of outputs.slice(5)) writeFileSync(join(outDir, rel), text);
  writeFileSync(join(outDir, 'taxonomy-digest.md'), digest);

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
    digest_sha: sha256(digest),
    code_sha: codeSha(root),
    outputs: Object.fromEntries(outputs.map(([rel, text]) => [rel, sha256(text)])),
  };
  writeFileSync(join(outDir, 'prepare-stats.json'), json(stats));
  return { stats, batches: index };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// Nothing prepare depends on or writes has changed since out/prepare-stats.json was written: the
// stats record this code, every output is there with the hash recorded (the digest against
// digest_sha, each batch file against its content_sha in the index, which is itself an output),
// and the corpus listing is the one they were built from. Anything unreadable means "run".
export function prepareIsCurrent(root: string, outDir: string = join(root, 'out')): boolean {
  try {
    const stats: unknown = JSON.parse(readFileSync(join(outDir, 'prepare-stats.json'), 'utf8'));
    if (!isRecord(stats) || typeof stats.code_sha !== 'string' || typeof stats.digest_sha !== 'string' || !isRecord(stats.outputs)) return false;
    if (stats.code_sha !== codeSha(root)) return false;
    const outputs = stats.outputs;
    if (!Object.hasOwn(outputs, 'batches/index.json')) return false;
    for (const [rel, sha] of Object.entries(outputs)) {
      if (typeof sha !== 'string' || sha256(readFileSync(join(outDir, rel))) !== sha) return false;
    }
    if (sha256(readFileSync(join(outDir, 'taxonomy-digest.md'))) !== stats.digest_sha) return false;
    const index = JSON.parse(readFileSync(join(outDir, 'batches', 'index.json'), 'utf8')) as BatchEntry[];
    for (const b of index) {
      if (sha256(readFileSync(join(outDir, 'batches', `${b.batch_id}.md`))) !== b.content_sha) return false;
    }
    // Last, as the slowest: the corpus listing (from Git HEAD in a checkout: no message bytes read).
    return buildManifest(openCorpus(root).entries).corpus_hash === stats.corpus_hash;
  } catch {
    return false;
  }
}

export function prepareCommand(root: string, args: readonly string[] = []): number {
  const unknown = args.filter((a) => a !== '--force');
  if (unknown.length > 0) {
    console.error(`prepare: unexpected argument "${unknown[0]}". Usage: node obs.mjs prepare [--force]`);
    return 1;
  }
  // During a run the run's log gets one `prepare` event with its duration (ARCHITECTURE.md 7.4).
  const started = performance.now();
  if (!args.includes('--force') && prepareIsCurrent(root)) {
    logRunEvent(root, { event: 'prepare', ms: Math.round(performance.now() - started), skipped: true });
    console.log('prepare: unchanged');
    return 0;
  }
  let stats: PrepareStats;
  try {
    ({ stats } = prepare(root, join(root, 'out')));
  } catch (err) {
    if (err instanceof CorpusError || err instanceof ConfigError || err instanceof BatchError || err instanceof DigestError) {
      console.error(`prepare: ${err.message.replace(/\s*\n\s*/g, ' ')}`);
      return 1;
    }
    throw err;
  }
  logRunEvent(root, { event: 'prepare', ms: Math.round(performance.now() - started), skipped: false });
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
  console.log('prepare: taxonomy digest in out/taxonomy-digest.md (flagged messages left out).');
  return 0;
}
