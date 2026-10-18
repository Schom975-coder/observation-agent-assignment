// The whole extraction loop, model-free: a 6-batch temp project whose corpus exists only as Git
// objects (as on Windows), driven exactly as the /observe orchestrator drives it. A scripted
// "extractor" reads its prompt and batch file and writes a good or a bad output; the guard's
// binding and the SubagentStop gate are modelled with the ledger calls the hooks make, and the
// other completions go through `validate`. Over three sessions: one batch is fixed on its second
// dispatch, one is exhausted after four, a session dies with an extractor in flight and the next
// `run start` stamps it, and a final session repeats nothing. `verify` passes on the result and
// fails once a validated file is edited.
//
// Then the M5 stages on a second project (30 messages, six taxonomy keys and three proposed ones):
// the same loop through merge (one fix round), rollup, synthesis (driven by `refill`, as the
// skill does: one group fixed on round 2, one exhausted, a session dying mid-synthesis and the
// next resuming without repeating anything) and score, with `status --json` walking every stage
// and `verify` covering batches and synthesis groups.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMessage } from '../src/batch/build.ts';
import { checkExtraction } from '../src/model/validate-extraction.ts';
import { parseMessage } from '../src/parse/message.ts';
import {
  advanceCommand,
  dispatchCommand,
  refillCommand,
  runCommand,
  statusCommand,
  validateCommand,
  verifyCommand,
  type AdvanceReport,
  type RefillReport,
  type StatusReport,
} from '../src/run/commands.ts';
import { SYNTH_MAX_GROUPS } from '../src/model/synthesis-input.ts';
import { canonicalTaxonomy } from '../src/model/taxonomy.ts';
import { buildPeople } from '../src/normalize/people.ts';
import { buildThreads } from '../src/normalize/threads.ts';
import { mergeCommand } from '../src/run/merge.ts';
import { rollupCommand } from '../src/run/rollup.ts';
import { scoreCommand } from '../src/run/score.ts';
import {
  MAX_DISPATCHES,
  bindAgent,
  bindingIsCurrent,
  boundBatch,
  findBatch,
  loadIndex,
  outDir,
  readBatchState,
  readRun,
  recordValidation,
  validatedFile,
} from '../src/run/ledger.ts';
import { gitBlobSha, sha256 } from '../src/util/hash.ts';
import { normalizeNewlines } from '../src/util/text.ts';
import type { BatchEntry, Extraction, Opportunities, SynthesisGroup, SynthSidecar } from '../src/types.ts';

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

// A job prompt read the way the agent definitions say (ARCHITECTURE.md 6.22): the job and whether
// it is a fix round from the first line, the project folder from the second, and every file as a
// path under the folder joined with "/".
type Task = { id: string; fix: boolean; at: (rel: string) => string };
function task(prompt: string, verb: 'Extract' | 'Synthesize'): Task {
  const lines = prompt.split('\n');
  assert.equal(lines.length, 2, prompt);
  const m = new RegExp(`^${verb} ((?:batch|synth)-\\d{3})(\\.| \\(fix round \\d+ of \\d+\\): \\d+ problems? in the problems file\\.)$`).exec(lines[0] as string);
  assert.ok(m !== null, lines[0]);
  const folder = /^Project folder: (.+)$/.exec(lines[1] as string)?.[1] as string;
  assert.ok(folder !== undefined && !folder.includes('\\'), lines[1]);
  return { id: m[1] as string, fix: m[2] !== '.', at: (rel) => `${folder}/${rel}` };
}

// Reads its prompt and files the way the agent definition tells it to, and writes the output file.
function extractor(agentId: string, prompt: string, behaviour: Behaviour, root: string, session: Session): void {
  const { id: batchId, fix, at } = task(prompt, 'Extract');
  const batchPath = at(`out/batches/${batchId}.md`);
  // The guard binds the agent on its first batch-file read.
  const bound = bindAgent(root, agentId, /\/out\/batches\/(batch-\d{3})\.md$/.exec(batchPath)?.[1] as string);
  assert.ok(bound.ok, JSON.stringify(bound));
  const batch = readFileSync(batchPath, 'utf8');
  const output = at(`out/extract/${batchId}.json`);
  let x: Extraction;
  if (fix) {
    // A fix round edits the file it wrote, with the problems from the problems file.
    const problems = readFileSync(at(`out/fix/${batchId}.txt`), 'utf8');
    session.problems.set(batchId, [...(session.problems.get(batchId) ?? []), problems]);
    x = JSON.parse(readFileSync(output, 'utf8')) as Extraction;
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
    const folder = `Project folder: ${root.replaceAll('\\', '/')}`;
    assert.equal(fresh, `Extract batch-003.\n${folder}`);
    assert.equal(fix, `Extract batch-003 (fix round 1 of 3): 2 problems in the problems file.\n${folder}`);
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
      'Extract batch-004 (fix round 1 of 3): 2 problems in the problems file.',
      'Extract batch-004 (fix round 2 of 3): 2 problems in the problems file.',
      'Extract batch-004 (fix round 3 of 3): 2 problems in the problems file.',
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

    // A changed extractor definition re-keys every batch: none is verified, and verify says how
    // many done batches it skipped as stale, without changing its exit code.
    const agent = join(root, '.claude', 'agents', 'extractor.md');
    const definition = readFileSync(agent, 'utf8');
    writeFileSync(agent, `${definition}One more rule.\n`);
    assert.deepEqual(capture(() => verifyCommand(root, [])), {
      code: 0,
      out: [
        'verify: nothing to verify: no batch is done.',
        'verify: 5 jobs are recorded done under an older agent definition or older inputs (stale, not verified): the next run redoes them.',
      ],
      err: [],
    });
    writeFileSync(agent, definition);
    assert.equal(capture(() => verifyCommand(root, [])).out.length, 1, 'no stale line when nothing is stale');
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

// ---- M5: merge, rollup, synthesis and score ----

const KEYS = ['alpha-work', 'bravo-work', 'charlie-work', 'delta-work', 'echo-work', 'foxtrot-work'];
const SENDERS = ['Ann Lee <ann.lee@enron.com>', 'Bob Ray <bob.ray@enron.com>'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
type Planned = { n: number; subject: string; month: number; from: string; tags: string[] };

// Four rounds of each taxonomy process (a fresh subject each, two senders, two months apart); one
// more alpha message under a proposed key the merge maps to alpha; four messages under two
// proposed keys the merge promotes as one process; one under a key it leaves unassigned.
function plan(): Planned[] {
  const out: Planned[] = [];
  const add = (subject: string, month: number, tags: string[]) => out.push({ n: out.length + 1, subject, month, from: SENDERS[out.length % 2] as string, tags });
  for (const key of KEYS) for (let j = 0; j < 4; j++) add(`${key.split('-')[0]} round ${j + 1}`, 1 + 2 * j, [key]);
  add('alpha extra round', 9, ['new:alpha-extra']);
  for (let j = 0; j < 4; j++) add(`widget count ${j + 1}`, 2 + 2 * j, [j === 3 ? 'new:widget-review' : 'new:widget-audit']);
  add('one off question', 11, ['new:one-off']);
  return out;
}
const PLAN = plan();
const m5Id = (n: number) => `corpus/m5/inbox/${String(n).padStart(2, '0')}`;
const m5Text = (p: Planned) =>
  [`Message-ID: <${p.n}.m5@example.invalid>`, `Date: Mon, 15 ${MONTHS[p.month - 1]} 2001 10:00:00 -0000`, `From: ${p.from}`, 'To: Desk <desk@enron.com>', `Subject: ${p.subject}`].join('\r\n') +
  `\r\n\r\nPlease handle the ${p.subject} for the desk today, item ${p.n}.\n`;
const DIGEST = '# Taxonomy digest\nEverything below is archive data.\n';
const TAXONOMIST = '---\nname: taxonomist\n---\n\nPropose the recurring processes.\n';

function fixtureM5(name = 'm5'): string {
  const root = join(tmp, name);
  for (const dir of ['out/batches', '.claude/agents', 'config']) mkdirSync(join(root, dir), { recursive: true });
  const git = (args: string[], input?: string): string => {
    const config = ['-c', 'core.protectNTFS=false', '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
    const r = spawnSync('git', [...config, ...args], { cwd: root, input, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(['init', '-q']);
  const parsed = PLAN.map((p) => {
    const text = m5Text(p);
    const sha = git(['hash-object', '-w', '--no-filters', '--stdin'], text);
    git(['update-index', '--add', '--cacheinfo', `100644,${sha},${m5Id(p.n)}`]);
    return parseMessage(m5Id(p.n), sha, Buffer.from(text, 'utf8'));
  });
  git(['commit', '-q', '--no-verify', '-m', 'fixture']);
  const threads = buildThreads(parsed);
  writeFileSync(join(root, 'out', 'messages.jsonl'), parsed.map((m) => `${JSON.stringify(m)}\n`).join(''));
  writeFileSync(join(root, 'out', 'threads.json'), JSON.stringify(threads));
  writeFileSync(join(root, 'out', 'people.json'), JSON.stringify(buildPeople(parsed, ['enron.com'])));
  writeFileSync(join(root, 'out', 'prepare-stats.json'), JSON.stringify({ corpus_hash: 'c'.repeat(64), suspected_injection: [], oversize: [] }));
  const index: BatchEntry[] = [];
  for (let b = 0; b * 5 < parsed.length; b++) {
    const id = batchName(b);
    const ms = parsed.slice(b * 5, b * 5 + 5);
    const content = `# ${id} | ${ms.length} messages | ${ms.length} threads\n${ms.map((m) => `=== THREAD t | ${m.subject_norm} | 1 messages ===\n${renderMessage(m, m5Text(PLAN[Number(m.id.slice(-2)) - 1] as Planned))}`).join('')}`;
    writeFileSync(join(root, 'out', 'batches', `${id}.md`), content);
    index.push({ batch_id: id, file: `out/batches/${id}.md`, message_ids: ms.map((m) => m.id), thread_ids: [], bytes: Buffer.byteLength(content), lines: content.split('\n').length - 1, est_tokens: 100, content_sha: sha256(content) });
  }
  writeFileSync(join(root, 'out', 'batches', 'index.json'), JSON.stringify(index));
  writeFileSync(join(root, 'out', 'taxonomy-digest.md'), DIGEST);
  for (const [name, text] of [['extractor', 'Classify every message.'], ['taxonomist', null], ['merger', 'Merge the proposed keys.'], ['synthesizer', 'Describe and estimate.']] as const) {
    writeFileSync(join(root, '.claude', 'agents', `${name}.md`), text === null ? TAXONOMIST : `---\nname: ${name}\n---\n\n${text}\n`);
  }
  for (const f of ['effort-rates.json', 'scoring.json']) writeFileSync(join(root, 'config', f), readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'config', f)));
  return root;
}

function acceptTaxonomy(root: string): void {
  const processes = KEYS.map((key) => ({ key, name: `${key.split('-')[0]} work`, definition: `The recurring ${key.split('-')[0]} work of the desk.`, include: [], exclude: [], example_subjects: [`${key.split('-')[0]} round 1`] }));
  const taxonomy = canonicalTaxonomy(processes, sha256(normalizeNewlines(DIGEST)), sha256(normalizeNewlines(TAXONOMIST)));
  writeFileSync(join(root, 'out', 'taxonomy.json'), `${JSON.stringify(taxonomy, null, 2)}\n`);
}

// Extracts a batch as planned: each message's tags, its "Please handle" line as the quote, and a
// declaration for every proposed key the batch uses.
function plannedExtractor(prompt: string): void {
  const { id: batchId, at } = task(prompt, 'Extract');
  const batch = readFileSync(at(`out/batches/${batchId}.md`), 'utf8');
  const ids = [...batch.matchAll(/^--- MESSAGE (.+) ---$/gm)].map((m) => m[1] as string);
  const planned = ids.map((id) => PLAN[Number(id.slice(-2)) - 1] as Planned);
  const used = [...new Set(planned.flatMap((p) => p.tags.filter((t) => t.startsWith('new:'))))];
  const x: Extraction = {
    batch_id: batchId,
    messages: planned.map((p) => ({ id: m5Id(p.n), processes: p.tags, role: 'request', stall: null, ownership_claim: null })),
    evidence: planned.flatMap((p) => p.tags.map((t) => ({ process: t, message_id: m5Id(p.n), field: 'body' as const, quote: `Please handle the ${p.subject} for the desk today, item ${p.n}.`, note: 'The request.' }))),
    new_processes: used.map((key) => ({ key, name: key.slice(4).replace(/-/g, ' '), definition: `Proposed: ${key.slice(4)} handled by the desk.`, example_ids: [] })),
    batch_notes: '',
  };
  const output = at(`out/extract/${batchId}.json`);
  mkdirSync(dirname(output), { recursive: true }); // as the Write tool does
  writeFileSync(output, JSON.stringify(x, null, 2));
}

// The synthesizer as a script: good, bad (a mid of 900: E1), long (a 650-character description:
// over the stated 600, inside the margin), unknown (a stall citing an id the input does not show),
// or fix (the previous output with the minutes put back and the unknown id dropped). It reads the
// sidecar to choose ids from three occurrences and two senders; the real agent reads the same facts
// from the group input's lines.
type SynthBehaviour = 'good' | 'bad' | 'long' | 'unknown' | 'fix';
const UNKNOWN_ID = 'batch-099:e99';
function scriptedSynthesizer(root: string, prompt: string, behaviour: SynthBehaviour): void {
  const { id: groupId, fix, at } = task(prompt, 'Synthesize');
  const output = at(`out/synthesis/raw/${groupId}.json`);
  mkdirSync(dirname(output), { recursive: true });
  if (fix && behaviour === 'fix') {
    const g = JSON.parse(readFileSync(output, 'utf8')) as SynthesisGroup;
    for (const p of g.processes) {
      if (p.work_estimate !== null) p.work_estimate.minutes_per_occurrence = { low: 20, mid: 30, high: 45 };
      p.stalls = p.stalls.filter((s) => !s.evidence_ids.includes(UNKNOWN_ID));
    }
    writeFileSync(output, JSON.stringify(g));
    return;
  }
  const sidecar = JSON.parse(readFileSync(join(root, 'out', 'synthesis', 'input', `${groupId}.json`), 'utf8')) as SynthSidecar;
  const g: SynthesisGroup = {
    group_id: groupId,
    processes: sidecar.processes.map((p) => {
      const seen = new Set<string>();
      const ids = p.cited.filter((c) => c.kind === 'evidence' && !seen.has(c.occurrence_id) && seen.add(c.occurrence_id)).slice(0, 3).map((c) => c.id);
      const description = `The desk handles the ${p.key.split('-')[0]} requests that come round every other month and confirms each one.`;
      return {
        key: p.key,
        description: behaviour === 'long' ? `${description} ${'And it checks the figures again. '.repeat(30)}`.slice(0, 650) : description,
        steps: ['Read the request', 'Handle it', 'Confirm back'],
        stalls: behaviour === 'unknown' ? [{ summary: 'A request waits on the desk', evidence_ids: [UNKNOWN_ID] }] : [],
        contradictions: [],
        automation: { approach: 'A request tracker with a confirmation template', artifact_type: 'checklist' as const, rationale: 'Each round repeats the same steps.' },
        work_estimate:
          p.occurrences < 3
            ? null
            : { minutes_per_occurrence: behaviour === 'bad' ? { low: 20, mid: 900, high: 900 } : { low: 20, mid: 30, high: 45 }, automatable_pct: 50, basis: 'observed' as const, rationale: 'Read, handle and confirm: about half an hour a round.', evidence_ids: ids },
      };
    }),
  };
  writeFileSync(output, JSON.stringify(g));
}

const refill = (root: string, ids: string[]): RefillReport => {
  const r = capture(() => refillCommand(root, [...ids, '--json']));
  assert.equal(r.code, 0, r.err.join('\n'));
  return JSON.parse(r.out[0] as string) as RefillReport;
};
const stageOf = (root: string): string => status(root).stage;

test('the loop continues through merge, rollup, synthesis and score: a merge fix round, a group fixed on round 2, one exhausted, a resumed session; verify covers both kinds', () => {
  const root = fixtureM5();
  const saved = process.env.OBS_IN_FLIGHT;
  delete process.env.OBS_IN_FLIGHT;
  try {
    assert.equal(capture(() => runCommand(root, ['start'])).code, 0);
    const stages = [stageOf(root)];
    acceptTaxonomy(root);
    stages.push(stageOf(root));

    // Extraction, one refill per completion wave.
    let wave = refill(root, []);
    while (wave.jobs.length > 0) {
      for (const j of wave.jobs) plannedExtractor(j.prompt);
      wave = refill(root, wave.jobs.map((j) => j.id));
    }
    assert.deepEqual([wave.stage, wave.extraction], ['merge', 'complete']);
    stages.push(stageOf(root));

    // The merge: a bad target first (one fix round), then the table.
    const prompt = capture(() => mergeCommand(root, [])).out[0] as string;
    assert.match(prompt, /^Merge the proposed process keys into the taxonomy\.\n/);
    const good = {
      mapped: { 'alpha-work': ['new:alpha-extra'] },
      unassigned: ['new:one-off'],
      promoted: [{ key: 'widget-checks', name: 'Widget checks', definition: 'Checking the widget counts with the desk each round and fixing them.', aliases: ['new:widget-audit', 'new:widget-review'] }],
    };
    assert.equal(prompt.split('\n')[1], `Project folder: ${root.replaceAll('\\', '/')}`);
    const proposed = join(root, 'out', 'merge-proposed.json');
    writeFileSync(proposed, JSON.stringify({ ...good, mapped: { nominations: ['new:alpha-extra'] } }));
    assert.match(capture(() => mergeCommand(root, ['accept'])).out[0] ?? '', /not accepted: 1 problem/);
    assert.match(capture(() => mergeCommand(root, [])).out[0] ?? '', /^Fix the process-key merge proposal\.\n/);
    writeFileSync(proposed, JSON.stringify(good));
    assert.match(capture(() => mergeCommand(root, ['accept'])).out[0] ?? '', /^merge: accepted on attempt 2: 4 proposed keys: 1 mapped, 2 in 1 promoted process, 1 unassigned, 0 demoted/);
    stages.push(stageOf(root));

    const rolled = capture(() => rollupCommand(root, []));
    // One group per process: seven processes, fewer than a wave's twenty groups (5.8).
    assert.deepEqual(rolled.out, ['rollup: 7 processes (1 promoted), 29 counted messages in 29 occurrences; 1 tagged message unassigned; 7 synthesis groups.']);
    stages.push(stageOf(root));
    const GROUPS = Array.from({ length: 7 }, (_, i) => `synth-00${i}`);

    // Synthesis, session 1: synth-000 (alpha) wrong then fixed, synth-001 (bravo) always wrong, the
    // rest right but their session dies before anything checks them.
    const behaviour = (id: string, dispatch: number): SynthBehaviour => (id === 'synth-000' ? (dispatch === 1 ? 'bad' : 'fix') : id === 'synth-001' ? 'bad' : 'good');
    const dispatched: string[] = [];
    const first = refill(root, []);
    assert.deepEqual(first.jobs.map((j) => [j.id, j.description]), GROUPS.map((id) => [id, `Synthesize ${id}`]), 'every group in one wave');
    for (const j of first.jobs) {
      dispatched.push(j.id);
      scriptedSynthesizer(root, j.prompt, behaviour(j.id, readBatchState(root, j.id).dispatches));
    }
    const second = refill(root, ['synth-000', 'synth-001']);
    assert.deepEqual(second.validated.map((v) => [v.id, v.status]), [['synth-000', 'failed'], ['synth-001', 'failed']]);
    assert.deepEqual(second.jobs.map((j) => j.prompt.split('\n')[0]?.replace(/: \d+ problems?/, ': N problems')), [
      'Synthesize synth-000 (fix round 1 of 3): N problems in the problems file.',
      'Synthesize synth-001 (fix round 1 of 3): N problems in the problems file.',
    ]);
    for (const j of second.jobs) {
      dispatched.push(j.id);
      scriptedSynthesizer(root, j.prompt, behaviour(j.id, readBatchState(root, j.id).dispatches));
    }
    // The session dies here, with every group left running.
    assert.deepEqual(status(root).synthesis.running, GROUPS);

    // Session 2: run start stamps what was left; nothing done is redone; synth-001 uses up its dispatches.
    const resumed = capture(() => runCommand(root, ['start']));
    assert.equal(
      resumed.out[1],
      'run: 7 synthesis groups were left running by an earlier session: synth-000 done, synth-001 failed, synth-002 done, synth-003 done, synth-004 done, synth-005 done, synth-006 done.',
    );
    let more = refill(root, []);
    while (more.jobs.length > 0) {
      for (const j of more.jobs) {
        dispatched.push(j.id);
        scriptedSynthesizer(root, j.prompt, behaviour(j.id, readBatchState(root, j.id).dispatches));
      }
      more = refill(root, more.jobs.map((j) => j.id));
    }
    assert.deepEqual(dispatched, [...GROUPS, 'synth-000', 'synth-001', 'synth-001', 'synth-001']);
    assert.deepEqual([more.stage, more.exhausted, readBatchState(root, 'synth-001').dispatches], ['score', ['synth-001'], MAX_DISPATCHES]);
    stages.push(stageOf(root));

    // Score: the exhausted group's process is priced on its counted part and flagged.
    const scored = capture(() => scoreCommand(root, []));
    assert.equal(scored.code, 0, scored.err.join('\n'));
    assert.match(scored.out[0] ?? '', /; 7 opportunities \(0 A, 0 B, 7 C\); 1 estimate missing; wrote out\/opportunities\.json\.$/);
    const opportunities = JSON.parse(readFileSync(join(root, 'out', 'opportunities.json'), 'utf8')) as Opportunities;
    const byKey = new Map(opportunities.opportunities.map((o) => [o.key, o]));
    for (const key of ['bravo-work']) {
      assert.deepEqual([byKey.get(key)?.flags, byKey.get(key)?.estimated], [['synthesis_missing', 'estimate_missing'], null], key);
      assert.ok((byKey.get(key)?.counted.email_x100.today ?? 0) > 0, `${key} keeps its counted part`);
    }
    assert.deepEqual([byKey.get('alpha-work')?.estimated?.minutes_per_occurrence.mid, byKey.get('widget-checks')?.origin, byKey.get('widget-checks')?.estimated?.source], [30, 'promoted', 'model']);
    assert.equal(byKey.get('alpha-work')?.counted.occurrences, 5, 'the mapped key counts under alpha');
    stages.push(stageOf(root));
    assert.deepEqual(stages, ['taxonomy', 'extraction', 'merge', 'rollup', 'synthesis', 'score', 'done']);
    assert.equal(capture(() => runCommand(root, ['end'])).code, 0);

    // Session 3: nothing changed, so nothing is dispatched and no ledger file changes.
    const ledger = () => readdirSync(join(root, 'out', 'ledger')).filter((f) => /^(?:batch|synth)-/.test(f)).map((f) => readFileSync(join(root, 'out', 'ledger', f), 'utf8'));
    const before = ledger();
    capture(() => runCommand(root, ['start']));
    const idle = refill(root, []);
    assert.deepEqual([idle.jobs, idle.stage], [[], 'done']);
    assert.deepEqual(ledger(), before);

    // verify re-checks both kinds.
    assert.deepEqual(capture(() => verifyCommand(root, [])).out, [
      'verify: 6 done batches and 6 done synthesis groups re-checked against the corpus and their inputs; every validated file matches (1 synthesis group not done, not verified).',
    ]);
    const file = join(root, 'out', 'synthesis', 'validated', 'synth-002.json');
    const good2 = readFileSync(file, 'utf8');
    writeFileSync(file, good2.replace('"Read the request"', '"Read it"'));
    const edited = capture(() => verifyCommand(root, []));
    assert.equal(edited.code, 1);
    assert.equal(edited.out[1], '  - synth-002: out/synthesis/validated/synth-002.json differs from what out/synthesis/raw/synth-002.json validates to now');
    writeFileSync(file, good2);
  } finally {
    if (saved === undefined) delete process.env.OBS_IN_FLIGHT;
    else process.env.OBS_IN_FLIGHT = saved;
  }
});

// ---- advance: the whole run, one command per turn (ARCHITECTURE.md 6.7, 15.3) ----

test('advance alone drives the run: one wave of batches, the merger in the foreground, accept, rollup and one wave of groups, then score and run end; a second session repeats nothing; the log times every step', () => {
  const root = fixtureM5('m5-advance');
  const saved = process.env.OBS_IN_FLIGHT;
  delete process.env.OBS_IN_FLIGHT;
  const advance = (args: string[]): AdvanceReport => {
    const r = capture(() => advanceCommand(root, [...args, '--json']));
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.equal(r.out.length, 1, 'one JSON object on stdout');
    assert.ok(Buffer.byteLength(r.out[0] as string) < 64_000);
    return JSON.parse(r.out[0] as string) as AdvanceReport;
  };
  const folder = `Project folder: ${root.replaceAll('\\', '/')}`;
  try {
    const started = capture(() => runCommand(root, ['start']));
    assert.equal(started.code, 0, started.err.join('\n'));
    const runId = /^run: started (\S+?)[ .]/.exec(started.out[0] ?? '')?.[1] as string;
    acceptTaxonomy(root);

    // Extraction: the six batches in one wave, each Agent call's parameters ready to copy.
    const first = advance([]);
    assert.deepEqual(Object.keys(first), ['stage', 'halt', 'halt_reason', 'done', 'wait', 'steps', 'recorded', 'agents', 'refused', 'running', 'exhausted']);
    const batches = Array.from({ length: 6 }, (_, i) => batchName(i));
    assert.deepEqual(
      first.agents.map((a) => [a.subagent_type, a.description, a.prompt, a.run_in_background]),
      batches.map((id) => ['extractor', `Extract ${id}`, `Extract ${id}.\n${folder}`, true]),
    );
    assert.deepEqual([first.stage, first.halt, first.done, first.wait, first.steps, first.recorded, first.running], ['extraction', false, false, false, [], [], batches]);
    for (const a of first.agents) plannedExtractor(a.prompt);

    // Completions in two waves: the first records three and waits; the last hands out the merger,
    // in the foreground, with nothing else to start.
    const some = advance(batches.slice(0, 3));
    assert.deepEqual(some.recorded, batches.slice(0, 3).map((id) => ({ id, status: 'done', note: 'recorded' })));
    assert.deepEqual([some.agents, some.wait, some.running], [[], true, batches.slice(3)]);
    const last = advance(batches.slice(3));
    assert.deepEqual(last.recorded.map((r) => r.status), ['done', 'done', 'done']);
    assert.deepEqual(last.agents, [{ subagent_type: 'merger', description: 'Merge process keys', prompt: `Merge the proposed process keys into the taxonomy.\n${folder}`, run_in_background: false }]);
    assert.deepEqual([last.stage, last.wait, last.running], ['merge', false, []]);

    // The merger writes; one advance accepts it, rolls up and hands out every group in one wave.
    const proposal = {
      mapped: { 'alpha-work': ['new:alpha-extra'] },
      unassigned: ['new:one-off'],
      promoted: [{ key: 'widget-checks', name: 'Widget checks', definition: 'Checking the widget counts with the desk each round and fixing them.', aliases: ['new:widget-audit', 'new:widget-review'] }],
    };
    writeFileSync(join(root, 'out', 'merge-proposed.json'), JSON.stringify(proposal));
    const wave = advance([]);
    assert.deepEqual(wave.steps, [
      'merge: accepted the proposal the last merger run left: 4 proposed keys: 1 mapped, 2 in 1 promoted process, 1 unassigned, 0 demoted; 1 message left unassigned; wrote out/merge.json.',
      'rollup: 7 processes (1 promoted), 29 counted messages in 29 occurrences; 1 tagged message unassigned; 7 synthesis groups.',
    ]);
    const groups = Array.from({ length: Math.min(SYNTH_MAX_GROUPS, 7) }, (_, i) => `synth-00${i}`);
    assert.deepEqual(
      wave.agents.map((a) => [a.subagent_type, a.description, a.prompt, a.run_in_background]),
      groups.map((id) => ['synthesizer', `Synthesize ${id}`, `Synthesize ${id}.\n${folder}`, true]),
      'one wave: a group per process, every one handed out at once',
    );
    assert.equal(wave.stage, 'synthesis');

    // synth-000 writes a description over the stated cap but inside the margin: accepted. synth-001
    // cites an id its input does not show: a fix round, then good.
    const behaviour = (id: string, dispatch: number): SynthBehaviour => (id === 'synth-000' ? 'long' : id === 'synth-001' ? (dispatch === 1 ? 'unknown' : 'fix') : 'good');
    for (const a of wave.agents) scriptedSynthesizer(root, a.prompt, behaviour(a.description.split(' ')[1] as string, 1));
    const fixRound = advance(groups);
    assert.deepEqual(fixRound.recorded.map((r) => [r.id, r.status]), groups.map((id) => [id, id === 'synth-001' ? 'failed' : 'done']));
    assert.deepEqual(fixRound.agents.map((a) => [a.description, a.prompt]), [['Synthesize synth-001', `Synthesize synth-001 (fix round 1 of 3): 1 problem in the problems file.\n${folder}`]]);
    assert.match(readFileSync(join(root, 'out', 'fix', 'synth-001.txt'), 'utf8'), /"batch-099:e99" is not an id the input shows/);
    const kept = JSON.parse(readFileSync(join(root, 'out', 'synthesis', 'validated', 'synth-000.json'), 'utf8')) as { processes: Array<{ description: string }> };
    assert.equal([...(kept.processes[0]?.description ?? '')].length, 650, 'over the stated cap, inside the margin, kept as written');
    scriptedSynthesizer(root, fixRound.agents[0]?.prompt as string, behaviour('synth-001', 2));

    // The advance after the last group scores, ends the run and says so.
    const end = advance(['synth-001']);
    assert.deepEqual(end.recorded, [{ id: 'synth-001', status: 'done', note: 'recorded' }]);
    assert.match(end.steps[0] ?? '', /^score: tiers A\+B .*; 7 opportunities \(0 A, 0 B, 7 C\); 0 estimates missing; wrote out\/opportunities\.json\.$/);
    assert.equal(end.steps[1], `run: ended ${runId}.`);
    assert.deepEqual([end.stage, end.done, end.halt, end.wait, end.agents, end.running], ['done', true, false, false, [], []]);
    assert.equal(readRun(root).active, false);

    // A second session: run start, then advance hands out nothing and ends the run again.
    const ledger = () => readdirSync(join(root, 'out', 'ledger')).filter((f) => /^(?:batch|synth)-/.test(f)).map((f) => readFileSync(join(root, 'out', 'ledger', f), 'utf8'));
    const before = ledger();
    assert.equal(capture(() => runCommand(root, ['start'])).code, 0);
    const again = advance([]);
    assert.deepEqual([again.agents, again.done, again.steps.length, again.running], [[], true, 1, []]);
    assert.deepEqual(ledger(), before, 'no job dispatched or stamped');

    // The first run's log: one advance event per call and one stage event per step, each timed.
    const log = readFileSync(join(root, 'out', 'runs', `${runId}.jsonl`), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const advances = log.filter((e) => e.event === 'advance');
    assert.equal(advances.length, 6);
    for (const e of advances) assert.ok(Number.isInteger(e.ms) && (e.ms as number) >= 0, JSON.stringify(e));
    assert.deepEqual(advances.map((e) => [e.stage_before, e.stage_after, (e.dispatched as string[]).length, e.agents]), [
      ['extraction', 'extraction', 6, 6],
      ['extraction', 'extraction', 0, 0],
      ['merge', 'merge', 0, 1],
      ['merge', 'synthesis', 7, 7],
      ['synthesis', 'synthesis', 1, 1],
      ['score', 'done', 0, 0],
    ]);
    assert.deepEqual(advances[1]?.named, batches.slice(0, 3));
    assert.deepEqual(advances[1]?.recorded, batches.slice(0, 3).map((id) => ({ id, status: 'done' })));
    const stages = log.filter((e) => e.event === 'stage');
    assert.deepEqual(stages.map((e) => [e.name, e.attempt ?? null]), [['merge prompt', 1], ['merge accept', 1], ['rollup', null], ['score', null], ['run end', null]]);
    for (const e of stages) assert.ok(Number.isInteger(e.ms) && typeof e.summary === 'string' && e.summary !== '', JSON.stringify(e));
    assert.equal(log.at(-1)?.event, 'advance', 'the call that ended the run logged to it');
    assert.equal(stages.at(-1)?.name, 'run end');
  } finally {
    if (saved === undefined) delete process.env.OBS_IN_FLIGHT;
    else process.env.OBS_IN_FLIGHT = saved;
  }
});
