// A complete small pipeline project for the tests, model-free (extracted from tests/run-loop.test.ts
// so tests/build.test.ts can make a whole out/ too): 30 messages in a Git-object corpus, six taxonomy
// keys and three proposed ones, and scripted stand-ins for every agent (taxonomy accept, extractor,
// merger proposal, synthesizer, drafter) that read their prompts and files the way the agent
// definitions say. runPipeline drives `advance` from the taxonomy to the run's end, the build included.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMessage } from '../../src/batch/build.ts';
import { canonicalTaxonomy } from '../../src/model/taxonomy.ts';
import { foldPeople } from '../../src/normalize/identity.ts';
import { buildPeople } from '../../src/normalize/people.ts';
import { buildThreads } from '../../src/normalize/threads.ts';
import { parseMessage } from '../../src/parse/message.ts';
import { REQUIRED_ASSETS, buildStep, currentBuildInputs } from '../../src/report/build.ts';
import { advanceCommand, runCommand, type AdvanceReport } from '../../src/run/commands.ts';
import { sha256 } from '../../src/util/hash.ts';
import { normalizeNewlines } from '../../src/util/text.ts';
import { BODIES } from './drafts.ts';
import type { ArtifactBrief, BatchEntry, Extraction, SynthesisGroup, SynthSidecar } from '../../src/types.ts';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const batchName = (n: number) => `batch-${String(n).padStart(3, '0')}`;

// Runs `fn` with console.log and console.error captured.
export function capture(fn: () => number): { code: number; out: string[]; err: string[] } {
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

// A job prompt read the way the agent definitions say (ARCHITECTURE.md 6.22): the job and whether
// it is a fix round from the first line, the project folder from the second, and every file as a
// path under the folder joined with "/".
export type Task = { id: string; fix: boolean; at: (rel: string) => string };
export function task(prompt: string, verb: 'Extract' | 'Synthesize' | 'Draft'): Task {
  const lines = prompt.split('\n');
  assert.equal(lines.length, 2, prompt);
  const m = new RegExp(`^${verb} ((?:batch|synth|draft)-\\d{3})(\\.| \\(fix round \\d+ of \\d+\\): \\d+ problems? in the problems file\\.)$`).exec(lines[0] as string);
  assert.ok(m !== null, lines[0]);
  const folder = /^Project folder: (.+)$/.exec(lines[1] as string)?.[1] as string;
  assert.ok(folder !== undefined && !folder.includes('\\'), lines[1]);
  return { id: m[1] as string, fix: m[2] !== '.', at: (rel) => `${folder}/${rel}` };
}

export const KEYS = ['alpha-work', 'bravo-work', 'charlie-work', 'delta-work', 'echo-work', 'foxtrot-work'];
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
export const PLAN = plan();
export const m5Id = (n: number) => `corpus/m5/inbox/${String(n).padStart(2, '0')}`;
export const m5Text = (p: Planned) =>
  [`Message-ID: <${p.n}.m5@example.invalid>`, `Date: Mon, 15 ${MONTHS[p.month - 1]} 2001 10:00:00 -0000`, `From: ${p.from}`, 'To: Desk <desk@enron.com>', `Subject: ${p.subject}`].join('\r\n') +
  `\r\n\r\nPlease handle the ${p.subject} for the desk today, item ${p.n}.\n`;
export const DIGEST = '# Taxonomy digest\nEverything below is archive data.\n';
export const TAXONOMIST = '---\nname: taxonomist\n---\n\nPropose the recurring processes.\n';

// The project, under `base/name`: a Git repo holding the corpus only as objects, the prepared files
// (messages, threads, people with their identity fields, the manifest, the duplicate groups, the
// prepare stats, one batch per five messages), the agent definitions, the config (tier B at one
// round, no dollar bar, so every process is eligible for a document), and the dashboard assets the
// build needs.
export function fixtureM5(base: string, name = 'm5'): string {
  const root = join(base, name);
  for (const dir of ['out/batches', '.claude/agents', 'config']) mkdirSync(join(root, dir), { recursive: true });
  const git = (args: string[], input?: string): string => {
    const config = ['-c', 'core.protectNTFS=false', '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
    const r = spawnSync('git', [...config, ...args], { cwd: root, input, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(['init', '-q']);
  const entries: Array<{ id: string; blob_sha: string; size: number }> = [];
  const parsed = PLAN.map((p) => {
    const text = m5Text(p);
    const sha = git(['hash-object', '-w', '--no-filters', '--stdin'], text);
    git(['update-index', '--add', '--cacheinfo', `100644,${sha},${m5Id(p.n)}`]);
    entries.push({ id: m5Id(p.n), blob_sha: sha, size: Buffer.byteLength(text, 'utf8') });
    return parseMessage(m5Id(p.n), sha, Buffer.from(text, 'utf8'));
  });
  git(['commit', '-q', '--no-verify', '-m', 'fixture']);
  const threads = buildThreads(parsed);
  writeFileSync(join(root, 'out', 'messages.jsonl'), parsed.map((m) => `${JSON.stringify(m)}\n`).join(''));
  writeFileSync(join(root, 'out', 'threads.json'), JSON.stringify(threads));
  writeFileSync(join(root, 'out', 'people.json'), JSON.stringify(foldPeople(buildPeople(parsed, ['enron.com']), { priced_domains: ['enron.com'], system_senders: [] })));
  writeFileSync(join(root, 'out', 'prepare-stats.json'), JSON.stringify({ corpus_hash: 'c'.repeat(64), suspected_injection: [], oversize: [] }));
  writeFileSync(join(root, 'out', 'manifest.json'), `${JSON.stringify({ corpus_hash: 'c'.repeat(64), count: entries.length, entries }, null, 2)}\n`);
  writeFileSync(join(root, 'out', 'dedup.json'), `${JSON.stringify({ duplicates: 0, groups: [] }, null, 2)}\n`);
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
  for (const [agent, text] of [['extractor', 'Classify every message.'], ['taxonomist', null], ['merger', 'Merge the proposed keys.'], ['synthesizer', 'Describe and estimate.'], ['drafter', 'Write the body.']] as const) {
    const front = agent === 'synthesizer' ? `---\nname: ${agent}\nmodel: opus\neffort: medium\n---\n\n` : `---\nname: ${agent}\n---\n\n`;
    writeFileSync(join(root, '.claude', 'agents', `${agent}.md`), text === null ? TAXONOMIST : `${front}${text}\n`);
  }
  const config = (f: string) => readFileSync(join(REPO, 'config', f), 'utf8');
  writeFileSync(join(root, 'config', 'effort-rates.json'), config('effort-rates.json'));
  // Tier B at 1 occurrence, 1 month, 1 staff member (ARCHITECTURE.md 15.4), and no dollar bar (the
  // committed 8,500 cents is far above this small project's minutes): every process is eligible for
  // an artifact.
  const scoring = JSON.parse(config('scoring.json')) as { tiers: Record<string, unknown>; artifacts: Record<string, unknown> };
  scoring.tiers.B = { min_occurrences: 1, min_active_months: 1, min_staff: 1 };
  scoring.artifacts.min_automatable_cents = null;
  writeFileSync(join(root, 'config', 'scoring.json'), `${JSON.stringify(scoring, null, 2)}\n`);
  // The build's required assets only: the page's own files (Tasks 2 and 3) would change the pinned
  // hashes of tests/build.test.ts whenever they change.
  for (const rel of REQUIRED_ASSETS) {
    mkdirSync(dirname(join(root, 'dashboard', rel)), { recursive: true });
    copyFileSync(join(REPO, 'dashboard', ...rel.split('/')), join(root, 'dashboard', ...rel.split('/')));
  }
  return root;
}

export function acceptTaxonomy(root: string): void {
  const processes = KEYS.map((key) => ({ key, name: `${key.split('-')[0]} work`, definition: `The recurring ${key.split('-')[0]} work of the desk.`, include: [], exclude: [], example_subjects: [`${key.split('-')[0]} round 1`] }));
  const taxonomy = canonicalTaxonomy(processes, sha256(normalizeNewlines(DIGEST)), sha256(normalizeNewlines(TAXONOMIST)));
  writeFileSync(join(root, 'out', 'taxonomy.json'), `${JSON.stringify(taxonomy, null, 2)}\n`);
}

// Extracts a batch as planned: each message's tags, its "Please handle" line as the quote, and a
// declaration for every proposed key the batch uses.
export function plannedExtractor(prompt: string): void {
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

// The merger's proposal: alpha-extra mapped to alpha, the widget keys promoted as one, one-off left out.
export const GOOD_MERGE = {
  mapped: { 'alpha-work': ['new:alpha-extra'] },
  unassigned: ['new:one-off'],
  promoted: [{ key: 'widget-checks', name: 'Widget checks', definition: 'Checking the widget counts with the desk each round and fixing them.', aliases: ['new:widget-audit', 'new:widget-review'] }],
};

// The synthesizer as a script: good, bad (a mid of 900: E1), long (a 650-character description:
// over the stated 600, inside the margin), unknown (a stall citing an id the input does not show),
// fix (the previous output with the minutes put back and the unknown id dropped), or stalled (good,
// with one stall summary citing two of its quotes, for the build's stall labels). It reads the
// sidecar to choose ids from three occurrences and two senders; the real agent reads the same facts
// from the group input's lines.
export type SynthBehaviour = 'good' | 'bad' | 'long' | 'unknown' | 'fix' | 'stalled';
export const UNKNOWN_ID = 'batch-099:e99';
// The artifact each process's synthesis chooses: every type, and one process with none.
const ARTIFACT_OF: Record<string, 'sop' | 'checklist' | 'email_template' | 'template' | 'none'> = {
  alpha: 'sop',
  bravo: 'checklist',
  charlie: 'email_template',
  delta: 'template',
  echo: 'none',
  foxtrot: 'sop',
  widget: 'checklist',
};
export function scriptedSynthesizer(root: string, prompt: string, behaviour: SynthBehaviour): void {
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
        stalls:
          behaviour === 'unknown'
            ? [{ summary: 'A request waits on the desk', evidence_ids: [UNKNOWN_ID] }]
            : behaviour === 'stalled' && ids.length > 0
              ? [{ summary: 'Requests wait a day for the desk. Then they are confirmed.', evidence_ids: ids.slice(0, 2) }]
              : [],
        contradictions: [],
        automation: { approach: 'A request tracker with a confirmation template', artifact_type: ARTIFACT_OF[p.key.split('-')[0] as string] ?? 'checklist', rationale: 'Each round repeats the same steps.' },
        work_estimate:
          p.occurrences < 3
            ? null
            : { minutes_per_occurrence: behaviour === 'bad' ? { low: 20, mid: 900, high: 900 } : { low: 20, mid: 30, high: 45 }, automatable_pct: 50, basis: 'observed' as const, rationale: 'Read, handle and confirm: about half an hour a round.', evidence_ids: ids },
      };
    }),
  };
  writeFileSync(output, JSON.stringify(g));
}

// The drafter as a script: it reads its prompt and its brief the way drafter.md says, and writes a
// body of the brief's type: good; bad (a message path in the body, which the gate refuses); or, on
// its fix round, fix (the good body) or bad again (its previous body unchanged).
export type DraftBehaviour = 'good' | 'bad' | 'fix';
export function scriptedDrafter(prompt: string, behaviour: DraftBehaviour): void {
  const { id, fix, at } = task(prompt, 'Draft');
  const brief = JSON.parse(readFileSync(at(`out/artifacts/input/${id}.json`), 'utf8')) as ArtifactBrief;
  const output = at(`out/artifacts/raw/${id}.md`);
  mkdirSync(dirname(output), { recursive: true });
  if (fix) {
    assert.match(readFileSync(at(`out/fix/${id}.txt`), 'utf8'), /names a message or an evidence id/);
    if (behaviour === 'fix') writeFileSync(output, BODIES[brief.artifact_type as keyof typeof BODIES]);
    return;
  }
  const body = BODIES[brief.artifact_type as keyof typeof BODIES];
  writeFileSync(output, behaviour === 'good' ? body : `${body}\n\nSee corpus/x/1. for the source.\n`);
}

// The whole run with every agent right first time, driven by `advance` alone as /observe drives it:
// run start, the taxonomy, a wave of extractors, the merger, the synthesizers, the drafters, then
// collect, build and run end. Returns every advance report.
export function runPipeline(root: string): AdvanceReport[] {
  const advance = (args: string[]): AdvanceReport => {
    const r = capture(() => advanceCommand(root, [...args, '--json']));
    assert.equal(r.code, 0, r.err.join('\n'));
    return JSON.parse(r.out[0] as string) as AdvanceReport;
  };
  assert.equal(capture(() => runCommand(root, ['start'])).code, 0);
  acceptTaxonomy(root);
  const reports: AdvanceReport[] = [];
  let report = advance([]);
  reports.push(report);
  for (let turn = 0; turn < 20 && !report.done; turn++) {
    assert.equal(report.halt, false, report.halt_reason ?? '');
    const finished: string[] = [];
    for (const a of report.agents) {
      if (a.subagent_type === 'extractor') plannedExtractor(a.prompt);
      else if (a.subagent_type === 'merger') writeFileSync(join(root, 'out', 'merge-proposed.json'), JSON.stringify(GOOD_MERGE));
      else if (a.subagent_type === 'synthesizer') scriptedSynthesizer(root, a.prompt, 'stalled');
      else if (a.subagent_type === 'drafter') scriptedDrafter(a.prompt, 'good');
      if (a.run_in_background) finished.push(a.description.split(' ')[1] as string);
    }
    report = advance(finished);
    reports.push(report);
  }
  assert.equal(report.done, true, 'the run reached its end');
  return reports;
}

// A data.json that records the build's inputs as they are now and lists no output file, so
// buildCurrent holds and a stage test can walk past `build` without building.
export function markBuilt(root: string): void {
  mkdirSync(join(root, 'out', 'dashboard'), { recursive: true });
  writeFileSync(join(root, 'out', 'dashboard', 'data.json'), `${JSON.stringify({ version: 1, inputs: currentBuildInputs(root), outputs: {} }, null, 2)}\n`);
}

// A fixed run log in place of the one the run wrote, so the run facts (and the pinned hashes of
// tests/build.test.ts) do not depend on the clock. A18: a cold run (its prepare ran) that started four
// agents, had two gate failures (one job, two fix rounds) and two stage steps; a build in the middle,
// which the facts leave out while the agent started after it counts; then a run end and a rebuild
// after the last step of work, both left out.
export const FIXED_RUN_ID = '20261019T000000Z';
export const FIXED_RUN_LOG = [
  { ts: '2026-10-19T00:00:00.000Z', event: 'run_start', orchestrator: 'claimed', force: false, stamped: 0 },
  { ts: '2026-10-19T00:00:02.000Z', event: 'prepare', ms: 1800, skipped: false },
  { ts: '2026-10-19T00:00:05.120Z', event: 'SubagentStart', agent_type: 'extractor', agent_id: 'a1' },
  { ts: '2026-10-19T00:00:05.500Z', event: 'SubagentStart', agent_type: 'extractor', agent_id: 'a2' },
  { ts: '2026-10-19T00:03:00.000Z', event: 'gate', agent_type: 'extractor', agent_id: 'a2', batch_id: 'batch-001', dispatches: 1, status: 'failed', problems: 1 },
  { ts: '2026-10-19T00:04:00.000Z', event: 'gate', agent_type: 'extractor', agent_id: 'a2', batch_id: 'batch-001', dispatches: 2, status: 'failed', problems: 1 },
  { ts: '2026-10-19T00:05:00.000Z', event: 'stage', name: 'rollup', ms: 702, summary: 'rollup: 7 processes.' },
  { ts: '2026-10-19T00:06:00.000Z', event: 'SubagentStart', agent_type: 'synthesizer', agent_id: 'a3' },
  { ts: '2026-10-19T00:12:00.000Z', event: 'stage', name: 'score', ms: 252, summary: 'score: tiers A+B.' },
  { ts: '2026-10-19T00:12:30.000Z', event: 'stage', name: 'build', ms: 900, summary: 'build: done.' },
  { ts: '2026-10-19T00:20:00.000Z', event: 'SubagentStart', agent_type: 'extractor', agent_id: 'late' },
  { ts: '2026-10-19T00:21:00.000Z', event: 'stage', name: 'run end', ms: 3, summary: 'run end: done.' },
  { ts: '2026-10-19T00:30:00.000Z', event: 'stage', name: 'build', ms: 800, summary: 'build: done.' },
];

export function fixRunLog(root: string): void {
  for (const f of readdirSync(join(root, 'out', 'runs'))) rmSync(join(root, 'out', 'runs', f));
  writeFileSync(join(root, 'out', 'runs', `${FIXED_RUN_ID}.jsonl`), FIXED_RUN_LOG.map((e) => `${JSON.stringify(e)}\n`).join(''));
  writeFileSync(join(root, 'out', 'ledger', 'run.json'), `${JSON.stringify({ active: false, run_id: FIXED_RUN_ID, started_utc: '2026-10-19T00:00:00Z' }, null, 2)}\n`);
}

// The project built: the run driven to its end by advance, the fixed run log, and the build again.
export function builtProject(base: string, name = 'project'): string {
  const root = fixtureM5(base, name);
  runPipeline(root);
  fixRunLog(root);
  buildStep(root);
  return root;
}
