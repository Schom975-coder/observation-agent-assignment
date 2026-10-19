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
// and `verify` covering batches and synthesis groups. Last, `advance` alone drives a third copy
// from the taxonomy to the run's end, the M6 drafting included: briefs, a wave of drafters (one
// fixed on round 2, one exhausted after 2), the rendered artifacts and artifacts.json, and the build
// of the dashboard data and the report.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { mergeCommand } from '../src/run/merge.ts';
import { rollupCommand } from '../src/run/rollup.ts';
import { scoreCommand } from '../src/run/score.ts';
import { peopleLine } from '../src/model/artifacts.ts';
import { BODIES } from './fixtures/drafts.ts';
import { acceptTaxonomy, batchName, capture, fixtureM5, plannedExtractor, scriptedDrafter, scriptedSynthesizer, task, type DraftBehaviour, type SynthBehaviour } from './fixtures/pipeline.ts';
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
import type { ArtifactBrief, ArtifactIndex, Artifacts, BatchEntry, Extraction, Opportunities } from '../src/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'obs-loop-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const BATCHES = 6;
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

// ---- The scripted extractor ----

// good: a correct extraction; bad: the quote is not in the message (on a fix round it changes
// nothing); fix: on a fix round, corrects the previous output; crash: writes a good output, but
// its session dies before anything checks it.
type Behaviour = 'good' | 'bad' | 'fix' | 'crash';

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

// ---- M5: merge, rollup, synthesis and score (the project and the scripted agents: tests/fixtures/pipeline.ts) ----

const refill = (root: string, ids: string[]): RefillReport => {
  const r = capture(() => refillCommand(root, [...ids, '--json']));
  assert.equal(r.code, 0, r.err.join('\n'));
  return JSON.parse(r.out[0] as string) as RefillReport;
};
const stageOf = (root: string): string => status(root).stage;

test('the loop continues through merge, rollup, synthesis and score: a merge fix round, a group fixed on round 2, one exhausted, a resumed session; verify covers both kinds', () => {
  const root = fixtureM5(tmp);
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
    assert.match(scored.out[0] ?? '', /; 7 opportunities \(0 A, 7 B, 0 C\); 1 estimate missing; wrote out\/opportunities\.json\.$/);
    const opportunities = JSON.parse(readFileSync(join(root, 'out', 'opportunities.json'), 'utf8')) as Opportunities;
    const byKey = new Map(opportunities.opportunities.map((o) => [o.key, o]));
    for (const key of ['bravo-work']) {
      assert.deepEqual([byKey.get(key)?.flags, byKey.get(key)?.estimated], [['synthesis_missing', 'estimate_missing'], null], key);
      assert.ok((byKey.get(key)?.counted.email_x100.today ?? 0) > 0, `${key} keeps its counted part`);
    }
    assert.deepEqual([byKey.get('alpha-work')?.estimated?.minutes_per_occurrence.mid, byKey.get('widget-checks')?.origin, byKey.get('widget-checks')?.estimated?.source], [30, 'promoted', 'model']);
    assert.equal(byKey.get('alpha-work')?.counted.occurrences, 5, 'the mapped key counts under alpha');
    stages.push(stageOf(root));
    assert.deepEqual(stages, ['taxonomy', 'extraction', 'merge', 'rollup', 'synthesis', 'score', 'artifacts']);
    assert.equal(capture(() => runCommand(root, ['end'])).code, 0);

    // Session 3: nothing changed, so nothing is dispatched and no ledger file changes.
    const ledger = () => readdirSync(join(root, 'out', 'ledger')).filter((f) => /^(?:batch|synth)-/.test(f)).map((f) => readFileSync(join(root, 'out', 'ledger', f), 'utf8'));
    const before = ledger();
    capture(() => runCommand(root, ['start']));
    const idle = refill(root, []);
    assert.deepEqual([idle.jobs, idle.stage], [[], 'artifacts'], 'refill runs no stage step: the briefs wait for advance or artifacts prepare');
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

test('advance alone drives the run: one wave of batches, the merger in the foreground, accept, rollup and one wave of groups, score, the briefs and one wave of drafters, collect, build and run end; a second session repeats nothing; the log times every step', () => {
  const root = fixtureM5(tmp, 'm5-advance');
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

    // The advance after the last group scores, writes the briefs and hands out every draft in one
    // wave: every process is eligible here, and the one whose synthesis chose no artifact is skipped.
    const drafts = advance(['synth-001']);
    assert.deepEqual(drafts.recorded, [{ id: 'synth-001', status: 'done', note: 'recorded' }]);
    assert.match(drafts.steps[0] ?? '', /^score: tiers A\+B .*; 7 opportunities \(0 A, 7 B, 0 C\); 0 estimates missing; wrote out\/opportunities\.json\.$/);
    assert.equal(drafts.steps[1], 'artifacts: 6 briefs, 1 skipped; wrote out/artifacts/index.json.');
    const index = JSON.parse(readFileSync(join(root, 'out', 'artifacts', 'index.json'), 'utf8')) as ArtifactIndex;
    assert.deepEqual(index.skipped.map((x) => [x.key, x.reason]), [['echo-work', 'artifact_type none']]);
    const draftOf = new Map(index.jobs.map((j) => [j.key, j.job_id]));
    const draftIds = index.jobs.map((j) => j.job_id);
    assert.deepEqual(draftIds, Array.from({ length: 6 }, (_, i) => `draft-00${i}`), 'in rank order');
    assert.deepEqual(
      drafts.agents.map((a) => [a.subagent_type, a.description, a.prompt, a.run_in_background]),
      draftIds.map((id) => ['drafter', `Draft ${id}`, `Draft ${id}.\n${folder}`, true]),
    );
    assert.deepEqual([drafts.stage, drafts.done, drafts.wait, drafts.running], ['drafting', false, false, draftIds]);

    // alpha's first body cites a message (refused, then fixed on its one fix round); bravo's is
    // refused twice (exhausted); the rest pass.
    const alpha = draftOf.get('alpha-work') as string;
    const bravo = draftOf.get('bravo-work') as string;
    const draftBehaviour = (id: string, fix: boolean): DraftBehaviour => (id === alpha ? (fix ? 'fix' : 'bad') : id === bravo ? 'bad' : 'good');
    for (const a of drafts.agents) scriptedDrafter(a.prompt, draftBehaviour(a.description.split(' ')[1] as string, false));
    const fixes = advance(draftIds);
    assert.deepEqual(fixes.recorded.map((r) => [r.id, r.status]), draftIds.map((id) => [id, id === alpha || id === bravo ? 'failed' : 'done']));
    assert.deepEqual(
      fixes.agents.map((a) => a.prompt.split('\n')[0]?.replace(/: \d+ problems?/, ': N problems')),
      [alpha, bravo].sort().map((id) => `Draft ${id} (fix round 1 of 1): N problems in the problems file.`),
    );
    for (const a of fixes.agents) scriptedDrafter(a.prompt, draftBehaviour(a.description.split(' ')[1] as string, true));

    // The advance after the last fix round collects the artifacts, builds the dashboard data and the
    // report, ends the run and says so.
    const end = advance([alpha, bravo]);
    assert.deepEqual(end.recorded.map((r) => [r.id, r.status]), [alpha, bravo].map((id) => [id, id === alpha ? 'done' : 'failed']));
    assert.equal(end.steps.length, 3, end.steps.join('\n'));
    assert.equal(end.steps[0], 'artifacts: 5 drafted, 1 exhausted, 1 skipped; wrote out/artifacts/artifacts.json.');
    assert.match(end.steps[1] ?? '', /^build: 7 processes \(7 in the total\), 5 documents, .*; wrote out\/dashboard\/ \(\d+ files\), out\/report\.html, out\/report\.md and out\/run-summary\.json; \d+ files changed\.$/);
    assert.equal(end.steps[2], `run: ended ${runId}.`);
    assert.ok(existsSync(join(root, 'out', 'dashboard', 'data.json')) && existsSync(join(root, 'out', 'report.html')), 'the build wrote its files');
    assert.deepEqual([end.stage, end.done, end.halt, end.wait, end.agents, end.running, end.exhausted], ['done', true, false, false, [], [], [bravo]]);
    assert.equal(readRun(root).active, false);
    assert.equal(readBatchState(root, bravo).dispatches, 2);

    // The artifacts: one per done draft, none for the exhausted one; artifacts.json lists all seven.
    const record = JSON.parse(readFileSync(join(root, 'out', 'artifacts', 'artifacts.json'), 'utf8')) as Artifacts;
    assert.deepEqual(
      record.artifacts.map((a) => [a.key, a.status, a.path]),
      record.artifacts.map((a) => [
        a.key,
        a.key === 'echo-work' ? 'skipped' : a.key === 'bravo-work' ? 'exhausted' : 'done',
        a.key === 'echo-work' || a.key === 'bravo-work' ? null : `out/artifacts/${a.key}/${({ sop: 'sop', checklist: 'checklist', email_template: 'email-template', template: 'template' } as Record<string, string>)[a.artifact_type]}.md`,
      ]),
    );
    assert.deepEqual(record.artifacts.map((a) => a.rank), [...record.artifacts.map((a) => a.rank)].sort((x, y) => x - y));
    assert.match(record.artifacts.find((a) => a.key === 'bravo-work')?.reason ?? '', /^no usable draft after 2 attempts; see the problems in out\/ledger\/draft-00\d\.json$/);
    assert.equal(record.artifacts.find((a) => a.key === 'echo-work')?.reason, 'no document type was chosen for this process');
    assert.ok(!existsSync(join(root, 'out', 'artifacts', 'bravo-work')), 'no file for the exhausted draft');
    const sop = readFileSync(join(root, 'out', 'artifacts', 'alpha-work', 'sop.md'), 'utf8');
    // The body as the drafter wrote it, with the code-written people line under its Owner heading.
    const alphaBrief = JSON.parse(readFileSync(join(root, 'out', 'artifacts', 'input', `${alpha}.json`), 'utf8')) as ArtifactBrief;
    const people = peopleLine(alphaBrief);
    assert.match(people, /^People doing this work \(counted from the emails\): (?:Ann Lee|Bob Ray) \(\d+ written\)/);
    const body = BODIES.sop.replace('## Owner\n\n', `## Owner\n\n${people}\n\n`);
    assert.ok(sop.startsWith(`# alpha work: SOP\n\nDraft prepared from 5 emails about this process, for the process owner to review. Evidence about this process, quoted exactly from the emails, is listed at the end.\n\n${body}\n\n## Evidence\n`), sop.slice(0, 600));
    assert.match(sop, /\n- `corpus\/m5\/inbox\/01` \(2001-01-15, from Ann Lee\):\n\n {2}> Please handle the alpha round 1 for the desk today, item 1\.\n/);
    assert.match(sop, /\nCounted from the emails: this work came up \d+ times over \d+ active months \(2001-\d\d-\d\d to 2001-\d\d-\d\d\), across 5 emails, with \d+ staff taking part\.\n\nEstimated, not counted: about 30 minutes of hands-on work each time \(range 20 to 45\), about 50% of it automatable\. Basis: seen in the emails; proposed by a model and checked by code\.\n$/);
    assert.ok(!sop.includes('corpus/x/1.'), 'the refused first body never reached the artifact');
    const raws = readdirSync(join(root, 'out', 'artifacts', 'raw')).sort();
    assert.deepEqual(raws, draftIds.map((id) => `${id}.md`), 'every body as the model wrote it stays for review');

    // verify re-checks the drafts too.
    assert.deepEqual(capture(() => verifyCommand(root, [])).out, [
      'verify: 6 done batches, 7 done synthesis groups and 5 done drafts re-checked against the corpus and their inputs; every validated file matches; the collected artifacts match what collect writes (1 draft not done, not verified).',
    ]);
    // A rendered artifact edited by hand, or one left over, fails verify like any other mismatch.
    const sopFile = join(root, 'out', 'artifacts', 'alpha-work', 'sop.md');
    writeFileSync(sopFile, `${sop}Edited by hand.\n`);
    const edited = capture(() => verifyCommand(root, []));
    assert.equal(edited.code, 1);
    assert.deepEqual(edited.out, ['verify: the artifacts do not match (1 problem):', '  - out/artifacts/alpha-work/sop.md differs from what node obs.mjs artifacts collect writes now']);
    writeFileSync(sopFile, sop);
    mkdirSync(join(root, 'out', 'artifacts', 'old-work'), { recursive: true });
    writeFileSync(join(root, 'out', 'artifacts', 'old-work', 'sop.md'), 'left over');
    assert.deepEqual(capture(() => verifyCommand(root, [])).out.slice(1), ['  - out/artifacts/old-work/sop.md is left over: no done draft renders it']);
    rmSync(join(root, 'out', 'artifacts', 'old-work'), { recursive: true });
    const vfile = join(root, 'out', 'artifacts', 'validated', `${alpha}.json`);
    const vgood = readFileSync(vfile, 'utf8');
    writeFileSync(vfile, vgood.replace('"blockquotes": 0', '"blockquotes": 1'));
    const vbad = capture(() => verifyCommand(root, []));
    assert.equal(vbad.code, 1);
    assert.equal(vbad.out[1], `  - ${alpha}: out/artifacts/validated/${alpha}.json differs from what out/artifacts/raw/${alpha}.md validates to now`);
    writeFileSync(vfile, vgood);
    const rendered = () => ['alpha-work/sop.md', 'charlie-work/email-template.md', 'delta-work/template.md', 'widget-checks/checklist.md'].map((p) => readFileSync(join(root, 'out', 'artifacts', p), 'utf8'));
    const renderedBefore = rendered();

    // The first run's log, read now: a run ID is its start second, so on a fast machine the second
    // session below can start in the same second and append to the same file.
    const firstLog = readFileSync(join(root, 'out', 'runs', `${runId}.jsonl`), 'utf8');

    // A second session: run start, then advance hands out nothing and ends the run again.
    const ledger = () => readdirSync(join(root, 'out', 'ledger')).filter((f) => /^(?:batch|synth|draft)-/.test(f)).map((f) => readFileSync(join(root, 'out', 'ledger', f), 'utf8'));
    const before = ledger();
    const recordBefore = readFileSync(join(root, 'out', 'artifacts', 'artifacts.json'), 'utf8');
    assert.equal(capture(() => runCommand(root, ['start'])).code, 0);
    const again = advance([]);
    assert.deepEqual([again.agents, again.done, again.steps.length, again.running], [[], true, 1, []]);
    assert.deepEqual(ledger(), before, 'no job dispatched or stamped');
    assert.deepEqual([rendered(), readFileSync(join(root, 'out', 'artifacts', 'artifacts.json'), 'utf8')], [renderedBefore, recordBefore], 'collect rewrites nothing');

    // The first run's log: one advance event per call and one stage event per step, each timed.
    const log = firstLog.trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const advances = log.filter((e) => e.event === 'advance');
    assert.equal(advances.length, 8);
    for (const e of advances) assert.ok(Number.isInteger(e.ms) && (e.ms as number) >= 0, JSON.stringify(e));
    assert.deepEqual(advances.map((e) => [e.stage_before, e.stage_after, (e.dispatched as string[]).length, e.agents]), [
      ['extraction', 'extraction', 6, 6],
      ['extraction', 'extraction', 0, 0],
      ['merge', 'merge', 0, 1],
      ['merge', 'synthesis', 7, 7],
      ['synthesis', 'synthesis', 1, 1],
      ['score', 'drafting', 6, 6],
      ['drafting', 'drafting', 2, 2],
      ['drafting', 'done', 0, 0],
    ]);
    assert.deepEqual(advances[1]?.named, batches.slice(0, 3));
    assert.deepEqual(advances[1]?.recorded, batches.slice(0, 3).map((id) => ({ id, status: 'done' })));
    const stages = log.filter((e) => e.event === 'stage');
    assert.deepEqual(stages.map((e) => [e.name, e.attempt ?? null]), [
      ['merge prompt', 1],
      ['merge accept', 1],
      ['rollup', null],
      ['score', null],
      ['artifacts prepare', null],
      ['artifacts collect', null],
      ['build', null],
      ['run end', null],
    ]);
    for (const e of stages) assert.ok(Number.isInteger(e.ms) && typeof e.summary === 'string' && e.summary !== '', JSON.stringify(e));
    assert.equal(log.at(-1)?.event, 'advance', 'the call that ended the run logged to it');
    assert.equal(stages.at(-1)?.name, 'run end');
  } finally {
    if (saved === undefined) delete process.env.OBS_IN_FLIGHT;
    else process.env.OBS_IN_FLIGHT = saved;
  }
});
