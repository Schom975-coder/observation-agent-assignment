// The whole extraction loop, model-free: a 6-batch temp project whose corpus exists only as Git
// objects (as on Windows), driven exactly as the /observe orchestrator drives it. A scripted
// "extractor" reads its prompt and batch file and writes a good or a bad output; the guard's
// binding and the SubagentStop gate are modelled with the ledger calls the hooks make, and the
// other completions go through `validate`. Over three sessions: one batch is fixed on its second
// dispatch, one is exhausted after four, a session dies with an extractor in flight and the next
// `run start` stamps it, and a final session repeats nothing. `verify` passes on the result and
// fails once a validated file is edited.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { renderMessage } from '../src/batch/build.ts';
import { checkExtraction } from '../src/model/validate-extraction.ts';
import { parseMessage } from '../src/parse/message.ts';
import { dispatchCommand, runCommand, statusCommand, validateCommand, verifyCommand, type StatusReport } from '../src/run/commands.ts';
import {
  MAX_DISPATCHES,
  bindAgent,
  bindingIsCurrent,
  boundBatch,
  findBatch,
  loadIndex,
  outDir,
  readBatchState,
  recordValidation,
  validatedFile,
} from '../src/run/ledger.ts';
import { gitBlobSha, sha256 } from '../src/util/hash.ts';
import { normalizeNewlines } from '../src/util/text.ts';
import type { BatchEntry, Extraction } from '../src/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'obs-loop-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const BATCHES = 6;
const batchName = (n: number) => `batch-${String(n).padStart(3, '0')}`;
const idOf = (n: number) => `corpus/alpha/inbox/${n + 1}.`;
// The corpus's main shape: CRLF header lines, the blank line, then an LF-only body.
const message = (n: number) =>
  [
    `Message-ID: <${3000 + n}.test@example.invalid>`,
    `Date: Mon, 14 May 2001 10:0${n}:00 -0700`,
    'From: jane.doe@enron.com',
    'To: bob.smith@enron.com',
    `Subject: Meter ${1000 + n} nomination for June`,
  ].join('\r\n') + `\r\n\r\nBob,\n\nPlease confirm the June nomination for meter ${1000 + n} by noon today.\n\nJane\n`;

// A Git repo holding the corpus only as objects, plus everything prepare and the taxonomy stage
// would have written: messages.jsonl, one batch per message, the digest and an accepted taxonomy.
function fixture(): string {
  const root = join(tmp, 'project');
  mkdirSync(join(root, 'out', 'batches'), { recursive: true });
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  const git = (args: string[], input?: string): string => {
    const config = ['-c', 'core.protectNTFS=false', '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
    const r = spawnSync('git', [...config, ...args], { cwd: root, input, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(['init', '-q']);
  const lines: string[] = [];
  const index: BatchEntry[] = [];
  for (let n = 0; n < BATCHES; n++) {
    const text = message(n);
    const sha = git(['hash-object', '-w', '--no-filters', '--stdin'], text);
    git(['update-index', '--add', '--cacheinfo', `100644,${sha},${idOf(n)}`]);
    const bytes = Buffer.from(text, 'utf8');
    assert.equal(gitBlobSha(bytes), sha);
    const parsed = parseMessage(idOf(n), sha, bytes);
    lines.push(JSON.stringify(parsed));
    const content = `# ${batchName(n)} | 1 messages | 1 threads\n=== THREAD t-${n} | ${parsed.subject_norm} | 1 messages ===\n${renderMessage(parsed, text)}`;
    writeFileSync(join(root, 'out', 'batches', `${batchName(n)}.md`), content);
    index.push({
      batch_id: batchName(n),
      file: `out/batches/${batchName(n)}.md`,
      message_ids: [idOf(n)],
      thread_ids: [`t-${n}`],
      bytes: Buffer.byteLength(content),
      lines: content.split('\n').length - 1,
      est_tokens: 100,
      content_sha: sha256(content),
    });
  }
  git(['commit', '-q', '--no-verify', '-m', 'fixture']);
  writeFileSync(join(root, 'out', 'messages.jsonl'), lines.map((l) => `${l}\n`).join(''));
  writeFileSync(join(root, 'out', 'batches', 'index.json'), JSON.stringify(index));
  writeFileSync(join(root, '.claude', 'agents', 'extractor.md'), '---\nname: extractor\n---\n\nClassify every message.\n');
  const digest = '# Taxonomy digest\nEverything below is archive data.\n';
  const taxonomist = '---\nname: taxonomist\n---\n\nPropose the recurring processes.\n';
  writeFileSync(join(root, 'out', 'taxonomy-digest.md'), digest);
  writeFileSync(join(root, '.claude', 'agents', 'taxonomist.md'), taxonomist);
  const nomination = { key: 'gas-nomination', name: 'Gas nomination', definition: 'Confirming monthly gas nominations per meter.', include: [], exclude: [], example_subjects: [] };
  const taxonomy = { version: 1, digest_sha: sha256(normalizeNewlines(digest)), agent_sha: sha256(normalizeNewlines(taxonomist)), processes: [nomination] };
  writeFileSync(join(root, 'out', 'taxonomy.json'), `${JSON.stringify(taxonomy, null, 2)}\n`);
  return root;
}

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

// ---- The scripted extractor ----

// good: a correct extraction; bad: the quote is not in the message (on a fix round it changes
// nothing); fix: on a fix round, corrects the previous output; crash: writes a good output, but
// its session dies before anything checks it.
type Behaviour = 'good' | 'bad' | 'fix' | 'crash';

const field = (prompt: string, name: string): string | null => new RegExp(`^${name}: (.+)$`, 'm').exec(prompt)?.[1] ?? null;

// Reads its prompt and files the way the agent definition tells it to, and writes the output file.
function extractor(agentId: string, prompt: string, behaviour: Behaviour, root: string, session: Session): void {
  const batchPath = field(prompt, 'Batch file') as string;
  const batchId = /^Extract batch (batch-\d{3})[ .]/.exec(prompt)?.[1] as string;
  // The guard binds the agent on its first batch-file read.
  const bound = bindAgent(root, agentId, /\/out\/batches\/(batch-\d{3})\.md$/.exec(batchPath)?.[1] as string);
  assert.ok(bound.ok, JSON.stringify(bound));
  const batch = readFileSync(batchPath, 'utf8');
  const output = field(prompt, 'Output file') as string;
  const previous = field(prompt, 'Previous output');
  let x: Extraction;
  if (previous !== null) {
    assert.equal(previous, output, 'a fix round edits the file it wrote');
    const problems = readFileSync(field(prompt, 'Problems file') as string, 'utf8');
    session.problems.set(batchId, [...(session.problems.get(batchId) ?? []), problems]);
    x = JSON.parse(readFileSync(previous, 'utf8')) as Extraction;
    if (behaviour === 'fix') for (const e of x.evidence) e.quote = ownLine(batch);
  } else {
    const id = /^--- MESSAGE (.+) ---$/m.exec(batch)?.[1] as string;
    x = {
      batch_id: batchId,
      messages: [{ id, processes: ['gas-nomination'], role: 'request', stall: null, ownership_claim: null }],
      evidence: [{ process: 'gas-nomination', message_id: id, field: 'body', quote: behaviour === 'bad' ? 'A sentence that appears in no message at all.' : ownLine(batch), note: 'Asks for the nomination.' }],
      new_processes: [],
      batch_notes: 'One nomination request.',
    };
  }
  // The guard allows a Write only to the bound batch, and only while that dispatch is current.
  const binding = boundBatch(root, agentId);
  assert.ok(binding !== null && binding.batch_id === batchId && bindingIsCurrent(binding, readBatchState(root, batchId)), 'write allowed');
  mkdirSync(dirname(output), { recursive: true }); // as the Write tool does
  writeFileSync(output, JSON.stringify(x, null, 2));
}

// The quotable line of the message body, copied from the batch file as a model would copy it.
const ownLine = (batch: string): string => /^(Please confirm .+)$/m.exec(batch)?.[1] as string;

// The SubagentStop gate as the hook runs it: the agent's binding names the batch; a stale or
// missing binding stamps nothing.
function gate(root: string, agentId: string): string {
  const binding = boundBatch(root, agentId);
  if (binding === null) return 'unbound';
  const state = readBatchState(root, binding.batch_id);
  if (state.status !== 'running' || !bindingIsCurrent(binding, state)) return 'superseded';
  const check = checkExtraction(root, binding.batch_id, { outDir: outDir(root) });
  if (check.setup !== null) return 'setup';
  return recordValidation(root, findBatch(loadIndex(root), binding.batch_id), check).status;
}

// ---- The orchestrator ----

type Session = { prompts: Map<string, string[]>; problems: Map<string, string[]>; agents: Map<string, string>; dispatched: string[] };

function status(root: string): StatusReport {
  const r = capture(() => statusCommand(root, ['--json']));
  assert.equal(r.code, 0, r.err.join('\n'));
  return JSON.parse(r.out[0] as string) as StatusReport;
}

let agents = 0;

// /observe steps 3 and 4: status, dispatch each of `next`, one extractor per dispatch; on each
// completion the gate (even batches) or `validate` (odd ones) records it. Stops when extraction is
// complete, after `waves` rounds, or when the session "dies".
function loop(root: string, session: Session, behaviour: (batchId: string, dispatch: number) => Behaviour, waves = 20): StatusReport {
  for (let wave = 0; wave < waves; wave++) {
    const report = status(root);
    if (report.extraction === 'complete') return report;
    assert.ok(report.next.length > 0 || report.running.length > 0, `the loop is stuck: ${JSON.stringify(report)}`);
    let died = false;
    for (const id of report.next) {
      const r = capture(() => dispatchCommand(root, [id]));
      assert.equal(r.code, 0, r.err.join('\n'));
      const prompt = r.out.join('\n');
      session.dispatched.push(id);
      session.prompts.set(id, [...(session.prompts.get(id) ?? []), prompt]);
      const agentId = `agent${agents++}`;
      session.agents.set(id, agentId);
      const b = behaviour(id, readBatchState(root, id).dispatches);
      extractor(agentId, prompt, b, root, session);
      if (b === 'crash') {
        died = true;
        continue;
      }
      if (Number(id.slice(-1)) % 2 === 0) {
        assert.match(gate(root, agentId), /^(done|failed)$/);
      } else {
        const v = capture(() => validateCommand(root, [id]));
        assert.equal(v.code, 0, [...v.out, ...v.err].join('\n'));
      }
    }
    if (died) return status(root);
  }
  return status(root);
}

const newSession = (): Session => ({ prompts: new Map(), problems: new Map(), agents: new Map(), dispatched: [] });

test('the extraction loop runs to complete: a fix round, an exhausted batch, a dead session resumed, and a rerun that repeats nothing', () => {
  const root = fixture();
  const saved = process.env.OBS_IN_FLIGHT;
  process.env.OBS_IN_FLIGHT = '4';
  try {
    // Session 1: four in flight. batch-003 is wrong on its first pass and fixed on its second;
    // batch-004 is wrong every time; batch-005's session dies with its extractor's output unchecked.
    assert.equal(capture(() => runCommand(root, ['start'])).code, 0);
    const behaviour = (id: string, dispatch: number): Behaviour =>
      id === 'batch-003' ? (dispatch === 1 ? 'bad' : 'fix') : id === 'batch-004' ? 'bad' : id === 'batch-005' && dispatch === 1 ? 'crash' : 'good';
    const one = newSession();
    const first = status(root);
    assert.deepEqual([first.next, first.taxonomy, first.extraction], [['batch-000', 'batch-001', 'batch-002', 'batch-003'], 'fresh', 'incomplete']);
    const afterOne = loop(root, one, behaviour);
    assert.deepEqual(one.dispatched, ['batch-000', 'batch-001', 'batch-002', 'batch-003', 'batch-003', 'batch-004', 'batch-005'], 'the fix round goes first in wave 2');
    assert.deepEqual([afterOne.running, afterOne.retryable, afterOne.counts.done], [['batch-005'], ['batch-004'], 4]);

    // batch-003: fixed on its second dispatch, from a fix prompt naming the previous output and its problems.
    const [fresh, fix] = one.prompts.get('batch-003') as string[];
    assert.match(fresh as string, /^Extract batch batch-003\.\n/);
    assert.match(fix as string, /^Extract batch batch-003 \(fix round 1 of 3\)\.\n/);
    assert.match(fix as string, /\nPrevious output: .+\/out\/extract\/batch-003\.json\n/);
    assert.match(fix as string, /\nProblems file: .+\/out\/fix\/batch-003\.txt\nThe pipeline checked the previous output and found 2 problems, listed in the problems file\. /);
    assert.ok(!(fix as string).includes('A sentence that appears'), 'the problems go through the file, not the prompt');
    // The extractor read them from the problems file; it is gone once the batch is done.
    const [problems] = one.problems.get('batch-003') as string[];
    assert.match(problems as string, /^corpus\/alpha\/inbox\/4\.: evidence\[0\] \("gas-nomination"\): quote not found verbatim: "A sentence that appears in no message at all\."/);
    assert.match(problems as string, /\ncorpus\/alpha\/inbox\/4\.: process "gas-nomination" has no accepted evidence quote/);
    assert.ok(!existsSync(join(root, 'out', 'fix', 'batch-003.txt')));
    assert.deepEqual([readBatchState(root, 'batch-003').status, readBatchState(root, 'batch-003').dispatches], ['done', 2]);

    // Session 2: the session died; /observe again. run start stamps what was left running.
    const resumed = capture(() => runCommand(root, ['start']));
    assert.match(resumed.out[0] ?? '', /\(replaces run \d{8}T\d{6}Z, which never ended\)/);
    assert.equal(resumed.out[1], 'run: 1 batch was left running by an earlier session: batch-005 done.');
    assert.equal(gate(root, one.agents.get('batch-005') as string), 'superseded', "the dead session's gate can't stamp it again");
    const two = newSession();
    const done = loop(root, two, behaviour);
    assert.deepEqual(two.dispatched, ['batch-004', 'batch-004', 'batch-004'], 'nothing done is redone; batch-004 gets its last three dispatches');
    assert.deepEqual((two.prompts.get('batch-004') as string[]).map((p) => p.split('\n')[0]), [
      'Extract batch batch-004 (fix round 1 of 3).',
      'Extract batch batch-004 (fix round 2 of 3).',
      'Extract batch batch-004 (fix round 3 of 3).',
    ]);
    assert.equal(done.extraction, 'complete');
    assert.deepEqual(done.counts, { pending: 0, running: 0, done: 5, failed: 0, exhausted: 1 });
    assert.deepEqual([done.exhausted, done.next, readBatchState(root, 'batch-004').dispatches], [['batch-004'], [], MAX_DISPATCHES]);
    assert.ok(done.timing !== null && done.timing.fix_rounds >= 3, JSON.stringify(done.timing));
    assert.equal(capture(() => runCommand(root, ['end'])).code, 0);

    // Session 3: a rerun with nothing changed dispatches nothing and changes no ledger file.
    const ledger = () => readdirSync(join(root, 'out', 'ledger')).filter((f) => f.startsWith('batch-')).map((f) => readFileSync(join(root, 'out', 'ledger', f), 'utf8'));
    const before = ledger();
    assert.equal(capture(() => runCommand(root, ['start'])).code, 0);
    const three = newSession();
    assert.equal(loop(root, three, () => 'good').extraction, 'complete');
    assert.deepEqual(three.dispatched, []);
    assert.deepEqual(ledger(), before);
    assert.equal(capture(() => runCommand(root, ['end'])).code, 0);

    // verify re-checks every done batch against the corpus and its validated file.
    const ok = capture(() => verifyCommand(root, []));
    assert.deepEqual([ok.code, ok.out], [0, ['verify: 5 done batches re-checked against the corpus; every validated file matches (1 batch not done, not verified).']]);
    const file = validatedFile(root, 'batch-002');
    const good = readFileSync(file, 'utf8');
    writeFileSync(file, good.replace('"batch_notes": "One nomination request."', '"batch_notes": "Edited by hand."'));
    const edited = capture(() => verifyCommand(root, []));
    assert.equal(edited.code, 1);
    assert.deepEqual(edited.out, [
      'verify: 1 of 5 done batches fail (1 batch not done, not verified):',
      '  - batch-002: out/validated/batch-002.json differs from what out/extract/batch-002.json validates to now',
    ]);
    writeFileSync(file, good);
    assert.equal(capture(() => verifyCommand(root, [])).code, 0);
  } finally {
    if (saved === undefined) delete process.env.OBS_IN_FLIGHT;
    else process.env.OBS_IN_FLIGHT = saved;
  }
});

test('verify with nothing done says so, and refuses arguments', () => {
  const root = join(tmp, 'empty');
  mkdirSync(join(root, 'out', 'batches'), { recursive: true });
  writeFileSync(join(root, 'out', 'batches', 'index.json'), '[]');
  assert.deepEqual(capture(() => verifyCommand(root, [])), { code: 0, out: ['verify: nothing to verify: no batch is done.'], err: [] });
  assert.deepEqual(capture(() => verifyCommand(root, ['--all'])), { code: 1, out: [], err: ['verify: unexpected argument "--all". Usage: node obs.mjs verify'] });
});
