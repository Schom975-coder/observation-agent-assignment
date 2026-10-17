import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CorpusError, openCorpus } from '../src/corpus/reader.ts';
import { gitBlobSha } from '../src/util/hash.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const corpus = openCorpus(root);

const tmp = mkdtempSync(join(tmpdir(), 'obs-corpus-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function fixtureDir(name: string, files: Record<string, string>): string {
  const dir = join(tmp, name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

test('lists all 3,240 messages from Git, with exact Git paths as IDs, in ID order', () => {
  assert.equal(corpus.listedFrom, 'git');
  assert.equal(corpus.entries.length, 3240);
  const ids = corpus.entries.map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.ok(corpus.has('corpus/farmer-d/logistics/1.'), 'trailing dot kept');
  assert.ok(ids.every((id) => id.startsWith('corpus/') && !id.includes('\\')));
});

test("every message's bytes hash to its Git blob ID", () => {
  const { checkedAgainstGit, mismatches } = corpus.verify();
  assert.equal(checkedAgainstGit, true);
  assert.deepEqual(mismatches, []);
});

test(
  'reading from disk and from Git objects gives identical bytes',
  { skip: corpus.readFrom !== 'disk' && 'corpus is not on disk here (Windows); CI covers this on macOS and Linux' },
  () => {
    const fromDisk = corpus.readAll();
    const fromGit = openCorpus(root, { readFrom: 'git' }).readAll();
    assert.equal(fromGit.size, fromDisk.size);
    for (const [id, bytes] of fromDisk) assert.ok(bytes.equals(fromGit.get(id) as Buffer), id);
  },
);

test('bytes come back raw: CRLF line endings are kept', () => {
  const bytes = corpus.read('corpus/farmer-d/logistics/1.');
  assert.ok(bytes.includes('\r\n'));
  assert.equal(gitBlobSha(bytes), corpus.entries.find((e) => e.id === 'corpus/farmer-d/logistics/1.')?.blob_sha);
});

test('an unknown ID is an error, not an empty message', () => {
  assert.throws(() => corpus.read('corpus/nobody/1.'), CorpusError);
});

test('without Git, lists corpus/ from disk and skips hidden files such as .DS_Store', () => {
  const dir = fixtureDir('no-git', {
    'corpus/b/m2.txt': 'second\r\n',
    'corpus/a/m1.txt': 'first\r\nline\r\n',
    'corpus/a/.DS_Store': 'finder junk',
  });
  const c = openCorpus(dir);
  assert.equal(c.listedFrom, 'disk');
  assert.deepEqual(c.entries.map((e) => e.id), ['corpus/a/m1.txt', 'corpus/b/m2.txt']);
  assert.equal(c.read('corpus/a/m1.txt').toString(), 'first\r\nline\r\n');
  assert.equal(c.verify().checkedAgainstGit, false);
});

test('no corpus and no Git: the error points at the Windows clone recipe', () => {
  const dir = fixtureDir('empty', { 'README.md': 'nothing here' });
  assert.throws(() => openCorpus(dir), (e: unknown) => e instanceof CorpusError && /README\.md/.test(e.message));
});

test('a checkout with some corpus files missing from disk is refused, not half-read', () => {
  const dir = fixtureDir('partial', { 'corpus/a/m1.txt': 'one\r\n', 'corpus/a/m2.txt': 'two\r\n' });
  const run = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  run('init', '-q');
  run('add', '.');
  run('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'fixture');
  assert.equal(openCorpus(dir).readFrom, 'disk');
  unlinkSync(join(dir, 'corpus/a/m2.txt'));
  assert.throws(() => openCorpus(dir), /1 of 2 corpus files are missing from disk/);
});
