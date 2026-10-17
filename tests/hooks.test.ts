// The Claude Code hooks, each run the way Claude Code runs it: `node .claude/hooks/<name>.ts` with the
// hook input as JSON on stdin and CLAUDE_PROJECT_DIR pointing at the project. The project is a temp
// folder holding a tiny Git-initialised corpus (Windows-safe names) that `prepare` has turned into
// out/, so the gate checks real quotes against real messages. Also here: the seams between the
// settings, the agent definition, the skill and the code they rely on.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BATCH_NOTES_MAX_WORDS, NOTE_MAX_CHARS } from '../src/model/validate-extraction.ts';
import { prepare } from '../src/pipeline/prepare.ts';
import { validateCommand } from '../src/run/commands.ts';
import { batchViews, findBatch, loadIndex, markDispatched, readBatchState, validatedFile } from '../src/run/ledger.ts';
import { QUOTE_MAX_CHARS, QUOTE_MIN_CHARS } from '../src/validate/quotes.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'obs-hooks-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// ---- The fixture project ----

const A = 'corpus/alpha/inbox/1';
const B = 'corpus/alpha/inbox/2';
const C = 'corpus/beta/sent/3';
const D = 'corpus/beta/sent/4';
const crlf = (s: string) => s.replaceAll('\n', '\r\n');
const MESSAGES: Record<string, string> = {
  [A]: crlf(
    'From: ann.lee@enron.com\nTo: bob.ray@enron.com\nSubject: Daily volume confirmation\nDate: Mon, 14 May 2001 10:00:00 -0700\n\n' +
      'Bob, please confirm the daily volumes for the Katy meter before noon today.\nThanks, Ann\n',
  ),
  [B]: crlf(
    'From: bob.ray@enron.com\nTo: ann.lee@enron.com\nSubject: RE: Daily volume confirmation\nDate: Mon, 14 May 2001 11:00:00 -0700\n\n' +
      'Confirmed on my end. Same volumes as yesterday for the Katy meter.\n',
  ),
  [C]: crlf('From: cy.dee@enron.com\nTo: dan.eve@enron.com\nSubject: lunch friday\nDate: Tue, 15 May 2001 09:00:00 -0700\n\nAre we still on for lunch on Friday at the usual place?\n'),
  // The corpus's most common shape: CRLF headers, then a body with bare LF line endings.
  [D]:
    crlf('From: ops.desk@enron.com\nTo: ann.lee@enron.com\nSubject: Meter feed\nDate: Wed, 16 May 2001 08:00:00 -0700\n\n') +
    'The Katy meter feed is down again, volumes will be late.\nPlease hold the\tconfirmation until it is back.\n',
};

const proj = join(tmp, 'proj');
function gitInit(dir: string): void {
  const git = (...args: string[]) => {
    const r = spawnSync(
      'git',
      ['-c', 'user.name=obs test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'fixture corpus');
}
mkdirSync(proj, { recursive: true });
writeFileSync(join(proj, '.gitattributes'), '* -text\n');
for (const [id, text] of Object.entries(MESSAGES)) {
  mkdirSync(join(proj, id, '..'), { recursive: true });
  writeFileSync(join(proj, id), text);
}
gitInit(proj);
mkdirSync(join(proj, 'config'), { recursive: true });
copyFileSync(join(repo, 'config', 'effort-rates.json'), join(proj, 'config', 'effort-rates.json'));
mkdirSync(join(proj, '.claude', 'agents'), { recursive: true });
copyFileSync(join(repo, '.claude', 'agents', 'extractor.md'), join(proj, '.claude', 'agents', 'extractor.md'));
prepare(proj, join(proj, 'out'));

const BATCH = 'batch-000';
const base = proj.replaceAll('\\', '/');
const batchFile = join(proj, 'out', 'batches', `${BATCH}.md`);
const extractPath = join(proj, 'out', 'extract', `${BATCH}.json`);
const KEY = 'new:daily-volume-confirmation';

function goodExtraction() {
  return {
    batch_id: BATCH,
    messages: [
      { id: A, processes: [KEY], role: 'request', stall: null, ownership_claim: null },
      { id: B, processes: [KEY], role: 'response', stall: null, ownership_claim: null },
      { id: C, processes: [], role: 'personal', stall: null, ownership_claim: null },
      { id: D, processes: [KEY], role: 'fyi', stall: { kind: 'system_failure', quote: 'The Katy meter feed is down again, volumes will be late.' }, ownership_claim: null },
    ],
    evidence: [
      { process: KEY, message_id: A, field: 'body', quote: 'please confirm the daily volumes for the Katy meter before noon today', note: 'Asks for the daily volumes.' },
      { process: KEY, message_id: B, field: 'body', quote: 'Confirmed on my end. Same volumes as yesterday for the Katy meter.', note: 'Confirms them.' },
      { process: KEY, message_id: D, field: 'body', quote: 'volumes will be late.\nPlease hold the\tconfirmation until it is back.', note: 'Holds the confirmation.' },
    ],
    new_processes: [{ key: KEY, name: 'Daily volume confirmation', definition: 'Confirming the day\'s volumes with a colleague.', example_ids: [A] }],
    batch_notes: 'One personal message.',
  };
}
function badExtraction() {
  const x = goodExtraction();
  (x.evidence[1] as { quote: string }).quote = 'Confirmed at my end. The same volumes as yesterday for the meter.';
  return x;
}

// A fresh dispatch of the batch, then the extractor's output file.
function dispatchWith(extraction: unknown): void {
  markDispatched(proj, findBatch(loadIndex(proj), BATCH));
  mkdirSync(join(proj, 'out', 'extract'), { recursive: true });
  writeFileSync(extractPath, JSON.stringify(extraction, null, 2));
}

// ---- Running hooks ----

type HookResult = { status: number | null; stdout: string; stderr: string };
function hook(name: string, input: unknown, projectDir = proj): HookResult {
  const r = spawnSync(process.execPath, [join(repo, '.claude', 'hooks', `${name}.ts`)], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const decision = (r: HookResult): Record<string, unknown> | null => (r.stdout.trim() === '' ? null : JSON.parse(r.stdout));

const preToolUse = (tool_name: string, tool_input: unknown, extra: Record<string, unknown> = {}) => ({
  session_id: 's1',
  transcript_path: 't.jsonl',
  cwd: proj,
  permission_mode: 'default',
  hook_event_name: 'PreToolUse',
  tool_name,
  tool_input,
  tool_use_id: 'toolu_1',
  ...extra,
});
const asExtractor = { agent_id: 'agent-x', agent_type: 'extractor' };

// The guard's answer, checked for shape. Every denial names the CLAUDE.md rule.
function guard(input: unknown, projectDir = proj): { verdict: 'deny' | 'silent'; reason: string } {
  const r = hook('guard-corpus', input, projectDir);
  assert.equal(r.status, 0, r.stderr);
  const d = decision(r);
  if (d === null) return { verdict: 'silent', reason: '' };
  const out = d.hookSpecificOutput as Record<string, unknown>;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  const reason = String(out.permissionDecisionReason);
  assert.match(reason, /CLAUDE\.md/);
  assert.ok(!reason.includes(base) && !reason.includes(proj), `no local path in the reason: ${reason}`);
  return { verdict: 'deny', reason };
}
const verdict = (input: unknown, projectDir = proj) => guard(input, projectDir).verdict;

const subagentStop = (last_assistant_message: string, agent_type = 'extractor', agent_id = 'agent-1', transcript = 'subagents/none.jsonl') => ({
  session_id: 's1',
  transcript_path: 't.jsonl',
  cwd: proj,
  permission_mode: 'default',
  hook_event_name: 'SubagentStop',
  stop_hook_active: false,
  agent_id,
  agent_type,
  agent_transcript_path: transcript,
  last_assistant_message,
});
const REPLY = `Wrote the extraction.\nOUTPUT: out/extract/${BATCH}.json`;
const statusOf = (batchId: string) => batchViews(proj).find((v) => v.entry.batch_id === batchId)?.status;
const runLog = (name: string, dir = proj) =>
  readFileSync(join(dir, 'out', 'runs', `${name}.jsonl`), 'utf8')
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

// A subagent transcript as Claude Code keeps it (JSONL): the task prompt first, and optionally a
// SubagentHandback call carrying the final reply.
function transcriptFile(name: string, assigned: string, handback: string | null): string {
  const file = join(tmp, `${name}.jsonl`);
  const lines: unknown[] = [
    { type: 'user', message: { role: 'user', content: `Extract batch ${assigned}.\nBatch file: ...\nOUTPUT: out/extract/${assigned}.json` } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: `${base}/out/batches/${assigned}.md` } }] } },
  ];
  if (handback !== null) lines.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: handback } }] } });
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

// ---- guard-corpus: the extractor's allowlist ----

test('fixture: one batch holding all four messages, whose text mentions corpus/ IDs', () => {
  assert.deepEqual([...findBatch(loadIndex(proj), BATCH).message_ids].sort(), [A, B, C, D].sort());
  assert.ok(readFileSync(batchFile, 'utf8').includes(`--- MESSAGE ${A} ---`));
});

test('guard: the extractor may read its batch, the taxonomy and its output, and write only out/extract/batch-NNN.json', () => {
  const allowed: Array<[string, Record<string, unknown>]> = [
    ['Read', { file_path: `${base}/out/batches/${BATCH}.md` }],
    ['Read', { file_path: batchFile }],
    ['Read', { file_path: `${base}/out/batches/${BATCH}.md`, offset: 1200, limit: 800 }],
    ['Read', { file_path: `${base}/out/taxonomy.json` }],
    ['Read', { file_path: `${base}/out/extract/${BATCH}.json` }],
    ['Read', { file_path: `${base}/out/extract/../batches/${BATCH}.md` }],
    ['Read', { file_path: `out/batches/${BATCH}.md` }],
    ['Write', { file_path: `${base}/out/extract/${BATCH}.json`, content: JSON.stringify(goodExtraction()) }],
    ['Write', { file_path: extractPath, content: '{}' }],
    ['SubagentHandback', { message: `Done.\nOUTPUT: out/extract/${BATCH}.json` }],
  ];
  for (const [tool, input] of allowed) assert.equal(verdict(preToolUse(tool, input, asExtractor)), 'silent', `${tool} ${JSON.stringify(input).slice(0, 120)}`);
});

test('guard: everything else the extractor tries is denied with a reason', () => {
  const denied: Array<[string, Record<string, unknown>]> = [
    // The corpus and its browsing copy, in every spelling.
    ['Read', { file_path: 'corpus/farmer-d/1.' }],
    ['Read', { file_path: `${base}/${A}` }],
    ['Read', { file_path: './corpus-view/x.eml' }],
    ['Read', { file_path: 'C:\\work\\obs\\corpus\\farmer-d\\logistics\\1.' }],
    ['Read', { file_path: `${base}/out/batches/../../corpus/alpha/inbox/1` }],
    // Pipeline state and code: never written by the extractor.
    ['Write', { file_path: `${base}/.claude/hooks/guard-corpus.ts`, content: 'x' }],
    ['Write', { file_path: `${base}/.claude/settings.json`, content: '{}' }],
    ['Write', { file_path: `${base}/.claude/agents/extractor.md`, content: 'x' }],
    ['Write', { file_path: `${base}/out/ledger/${BATCH}.json`, content: '{}' }],
    ['Write', { file_path: `${base}/out/ledger/run.json`, content: '{}' }],
    ['Write', { file_path: `${base}/out/validated/${BATCH}.json`, content: '{}' }],
    ['Write', { file_path: `${base}/src/cli.ts`, content: 'x' }],
    ['Write', { file_path: `${base}/out/extract/../ledger/run.json`, content: '{}' }],
    ['Write', { file_path: `${base}/out/extract/${BATCH}.json/../../validated/${BATCH}.json`, content: '{}' }],
    ['Write', { file_path: `${base}/out/extract/notes.txt`, content: 'x' }],
    ['Write', { file_path: `${base}/out/extract/${BATCH}.json.`, content: 'x' }],
    ['Write', { file_path: `${base}/out/extract/${BATCH}.json:stream`, content: 'x' }],
    ['Write', { file_path: `${base}/out/batches/${BATCH}.md`, content: 'x' }],
    // Reads outside its files.
    ['Read', { file_path: `${base}/out/messages.jsonl` }],
    ['Read', { file_path: `${base}/out/ledger/run.json` }],
    ['Read', { file_path: `${base}/.claude/settings.json` }],
    ['Read', { file_path: `${base}/OUT~1/batches/${BATCH}.md` }],
    ['Read', { file_path: '/etc/passwd' }],
    ['Read', {}],
    // Other tools, whatever their input.
    ['Glob', { pattern: 'out/batches/*.md' }],
    ['Grep', { pattern: 'invoice', path: `${base}/out/batches` }],
    ['Bash', { command: 'node obs.mjs status' }],
    ['Bash', { command: 'cat corpus/farmer-d/logistics/1.' }],
    ['Edit', { file_path: `${base}/out/extract/${BATCH}.json`, old_string: 'a', new_string: 'b' }],
    ['NotebookEdit', { notebook_path: `${base}/out/extract/n.ipynb`, new_source: 'x' }],
    ['PowerShell', { command: 'Get-Content out/batches/batch-000.md' }],
    ['WebFetch', { url: 'https://example.com', prompt: 'x' }],
    ['Agent', { subagent_type: 'extractor', prompt: 'x' }],
  ];
  for (const [tool, input] of denied) {
    const g = guard(preToolUse(tool, input, asExtractor));
    assert.equal(g.verdict, 'deny', `${tool} ${JSON.stringify(input).slice(0, 120)}`);
    assert.match(g.reason, /^Guard for the extractor subagent: /);
  }
  assert.match(guard(preToolUse('Bash', { command: 'ls' }, asExtractor)).reason, /the Bash tool is not allowed\. It may use only Read of out\/batches\//);
  assert.match(guard(preToolUse('Write', { file_path: `${base}/src/cli.ts`, content: 'x' }, asExtractor)).reason, /Write of src\/cli\.ts is not allowed/);
  assert.match(guard(preToolUse('Read', { file_path: '/etc/passwd' }, asExtractor)).reason, /Read of a path outside its own files is not allowed/);
});

test('guard: Windows paths are matched without case, through Git Bash spellings, under any install folder', () => {
  const win = 'D:\\data\\corpus\\Obs';
  const asWin = (tool: string, file_path: string) => verdict(preToolUse(tool, { file_path, content: '{}' }, { ...asExtractor, cwd: win }), win);
  assert.equal(asWin('Read', 'D:\\data\\corpus\\Obs\\out\\batches\\batch-000.md'), 'silent');
  assert.equal(asWin('Read', 'd:/DATA/Corpus/obs/OUT/Batches/batch-000.md'), 'silent');
  assert.equal(asWin('Read', '/d/data/corpus/Obs/out/taxonomy.json'), 'silent');
  assert.equal(asWin('Read', '/cygdrive/d/data/corpus/Obs/out/extract/batch-000.json'), 'silent');
  assert.equal(asWin('Write', 'D:\\data\\corpus\\Obs\\out\\extract\\batch-000.json'), 'silent');
  assert.equal(asWin('Read', 'out\\batches\\batch-000.md'), 'silent', 'relative to the cwd');
  assert.equal(asWin('Read', 'D:\\data\\corpus\\Obs\\corpus\\a\\1.'), 'deny');
  assert.equal(asWin('Read', 'D:\\data\\corpus\\other\\out\\batches\\batch-000.md'), 'deny', 'another checkout');
  assert.equal(asWin('Write', 'D:\\data\\corpus\\Obs\\out\\extract\\..\\..\\.claude\\settings.json'), 'deny');
  const posix = '/srv/corpus/obs';
  assert.equal(verdict(preToolUse('Read', { file_path: `${posix}/out/batches/${BATCH}.md` }, { ...asExtractor, cwd: posix }), posix), 'silent');
  assert.equal(verdict(preToolUse('Read', { file_path: `${posix}/corpus/a/1.` }, { ...asExtractor, cwd: posix }), posix), 'deny');
});

test('guard: a pipeline agent with no allowlist yet is denied everything', () => {
  for (const agent of ['synthesizer', 'drafter']) {
    const g = guard(preToolUse('Read', { file_path: `${base}/out/batches/${BATCH}.md` }, { agent_id: 's', agent_type: agent }));
    assert.equal(g.verdict, 'deny');
    assert.match(g.reason, /no allowlist is defined for this agent yet/);
  }
});

// ---- guard-corpus: development sessions and runs ----

test('guard: silent for the main session and other agents when no run is active', () => {
  for (const extra of [{}, { agent_id: 'a', agent_type: 'Explore' }, { agent_id: 'b', agent_type: 'general-purpose' }]) {
    assert.equal(verdict(preToolUse('Read', { file_path: `${proj}/corpus/alpha/inbox/1` }, extra)), 'silent');
    assert.equal(verdict(preToolUse('Bash', { command: 'cat corpus-view/alpha/inbox/1.eml' }, extra)), 'silent');
    assert.equal(verdict(preToolUse('Write', { file_path: `${base}/src/cli.ts`, content: 'x' }, extra)), 'silent');
  }
  assert.equal(verdict('not json at all'), 'silent', 'unreadable input from an unknown caller, no run');
});

test('guard: while a run is active, any caller is kept off the corpus and told how to clear the run', () => {
  const runFile = join(proj, 'out', 'ledger', 'run.json');
  mkdirSync(join(proj, 'out', 'ledger'), { recursive: true });
  writeFileSync(runFile, JSON.stringify({ active: true, run_id: '20261017T000000Z', started_utc: '2026-10-17T00:00:00Z' }));
  try {
    const denied: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['Read', { file_path: 'corpus/alpha/inbox/1' }, {}],
      ['Read', { file_path: 'C:\\work\\obs\\corpus-view\\farmer-d\\1.eml' }, {}],
      ['Read', { file_path: 'CORPUS/Farmer-D/1.' }, {}],
      ['Bash', { command: 'git show HEAD:corpus/farmer-d/1.' }, {}],
      ['Bash', { command: 'ls corpus' }, {}],
      ['Bash', { command: 'type "corpus\\farmer-d\\1."' }, {}],
      ['Grep', { pattern: 'x', path: 'corpus-view' }, { agent_id: 'e', agent_type: 'Explore' }],
      ['Grep', { pattern: 'invoice', path: 'out', glob: 'corpus/**' }, {}],
      ['Glob', { pattern: 'corpus/**/*' }, {}],
      ['NotebookEdit', { notebook_path: 'corpus/a/n.ipynb', new_source: 'x' }, {}],
    ];
    for (const [tool, input, extra] of denied) {
      const g = guard(preToolUse(tool, input, extra));
      assert.equal(g.verdict, 'deny', `${tool} ${JSON.stringify(input)}`);
      assert.match(g.reason, /clear the run marker with: node obs\.mjs run end$/);
    }
    for (const file_path of [`${proj}/out/batches/${BATCH}.md`, 'tests/fixtures/corpus-mini/1.eml', 'out/my_corpus/x', 'docs/corpusnotes.md']) {
      assert.equal(verdict(preToolUse('Read', { file_path })), 'silent', file_path);
    }
    assert.equal(verdict('not json at all'), 'deny', 'unreadable input during a run fails closed');
  } finally {
    writeFileSync(runFile, JSON.stringify({ active: false, run_id: '20261017T000000Z', started_utc: '2026-10-17T00:00:00Z' }));
  }
  assert.equal(verdict(preToolUse('Read', { file_path: 'corpus/alpha/inbox/1' })), 'silent', 'after the run ends');
});

test('guard: during a run, a checkout under a folder named corpus is not mistaken for the corpus', () => {
  const nested = join(tmp, 'corpus', 'obs');
  mkdirSync(join(nested, 'out', 'ledger'), { recursive: true });
  writeFileSync(join(nested, 'out', 'ledger', 'run.json'), JSON.stringify({ active: true, run_id: 'r1', started_utc: null }));
  const n = nested.replaceAll('\\', '/');
  assert.equal(verdict(preToolUse('Read', { file_path: `${n}/out/batches/${BATCH}.md` }, { cwd: nested }), nested), 'silent');
  assert.equal(verdict(preToolUse('Bash', { command: `node ${n}/obs.mjs status` }, { cwd: nested }), nested), 'silent');
  assert.equal(verdict(preToolUse('Read', { file_path: `${n}/corpus/a/1.` }, { cwd: nested }), nested), 'deny');
});

test('guard: malformed input is denied whenever the guard applies (fail closed)', () => {
  assert.equal(verdict(preToolUse('Read', 'corpus/a/1.', asExtractor)), 'deny', 'tool_input not an object');
  assert.equal(verdict(preToolUse('Read', null, asExtractor)), 'deny', 'tool_input null');
  assert.equal(verdict({ ...asExtractor, hook_event_name: 'PreToolUse', tool_name: 'Read' }), 'deny', 'tool_input missing');
  assert.equal(verdict(preToolUse('Read', { file_path: 42 }, asExtractor)), 'deny', 'file_path not text');
  assert.equal(verdict('{"agent_type": "extractor", "tool_input": {"file_path": "corpus/a'), 'deny', 'truncated JSON from the extractor');
  // An unreadable run state is treated as a run.
  const runFile = join(proj, 'out', 'ledger', 'run.json');
  const saved = existsSync(runFile) ? readFileSync(runFile, 'utf8') : null;
  writeFileSync(runFile, '{broken');
  try {
    assert.equal(verdict(preToolUse('Read', { file_path: 'corpus/alpha/inbox/1' })), 'deny');
    assert.equal(verdict(preToolUse('Bash', { command: ['cat', 'corpus/a'] })), 'deny', 'command not text');
  } finally {
    if (saved === null) rmSync(runFile);
    else writeFileSync(runFile, saved);
  }
});

// ---- gate-subagent ----

const noLocalPaths = (text: string) => !text.includes(proj) && !text.includes(base) && !text.toLowerCase().includes(base.toLowerCase());

test('gate: a valid extraction passes; the validated file is written and the batch is done', () => {
  dispatchWith(goodExtraction());
  assert.equal(statusOf(BATCH), 'running');
  const r = hook('gate-subagent', subagentStop(REPLY));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(decision(r), null, `no block: ${r.stdout}`);
  assert.equal(statusOf(BATCH), 'done');
  const state = readBatchState(proj, BATCH);
  assert.deepEqual([state.problems, state.gate_blocks], [0, 0]);
  assert.deepEqual(state.quote_stats, { exact: 4, repaired: 0, rejected: 0 }, 'three evidence quotes and one stall quote, all exact');
  const validated = JSON.parse(readFileSync(validatedFile(proj, BATCH), 'utf8'));
  assert.equal(validated.batch_id, BATCH);
  assert.equal(validated.evidence.length, 3);
  const last = runLog('adhoc').filter((e) => e.event === 'gate').at(-1);
  assert.equal(last?.decision, 'done');
  assert.equal(last?.batch_id, BATCH);
});

test('gate: an invalid extraction is blocked with its problems and the fix instruction, and no local path', () => {
  dispatchWith(badExtraction());
  const r = hook('gate-subagent', subagentStop(REPLY));
  assert.equal(r.status, 0, r.stderr);
  const d = decision(r);
  assert.equal(d?.decision, 'block');
  const reason = String(d?.reason);
  assert.match(reason, new RegExp(`out/extract/${BATCH}\\.json`));
  assert.match(reason, /quote not found verbatim/);
  assert.match(reason, /\n- /, 'problems listed one per line');
  assert.match(reason, /Read your output file, using the absolute "Output file:" path from your task\./);
  assert.ok(reason.endsWith('Fix only these problems in the same file, then reply again ending with the OUTPUT line.'));
  assert.ok(noLocalPaths(reason), reason);
  assert.equal(readBatchState(proj, BATCH).gate_blocks, 1);
  assert.equal(statusOf(BATCH), 'running');
  assert.ok(!existsSync(validatedFile(proj, BATCH)), 'nothing validated while the subagent is still fixing');
});

test('gate: after 3 blocks the 4th stop is allowed and the batch is failed', () => {
  dispatchWith(badExtraction());
  for (let i = 1; i <= 3; i++) {
    const r = hook('gate-subagent', { ...subagentStop(REPLY), stop_hook_active: i > 1 });
    assert.equal(decision(r)?.decision, 'block', `stop ${i}`);
    assert.equal(readBatchState(proj, BATCH).gate_blocks, i);
  }
  const fourth = hook('gate-subagent', { ...subagentStop(REPLY), stop_hook_active: true });
  assert.equal(fourth.status, 0, fourth.stderr);
  assert.equal(decision(fourth), null, 'allowed to finish');
  assert.equal(statusOf(BATCH), 'failed');
  const state = readBatchState(proj, BATCH);
  assert.equal(state.gate_blocks, 3);
  assert.ok((state.problems ?? 0) > 0);
  assert.deepEqual(state.quote_stats, { exact: 3, repaired: 0, rejected: 1 });
});

test('gate: a setup problem the model cannot fix neither blocks nor stamps; the batch stays running', () => {
  dispatchWith(goodExtraction());
  const messages = join(proj, 'out', 'messages.jsonl');
  renameSync(messages, `${messages}.away`);
  try {
    const r = hook('gate-subagent', subagentStop(REPLY));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(decision(r), null, 'no block');
    const state = readBatchState(proj, BATCH);
    assert.deepEqual([state.status, state.gate_blocks, state.problems], ['running', 0, null]);
    const logged = runLog('adhoc').at(-1);
    assert.equal(logged?.event, 'gate_setup_error');
    assert.match(JSON.stringify(logged?.setup), /^\["setup: /);
    assert.ok(noLocalPaths(JSON.stringify(logged)), JSON.stringify(logged));

    // validate says so too, and also leaves it running.
    const v = quiet(() => validateCommand(proj, [BATCH]));
    assert.equal(v.code, 1);
    assert.match(v.out[0] ?? '', /^validate: batch-000 could not be checked; it stays running\.$/);
    assert.ok(v.out.slice(1).every(noLocalPaths), v.out.join('\n'));
    assert.equal(readBatchState(proj, BATCH).status, 'running');
  } finally {
    renameSync(`${messages}.away`, messages);
  }
  assert.equal(decision(hook('gate-subagent', subagentStop(REPLY))), null);
  assert.equal(statusOf(BATCH), 'done', 'checked once the setup is fixed');
});

test('gate: a reply without the OUTPUT line is blocked, a bounded number of times per subagent', () => {
  dispatchWith(goodExtraction());
  for (let i = 1; i <= 3; i++) {
    const d = decision(hook('gate-subagent', subagentStop('I have written the file.', 'extractor', 'agent-no-line')));
    assert.equal(d?.decision, 'block', `stop ${i}`);
    assert.match(String(d?.reason), /OUTPUT: out\/extract\/<batch_id>\.json/);
  }
  assert.equal(decision(hook('gate-subagent', subagentStop('Still no line.', 'extractor', 'agent-no-line'))), null, '4th stop allowed');
  assert.equal(readBatchState(proj, BATCH).gate_blocks, 0, 'the batch keeps its own blocks');
  assert.equal(statusOf(BATCH), 'running');

  const unknown = decision(hook('gate-subagent', subagentStop('OUTPUT: out/extract/batch-999.json', 'extractor', 'agent-other')));
  assert.equal(unknown?.decision, 'block');
  assert.match(String(unknown?.reason), /names "out\/extract\/batch-999\.json", which is not an output file of this run/);
});

test('gate: an OUTPUT line naming a batch that is not running is blocked, naming the batch from the task', () => {
  dispatchWith(goodExtraction());
  assert.equal(decision(hook('gate-subagent', subagentStop(REPLY))), null);
  assert.equal(statusOf(BATCH), 'done');
  const transcript = transcriptFile('t-done', BATCH, null);
  const d = decision(hook('gate-subagent', subagentStop(REPLY, 'extractor', 'agent-late', transcript)));
  assert.equal(d?.decision, 'block');
  assert.match(String(d?.reason), /batch-000 is not being extracted \(it is done\)\. Your task is batch-000\./);
  assert.equal(statusOf(BATCH), 'done', 'a done batch is not re-stamped');
});

test('gate: an OUTPUT line for another batch than the task named is blocked', () => {
  dispatchWith(goodExtraction());
  const transcript = transcriptFile('t-other', 'batch-001', null);
  const d = decision(hook('gate-subagent', subagentStop(REPLY, 'extractor', 'agent-mixup', transcript)));
  assert.equal(d?.decision, 'block');
  assert.match(String(d?.reason), /Your OUTPUT line names batch-000, but your task is batch-001\. Reply again ending with the line OUTPUT: out\/extract\/batch-001\.json\./);
  assert.equal(statusOf(BATCH), 'running');
});

test('gate: a reply delivered through SubagentHandback is read from the transcript', () => {
  dispatchWith(goodExtraction());
  const transcript = transcriptFile('t-handback', BATCH, `Done.\nOUTPUT: out/extract/${BATCH}.json`);
  const r = hook('gate-subagent', subagentStop('', 'extractor', 'agent-handback', transcript));
  assert.equal(decision(r), null, r.stdout);
  assert.equal(statusOf(BATCH), 'done');

  // The OUTPUT line in the task prompt itself never counts as the reply.
  dispatchWith(goodExtraction());
  const promptOnly = transcriptFile('t-prompt-only', BATCH, null);
  assert.equal(decision(hook('gate-subagent', subagentStop('', 'extractor', 'agent-silent', promptOnly)))?.decision, 'block');
  assert.equal(statusOf(BATCH), 'running');
});

test('gate: the OUTPUT line may be decorated or a full path; the last one counts', () => {
  dispatchWith(goodExtraction());
  const reply = `OUTPUT: out/extract/batch-999.json was wrong, so:\n\n\`OUTPUT: ${extractPath.replaceAll('\\', '/')}\``;
  const r = hook('gate-subagent', subagentStop(reply));
  assert.equal(decision(r), null, r.stdout);
  assert.equal(statusOf(BATCH), 'done');
});

test('gate: ignores other agents, and logs a stop whose input names no agent', () => {
  dispatchWith(badExtraction());
  const before = readFileSync(join(proj, 'out', 'ledger', `${BATCH}.json`), 'utf8');
  for (const agent of ['drafter', 'synthesizer', 'general-purpose']) {
    const r = hook('gate-subagent', subagentStop(REPLY, agent));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
  const noType = hook('gate-subagent', { ...subagentStop(REPLY, 'extractor', 'agent-anon'), agent_type: undefined }); // dropped from the JSON
  assert.equal(noType.stdout, '');
  const skipped = runLog('adhoc').at(-1);
  assert.equal(skipped?.event, 'gate_skipped');
  assert.equal(skipped?.agent_id, 'agent-anon');
  assert.equal(readFileSync(join(proj, 'out', 'ledger', `${BATCH}.json`), 'utf8'), before, 'ledger untouched');
});

test('gate: if the gate itself fails it reports the error and lets the subagent finish', () => {
  const empty = join(tmp, 'empty-project');
  mkdirSync(empty, { recursive: true });
  const r = hook('gate-subagent', subagentStop(REPLY), empty);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'no block');
  assert.match(r.stderr, /^gate-subagent: .*prepare/m);
  assert.ok(!r.stderr.includes('    at '), 'no stack trace');
  assert.ok(!r.stderr.includes(empty) && !r.stderr.includes(empty.replaceAll('\\', '/')), r.stderr);
  assert.equal(runLog('adhoc', empty).at(-1)?.event, 'gate_error');
});

// ---- validate (the CLI side of the same check) ----

function quiet(fn: () => number): { code: number; out: string[]; err: string[] } {
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

test('validate: records the same outcome as the gate, only for a running batch, and exits 0 only when it passes', () => {
  dispatchWith(goodExtraction());
  const ok = quiet(() => validateCommand(proj, ['0']));
  assert.equal(ok.code, 0, ok.err.join('\n'));
  assert.equal(ok.out[0], 'validate: batch-000 done: 0 problems, quotes 4 exact, 0 repaired, 0 rejected.');
  assert.equal(statusOf(BATCH), 'done');

  const again = quiet(() => validateCommand(proj, [BATCH]));
  assert.equal(again.code, 1);
  assert.equal(again.err[0], 'validate: batch-000 is done, not running: only a dispatched batch can be validated. Run node obs.mjs dispatch batch-000 first.');

  dispatchWith(badExtraction());
  const bad = quiet(() => validateCommand(proj, [BATCH]));
  assert.equal(bad.code, 1);
  assert.match(bad.out[0] ?? '', /^validate: batch-000 failed: \d+ problems?, quotes 3 exact, 0 repaired, 1 rejected\.$/);
  assert.match(bad.out[1] ?? '', /^ {2}- .*quote not found verbatim/);
  assert.equal(statusOf(BATCH), 'failed');
  assert.ok(existsSync(validatedFile(proj, BATCH)), 'the checked record is kept for the report, but the batch is not done');

  const unknown = quiet(() => validateCommand(proj, ['batch-999']));
  assert.equal(unknown.code, 1);
  assert.match(unknown.err[0] ?? '', /^validate: Unknown batch "batch-999"/);
});

// ---- log-event ----

test('log-event: appends one line per event to the run log, adhoc outside a run', () => {
  const start = { session_id: 's1', cwd: proj, hook_event_name: 'SubagentStart', agent_id: 'agent-7', agent_type: 'extractor' };
  assert.equal(hook('log-event', start).status, 0);
  const line = runLog('adhoc').at(-1);
  assert.deepEqual({ ...line, ts: undefined }, { ts: undefined, event: 'SubagentStart', agent_type: 'extractor', agent_id: 'agent-7' });
  assert.match(String(line?.ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const runFile = join(proj, 'out', 'ledger', 'run.json');
  writeFileSync(runFile, JSON.stringify({ active: true, run_id: '20261017T010000Z', started_utc: '2026-10-17T01:00:00Z' }));
  try {
    assert.equal(hook('log-event', { ...start, hook_event_name: 'SubagentStop' }).status, 0);
    assert.deepEqual(runLog('20261017T010000Z').map((e) => e.event), ['SubagentStop']);
  } finally {
    rmSync(runFile);
  }
  const garbage = hook('log-event', 'not json');
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, '');
});

test('the run logs hold no local paths', () => {
  for (const file of readdirSync(join(proj, 'out', 'runs'))) {
    const text = readFileSync(join(proj, 'out', 'runs', file), 'utf8');
    assert.ok(noLocalPaths(text) && !text.includes(proj.replaceAll('\\', '\\\\')), file);
  }
});

// ---- Seams: settings, agent definition, skill ----

function frontmatter(file: string): Record<string, string> {
  const text = readFileSync(join(repo, file), 'utf8').replaceAll('\r\n', '\n');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m !== null, `${file} has frontmatter`);
  return Object.fromEntries(
    (m[1] as string).split('\n').map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
}
const agentNames = () =>
  readdirSync(join(repo, '.claude', 'agents'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => frontmatter(`.claude/agents/${f}`).name);

test('seam: the extractor definition keeps the name, tools, model and effort the pipeline relies on', () => {
  const fm = frontmatter('.claude/agents/extractor.md');
  assert.equal(fm.name, 'extractor', 'the SubagentStop matcher and the guard key on this name');
  assert.equal(fm.tools, 'Read, Write', 'the guard allowlist assumes exactly these');
  assert.ok((fm.model ?? '') !== '', 'model line present');
  assert.ok((fm.effort ?? '') !== '', 'effort line present');
  assert.equal(fm.permissionMode, 'acceptEdits');
  assert.equal(fm.maxTurns, '16', 'room for three fix rounds');
});

test('seam: the limits the extractor is told are the limits the validator enforces', () => {
  const prompt = readFileSync(join(repo, '.claude', 'agents', 'extractor.md'), 'utf8');
  assert.ok(prompt.includes(`${QUOTE_MIN_CHARS}-${QUOTE_MAX_CHARS} characters`));
  assert.ok(prompt.includes(`${QUOTE_MIN_CHARS} to ${QUOTE_MAX_CHARS} characters`));
  assert.ok(prompt.includes(`at most ${NOTE_MAX_CHARS} characters`));
  assert.ok(prompt.includes(`at most ${BATCH_NOTES_MAX_WORDS} words`));
  for (const n of prompt.match(/\b\d+(?= characters| words)/g) ?? []) {
    assert.ok([QUOTE_MIN_CHARS, QUOTE_MAX_CHARS, NOTE_MAX_CHARS, BATCH_NOTES_MAX_WORDS].includes(Number(n)), `stray limit ${n} in the prompt`);
  }
});

test('seam: settings.json runs every hook in exec form, on files that exist, matched to real agent names', () => {
  const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions, { allow: ['Bash(node obs.mjs *)'], deny: ['Edit(./corpus/**)'] });
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['PreToolUse', 'SubagentStart', 'SubagentStop']);
  const names = new Set(agentNames());
  for (const [event, groups] of Object.entries(settings.hooks as Record<string, Array<{ matcher: string; hooks: Array<Record<string, unknown>> }>>)) {
    for (const group of groups) {
      if (event === 'PreToolUse') assert.equal(group.matcher, '*', 'the guard sees every tool, so its allowlist covers anything');
      else for (const name of group.matcher.split('|')) assert.ok(names.has(name), `${event} matcher "${name}" is an agent name`);
      for (const h of group.hooks) {
        assert.equal(h.type, 'command');
        assert.equal(h.command, 'node', 'exec form: a real executable, no shell');
        assert.ok(Array.isArray(h.args) && h.args.length === 1);
        const arg = (h.args as string[])[0] as string;
        assert.match(arg, /^\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/hooks\/[a-z-]+\.ts$/);
        assert.ok(existsSync(join(repo, arg.replace('${CLAUDE_PROJECT_DIR}/', ''))), arg);
        assert.ok(typeof h.timeout === 'number' && h.timeout > 0);
      }
    }
  }
  const stop = (settings.hooks.SubagentStop as Array<{ hooks: Array<{ args: string[] }> }>).flatMap((g) => g.hooks.map((h) => h.args[0]));
  assert.ok(stop.some((a) => a?.endsWith('/gate-subagent.ts')) && stop.some((a) => a?.endsWith('/log-event.ts')));
});

test('seam: the extract-batch skill is user-only and may run only obs commands and subagents', () => {
  const fm = frontmatter('.claude/skills/extract-batch/SKILL.md');
  assert.equal(fm.name, 'extract-batch');
  assert.equal(fm['disable-model-invocation'], 'true');
  assert.equal(fm['allowed-tools'], 'Bash(node obs.mjs *) Agent');
  assert.match(fm['argument-hint'] ?? '', /<batch_id>/);
  const body = readFileSync(join(repo, '.claude', 'skills', 'extract-batch', 'SKILL.md'), 'utf8');
  assert.match(body, /`subagent_type` `extractor`/, 'dispatches the agent the settings gate');
  assert.match(body, /node obs\.mjs dispatch <batch_id>/);
});
