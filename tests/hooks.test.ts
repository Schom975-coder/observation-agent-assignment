// The Claude Code hooks, each run the way Claude Code runs it: `node .claude/hooks/<name>.ts` with the
// hook input as JSON on stdin and CLAUDE_PROJECT_DIR pointing at the project. The main project is a
// temp folder holding a tiny Git-initialised corpus (Windows-safe names) that `prepare` has turned
// into out/, so the gate checks real quotes against real messages; a few hand-made batches beside
// it exercise the guard's agent-to-batch binding. The Stop hook gets projects of its own, with a
// fresh taxonomy and ledgers built through the ledger's own transitions. Also here: the seams
// between the settings, the agent definitions, the skills and the code they rely on.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootVariants } from '../.claude/hooks/lib.ts';
import { canonicalTaxonomy } from '../src/model/taxonomy.ts';
import { BATCH_NOTES_MAX_WORDS, NOTE_MAX_CHARS, checkExtraction } from '../src/model/validate-extraction.ts';
import { prepare } from '../src/pipeline/prepare.ts';
import { extractorPrompt, runCommand } from '../src/run/commands.ts';
import {
  HALT_NO_OUTPUT,
  MAX_DISPATCHES,
  ORPHAN_GRACE_S,
  batchStateFile,
  batchViews,
  boundBatch,
  findBatch,
  loadIndex,
  markDispatched,
  readBatchState,
  recordValidation,
  stopGateFile,
  updateBatchState,
  validatedFile,
  type BatchState,
} from '../src/run/ledger.ts';
import { currentShas } from '../src/run/taxonomy.ts';
import { sha256 } from '../src/util/hash.ts';
import { QUOTE_MAX_CHARS, QUOTE_MIN_CHARS } from '../src/validate/quotes.ts';
import type { BatchEntry, ValidatedExtraction } from '../src/types.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'obs-hooks-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// ---- Projects ----

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

// Batches with no messages, appended to a project's index: enough for dispatch, binding and status.
function addBatches(root: string, ids: readonly string[]): void {
  const file = join(root, 'out', 'batches', 'index.json');
  mkdirSync(join(root, 'out', 'batches'), { recursive: true });
  const index: BatchEntry[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  for (const id of ids) {
    const text = `# ${id} | 0 messages | 0 threads\n`;
    writeFileSync(join(root, 'out', 'batches', `${id}.md`), text);
    index.push({ batch_id: id, file: `out/batches/${id}.md`, message_ids: [], thread_ids: [], bytes: text.length, lines: 1, est_tokens: 3, content_sha: sha256(text) });
  }
  writeFileSync(file, JSON.stringify(index, null, 2));
}

const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `batch-${String(from + i).padStart(3, '0')}`);

const proj = join(tmp, 'proj');
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
addBatches(proj, ids(1, 3));

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

// ---- Ledger moves, made the way the commands make them ----

const entryOf = (root: string, id: string) => findBatch(loadIndex(root), id);
const dispatch = (root: string, id: string): BatchState => markDispatched(root, entryOf(root, id)).state;

// What validate records for a passing or failing output, without a model or a real file.
function stamp(root: string, id: string, ok: boolean): BatchState {
  const entry = entryOf(root, id);
  const validated = ok ? ({ batch_id: id, content_sha: entry.content_sha, quote_stats: { exact: 1, repaired: 0, rejected: 0 } } as unknown as ValidatedExtraction) : null;
  return recordValidation(root, entry, { ok, setup: null, problems: ok ? [] : ['corpus/x/1.: a problem'], validated });
}

// A first dispatch of batch-000 from a clean state, then the extractor's output file.
function dispatchWith(extraction: unknown): void {
  rmSync(batchStateFile(proj, BATCH), { force: true });
  markDispatched(proj, entryOf(proj, BATCH));
  mkdirSync(join(proj, 'out', 'extract'), { recursive: true });
  writeFileSync(extractPath, JSON.stringify(extraction, null, 2));
}

// A run started an hour ago.
function setRun(root: string, active: boolean, runId = '20261017T000000Z'): void {
  mkdirSync(join(root, 'out', 'ledger'), { recursive: true });
  const started_utc = new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');
  writeFileSync(join(root, 'out', 'ledger', 'run.json'), JSON.stringify({ active, run_id: runId, started_utc }));
}

// ---- Running hooks ----

type HookResult = { status: number | null; stdout: string; stderr: string; ms: number };
function hook(name: string, input: unknown, projectDir = proj, env: Record<string, string> = {}): HookResult {
  const started = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [join(repo, '.claude', 'hooks', `${name}.ts`)], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, OBS_IN_FLIGHT: '', ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Number(process.hrtime.bigint() - started) / 1e6 };
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
const extractor = (agent_id: string) => ({ agent_id, agent_type: 'extractor' });
const asExtractor = extractor('agent-x');

const noLocalPaths = (text: string) => !text.includes(proj) && !text.includes(base) && !text.toLowerCase().includes(base.toLowerCase());

// The guard's answer, checked for shape. Every denial names the CLAUDE.md rule and no local path.
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
  assert.ok(noLocalPaths(reason), `no local path in the reason: ${reason}`);
  return { verdict: 'deny', reason };
}
const verdict = (input: unknown, projectDir = proj) => guard(input, projectDir).verdict;

const runLog = (name: string, dir = proj): Array<Record<string, unknown>> => {
  const file = join(dir, 'out', 'runs', `${name}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};
const statusOf = (batchId: string) => batchViews(proj).find((v) => v.entry.id === batchId)?.status;

// ---- guard-corpus: the extractor's allowlist and its batch ----

test('fixture: batch-000 holds all four messages, whose text mentions corpus/ IDs; three empty batches follow', () => {
  assert.deepEqual([...(loadIndex(proj).find((b) => b.batch_id === BATCH)?.message_ids ?? [])].sort(), [A, B, C, D].sort());
  assert.ok(readFileSync(batchFile, 'utf8').includes(`--- MESSAGE ${A} ---`));
  assert.deepEqual(loadIndex(proj).map((b) => b.batch_id), ids(0, 3));
});

test('guard: an extractor reads its batch, its output and the taxonomy, and writes its own output', () => {
  dispatch(proj, BATCH);
  const me = extractor('agent-own');
  const allowed: Array<[string, Record<string, unknown>]> = [
    ['Read', { file_path: `${base}/out/taxonomy.json` }],
    ['Read', { file_path: `${base}/out/batches/${BATCH}.md` }],
    ['Read', { file_path: batchFile }],
    ['Read', { file_path: `${base}/out/batches/${BATCH}.md`, offset: 1200, limit: 800 }],
    ['Read', { file_path: `${base}/out/extract/${BATCH}.json` }],
    ['Read', { file_path: `${base}/out/fix/${BATCH}.txt` }],
    ['Read', { file_path: `${base}/out/extract/../batches/${BATCH}.md` }],
    ['Read', { file_path: `out/batches/${BATCH}.md` }],
    ['Write', { file_path: `${base}/out/extract/${BATCH}.json`, content: JSON.stringify(goodExtraction()) }],
    ['Write', { file_path: extractPath, content: '{}' }],
    ['SubagentHandback', { message: 'Wrote the extraction for batch-000.' }],
  ];
  for (const [tool, input] of allowed) assert.equal(verdict(preToolUse(tool, input, me)), 'silent', `${tool} ${JSON.stringify(input).slice(0, 120)}`);
  const binding = boundBatch(proj, 'agent-own');
  assert.deepEqual([binding?.batch_id, binding?.dispatches], [BATCH, readBatchState(proj, BATCH).dispatches]);
  const binds = runLog('adhoc').filter((e) => e.event === 'guard_bind' && e.agent_id === 'agent-own');
  assert.deepEqual(binds.map((e) => [e.agent_type, e.batch_id]), [['extractor', BATCH]], 'bound once, on the first batch read');
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
    ['Write', { file_path: `${base}/out/ledger/agents/agent-x.json`, content: '{}' }],
    ['Write', { file_path: `${base}/out/validated/${BATCH}.json`, content: '{}' }],
    ['Write', { file_path: `${base}/out/taxonomy.json`, content: '{}' }],
    ['Write', { file_path: `${base}/src/cli.ts`, content: 'x' }],
    ['Write', { file_path: `${base}/out/extract/../ledger/run.json`, content: '{}' }],
    ['Write', { file_path: `${base}/out/extract/${BATCH}.json/../../validated/${BATCH}.json`, content: '{}' }],
    ['Write', { file_path: `${base}/out/extract/notes.txt`, content: 'x' }],
    ['Write', { file_path: `${base}/out/extract/${BATCH}.json.`, content: 'x' }],
    ['Write', { file_path: `${base}/out/extract/${BATCH}.json:stream`, content: 'x' }],
    ['Write', { file_path: `${base}/out/batches/${BATCH}.md`, content: 'x' }],
    ['Write', { file_path: `${base}/out/fix/${BATCH}.txt`, content: 'x' }],
    // Reads outside its files.
    ['Read', { file_path: `${base}/out/fix/${BATCH}.json` }],
    ['Read', { file_path: `${base}/out/fix/notes.txt` }],
    ['Read', { file_path: `${base}/out/batches/index.json` }],
    ['Read', { file_path: `${base}/out/extract/notes.txt` }],
    ['Read', { file_path: `${base}/out/taxonomy-digest.md` }],
    ['Read', { file_path: `${base}/out/taxonomy-proposed.json` }],
    ['Read', { file_path: `${base}/out/messages.jsonl` }],
    ['Read', { file_path: `${base}/out/ledger/run.json` }],
    ['Read', { file_path: `${base}/out/ledger/agents/agent-x.json` }],
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
  assert.match(guard(preToolUse('Bash', { command: 'ls' }, asExtractor)).reason, /the Bash tool is not allowed\. It may use only Read of its own batch file/);
  assert.match(guard(preToolUse('Write', { file_path: `${base}/src/cli.ts`, content: 'x' }, asExtractor)).reason, /Write of src\/cli\.ts is not allowed/);
  assert.match(guard(preToolUse('Read', { file_path: '/etc/passwd' }, asExtractor)).reason, /Read of a path outside its own files is not allowed/);
  assert.equal(boundBatch(proj, 'agent-x'), null, 'nothing above bound the agent');
  assert.ok(runLog('adhoc').some((e) => e.event === 'guard_deny' && e.agent_id === 'agent-x' && e.tool === 'Bash'), 'denials are logged');
});

test('guard: Windows paths are matched without case, through Git Bash spellings, under any install folder', () => {
  const win = 'D:\\data\\corpus\\Obs';
  const asWin = (tool: string, file_path: string, agent: Record<string, unknown> = asExtractor) =>
    guard(preToolUse(tool, { file_path, content: '{}' }, { ...agent, cwd: win }), win);
  for (const p of [
    'D:\\data\\corpus\\Obs\\out\\taxonomy.json',
    'd:/DATA/Corpus/obs/OUT/Taxonomy.json',
    '/d/data/corpus/Obs/out/taxonomy.json',
    '/cygdrive/d/data/corpus/Obs/out/taxonomy.json',
    'out\\taxonomy.json',
  ]) {
    assert.equal(asWin('Read', p).verdict, 'silent', p);
  }
  // Recognised as the extractor's own output (and then refused only because nothing bound it).
  assert.match(asWin('Write', 'D:\\data\\corpus\\Obs\\out\\extract\\batch-000.json').reason, /Write of out\/extract\/batch-000\.json is refused: it has not read its batch yet/);
  assert.match(asWin('Write', '/d/DATA/corpus/obs/out/Extract/BATCH-000.json').reason, /Write of out\/extract\/batch-000\.json is refused/);
  assert.equal(asWin('Read', 'D:\\data\\corpus\\Obs\\out\\taxonomy-digest.md', { agent_id: 't', agent_type: 'taxonomist' }).verdict, 'silent');
  assert.match(asWin('Read', 'D:\\data\\corpus\\Obs\\corpus\\a\\1.').reason, /Read of corpus\/a\/1\. is not allowed|a path outside its own files/);
  assert.match(asWin('Read', 'D:\\data\\corpus\\other\\out\\taxonomy.json').reason, /a path outside its own files/, 'another checkout');
  assert.equal(asWin('Write', 'D:\\data\\corpus\\Obs\\out\\extract\\..\\..\\.claude\\settings.json').verdict, 'deny');
  const posix = '/srv/corpus/obs';
  assert.equal(verdict(preToolUse('Read', { file_path: `${posix}/out/taxonomy.json` }, { ...asExtractor, cwd: posix }), posix), 'silent');
  assert.equal(verdict(preToolUse('Read', { file_path: `${posix}/corpus/a/1.` }, { ...asExtractor, cwd: posix }), posix), 'deny');
});

test('guard: a project reached through a link matches through its real path too', (t) => {
  assert.deepEqual(rootVariants(join(tmp, 'no-such-folder')), [join(tmp, 'no-such-folder')], 'unresolvable: as given');
  assert.ok(rootVariants(proj).includes(proj) && rootVariants(proj).includes(realpathSync(proj)));
  const link = join(tmp, 'proj-link');
  try {
    symlinkSync(proj, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('links cannot be made here; the root normalisation above is what the guard relies on');
    return;
  }
  assert.ok(rootVariants(link).includes(realpathSync(proj)), 'the link resolves to the checkout');
  const real = realpathSync(proj).replaceAll('\\', '/');
  const viaLink = (file_path: string) => verdict(preToolUse('Read', { file_path }, { ...asExtractor, cwd: link }), link);
  assert.equal(viaLink(`${link.replaceAll('\\', '/')}/out/taxonomy.json`), 'silent', 'the link spelling');
  assert.equal(viaLink(`${real}/out/taxonomy.json`), 'silent', 'the resolved spelling');
  assert.equal(viaLink(`${real}/${A}`), 'deny');
  assert.equal(viaLink(`${real}/../other/out/taxonomy.json`), 'deny');
});

test('guard: an extractor is bound to the first batch it reads, and to that dispatch', () => {
  dispatch(proj, 'batch-001');
  dispatch(proj, 'batch-002');
  const b1 = extractor('agent-b1');
  const read = (id: string, agent: Record<string, unknown>, dir = 'batches', ext = 'md') =>
    guard(preToolUse('Read', { file_path: `${base}/out/${dir}/${id}.${ext}` }, agent));
  const write = (id: string, agent: Record<string, unknown>) => guard(preToolUse('Write', { file_path: `${base}/out/extract/${id}.json`, content: '{}' }, agent));

  // The taxonomy binds nothing; the first batch file does.
  assert.equal(verdict(preToolUse('Read', { file_path: `${base}/out/taxonomy.json` }, b1)), 'silent');
  assert.equal(boundBatch(proj, 'agent-b1'), null);
  assert.equal(read('batch-001', b1).verdict, 'silent');
  const binding = boundBatch(proj, 'agent-b1');
  assert.deepEqual([binding?.batch_id, binding?.dispatches], ['batch-001', readBatchState(proj, 'batch-001').dispatches]);

  // Another batch's files are refused, read or write; its own output may be written.
  assert.match(read('batch-002', b1).reason, /Read of out\/batches\/batch-002\.md is refused: it is working on batch-001 \(the first batch file it read\)/);
  assert.equal(read('batch-002', b1, 'extract', 'json').verdict, 'deny');
  assert.match(write('batch-002', b1).reason, /it is working on batch-001/);
  assert.equal(write('batch-001', b1).verdict, 'silent');
  assert.equal(boundBatch(proj, 'agent-b1')?.batch_id, 'batch-001', 'the first binding stands');

  // So is another batch's problems file; reading its own previous output or problems file first
  // binds just the same.
  assert.match(read('batch-002', b1, 'fix', 'txt').reason, /Read of out\/fix\/batch-002\.txt is refused: it is working on batch-001/);
  assert.equal(read('batch-001', b1, 'fix', 'txt').verdict, 'silent');
  assert.equal(read('batch-002', extractor('agent-b5'), 'extract', 'json').verdict, 'silent');
  assert.equal(boundBatch(proj, 'agent-b5')?.batch_id, 'batch-002');
  assert.equal(read('batch-002', extractor('agent-b6'), 'fix', 'txt').verdict, 'silent');
  assert.equal(boundBatch(proj, 'agent-b6')?.batch_id, 'batch-002');

  // No binding, no write; no agent_id, no binding.
  assert.match(write('batch-002', extractor('agent-b2')).reason, /Write of out\/extract\/batch-002\.json is refused: it has not read its batch yet/);
  assert.match(read('batch-001', { agent_type: 'extractor' }).reason, /carries no agent_id/);

  // A batch nobody dispatched can't be bound.
  const b3 = read('batch-003', extractor('agent-b3'));
  assert.match(b3.reason, /it cannot start on batch-003: batch-003 is pending, not running/);
  assert.equal(boundBatch(proj, 'agent-b3'), null);
  assert.ok(runLog('adhoc').some((e) => e.event === 'guard_bind_refused' && e.agent_id === 'agent-b3' && e.batch_id === 'batch-003'));

  // A re-dispatch hands the batch to a new extractor: the old one may no longer write.
  stamp(proj, 'batch-001', false);
  const redispatched = dispatch(proj, 'batch-001');
  assert.equal(redispatched.dispatches, (binding?.dispatches ?? 0) + 1);
  assert.match(write('batch-001', b1).reason, /batch-001 has been handed to another extractor since this one started/);
  const b4 = extractor('agent-b4');
  assert.equal(read('batch-001', b4).verdict, 'silent');
  assert.equal(boundBatch(proj, 'agent-b4')?.dispatches, redispatched.dispatches);
  assert.equal(write('batch-001', b4).verdict, 'silent');

  // Once the batch is stamped its output can't change.
  stamp(proj, 'batch-001', true);
  assert.match(write('batch-001', b4).reason, /batch-001 is no longer being extracted \(it is done\)/);

  const bound = runLog('adhoc').filter((e) => e.event === 'guard_bind' && e.batch_id === 'batch-001').map((e) => [e.agent_id, e.dispatches]);
  assert.deepEqual(bound, [['agent-b1', binding?.dispatches], ['agent-b4', redispatched.dispatches]]);
});

test('guard: the taxonomist reads the digest and its proposal and writes only the proposal', () => {
  const tax = { agent_id: 'agent-t', agent_type: 'taxonomist' };
  const allowed: Array<[string, Record<string, unknown>]> = [
    ['Read', { file_path: `${base}/out/taxonomy-digest.md` }],
    ['Read', { file_path: `${base}/out/taxonomy-digest.md`, offset: 300, limit: 300 }],
    ['Read', { file_path: `${base}/out/taxonomy-proposed.json` }],
    ['Write', { file_path: `${base}/out/taxonomy-proposed.json`, content: '{"processes":[]}' }],
    ['SubagentHandback', { message: 'Wrote the proposal.' }],
  ];
  for (const [tool, input] of allowed) assert.equal(verdict(preToolUse(tool, input, tax)), 'silent', `${tool} ${JSON.stringify(input)}`);
  const denied: Array<[string, Record<string, unknown>]> = [
    ['Read', { file_path: `${base}/out/taxonomy.json` }],
    ['Write', { file_path: `${base}/out/taxonomy.json`, content: '{}' }],
    ['Read', { file_path: `${base}/out/batches/${BATCH}.md` }],
    ['Read', { file_path: `${base}/out/fix/${BATCH}.txt` }],
    ['Read', { file_path: `${base}/out/threads.json` }],
    ['Read', { file_path: `${base}/out/messages.jsonl` }],
    ['Read', { file_path: `${base}/out/ledger/taxonomy.json` }],
    ['Write', { file_path: `${base}/out/ledger/taxonomy.json`, content: '{}' }],
    ['Write', { file_path: `${base}/.claude/agents/taxonomist.md`, content: 'x' }],
    ['Write', { file_path: `${base}/out/taxonomy-digest.md`, content: 'x' }],
    ['Read', { file_path: `${base}/${A}` }],
    ['Read', { file_path: `${base}/corpus-view/alpha/inbox/1.eml` }],
    ['Edit', { file_path: `${base}/out/taxonomy-proposed.json`, old_string: 'a', new_string: 'b' }],
    ['Bash', { command: 'node obs.mjs taxonomy accept' }],
    ['Glob', { pattern: 'out/*.json' }],
    ['Grep', { pattern: 'x', path: `${base}/out` }],
    ['Agent', { subagent_type: 'taxonomist', prompt: 'x' }],
  ];
  for (const [tool, input] of denied) {
    const g = guard(preToolUse(tool, input, tax));
    assert.equal(g.verdict, 'deny', `${tool} ${JSON.stringify(input)}`);
    assert.match(g.reason, /^Guard for the taxonomist subagent: /);
    assert.match(g.reason, /It may use only Read of out\/taxonomy-digest\.md and out\/taxonomy-proposed\.json, and Write of out\/taxonomy-proposed\.json/);
  }
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
  assert.equal(verdict(preToolUse('Agent', { subagent_type: 'general-purpose', prompt: 'x', description: 'y' })), 'silent');
  assert.equal(verdict(preToolUse('Agent', { prompt: 'x', description: 'y' })), 'silent');
  assert.equal(verdict('not json at all'), 'silent', 'unreadable input from an unknown caller, no run');
  assert.ok(!existsSync(stopGateFile(proj)), 'no orchestrator recorded outside a run');
});

test('guard: while a run is active, any caller is kept off the corpus and to the pipeline subagents', () => {
  setRun(proj, true);
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
      ['Agent', { subagent_type: 'general-purpose', prompt: 'x', description: 'y' }, {}],
      ['Agent', { subagent_type: 'Explore', prompt: 'x' }, {}],
      ['Agent', { prompt: 'x', description: 'no type given' }, {}],
      ['Task', { subagent_type: 'Plan', prompt: 'x' }, {}],
    ];
    for (const [tool, input, extra] of denied) {
      const g = guard(preToolUse(tool, input, extra));
      assert.equal(g.verdict, 'deny', `${tool} ${JSON.stringify(input)}`);
      assert.match(g.reason, /clear the run marker with: node obs\.mjs run end$/);
    }
    assert.match(
      guard(preToolUse('Agent', { subagent_type: 'Explore', prompt: 'x' })).reason,
      /only the pipeline's own subagents \(extractor, taxonomist, synthesizer, drafter\) may be started, so the Explore subagent is refused/,
    );
    for (const file_path of [`${proj}/out/batches/${BATCH}.md`, 'tests/fixtures/corpus-mini/1.eml', 'out/my_corpus/x', 'docs/corpusnotes.md']) {
      assert.equal(verdict(preToolUse('Read', { file_path })), 'silent', file_path);
    }
    for (const type of ['extractor', 'taxonomist']) {
      assert.equal(verdict(preToolUse('Agent', { subagent_type: type, description: 'Extract batch-000', prompt: 'x', run_in_background: true })), 'silent', type);
    }
    assert.equal(verdict('not json at all'), 'deny', 'unreadable input during a run fails closed');
  } finally {
    setRun(proj, false);
    rmSync(stopGateFile(proj), { force: true });
  }
  assert.equal(verdict(preToolUse('Read', { file_path: 'corpus/alpha/inbox/1' })), 'silent', 'after the run ends');
});

test('guard: the session that starts a pipeline subagent during a run is recorded as its orchestrator', () => {
  const spawn = (session_id: string, subagent_type: string) => preToolUse('Agent', { subagent_type, description: 'x', prompt: 'x' }, { session_id });
  const gate = () => JSON.parse(readFileSync(stopGateFile(proj), 'utf8'));
  setRun(proj, true, 'r-claim');
  try {
    assert.equal(verdict(spawn('s-orch', 'taxonomist')), 'silent');
    assert.deepEqual(gate(), { run_id: 'r-claim', session_id: 's-orch', last_block: null });
    writeFileSync(stopGateFile(proj), JSON.stringify({ run_id: 'r-claim', session_id: 's-orch', last_block: 'dispatch:batch-000' }));
    assert.equal(verdict(spawn('s-orch', 'extractor')), 'silent');
    assert.equal(gate().last_block, 'dispatch:batch-000', 'the same session again changes nothing');
    assert.equal(verdict(spawn('s-dev', 'Explore')), 'deny');
    assert.equal(verdict(preToolUse('Read', { file_path: 'README.md' }, { session_id: 's-dev' })), 'silent');
    assert.equal(gate().session_id, 's-orch', 'a refused spawn or another tool claims nothing');
    assert.equal(runLog('r-claim').filter((e) => e.event === 'guard_claim').length, 1);
  } finally {
    setRun(proj, false, 'r-claim');
    rmSync(stopGateFile(proj), { force: true });
  }
  assert.equal(verdict(spawn('s-other', 'extractor')), 'silent');
  assert.ok(!existsSync(stopGateFile(proj)), 'outside a run nothing is claimed');
});

test('guard: a Bash call starting `node obs.mjs run start` claims the run for its session, inside a run or not; run start takes the claim', () => {
  const dir = join(tmp, 'claim');
  addBatches(dir, ids(0, 1));
  const claimPath = join(dir, 'out', 'ledger', 'claim.json');
  const bash = (command: string, extra: Record<string, unknown> = {}) => preToolUse('Bash', { command }, { cwd: dir, session_id: 's-orch', ...extra });
  const claimed = (): Record<string, unknown> | null => (existsSync(claimPath) ? JSON.parse(readFileSync(claimPath, 'utf8')) : null);

  for (const command of ['node obs.mjs run start', '  node obs.mjs run start --force']) {
    assert.equal(verdict(bash(command), dir), 'silent', command);
    const claim = claimed();
    assert.deepEqual(Object.keys(claim ?? {}), ['session_id', 'utc'], command);
    assert.equal(claim?.session_id, 's-orch');
    assert.match(String(claim?.utc), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    rmSync(claimPath);
  }
  for (const command of ['node obs.mjs status', 'node obs.mjs run end', 'node obs.mjs run starts', 'echo node obs.mjs run start', 'node obs.mjs prepare && node obs.mjs run start']) {
    assert.equal(verdict(bash(command), dir), 'silent', command);
    assert.equal(claimed(), null, command);
  }
  assert.equal(verdict(bash('node obs.mjs run start', { session_id: undefined }), dir), 'silent');
  assert.equal(claimed(), null, 'no session to name');
  // A pipeline subagent may not run commands at all, so it claims nothing.
  assert.equal(verdict(bash('node obs.mjs run start', extractor('agent-c')), dir), 'deny');
  assert.equal(claimed(), null);

  // Inside an active run (a resume): the same claim, and the call goes ahead.
  setRun(dir, true, 'r-old');
  assert.equal(verdict(bash('node obs.mjs run start'), dir), 'silent');
  assert.equal(claimed()?.session_id, 's-orch');
  assert.equal(runLog('r-old', dir).filter((e) => e.event === 'guard_claim').length, 1);
  // run start turns it into the new run's orchestrator session, before anything else.
  const { log } = console;
  console.log = () => {};
  try {
    assert.equal(runCommand(dir, ['start']), 0);
  } finally {
    console.log = log;
  }
  const run = JSON.parse(readFileSync(join(dir, 'out', 'ledger', 'run.json'), 'utf8'));
  assert.deepEqual(JSON.parse(readFileSync(stopGateFile(dir), 'utf8')), { run_id: run.run_id, session_id: 's-orch', last_block: null });
  assert.equal(claimed(), null, 'used once');
  // So the Stop hook steers that session and leaves another one alone.
  const other = hook('gate-run', { session_id: 's-dev', cwd: dir, hook_event_name: 'Stop', background_tasks: [] }, dir);
  assert.deepEqual([other.status, other.stdout], [0, '']);
  assert.equal(runLog(run.run_id, dir).find((e) => e.event === 'gate_run')?.decision, 'other_session');
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
  assert.equal(verdict('{"agent_type": "taxonomist", "tool_input": {"file_path": "out/tax'), 'deny', 'truncated JSON from the taxonomist');
  // A binding file that can't be read refuses the batch rather than guessing.
  mkdirSync(join(proj, 'out', 'ledger', 'agents'), { recursive: true });
  writeFileSync(join(proj, 'out', 'ledger', 'agents', 'agent-broken.json'), '{broken');
  assert.equal(verdict(preToolUse('Read', { file_path: `${base}/out/batches/${BATCH}.md` }, extractor('agent-broken'))), 'deny');
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

// ---- gate-subagent: records, never blocks ----

const subagentStop = (agent_id: string, agent_type = 'extractor', last_assistant_message = 'Wrote the extraction for batch-000.') => ({
  session_id: 's1',
  transcript_path: 't.jsonl',
  cwd: proj,
  permission_mode: 'auto',
  hook_event_name: 'SubagentStop',
  stop_hook_active: false,
  agent_id,
  agent_type,
  agent_transcript_path: 'subagents/none.jsonl',
  last_assistant_message,
  background_tasks: [],
  session_crons: [],
});
const bindTo = (agentId: string, batchId = BATCH) =>
  assert.equal(verdict(preToolUse('Read', { file_path: `${base}/out/batches/${batchId}.md` }, extractor(agentId))), 'silent', `bind ${agentId}`);
const lastEvent = (event: string, dir = proj, log = 'adhoc') => runLog(log, dir).filter((e) => e.event === event).at(-1);

// The gate's whole output is its run-log line: stdout stays empty in every case.
function gate(agentId: string, input: unknown = subagentStop(agentId)): HookResult {
  const r = hook('gate-subagent', input);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', `the gate never emits a decision: ${r.stdout}`);
  return r;
}

test('gate: a valid output from the bound agent is recorded done, under the same agent_id the guard bound', () => {
  dispatchWith(goodExtraction());
  bindTo('agent-g1');
  gate('agent-g1');
  assert.equal(statusOf(BATCH), 'done');
  const state = readBatchState(proj, BATCH);
  assert.deepEqual([state.problems, state.last_problems], [0, []]);
  assert.deepEqual(state.quote_stats, { exact: 4, repaired: 0, rejected: 0 }, 'three evidence quotes and one stall quote, all exact');
  const validated = JSON.parse(readFileSync(validatedFile(proj, BATCH), 'utf8'));
  assert.deepEqual([validated.batch_id, validated.evidence.length], [BATCH, 3]);
  const g = lastEvent('gate');
  assert.deepEqual([g?.agent_id, g?.batch_id, g?.status, g?.problems, g?.dispatches], ['agent-g1', BATCH, 'done', 0, state.dispatches]);
  assert.equal(lastEvent('guard_bind')?.agent_id, 'agent-g1', 'the binding and the gate share the agent_id');
});

test('gate: an invalid output is recorded failed with its problems, for a fix round', () => {
  dispatchWith(badExtraction());
  bindTo('agent-g2');
  gate('agent-g2', subagentStop('agent-g2', 'extractor', 'OUTPUT: out/extract/batch-001.json'));
  assert.equal(statusOf(BATCH), 'failed', 'judged by the binding, whatever the reply says');
  const state = readBatchState(proj, BATCH);
  assert.ok((state.problems ?? 0) > 0);
  assert.ok(state.last_problems.some((p) => /quote not found verbatim/.test(p)), state.last_problems.join('\n'));
  assert.ok(state.last_problems.every(noLocalPaths));
  assert.deepEqual(state.quote_stats, { exact: 3, repaired: 0, rejected: 1 });
  assert.equal(lastEvent('gate')?.status, 'failed');
  // The fix round that follows hands those problems to the next extractor in its problems file,
  // which the guard lets that extractor read once it is bound to the batch.
  const { fix } = markDispatched(proj, entryOf(proj, BATCH));
  assert.ok(fix !== null && fix.length > 0);
  const problems = readFileSync(join(proj, 'out', 'fix', `${BATCH}.txt`), 'utf8');
  for (const p of state.last_problems) assert.ok(problems.includes(p), p);
  const prompt = extractorPrompt(proj, BATCH, fix);
  assert.match(prompt, /^Problems file: .*\/out\/fix\/batch-000\.txt$/m);
  for (const p of state.last_problems) assert.ok(!prompt.includes(p), 'the problems travel in the file, not the prompt');
  assert.ok(existsSync(extractPath), 'the previous output stays for the fix round');
  bindTo('agent-g3');
  assert.equal(verdict(preToolUse('Read', { file_path: `${base}/out/fix/${BATCH}.txt` }, extractor('agent-g3'))), 'silent');
});

test('gate: an agent with no binding is logged gate_unbound and nothing is stamped', () => {
  dispatchWith(goodExtraction());
  gate('agent-never-read');
  assert.equal(statusOf(BATCH), 'running', 'left for the orchestrator to validate');
  assert.equal(lastEvent('gate_unbound')?.agent_id, 'agent-never-read');
  gate('', { ...subagentStop(''), agent_id: undefined });
  assert.equal(lastEvent('gate_unbound')?.agent_id, null, 'no agent_id at all');
  assert.equal(statusOf(BATCH), 'running');
});

test('gate: a binding superseded by a re-dispatch is logged gate_superseded and the new dispatch is untouched', () => {
  dispatchWith(badExtraction());
  bindTo('agent-s1');
  const first = readBatchState(proj, BATCH).dispatches;
  stamp(proj, BATCH, false);
  markDispatched(proj, entryOf(proj, BATCH));
  gate('agent-s1');
  const state = readBatchState(proj, BATCH);
  assert.deepEqual([state.status, state.dispatches], ['running', first + 1]);
  const logged = lastEvent('gate_superseded');
  assert.deepEqual([logged?.agent_id, logged?.batch_id, logged?.bound_dispatch, logged?.dispatches], ['agent-s1', BATCH, first, first + 1]);
});

test('guard and gate: a re-dispatch under new inputs supersedes a binding even at the same dispatch count', () => {
  dispatchWith(goodExtraction());
  bindTo('agent-k1');
  const before = readBatchState(proj, BATCH);
  stamp(proj, BATCH, false);
  const agentDef = join(proj, '.claude', 'agents', 'extractor.md');
  const saved = readFileSync(agentDef, 'utf8');
  writeFileSync(agentDef, `${saved}\nA changed definition: a new cache key.\n`);
  try {
    const after = dispatch(proj, BATCH);
    assert.equal(after.dispatches, before.dispatches, 'the count restarts under the new key, so it matches the old binding');
    assert.notEqual(after.cache_key, before.cache_key);
    const write = guard(preToolUse('Write', { file_path: extractPath, content: '{}' }, extractor('agent-k1')));
    assert.match(write.reason, /batch-000 has been handed to another extractor since this one started/);
    gate('agent-k1');
    assert.equal(lastEvent('gate_superseded')?.agent_id, 'agent-k1');
    assert.equal(readBatchState(proj, BATCH).status, 'running', 'the new dispatch is untouched');
  } finally {
    writeFileSync(agentDef, saved);
  }
});

test('gate: a batch already stamped is left alone (gate_not_running)', () => {
  dispatchWith(goodExtraction());
  bindTo('agent-n1');
  recordValidation(proj, entryOf(proj, BATCH), checkExtraction(proj, BATCH, { outDir: join(proj, 'out') }));
  const before = readFileSync(join(proj, 'out', 'ledger', `${BATCH}.json`), 'utf8');
  gate('agent-n1');
  assert.equal(readFileSync(join(proj, 'out', 'ledger', `${BATCH}.json`), 'utf8'), before);
  assert.deepEqual([lastEvent('gate_not_running')?.agent_id, lastEvent('gate_not_running')?.status], ['agent-n1', 'done']);
});

test('gate: a setup problem the model cannot fix stamps nothing; the batch stays running', () => {
  dispatchWith(goodExtraction());
  bindTo('agent-su');
  const messages = join(proj, 'out', 'messages.jsonl');
  renameSync(messages, `${messages}.away`);
  try {
    gate('agent-su');
    const state = readBatchState(proj, BATCH);
    assert.deepEqual([state.status, state.problems], ['running', null]);
    const logged = lastEvent('gate_setup_error');
    assert.equal(logged?.agent_id, 'agent-su');
    assert.ok(typeof logged?.setup === 'string' && logged.setup !== '');
    assert.ok(noLocalPaths(JSON.stringify(logged)), JSON.stringify(logged));
  } finally {
    renameSync(`${messages}.away`, messages);
  }
  gate('agent-su');
  assert.equal(statusOf(BATCH), 'done', 'checked once the setup is fixed');
});

test('gate: ignores other agents, and logs a stop whose input names no agent', () => {
  dispatchWith(badExtraction());
  bindTo('agent-other');
  const before = readFileSync(join(proj, 'out', 'ledger', `${BATCH}.json`), 'utf8');
  for (const agent of ['drafter', 'synthesizer', 'taxonomist', 'general-purpose']) gate('agent-other', subagentStop('agent-other', agent));
  gate('agent-anon', { ...subagentStop('agent-anon'), agent_type: undefined });
  const skipped = runLog('adhoc').at(-1);
  assert.deepEqual([skipped?.event, skipped?.agent_id], ['gate_skipped', 'agent-anon']);
  assert.equal(readFileSync(join(proj, 'out', 'ledger', `${BATCH}.json`), 'utf8'), before, 'ledger untouched');
});

test('gate: if the gate itself fails it reports the error and lets the subagent finish', () => {
  dispatchWith(goodExtraction());
  bindTo('agent-err');
  const index = join(proj, 'out', 'batches', 'index.json');
  renameSync(index, `${index}.away`);
  try {
    const r = gate('agent-err');
    assert.match(r.stderr, /^gate-subagent: .*prepare/m);
    assert.ok(!r.stderr.includes('    at '), 'no stack trace');
    assert.ok(noLocalPaths(r.stderr), r.stderr);
    assert.equal(runLog('adhoc').at(-1)?.event, 'gate_error');
  } finally {
    renameSync(`${index}.away`, index);
  }
  assert.equal(statusOf(BATCH), 'running');
});

// ---- log-event ----

test('log-event: appends one line per event to the run log, adhoc outside a run', () => {
  const start = { session_id: 's1', cwd: proj, hook_event_name: 'SubagentStart', agent_id: 'agent-7', agent_type: 'extractor' };
  assert.equal(hook('log-event', start).status, 0);
  const line = runLog('adhoc').at(-1);
  assert.deepEqual({ ...line, ts: undefined }, { ts: undefined, event: 'SubagentStart', agent_type: 'extractor', agent_id: 'agent-7' });
  assert.match(String(line?.ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  setRun(proj, true, '20261017T010000Z');
  try {
    assert.equal(hook('log-event', { ...start, hook_event_name: 'SubagentStop', agent_type: 'taxonomist', agent_id: 'agent-8' }).status, 0);
    assert.deepEqual(
      runLog('20261017T010000Z').map((e) => [e.event, e.agent_type, e.agent_id]),
      [['SubagentStop', 'taxonomist', 'agent-8']],
    );
  } finally {
    setRun(proj, false, '20261017T010000Z');
  }
  const garbage = hook('log-event', 'not json');
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, '');
});

// ---- gate-run: the Stop hook ----

const skill = readFileSync(join(repo, '.claude', 'skills', 'observe', 'SKILL.md'), 'utf8');
const reasons: Record<string, string[]> = { validate: [], taxonomy: [], dispatch: [], run_end: [] };

// A project with `n` empty batches, a stand-in taxonomist definition and a digest; fresh taxonomy
// unless told otherwise.
function runProject(name: string, n: number, opts: { taxonomy?: 'fresh' | 'missing' } = {}): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  copyFileSync(join(repo, '.claude', 'agents', 'extractor.md'), join(dir, '.claude', 'agents', 'extractor.md'));
  writeFileSync(join(dir, '.claude', 'agents', 'taxonomist.md'), '---\nname: taxonomist\n---\nA stand-in: only its hash matters here.\n');
  mkdirSync(join(dir, 'out'), { recursive: true });
  writeFileSync(join(dir, 'out', 'taxonomy-digest.md'), '# taxonomy digest (stand-in)\n');
  addBatches(dir, ids(0, n - 1));
  if ((opts.taxonomy ?? 'fresh') === 'fresh') {
    const s = currentShas(dir);
    writeFileSync(join(dir, 'out', 'taxonomy.json'), JSON.stringify(canonicalTaxonomy([], s.digest_sha, s.agent_sha)));
  }
  setRun(dir, true, 'r-stop');
  return dir;
}

type Task = { id: string; type: string; status: string; description: string; agent_type?: string };
// agent_type null: an entry without the field.
const task = (description: string, status = 'running', agent_type: string | null = 'extractor'): Task => ({
  id: `t-${description.replace(/\W+/g, '-')}`,
  type: 'subagent',
  status,
  description,
  ...(agent_type === null ? {} : { agent_type }),
});
const stopInput = (dir: string, tasks: Task[] | undefined, session_id = 's-orch') => ({
  session_id,
  transcript_path: 't.jsonl',
  cwd: dir,
  permission_mode: 'auto',
  hook_event_name: 'Stop',
  stop_hook_active: false,
  last_assistant_message: 'Dispatched the next wave.',
  ...(tasks === undefined ? {} : { background_tasks: tasks, session_crons: [] }),
});

// One Stop: the block reason, or null when the turn may end. Exit 0 and nothing on stderr, always.
function stop(dir: string, tasks: Task[] | undefined, opts: { session?: string; inFlight?: number } = {}): string | null {
  const r = hook('gate-run', stopInput(dir, tasks, opts.session), dir, { OBS_IN_FLIGHT: String(opts.inFlight ?? 12) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stderr.includes('gate-run:'), r.stderr);
  const d = decision(r);
  if (d === null) return null;
  assert.deepEqual(Object.keys(d).sort(), ['decision', 'reason']);
  assert.equal(d.decision, 'block');
  const reason = String(d.reason);
  assert.ok(noLocalPaths(reason) && !reason.includes(dir), reason);
  const kind = lastEvent('gate_run', dir, 'r-stop')?.kind as string;
  reasons[kind]?.push(reason);
  return reason;
}
const forget = (dir: string) => rmSync(stopGateFile(dir), { force: true });

// Make running batches look as if they were dispatched `seconds` ago.
function age(dir: string, batchIds: readonly string[], seconds: number): void {
  const at = new Date(Date.now() - seconds * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  for (const id of batchIds) updateBatchState(dir, id, (s) => ({ ...s, dispatched_utc: at }));
}
const PAST_GRACE = ORPHAN_GRACE_S + 60;
const PAST_MAX = 20 * 60; // the Stop hook's ORPHAN_MAX_S is 15 minutes

test('stop gate: silent without an active run', () => {
  const dir = runProject('stop-idle', 2);
  setRun(dir, false, 'r-stop');
  assert.equal(stop(dir, []), null);
  rmSync(join(dir, 'out', 'ledger', 'run.json'));
  assert.equal(stop(dir, undefined), null);
  assert.ok(!existsSync(stopGateFile(dir)) && !existsSync(join(dir, 'out', 'runs')), 'nothing written outside a run');
});

test('stop gate: a taxonomy that is not fresh comes first, unless a taxonomist is still working', () => {
  const dir = runProject('stop-taxonomy', 3, { taxonomy: 'missing' });
  const missing = stop(dir, []);
  assert.match(missing ?? '', /^Pipeline run: the taxonomy is missing\. Run `node obs\.mjs taxonomy` and carry on with step 2 of \/observe\.$/);
  forget(dir);
  writeFileSync(join(dir, 'out', 'taxonomy.json'), JSON.stringify({ version: 1, digest_sha: 'old', agent_sha: 'old', processes: [] }));
  assert.match(stop(dir, []) ?? '', /the taxonomy is out of date/);
  forget(dir);
  assert.equal(stop(dir, [task('Build taxonomy', 'running', 'taxonomist')]), null, 'a live taxonomist is waited for');
});

test('stop gate: free slots are filled by naming each dispatch command', () => {
  const dir = runProject('stop-dispatch', 5);
  const reason = stop(dir, [], { inFlight: 3 });
  assert.equal(
    reason,
    'Pipeline run: batch-000, batch-001, batch-002 are ready to dispatch. Run `node obs.mjs dispatch batch-000`, `node obs.mjs dispatch batch-001`, ' +
      '`node obs.mjs dispatch batch-002`, then start one extractor per dispatched batch, all in one message, as in step 3 of /observe, and end your turn.',
  );
  // Two running and accounted for: one slot left.
  dispatch(dir, 'batch-000');
  dispatch(dir, 'batch-001');
  assert.match(stop(dir, [task('Extract batch-000'), task('Extract batch-001')], { inFlight: 3 }) ?? '', /^Pipeline run: batch-002 is ready to dispatch\./);
  // All slots busy: wait for completions.
  dispatch(dir, 'batch-002');
  assert.equal(stop(dir, [task('Extract batch-000'), task('Extract batch-001'), task('Extract batch-002')], { inFlight: 3 }), null);
  assert.equal(JSON.parse(readFileSync(stopGateFile(dir), 'utf8')).last_block, null, 'a wait clears the repeat memory');
  const logged = lastEvent('gate_run', dir, 'r-stop');
  assert.deepEqual([logged?.decision, logged?.orphan_check], ['wait', 'checked']);
  assert.deepEqual(logged?.tasks, [0, 1, 2].map((i) => ({ type: 'subagent', agent_type: 'extractor', status: 'running', description: `Extract batch-00${i}` })), 'raw statuses logged');
});

test('stop gate: a running batch no live extractor accounts for is named for validate, once past the grace period', () => {
  const dir = runProject('stop-orphans', 4);
  for (const id of ids(0, 2)) dispatch(dir, id);
  age(dir, ids(0, 2), PAST_GRACE);
  const reason = stop(dir, [task('Extract batch-000'), task('Extract batch-001', 'completed')]);
  assert.equal(
    reason,
    'Pipeline run: batch-001, batch-002 are still running, but no extractor is working on them. Run `node obs.mjs validate batch-001`, ' +
      '`node obs.mjs validate batch-002`, then `node obs.mjs status --json`, and carry on with step 4 of /observe.',
  );
  // Every finished status counts as finished, in any case.
  for (const status of ['completed', 'done', 'failed', 'stopped', 'killed', 'cancelled', 'Completed']) {
    forget(dir);
    const r = stop(dir, [task('Extract batch-000'), task('Extract batch-001', status), task('Extract batch-002')]);
    assert.match(r ?? '', /^Pipeline run: batch-001 is still running, but no extractor is working on it\./, status);
  }
  // Unknown statuses count as live; the batch number is matched loosely.
  forget(dir);
  const loose = [task('Extract batch 0', 'queued'), task('extract BATCH-001 (fix round)', 'something-new'), task('Extract batch-002', 'pending', null)];
  assert.match(stop(dir, loose) ?? '', /^Pipeline run: batch-003 is ready to dispatch\./, 'no orphan, so on to dispatch');
  assert.equal(lastEvent('gate_run', dir, 'r-stop')?.orphan_check, 'checked');
  // A non-extractor task never accounts for a batch.
  forget(dir);
  const other = [task('Extract batch-000'), task('Extract batch-001'), task('Extract batch-002', 'running', 'general-purpose')];
  assert.match(stop(dir, other) ?? '', /^Pipeline run: batch-002 is still running/);
});

test('stop gate: right after dispatch nothing is taken for an orphan, even with an empty registry', () => {
  const dir = runProject('stop-fresh', 3);
  for (const id of ids(0, 2)) dispatch(dir, id);
  assert.equal(stop(dir, [], { inFlight: 3 }), null, 'extractors not yet in the registry: wait');
  assert.deepEqual([lastEvent('gate_run', dir, 'r-stop')?.decision, lastEvent('gate_run', dir, 'r-stop')?.orphan_check], ['wait', 'checked']);
  assert.equal(stop(dir, [task('Extract batch-000', 'completed')], { inFlight: 3 }), null);
});

test('stop gate: without background_tasks, or with a registry it cannot read, orphans are not guessed', () => {
  const dir = runProject('stop-unknown', 3);
  for (const id of ids(0, 2)) dispatch(dir, id);
  age(dir, ids(0, 2), PAST_GRACE);
  assert.equal(stop(dir, undefined, { inFlight: 3 }), null, 'running batches count as live');
  assert.match(String(lastEvent('gate_run', dir, 'r-stop')?.orphan_check), /^skipped: no background_tasks/);
  assert.equal(lastEvent('gate_run', dir, 'r-stop')?.tasks, null);
  assert.equal(stop(dir, [task('Extract something')], { inFlight: 3 }), null);
  assert.match(String(lastEvent('gate_run', dir, 'r-stop')?.orphan_check), /^skipped: a live extractor description names no batch/);
  // A live subagent task neither typed nor described as a pipeline agent: shapes unknown, so wait.
  for (const odd of [
    [{ id: 't1', type: 'subagent', status: 'running', description: 'Working on it' }],
    [{ id: 't2', type: 'subagent', status: 'running', description: '' }],
    [task('Extract batch-000'), { id: 't3', type: 'subagent', status: 'in_progress', description: 'b-001' }],
  ]) {
    assert.equal(stop(dir, odd as Task[], { inFlight: 3 }), null, JSON.stringify(odd));
    assert.equal(lastEvent('gate_run', dir, 'r-stop')?.orphan_check, 'skipped: a live subagent task of unrecognised shape');
  }
});

test('stop gate: a batch running for 15 minutes is validated whatever the registry says', () => {
  const dir = runProject('stop-stale', 3);
  for (const id of ids(0, 2)) dispatch(dir, id);
  age(dir, ['batch-001'], PAST_MAX);
  const expected = /^Pipeline run: batch-001 is still running, but no extractor is working on it\. Run `node obs\.mjs validate batch-001`/;
  assert.match(stop(dir, undefined, { inFlight: 3 }) ?? '', expected, 'no registry');
  forget(dir);
  const unknownStatus = ids(0, 2).map((id) => task(`Extract ${id}`, 'succeeded'));
  assert.match(stop(dir, unknownStatus, { inFlight: 3 }) ?? '', expected, 'finished under a status it does not know');
  forget(dir);
  assert.match(stop(dir, [{ id: 't1', type: 'subagent', status: 'running', description: 'Working on it' }], { inFlight: 3 }) ?? '', expected, 'unreadable registry');
});

test('stop gate: when nothing is left it asks for run end once, then lets the turn end', () => {
  const dir = runProject('stop-end', 2);
  for (const id of ids(0, 1)) {
    dispatch(dir, id);
    stamp(dir, id, true);
  }
  const first = stop(dir, []);
  assert.equal(first, 'Pipeline run: extraction is complete. Run `node obs.mjs run end`, then `node obs.mjs status`, and print its output (step 5 of /observe).');
  assert.equal(stop(dir, []), null, 'the same reason twice in a row: give up');
  const gaveUp = lastEvent('gate_run_gave_up', dir, 'r-stop');
  assert.deepEqual([gaveUp?.kind, gaveUp?.ids], ['run_end', []]);
  assert.equal(stop(dir, []), first, 'after letting one turn end it may ask again');

  // An exhausted batch is reported by status, not waited for: the run still ends.
  forget(dir);
  const statusOf1 = () => batchViews(dir).find((v) => v.entry.id === 'batch-001')?.status;
  markDispatched(dir, entryOf(dir, 'batch-001'), { force: true });
  stamp(dir, 'batch-001', false);
  for (let i = 0; i < 2 * MAX_DISPATCHES && statusOf1() !== 'exhausted'; i++) {
    dispatch(dir, 'batch-001');
    stamp(dir, 'batch-001', false);
  }
  assert.equal(statusOf1(), 'exhausted');
  assert.match(stop(dir, []) ?? '', /^Pipeline run: extraction is complete\. Run `node obs\.mjs run end`/);
});

test('stop gate: when status reports a halt the turn may end, whatever else is pending', () => {
  const dir = runProject('stop-halt', 8);
  for (const id of ids(0, HALT_NO_OUTPUT - 1)) {
    dispatch(dir, id);
    stamp(dir, id, false); // no output file: extractors cut off before they wrote
  }
  dispatch(dir, ids(HALT_NO_OUTPUT, HALT_NO_OUTPUT)[0] as string);
  age(dir, ids(HALT_NO_OUTPUT, HALT_NO_OUTPUT), PAST_MAX);
  assert.equal(stop(dir, []), null, 'no dispatch, no validate: the orchestrator prints halt_reason and stops');
  assert.equal(lastEvent('gate_run', dir, 'r-stop')?.decision, 'halt');
});

test('stop gate: only the orchestrator session is steered once one is recorded', () => {
  const dir = runProject('stop-session', 2);
  writeFileSync(stopGateFile(dir), JSON.stringify({ run_id: 'r-stop', session_id: 's-orch', last_block: null }));
  assert.equal(stop(dir, [], { session: 's-dev' }), null);
  assert.equal(lastEvent('gate_run', dir, 'r-stop')?.decision, 'other_session');
  assert.match(stop(dir, [], { session: 's-orch' }) ?? '', /ready to dispatch/);
  // What another run recorded does not count.
  writeFileSync(stopGateFile(dir), JSON.stringify({ run_id: 'r-earlier', session_id: 's-orch', last_block: 'dispatch:batch-000,batch-001' }));
  assert.match(stop(dir, [], { session: 's-dev' }) ?? '', /ready to dispatch/, 'unclaimed in this run: whoever stops is steered, and an old block is no repeat');
});

test('stop gate: a failure lets the turn end, reported without a trace or a local path', () => {
  const dir = join(tmp, 'stop-broken');
  setRun(dir, true, 'r-stop');
  const r = hook('gate-run', stopInput(dir, []), dir);
  assert.deepEqual([r.status, r.stdout], [0, '']);
  assert.match(r.stderr, /^gate-run: .*prepare/m);
  assert.ok(!r.stderr.includes('    at ') && !r.stderr.includes(dir) && !r.stderr.includes(dir.replaceAll('\\', '/')), r.stderr);
  assert.equal(lastEvent('gate_run_error', dir, 'r-stop')?.event, 'gate_run_error');
});

test('stop gate: under 2 s on a 99-batch ledger', () => {
  const dir = runProject('stop-99', 99);
  const padding = 'x'.repeat(40_000);
  for (const id of ids(0, 84)) {
    dispatch(dir, id);
    const entry = entryOf(dir, id);
    const validated = { batch_id: id, content_sha: entry.content_sha, quote_stats: { exact: 1, repaired: 0, rejected: 0 }, batch_notes: padding };
    recordValidation(dir, entry, { ok: true, setup: null, problems: [], validated: validated as unknown as ValidatedExtraction });
  }
  for (const id of ids(85, 96)) dispatch(dir, id);
  const tasks = ids(85, 96).map((id) => task(`Extract ${id}`));
  // Timed on the second stop: the first reads 85 files written a moment ago, which a virus scanner
  // may inspect first; in a run the hook fires at every turn's end over files minutes old.
  hook('gate-run', stopInput(dir, tasks), dir, { OBS_IN_FLIGHT: '12' });
  const r = hook('gate-run', stopInput(dir, tasks), dir, { OBS_IN_FLIGHT: '12' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(decision(r), null, 'twelve live, nothing free: wait');
  assert.ok(r.ms < 2000, `took ${Math.round(r.ms)} ms`);
});

test('stop gate: every reason quotes the /observe skill word for word', () => {
  for (const [kind, list] of Object.entries(reasons)) {
    assert.ok(list.length > 0, `a ${kind} reason was seen`);
    for (const reason of list) {
      const commands = [...reason.matchAll(/`([^`]+)`/g)].map((m) => (m[1] as string).replace(/batch-\d{3,6}/g, '<id>'));
      assert.ok(commands.length > 0, reason);
      for (const command of commands) assert.ok(skill.includes(`\`${command}\``), `"${command}" is in observe/SKILL.md`);
      const step = /step (\d) of \/observe/.exec(reason)?.[1];
      assert.ok(step !== undefined && skill.includes(`## ${step}. `), `${reason} names a step of the skill`);
    }
  }
});

test('the run logs hold no local paths', () => {
  for (const dir of [proj, ...readdirSync(tmp).filter((d) => d.startsWith('stop-')).map((d) => join(tmp, d))]) {
    const runs = join(dir, 'out', 'runs');
    if (!existsSync(runs)) continue;
    for (const file of readdirSync(runs)) {
      const text = readFileSync(join(runs, file), 'utf8');
      const d = dir.replaceAll('\\', '/');
      assert.ok(noLocalPaths(text) && !text.includes(d) && !text.includes(dir.replaceAll('\\', '\\\\')), `${dir} ${file}`);
    }
  }
});

// ---- Seams: settings, agent definitions, skills ----

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
    .map((f) => frontmatter(`.claude/agents/${f}`).name as string);

test('seam: the extractor definition keeps its name, tools, model and effort, and has no reply line to parse', () => {
  const fm = frontmatter('.claude/agents/extractor.md');
  assert.equal(fm.name, 'extractor', 'the SubagentStop matcher and the guard key on this name');
  assert.equal(fm.tools, 'Read, Write', 'the guard allowlist assumes exactly these');
  for (const key of ['model', 'effort']) assert.match(fm[key] ?? '', /^[a-z0-9][a-z0-9.-]*$/, `${key}: an approved choice, kept on its own line`);
  assert.equal(fm.permissionMode, 'acceptEdits');
  assert.equal(fm.maxTurns, '16');
  const text = readFileSync(join(repo, '.claude', 'agents', 'extractor.md'), 'utf8');
  assert.ok(!text.includes('OUTPUT'), 'nothing parses the reply, so the prompt asks for no OUTPUT line');
});

test('seam: the extractor is told about every line the dispatch prompt gives it', () => {
  const text = readFileSync(join(repo, '.claude', 'agents', 'extractor.md'), 'utf8');
  const fresh = extractorPrompt(proj, BATCH, null);
  const fix = extractorPrompt(proj, BATCH, ['corpus/x/1.: a problem']);
  for (const prompt of [fresh, fix]) {
    assert.ok(!prompt.includes('OUTPUT'), prompt);
    assert.match(prompt, /Reply with one short sentence and no email content\.$/);
  }
  for (const label of ['Batch file:', 'Taxonomy file:', 'Output file:', 'Previous output:', 'Problems file:', 'fix round']) {
    assert.ok(fix.includes(label), `the fix prompt has "${label}"`);
    assert.ok(text.includes(`\`${label}\``), `extractor.md explains "${label}"`);
  }
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

test('seam: settings.json wires the four hook events in exec form, on files that exist, matched to real agent names', () => {
  const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions, { allow: ['Bash(node obs.mjs *)'], deny: ['Edit(./corpus/**)'] });
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['PreToolUse', 'Stop', 'SubagentStart', 'SubagentStop']);
  const names = new Set(agentNames());
  type Group = { matcher?: string; hooks: Array<Record<string, unknown>> };
  const scripts = (event: string, matcher?: string) =>
    (settings.hooks[event] as Group[]).filter((g) => g.matcher === matcher).flatMap((g) => g.hooks.map((h) => (h.args as string[])[0]?.split('/').at(-1)));
  for (const [event, groups] of Object.entries(settings.hooks as Record<string, Group[]>)) {
    for (const group of groups) {
      if (event === 'PreToolUse') assert.equal(group.matcher, '*', 'the guard sees every tool, so its allowlist covers anything');
      else if (event === 'Stop') assert.equal(group.matcher, undefined, 'Stop takes no matcher');
      else for (const name of (group.matcher ?? '').split('|')) assert.ok(names.has(name), `${event} matcher "${name}" is an agent name`);
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
  assert.deepEqual(scripts('PreToolUse', '*'), ['guard-corpus.ts']);
  assert.deepEqual(scripts('SubagentStart', 'extractor|taxonomist'), ['log-event.ts']);
  assert.deepEqual(scripts('SubagentStop', 'extractor'), ['gate-subagent.ts', 'log-event.ts']);
  assert.deepEqual(scripts('SubagentStop', 'taxonomist'), ['log-event.ts']);
  assert.deepEqual(scripts('Stop'), ['gate-run.ts']);
});

test('seam: every agent definition has a guard allowlist', () => {
  for (const name of agentNames()) {
    const g = guard(preToolUse('Bash', { command: 'ls' }, { agent_id: 'seam', agent_type: name }));
    assert.equal(g.verdict, 'deny');
    assert.doesNotMatch(g.reason, /no allowlist/, name);
  }
});

test('seam: the observe skill is user-only, pre-approves only obs commands and the pipeline subagents, and names every command', () => {
  assert.deepEqual(frontmatter('.claude/skills/observe/SKILL.md'), {
    name: 'observe',
    description: frontmatter('.claude/skills/observe/SKILL.md').description,
    'argument-hint': '"[--force]"',
    'disable-model-invocation': 'true',
    'allowed-tools': 'Bash(node obs.mjs *) Agent(extractor) Agent(taxonomist)',
  });
  assert.ok((frontmatter('.claude/skills/observe/SKILL.md').description ?? '').length > 20);
  for (const command of [
    'node obs.mjs run start $ARGUMENTS',
    'node obs.mjs prepare',
    'node obs.mjs taxonomy',
    'node obs.mjs taxonomy accept',
    'node obs.mjs status --json',
    'node obs.mjs dispatch <id>',
    'node obs.mjs validate <id>',
    'node obs.mjs run end',
    'node obs.mjs status',
  ]) {
    assert.ok(skill.includes(`\`${command}\``), command);
  }
  for (const phrase of [
    '`subagent_type` `extractor`',
    '`description` `Extract <id>`',
    '`run_in_background` true',
    '`subagent_type` `taxonomist`',
    // The loop reads status --json: halt stops it, blocked returns to the taxonomy, complete ends it.
    'If `halt` is true, print its `halt_reason` and stop',
    'If `extraction` is `complete`, go to step 5',
    'If `extraction` is `blocked`, the taxonomy is not fresh: go back to step 2',
    'Repeat until `extraction` is `complete`',
    'An Agent call that fails or is refused counts as a completion',
  ]) {
    assert.ok(skill.includes(phrase), phrase);
  }
});

test('seam: the extract-batch skill is user-only and pre-approves only obs commands and extractors', () => {
  assert.deepEqual(frontmatter('.claude/skills/extract-batch/SKILL.md'), {
    name: 'extract-batch',
    description: frontmatter('.claude/skills/extract-batch/SKILL.md').description,
    'argument-hint': '<batch_id> [<batch_id> ...] [--force]',
    'disable-model-invocation': 'true',
    'allowed-tools': 'Bash(node obs.mjs *) Agent(extractor)',
  });
  const body = readFileSync(join(repo, '.claude', 'skills', 'extract-batch', 'SKILL.md'), 'utf8');
  assert.match(body, /`subagent_type` `extractor`/, 'dispatches the agent the settings gate');
  assert.match(body, /`description` `Extract <batch_id>`/, 'the description the Stop hook reads');
  assert.match(body, /node obs\.mjs dispatch <batch_id>/);
  assert.match(body, /node obs\.mjs dispatch <batch_id> --force/);
  assert.match(body, /node obs\.mjs validate <batch_id>/);
});
