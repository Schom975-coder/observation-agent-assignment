// Stage 1: list every message, prove the bytes are the repo's bytes, write the manifest.
// The manifest holds nothing machine-specific (no source, no timestamps), so every OS
// writes the same file and later stages can key their caches on corpus_hash.
import { join } from 'node:path';
import { sha256 } from '../util/hash.ts';
import { writeJson } from '../util/json.ts';
import { CorpusError, openCorpus, type CorpusEntry, type Source } from './reader.ts';

export type Manifest = { corpus_hash: string; count: number; entries: CorpusEntry[] };

export function buildManifest(entries: readonly CorpusEntry[]): Manifest {
  const corpus_hash = sha256(entries.map((e) => `${e.id}\0${e.blob_sha}\n`).join(''));
  return { corpus_hash, count: entries.length, entries: [...entries] };
}

export type IngestResult = {
  manifest: Manifest;
  listedFrom: Source;
  readFrom: Source;
  checkedAgainstGit: boolean;
  mismatches: string[];
};

// Writes `${outDir}/manifest.json` only when every byte checks out.
export function ingest(root: string, outDir: string, options: { readFrom?: Source } = {}): IngestResult {
  const corpus = openCorpus(root, options);
  const { checkedAgainstGit, mismatches } = corpus.verify();
  const manifest = buildManifest(corpus.entries);
  if (mismatches.length === 0) writeJson(join(outDir, 'manifest.json'), manifest);
  return { manifest, listedFrom: corpus.listedFrom, readFrom: corpus.readFrom, checkedAgainstGit, mismatches };
}

export function ingestCommand(root: string): number {
  let result: IngestResult;
  try {
    result = ingest(root, join(root, 'out'));
  } catch (err) {
    if (err instanceof CorpusError) {
      console.error(`ingest: ${err.message}`);
      return 1;
    }
    throw err;
  }
  const { manifest, listedFrom, readFrom, checkedAgainstGit, mismatches } = result;
  const n = manifest.count.toLocaleString('en-US');
  const where = readFrom === 'git' ? 'Git objects (corpus not on disk)' : 'disk';
  console.log(`ingest: ${n} messages listed from ${listedFrom === 'git' ? 'Git HEAD' : 'corpus/ on disk'}, read from ${where}.`);
  if (mismatches.length > 0) {
    console.error(`ingest: ${mismatches.length} messages do not match the bytes Git holds, so nothing downstream can be trusted:`);
    for (const id of mismatches.slice(0, 10)) console.error(`  ${id}`);
    console.error('Restore them with "git checkout -- corpus" and check that nothing rewrote their line endings.');
    return 1;
  }
  console.log(
    checkedAgainstGit
      ? "ingest: every message's bytes match its Git blob ID."
      : 'ingest: not a Git checkout, so the byte check against Git was skipped.',
  );
  console.log(`ingest: wrote out/manifest.json (corpus hash ${manifest.corpus_hash.slice(0, 12)}).`);
  return 0;
}
