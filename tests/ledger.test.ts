// The run ledger and its commands, on temp projects with hand-made batch files (no corpus needed):
// status transitions, what the cache key depends on, reruns that repeat nothing, concurrent writers
// and stale locks, run start/end, batch IDs as typed, and the dispatch prompt.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchCommand, extractorPrompt, runCommand, statusCommand, type StatusReport } from '../src/run/commands.ts';
import {
  GATE_MAX_BLOCKS,
  LOCK_STALE_MS,
  LedgerError,
  batchStateFile,
  batchViews,
  cacheKey,
  extractFile,
  loadIndex,
  markDispatched,
  normalizeBatchId,
  parseOutputLine,
  readBatchState,
  readRun,
  recordValidation,
  sharedKeyParts,
  takeAgentBlock,
  takeGateBlock,
  updateBatchState,
  validatedFile,
  withoutRoot,
} from '../src/run/ledger.ts';
import { sha256 } from '../src/util/hash.ts';
import type { BatchEntry, ExtractionCheck, ValidatedExtraction } from '../src/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'obs-ledger-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const AGENT = '---\nname: extractor\n---\n\nClassify every message.\n';

const batchName = (n: number) => `batch-${String(n).padStart(3, '0')}`;
const content = (n: number) => `# ${batchName(n)} | 1 messages | 1 threads\n--- MESSAGE corpus/x/inbox/${n}. ---\n`;

function entry(n: number): BatchEntry {
  const batch_id = batchName(n);
  return {
    batch_id,
    file: `out/batches/${batch_id}.md`,
    message_ids: [`corpus/x/inbox/${n}.`],
    thread_ids: [`t-${n}`],
    bytes: Buffer.byteLength(content(n)),
    lines: 2,
    est_tokens: 30,
    content_sha: sha256(content(n)),
  };
}

let projects = 0;
function project(batches = 4): string {
  const root = join(tmp, `p${projects++}`);
  mkdirSync(join(root, 'out', 'batches'), { recursive: true });
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(root, '.claude', 'agents', 'extractor.md'), AGENT);
  for (let n = 0; n < batches; n++) writeFileSync(join(root, 'out', 'batches', `${batchName(n)}.md`), content(n));
  writeIndex(root, Array.from({ length: batches }, (_, i) => entry(i)));
  return root;
}

const writeIndex = (root: string, index: BatchEntry[]) => writeFileSync(join(root, 'out', 'batches', 'index.json'), JSON.stringify(index));

function validated(batchId: string): ValidatedExtraction {
  return {
    batch_id: batchId,
    content_sha: 'x',
    messages: [],
    evidence: [],
    stall_checks: [],
    ownership_checks: [],
    new_processes: [],
    batch_notes: '',
    quote_stats: { exact: 3, repaired: 1, rejected: 0 },
  };
}
const passed = (batchId: string): ExtractionCheck => ({ ok: true, problems: [], validated: validated(batchId) });
const failedCheck = (batchId: string): ExtractionCheck => ({ ok: false, problems: ['a', 'b'], validated: validated(batchId) });

const statusOf = (root: string, batchId: string) => batchViews(root).find((v) => v.entry.batch_id === batchId)?.status;
const keyOf = (root: string, batchId: string) => batchViews(root).find((v) => v.entry.batch_id === batchId)?.cache_key;
const indexEntry = (root: string, batchId: string) => loadIndex(root).find((b) => b.batch_id === batchId) as BatchEntry;
const dispatch = (root: string, batchId: string) => markDispatched(root, indexEntry(root, batchId));
// Dispatch, then record a check: the only way a batch gets stamped.
const finish = (root: string, batchId: string, check: ExtractionCheck) => {
  dispatch(root, batchId);
  return recordValidation(root, indexEntry(root, batchId), check);
};

// Runs `fn` with console.log and console.error captured.
function capture(fn: () => number): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...args: unknown[]) => void out.push(args.join(' '));
  console.error = (...args: unknown[]) => void err.push(args.join(' '));
  try {
    return { code: fn(), out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('a batch goes pending -> running -> done, and a failed one back to running on re-dispatch', () => {
  const root = project();
  assert.equal(statusOf(root, 'batch-001'), 'pending');
  assert.equal(readBatchState(root, 'batch-001').dispatches, 0);

  const running = dispatch(root, 'batch-001');
  assert.equal(running.status, 'running');
  assert.equal(running.dispatches, 1);
  assert.equal(running.gate_blocks, 0);
  assert.match(running.dispatched_utc ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(running.finished_utc, null);
  assert.equal(statusOf(root, 'batch-001'), 'running');

  const done = recordValidation(root, indexEntry(root, 'batch-001'), passed('batch-001'));
  assert.equal(done.status, 'done');
  assert.deepEqual(done.quote_stats, { exact: 3, repaired: 1, rejected: 0 });
  assert.equal(done.problems, 0);
  assert.match(done.finished_utc ?? '', /Z$/);
  assert.ok(existsSync(validatedFile(root, 'batch-001')));
  assert.equal(statusOf(root, 'batch-001'), 'done');

  assert.equal(finish(root, 'batch-002', failedCheck('batch-002')).status, 'failed');
  assert.equal(readBatchState(root, 'batch-002').problems, 2);
  assert.equal(statusOf(root, 'batch-002'), 'failed');
  const again = dispatch(root, 'batch-002');
  assert.deepEqual([again.status, again.dispatches, again.gate_blocks, again.problems], ['running', 2, 0, null]);
  assert.ok(!existsSync(validatedFile(root, 'batch-002')), 'a re-dispatched batch has no validated output');
});

test('only a running batch can be stamped: pending, done and failed batches are refused', () => {
  const root = project();
  assert.throws(() => recordValidation(root, indexEntry(root, 'batch-000'), passed('batch-000')), (e: unknown) => e instanceof LedgerError && /batch-000 is pending, not running/.test(e.message));
  assert.ok(!existsSync(validatedFile(root, 'batch-000')), 'nothing written');
  finish(root, 'batch-001', passed('batch-001'));
  assert.throws(() => recordValidation(root, indexEntry(root, 'batch-001'), failedCheck('batch-001')), /batch-001 is done, not running/);
  assert.equal(statusOf(root, 'batch-001'), 'done', 'a done batch is not overwritten');
});

test('a setup problem never stamps a batch', () => {
  const root = project();
  dispatch(root, 'batch-000');
  const setup: ExtractionCheck = { ok: false, problems: ['setup: cannot read messages.jsonl'], validated: null };
  assert.throws(() => recordValidation(root, indexEntry(root, 'batch-000'), setup), /could not be checked: setup: /);
  assert.equal(readBatchState(root, 'batch-000').status, 'running');
});

test('the cache key is recorded at dispatch and kept: inputs that change mid-run make the batch pending', () => {
  const root = project();
  const atDispatch = dispatch(root, 'batch-000').cache_key;
  assert.equal(atDispatch, keyOf(root, 'batch-000'));
  writeFileSync(join(root, 'out', 'taxonomy.json'), '{"processes": []}\n'); // the taxonomy changes while it runs
  const done = recordValidation(root, indexEntry(root, 'batch-000'), passed('batch-000'));
  assert.equal(done.cache_key, atDispatch, 'validation keeps the dispatch-time key');
  assert.equal(statusOf(root, 'batch-000'), 'pending', 'made from the old taxonomy, so it is redone');
});

test('dispatch refuses a batch file that is missing or no longer matches the index', () => {
  const root = project();
  writeFileSync(join(root, 'out', 'batches', 'batch-001.md'), 'edited after prepare\n');
  assert.throws(() => dispatch(root, 'batch-001'), /batch-001\.md does not match out\/batches\/index\.json/);
  rmSync(join(root, 'out', 'batches', 'batch-002.md'));
  const r = capture(() => dispatchCommand(root, ['batch-002']));
  assert.equal(r.code, 1);
  assert.match(r.err[0] ?? '', /^dispatch: out\/batches\/batch-002\.md is missing\. Run node obs\.mjs prepare again\.$/);
  assert.equal(r.out.length, 0);
  assert.equal(readBatchState(root, 'batch-001').status, 'pending');
  assert.equal(readBatchState(root, 'batch-002').status, 'pending');
});

test('dispatch removes the previous outputs, so a stale file is never validated or blocks the Write', () => {
  const root = project();
  dispatch(root, 'batch-000');
  mkdirSync(join(root, 'out', 'extract'), { recursive: true });
  writeFileSync(extractFile(root, 'batch-000'), '{"old": true}');
  recordValidation(root, indexEntry(root, 'batch-000'), passed('batch-000'));
  dispatch(root, 'batch-000');
  assert.ok(!existsSync(extractFile(root, 'batch-000')));
  assert.ok(!existsSync(validatedFile(root, 'batch-000')));
});

test('gate blocks stop at the limit, per batch and per agent', () => {
  const root = project();
  const taken = Array.from({ length: GATE_MAX_BLOCKS + 2 }, () => takeGateBlock(root, 'batch-003'));
  assert.deepEqual(taken, [1, 2, 3, null, null]);
  assert.equal(readBatchState(root, 'batch-003').gate_blocks, 3);
  assert.deepEqual(Array.from({ length: 4 }, () => takeAgentBlock(root, 'agent/1')), [1, 2, 3, null]);
  assert.equal(takeAgentBlock(root, 'agent-2'), 1, 'another agent has its own count');
});

test('done needs the validated file: without it the batch is pending again', () => {
  const root = project();
  finish(root, 'batch-000', passed('batch-000'));
  assert.equal(statusOf(root, 'batch-000'), 'done');
  rmSync(validatedFile(root, 'batch-000'));
  assert.equal(statusOf(root, 'batch-000'), 'pending');
});

test('a failed check with no validated record leaves no validated file', () => {
  const root = project();
  finish(root, 'batch-000', passed('batch-000'));
  finish(root, 'batch-000', { ok: false, problems: ['not JSON'], validated: null });
  assert.ok(!existsSync(validatedFile(root, 'batch-000')));
  assert.equal(statusOf(root, 'batch-000'), 'failed');
  assert.equal(readBatchState(root, 'batch-000').quote_stats, null);
});

test('the cache key changes with the batch content, the extractor definition or the taxonomy, and only then', () => {
  const root = project();
  const k0 = keyOf(root, 'batch-001');
  const other0 = keyOf(root, 'batch-002');
  assert.equal(keyOf(root, 'batch-001'), k0, 'stable when nothing changes');

  // Unrelated files don't matter.
  writeFileSync(join(root, 'out', 'messages.jsonl'), 'changed\n');
  writeFileSync(join(root, '.claude', 'agents', 'synthesizer.md'), 'other agent');
  assert.equal(keyOf(root, 'batch-001'), k0);

  // Line endings of the agent file don't matter.
  writeFileSync(join(root, '.claude', 'agents', 'extractor.md'), AGENT.replaceAll('\n', '\r\n'));
  assert.equal(keyOf(root, 'batch-001'), k0, 'CRLF checkout of the same agent file');

  // This batch's content: its key changes, another batch's does not.
  const index = loadIndex(root);
  writeIndex(root, index.map((b) => (b.batch_id === 'batch-001' ? { ...b, content_sha: 'sha-of-new-content' } : b)));
  const k1 = keyOf(root, 'batch-001');
  assert.notEqual(k1, k0);
  assert.equal(keyOf(root, 'batch-002'), other0);

  // The extractor definition: every batch changes.
  writeFileSync(join(root, '.claude', 'agents', 'extractor.md'), `${AGENT}One more rule.\n`);
  const k2 = keyOf(root, 'batch-001');
  assert.notEqual(k2, k1);
  assert.notEqual(keyOf(root, 'batch-002'), other0);

  // The taxonomy: appearing, then changing.
  writeFileSync(join(root, 'out', 'taxonomy.json'), '{"processes": []}\n');
  const k3 = keyOf(root, 'batch-001');
  assert.notEqual(k3, k2);
  writeFileSync(join(root, 'out', 'taxonomy.json'), '{"processes": [{"key": "nominations"}]}\n');
  assert.notEqual(keyOf(root, 'batch-001'), k3);

  // The key is the documented function of its three parts.
  const parts = sharedKeyParts(root);
  assert.equal(keyOf(root, 'batch-001'), cacheKey('sha-of-new-content', parts));
});

test('a done batch stays done on an unchanged rerun, and any key change makes it pending', () => {
  const root = project();
  for (const id of ['batch-000', 'batch-001']) finish(root, id, passed(id));
  // A rerun: the index is rewritten with the same content, nothing else changes.
  writeIndex(root, loadIndex(root));
  const r = capture(() => statusCommand(root, ['--json']));
  assert.equal(r.code, 0);
  const report: StatusReport = JSON.parse(r.out.join('\n'));
  assert.deepEqual(report.done, ['batch-000', 'batch-001']);
  assert.deepEqual(report.pending, ['batch-002', 'batch-003']);
  assert.deepEqual(report.counts, { pending: 2, running: 0, done: 2, failed: 0 });
  assert.equal(report.extraction, 'incomplete');

  // A running or failed batch whose inputs changed is pending too.
  dispatch(root, 'batch-002');
  finish(root, 'batch-003', failedCheck('batch-003'));
  writeFileSync(join(root, 'out', 'taxonomy.json'), '{"processes": []}\n');
  assert.deepEqual(batchViews(root).map((v) => v.status), ['pending', 'pending', 'pending', 'pending']);
});

test('status: extraction is complete only when nothing is pending or running, and names the failed count', () => {
  const root = project(3);
  finish(root, 'batch-000', passed('batch-000'));
  dispatch(root, 'batch-001');
  finish(root, 'batch-002', failedCheck('batch-002'));
  assert.match(capture(() => statusCommand(root, [])).out[0] ?? '', /; extraction: incomplete; /, 'one still running');
  recordValidation(root, indexEntry(root, 'batch-001'), passed('batch-001'));
  const json = capture(() => statusCommand(root, ['--json']));
  assert.equal((JSON.parse(json.out.join('\n')) as StatusReport).extraction, 'complete');
  const human = capture(() => statusCommand(root, []));
  assert.equal(human.code, 0);
  assert.equal(human.out[0], 'status: 3 batches: 2 done, 0 running, 0 pending, 1 failed; extraction: complete, 1 failed; no run active.');
  assert.ok(human.out.includes('  done: batch-000, batch-001'));
  assert.ok(human.out.includes('  batch-002 failed: 2 problems after 0 gate blocks, 1 dispatch.'), human.out.join('\n'));
  assert.ok(human.out.length <= 6);
});

test('status compacts long runs of IDs into ranges', () => {
  const root = project(12);
  const r = capture(() => statusCommand(root, []));
  assert.ok(r.out.includes('  pending: batch-000..batch-011'), r.out.join('\n'));
});

test('status without a prepared batch index says to run prepare', () => {
  const root = join(tmp, 'unprepared');
  mkdirSync(root, { recursive: true });
  const r = capture(() => statusCommand(root, []));
  assert.equal(r.code, 1);
  assert.match(r.err[0] ?? '', /^status: .*Run node obs\.mjs prepare first/);
});

test('a corrupt batch state file is reported by its repo-relative path, not silently reset', () => {
  const root = project();
  mkdirSync(join(root, 'out', 'ledger'), { recursive: true });
  writeFileSync(join(root, 'out', 'ledger', 'batch-000.json'), '{not json');
  const r = capture(() => statusCommand(root, []));
  assert.equal(r.code, 1);
  assert.equal(r.err[0], 'status: out/ledger/batch-000.json is not valid JSON; delete it to reset batch-000 to pending.');
});

// Several processes updating the ledger at once, as up to 12 SubagentStop hooks do.
const ledgerUrl = new URL('../src/run/ledger.ts', import.meta.url).href;
const writerScript = `
  const { updateBatchState } = await import(${JSON.stringify(ledgerUrl)});
  const [root, own, shared, rounds] = process.argv.slice(1);
  for (let i = 0; i < Number(rounds); i++) {
    updateBatchState(root, own, (s) => ({ ...s, dispatches: s.dispatches + 1 }));
    updateBatchState(root, shared, (s) => ({ ...s, gate_blocks: s.gate_blocks + 1 }));
  }`;
function writers(root: string, procs: number, rounds: number, shared: string): Promise<unknown> {
  const run = (n: number) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', writerScript, root, batchName(n), shared, String(rounds)], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += String(d)));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${n} exited ${code}: ${stderr}`))));
    });
  return Promise.all(Array.from({ length: procs }, (_, n) => run(n)));
}
const leftovers = (root: string) => readdirSync(join(root, 'out', 'ledger')).filter((f) => !/^batch-\d{3}\.json$/.test(f));

test('concurrent writers from several processes lose no update', async () => {
  const root = project(8);
  const procs = 6;
  const rounds = 15;
  await writers(root, procs, rounds, 'batch-007');
  for (let n = 0; n < procs; n++) assert.equal(readBatchState(root, batchName(n)).dispatches, rounds, batchName(n));
  assert.equal(readBatchState(root, 'batch-007').gate_blocks, procs * rounds, 'the shared batch saw every increment');
  assert.equal(readBatchState(root, 'batch-006').dispatches, 0, 'an untouched batch stays untouched');
  assert.deepEqual(leftovers(root), [], 'no lock or temp file is left behind');
});

test('a stale lock left by a killed process is taken over, once, even with several waiters', async () => {
  const root = project(8);
  const lock = `${batchStateFile(root, 'batch-007')}.lock`;
  mkdirSync(join(root, 'out', 'ledger'), { recursive: true });
  writeFileSync(lock, '');
  const old = (Date.now() - LOCK_STALE_MS - 60_000) / 1000;
  utimesSync(lock, old, old);
  const started = Date.now();
  await writers(root, 6, 10, 'batch-007');
  assert.equal(readBatchState(root, 'batch-007').gate_blocks, 60, 'no increment lost while the lock changed hands');
  assert.deepEqual(leftovers(root), []);
  assert.ok(Date.now() - started < LOCK_STALE_MS + 60_000, 'nobody waited out the full lock timeout');
  updateBatchState(root, 'batch-007', (s) => s); // still lockable
});

test('run start and end set and clear run.active', () => {
  const root = project();
  assert.deepEqual(readRun(root), { active: false, run_id: null, started_utc: null });
  const start = capture(() => runCommand(root, ['start']));
  assert.equal(start.code, 0);
  const run = readRun(root);
  assert.equal(run.active, true);
  assert.match(run.run_id ?? '', /^\d{8}T\d{6}Z$/);
  assert.match(run.started_utc ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(start.out[0] ?? '', /^run: started \d{8}T\d{6}Z\./);

  const end = capture(() => runCommand(root, ['end']));
  assert.equal(end.code, 0);
  assert.deepEqual(readRun(root), { ...run, active: false });
  assert.match(end.out[0] ?? '', /^run: ended /);

  assert.equal(capture(() => runCommand(root, [])).code, 1);
  assert.equal(capture(() => runCommand(root, ['begin'])).code, 1);

  // An unreadable run file is an error to read, and `run end` resets it.
  writeFileSync(join(root, 'out', 'ledger', 'run.json'), 'garbage');
  assert.throws(() => readRun(root), /run\.json is not valid JSON/);
  assert.equal(capture(() => runCommand(root, ['end'])).code, 0);
  assert.equal(readRun(root).active, false);
});

test('batch IDs may be typed as bare numbers', () => {
  assert.equal(normalizeBatchId('0'), 'batch-000');
  assert.equal(normalizeBatchId('74'), 'batch-074');
  assert.equal(normalizeBatchId('074'), 'batch-074');
  assert.equal(normalizeBatchId('1234'), 'batch-1234');
  assert.equal(normalizeBatchId('batch-005'), 'batch-005');
  assert.equal(normalizeBatchId('1234567'), '1234567', 'too long to be a batch number');
  assert.equal(normalizeBatchId('-1'), '-1');
  const root = project();
  const r = capture(() => dispatchCommand(root, ['2']));
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.match(r.out[0] ?? '', /^Extract batch batch-002\./);
  assert.equal(readBatchState(root, 'batch-002').status, 'running');
  assert.equal(capture(() => dispatchCommand(root, ['003'])).code, 0);
  assert.equal(readBatchState(root, 'batch-003').status, 'running');
});

test('dispatch refuses an unknown or malformed batch ID and changes nothing', () => {
  const root = project();
  for (const bad of [['batch-999'], ['99'], ['../../etc/passwd'], [], ['batch-000', 'batch-001']]) {
    const r = capture(() => dispatchCommand(root, bad));
    assert.equal(r.code, 1, JSON.stringify(bad));
    assert.equal(r.out.length, 0, 'no prompt printed');
    assert.match(r.err[0] ?? '', /^dispatch: /);
  }
  assert.match(capture(() => dispatchCommand(root, ['batch-999'])).err[0] ?? '', /Unknown batch "batch-999" \(batches in out\/batches\/index\.json: batch-000 to batch-003\)/);
  assert.ok(!existsSync(join(root, 'out', 'ledger')), 'no ledger entry was written');
});

test('dispatch marks the batch running and prints the extractor prompt with absolute paths and the OUTPUT line', () => {
  const root = project();
  const r = capture(() => dispatchCommand(root, ['batch-002']));
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.equal(r.out.length, 1, 'only the prompt goes to stdout');
  const lines = (r.out[0] as string).split('\n');
  const base = root.replaceAll('\\', '/');
  assert.deepEqual(lines, [
    'Extract batch batch-002.',
    `Batch file: ${base}/out/batches/batch-002.md`,
    'Taxonomy file: none yet. Every process key must be new:<slug>, each defined in new_processes.',
    `Output file: ${base}/out/extract/batch-002.json`,
    'When the output file is written, end your reply with exactly this line:',
    'OUTPUT: out/extract/batch-002.json',
  ]);
  for (const line of lines) assert.ok(!line.includes('\\'), `forward slashes only: ${line}`);
  assert.match(lines[1] as string, /^Batch file: (?:[A-Za-z]:\/|\/)/, 'absolute');
  const state = readBatchState(root, 'batch-002');
  assert.deepEqual([state.status, state.dispatches], ['running', 1]);

  writeFileSync(join(root, 'out', 'taxonomy.json'), '{"processes": []}\n');
  const withTaxonomy = capture(() => dispatchCommand(root, ['batch-002']));
  assert.equal((withTaxonomy.out[0] as string).split('\n')[2], `Taxonomy file: ${base}/out/taxonomy.json`);
  assert.equal(readBatchState(root, 'batch-002').dispatches, 2);
});

test("the gate's OUTPUT parser reads the prompt's own last line, decorated or not", () => {
  const root = project();
  const last = extractorPrompt(root, 'batch-003').split('\n').at(-1) as string;
  assert.deepEqual(parseOutputLine(`Done.\n${last}`), { kind: 'named', batchId: 'batch-003' });
  assert.deepEqual(parseOutputLine(`Done.\n\`${last}\``), { kind: 'named', batchId: 'batch-003' });
  assert.deepEqual(parseOutputLine(`**${last}**`), { kind: 'named', batchId: 'batch-003' });
  assert.deepEqual(parseOutputLine('OUTPUT: C:\\work\\obs\\out\\extract\\batch-003.json'), { kind: 'named', batchId: 'batch-003' });
  assert.deepEqual(parseOutputLine('I wrote the file.'), { kind: 'missing' });
  assert.deepEqual(parseOutputLine('OUTPUT: somewhere.json'), { kind: 'unrecognised', text: 'somewhere.json' });
  assert.deepEqual(parseOutputLine('OUTPUT: out/extract/batch-001.json\nlater\nOUTPUT: out/extract/batch-002.json'), { kind: 'named', batchId: 'batch-002' });
});

test('withoutRoot cuts the project folder out of messages in every spelling', () => {
  const win = 'C:\\work\\obs';
  assert.equal(withoutRoot("ENOENT: open 'C:\\work\\obs\\out\\x.json'", win), "ENOENT: open 'out\\x.json'");
  assert.equal(withoutRoot('cannot read c:/work/obs/out/taxonomy.json', win), 'cannot read out/taxonomy.json');
  assert.equal(withoutRoot('see /c/work/obs/out/a and /mnt/c/work/obs/b', win), 'see out/a and b');
  assert.equal(withoutRoot('/srv/obs/out/x and /srv/obsolete', '/srv/obs'), 'out/x and /srv/obsolete', 'only the folder itself');
});
