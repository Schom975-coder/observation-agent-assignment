import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, ingest } from '../src/corpus/ingest.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'obs-ingest-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('ingest checks every message and writes a manifest of all 3,240', () => {
  const result = ingest(root, join(tmp, 'a'));
  assert.deepEqual(result.mismatches, []);
  const manifest = JSON.parse(readFileSync(join(tmp, 'a', 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest), ['corpus_hash', 'count', 'entries']);
  assert.equal(manifest.count, 3240);
  assert.equal(manifest.entries.length, 3240);
});

test('the manifest is the same bytes whichever source the corpus was read from', () => {
  ingest(root, join(tmp, 'default'));
  ingest(root, join(tmp, 'git'), { readFrom: 'git' });
  assert.ok(readFileSync(join(tmp, 'default', 'manifest.json')).equals(readFileSync(join(tmp, 'git', 'manifest.json'))));
});

test('corpus hash changes when any message changes and not otherwise', () => {
  const entries = [
    { id: 'corpus/a/1.', blob_sha: 'aa', size: 1 },
    { id: 'corpus/a/2.', blob_sha: 'bb', size: 1 },
  ];
  const base = buildManifest(entries).corpus_hash;
  assert.equal(buildManifest(entries.map((e) => ({ ...e }))).corpus_hash, base);
  assert.notEqual(buildManifest([entries[0]!, { ...entries[1]!, blob_sha: 'bc' }]).corpus_hash, base);
});
