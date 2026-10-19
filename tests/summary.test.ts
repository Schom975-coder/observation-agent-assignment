// `node obs.mjs summary` (src/run/summary.ts): the figures of out/run-summary.json, and a timeline of
// the stages read from the run logs of the run facts' span. The fixture is a hand-written out/: a
// run summary in the shape `build` writes, an older cold run the span leaves out, a cold run cut off
// mid-extraction, and its resume, which finishes the run (a merge fix round, the build, the run
// end). Every expected number below is worked out from the timestamps in the logs.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSpanOf } from '../src/report/build.ts';
import { runFacts } from '../src/report/data.ts';
import type { RunSummary } from '../src/report/types.ts';
import { STAGES, formatRunFacts, runFactsFor, summaryCommand, type StageTiming } from '../src/run/summary.ts';

const tmp = mkdtempSync(join(tmpdir(), 'obs-summary-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const COLD = '20261019T100000Z';
const RESUME = '20261019T120000Z';

const SUMMARY: RunSummary = {
  version: 1,
  run: { id: COLD, later_runs: [RESUME], wall_seconds: 715, agents: { drafter: 1, extractor: 4, merger: 2, synthesizer: 1, taxonomist: 1 }, fix_rounds: 1 },
  quotes: { exact: 2640, repaired: 15, rejected: 0 },
  merge: { slugs: 440, mapped: 61, promoted: 32, aliases: 253, unassigned: 126, demoted: 0, messages_mapped: 116, messages_promoted: 473, messages_unassigned: 205 },
  estimates: { accepted: 53, missing: 4, overridden: 0 },
  folds: { display_name: 4, middle_initial: 4, last_name: 6, first_last: 10, initial_last: 33 },
  headline: { total_cents: 205047, counted_cents: 53885, estimated_cents: 151162, low_cents: 121365, high_cents: 418341, all_tiers_cents: 221759, hours_x100: 2412 },
  artifacts: { drafted: 1, exhausted: 0, skipped: 0, failed: 0, pending: 0 },
  coverage: { counted: 2171, unassigned: 203, personal: 549, noise: 227, automated: 50, flagged: 1, duplicates: 39 },
  loops: { all: 153, recent: 21 },
  contradictions_dropped: 0,
};

const ev = (ts: string, event: string, fields: Record<string, unknown> = {}) => ({ ts: `2026-10-19T${ts}Z`, event, ...fields });
const agent = (ts: string, event: 'SubagentStart' | 'SubagentStop', agent_type: string, agent_id: string) => ev(ts, event, { agent_type, agent_id });
const gate = (ts: string, agent_type: string, agent_id: string, batch_id: string, status: 'done' | 'failed', dispatches = 1) =>
  ev(ts, 'gate', { agent_type, agent_id, batch_id, dispatches, status, problems: status === 'done' ? 0 : 2 });
const step = (ts: string, name: string, ms: number, summary: string, attempt?: number) => ev(ts, 'stage', { name, ...(attempt === undefined ? {} : { attempt }), ms, summary });
const advance = (ts: string, before: string, after: string, dispatched: string[], agents: number, recorded: Array<{ id: string; status: string }> = []) =>
  ev(ts, 'advance', { named: recorded.map((r) => r.id), recorded, stage_before: before, stage_after: after, dispatched, agents, ms: 300 });

// Cut off by a usage limit while batch-001's fix round was starting: its last step of work is the
// SubagentStart at 10:04:50, and the Stop hook's line after it is left out of the span.
const coldLog = [
  ev('10:00:00.000', 'run_start', { orchestrator: 'claimed', force: true, stamped: 0 }),
  ev('10:00:05.000', 'prepare', { ms: 2000, skipped: false }), // prepare 10:00:03 to 10:00:05
  step('10:00:06.000', 'taxonomy prompt', 10, 'attempt 1 of 4', 1), // taxonomy from 10:00:05.990
  advance('10:00:06.100', 'taxonomy', 'taxonomy', [], 1),
  agent('10:00:10.000', 'SubagentStart', 'taxonomist', 't1'),
  agent('10:02:00.000', 'SubagentStop', 'taxonomist', 't1'),
  step('10:02:01.000', 'taxonomy accept', 1000, 'taxonomy: accepted the proposal the last taxonomist run left: 3 processes; wrote out/taxonomy.json.', 1), // to 10:02:01
  advance('10:02:02.000', 'taxonomy', 'extraction', ['batch-000', 'batch-001'], 2), // extraction from 10:02:02
  agent('10:02:10.000', 'SubagentStart', 'extractor', 'e1'),
  agent('10:02:10.500', 'SubagentStart', 'extractor', 'e2'),
  ev('10:02:20.000', 'guard_bind', { agent_type: 'extractor', agent_id: 'e1', batch_id: 'batch-000', dispatches: 1 }),
  agent('10:04:00.000', 'SubagentStop', 'extractor', 'e1'),
  gate('10:04:01.000', 'extractor', 'e1', 'batch-000', 'done'),
  agent('10:04:30.000', 'SubagentStop', 'extractor', 'e2'),
  gate('10:04:31.000', 'extractor', 'e2', 'batch-001', 'failed'),
  advance('10:04:40.000', 'extraction', 'extraction', ['batch-001'], 1, [{ id: 'batch-000', status: 'done' }, { id: 'batch-001', status: 'failed' }]),
  agent('10:04:50.000', 'SubagentStart', 'extractor', 'e3'), // extraction to 10:04:50; the run's last step of work
  ev('10:05:00.000', 'gate_run', { stage: 'extraction', decision: 'wait' }),
];

const resumeLog = [
  ev('12:00:00.000', 'run_start', { orchestrator: 'claimed', force: false, stamped: 1 }),
  ev('12:00:02.000', 'prepare', { ms: 500, skipped: true }), // 12:00:01.5 to 12:00:02
  advance('12:00:03.000', 'extraction', 'extraction', ['batch-001'], 1), // extraction from 12:00:03
  agent('12:00:10.000', 'SubagentStart', 'extractor', 'e4'),
  agent('12:01:10.000', 'SubagentStop', 'extractor', 'e4'),
  gate('12:01:11.000', 'extractor', 'e4', 'batch-001', 'done', 3), // to 12:01:11
  step('12:01:15.000', 'merge prompt', 5, 'attempt 1 of 4', 1), // merge from 12:01:14.995
  advance('12:01:15.100', 'extraction', 'merge', [], 1, [{ id: 'batch-001', status: 'done' }]),
  agent('12:01:20.000', 'SubagentStart', 'merger', 'm1'),
  agent('12:03:00.000', 'SubagentStop', 'merger', 'm1'),
  step('12:03:01.000', 'merge accept', 20, 'merge: the proposal the last merger run left was not accepted: 2 problems.', 1),
  step('12:03:01.100', 'merge prompt', 5, 'attempt 2 of 4, a fix round for 2 problems', 2),
  advance('12:03:01.200', 'merge', 'merge', [], 1),
  agent('12:03:05.000', 'SubagentStart', 'merger', 'm2'),
  agent('12:04:00.000', 'SubagentStop', 'merger', 'm2'),
  step('12:04:01.000', 'merge accept', 30, 'merge: accepted the proposal the last merger run left: 10 proposed keys; wrote out/merge.json.', 2), // to 12:04:01
  step('12:04:02.000', 'rollup', 800, 'rollup: 3 processes; 1 synthesis group.'), // 12:04:01.2 to 12:04:02
  advance('12:04:02.300', 'merge', 'synthesis', ['synth-000'], 1), // synthesis from 12:04:02.3
  agent('12:04:10.000', 'SubagentStart', 'synthesizer', 's1'),
  agent('12:06:00.000', 'SubagentStop', 'synthesizer', 's1'),
  gate('12:06:00.500', 'synthesizer', 's1', 'synth-000', 'done'), // to 12:06:00.5
  step('12:06:05.000', 'score', 400, 'score: tiers A+B $2,050.47/mo automatable.'), // 12:06:04.6 to 12:06:05
  step('12:06:06.000', 'artifacts prepare', 300, 'artifacts: 1 brief, 0 skipped; wrote out/artifacts/index.json.'), // drafting from 12:06:05.7
  advance('12:06:06.200', 'synthesis', 'drafting', ['draft-000'], 1),
  agent('12:06:10.000', 'SubagentStart', 'drafter', 'd1'),
  agent('12:07:00.000', 'SubagentStop', 'drafter', 'd1'),
  gate('12:07:00.400', 'drafter', 'd1', 'draft-000', 'done'),
  step('12:07:05.000', 'artifacts collect', 50, 'artifacts: 1 drafted, 0 exhausted; wrote out/artifacts/artifacts.json.'), // to 12:07:05; the last step of work
  step('12:07:06.500', 'build', 1500, 'build: wrote out/dashboard/ (30 files), out/report.html, out/report.md and out/run-summary.json.'), // 12:07:05 to 12:07:06.5
  step('12:07:06.600', 'run end', 1, `run: ended ${RESUME}.`),
  advance('12:07:06.700', 'drafting', 'done', [], 0, [{ id: 'draft-000', status: 'done' }]),
];

// An earlier cold run: the span starts at the latest one, so this log is left out.
const olderLog = [ev('09:00:00.000', 'run_start'), ev('09:00:02.000', 'prepare', { ms: 900, skipped: false }), agent('09:00:10.000', 'SubagentStart', 'taxonomist', 'old')].map((e) => ({
  ...e,
  ts: e.ts.replace('2026-10-19', '2026-10-18'),
}));

const jsonl = (events: readonly object[]): string => events.map((e) => `${JSON.stringify(e)}\n`).join('');

let projects = 0;
function project(opts: { summary?: string | null; extraRun?: object[] } = {}): string {
  const root = join(tmp, `p${projects++}`);
  const runs = join(root, 'out', 'runs');
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, '20261018T090000Z.jsonl'), jsonl(olderLog));
  writeFileSync(join(runs, `${COLD}.jsonl`), jsonl(coldLog));
  writeFileSync(join(runs, `${RESUME}.jsonl`), `${jsonl(resumeLog)}{"ts":"2026-10-19T12:07:0`); // a torn last line, skipped
  writeFileSync(join(runs, 'adhoc.jsonl'), jsonl([ev('08:00:00.000', 'guard_claim', { via: 'run_start' })]));
  if (opts.extraRun !== undefined) writeFileSync(join(runs, '20261019T140000Z.jsonl'), jsonl(opts.extraRun));
  const summary = opts.summary === undefined ? `${JSON.stringify(SUMMARY, null, 2)}\n` : opts.summary;
  if (summary !== null) writeFileSync(join(root, 'out', 'run-summary.json'), summary);
  return root;
}

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

const EXPECTED_STAGES: StageTiming[] = [
  { stage: 'prepare', seconds: 2.5, jobs: 1, agents: 0, fix_rounds: 0 }, // 2 s cold, 0.5 s skipped on the resume; one prepare ran
  { stage: 'taxonomy', seconds: 115, jobs: 1, agents: 1, fix_rounds: 0 }, // 10:00:05.990 to 10:02:01.000
  { stage: 'extraction', seconds: 236, jobs: 2, agents: 4, fix_rounds: 1 }, // 168 s cold + 68 s resumed; batch-001 failed once
  { stage: 'merge', seconds: 166, jobs: 1, agents: 2, fix_rounds: 1 }, // 12:01:14.995 to 12:04:01.000; the second prompt
  { stage: 'rollup', seconds: 0.8, jobs: 1, agents: 0, fix_rounds: 0 },
  { stage: 'synthesis', seconds: 118.2, jobs: 1, agents: 1, fix_rounds: 0 }, // 12:04:02.3 to 12:06:00.5
  { stage: 'score', seconds: 0.4, jobs: 1, agents: 0, fix_rounds: 0 },
  { stage: 'drafting', seconds: 59.3, jobs: 1, agents: 1, fix_rounds: 0 }, // 12:06:05.7 to 12:07:05.0
  { stage: 'build', seconds: 1.5, jobs: 1, agents: 0, fix_rounds: 0 }, // from the resume's whole log
];

test('the fixture is one span, and its run facts are the ones the summary file holds', () => {
  const root = project();
  const span = runSpanOf(root);
  assert.deepEqual(span?.runs.map((r) => r.id), [COLD, RESUME]);
  const facts = runFacts(span);
  assert.deepEqual(
    [facts.minutes?.v, Object.fromEntries(facts.agents.map((a) => [a.type, a.count])), facts.fixNum?.v],
    [SUMMARY.run.wall_seconds, SUMMARY.run.agents, SUMMARY.run.fix_rounds],
    '290 s cold to its last step of work plus 425 s resumed; the agents and the failed check',
  );
});

test('stages: each stage timed from its first event to its last in each run, added up; jobs, agents and fix rounds', () => {
  const r = runFactsFor(project());
  assert.ok(r !== null);
  assert.deepEqual(r.stages, EXPECTED_STAGES);
  assert.deepEqual(r.stages.map((s) => s.stage), [...STAGES]);
  assert.deepEqual(r.logs, [`out/runs/${COLD}.jsonl`, `out/runs/${RESUME}.jsonl`], 'the cold run first; the older cold run and adhoc.jsonl left out');
  assert.deepEqual(r.summary, SUMMARY);
  // The job stages' fix rounds add up to the run facts' total.
  const jobStages = r.stages.filter((s) => ['extraction', 'synthesis', 'drafting'].includes(s.stage));
  assert.equal(jobStages.reduce((n, s) => n + s.fix_rounds, 0), SUMMARY.run.fix_rounds);
  assert.equal(r.stages.reduce((n, s) => n + s.agents, 0), Object.values(SUMMARY.run.agents).reduce((a, b) => a + b, 0));
});

test('formatRunFacts: labelled lines of the summary file, then one line per stage', () => {
  const text = formatRunFacts(runFactsFor(project()) as NonNullable<ReturnType<typeof runFactsFor>>);
  const lines = text.split('\n');
  assert.deepEqual(lines.slice(0, 15), [
    `Run: ${COLD}, continued in 1 later run (${RESUME}).`,
    'Wall time: 11 min 55 s.',
    'Agents: 9 in total; drafter 1, extractor 4, merger 2, synthesizer 1, taxonomist 1.',
    'Fix rounds: 1 (failed checks of batches, groups and drafts); the taxonomist and the merger were also asked again once.',
    'Quotes: 2,640 exact, 15 repaired, 0 rejected.',
    'Merge: 440 proposed keys: 61 mapped, 253 in 32 promoted processes, 126 unassigned, 0 demoted; messages 116 mapped, 473 promoted, 205 unassigned.',
    'Estimates: 53 accepted, 4 missing, 0 overridden.',
    'Folds: 57 in total; display_name 4, middle_initial 4, last_name 6, first_last 10, initial_last 33.',
    'Headline: about $2,050 a month automatable in tiers A and B (205,047 cents: counted email 53,885, estimated work 151,162); low about $1,214, high about $4,183; all tiers about $2,218.',
    'Hours: 24.12 a month automatable in tiers A and B.',
    'Artifacts: 1 drafted, 0 exhausted, 0 skipped, 0 failed.',
    'Coverage: counted 2,171, unassigned 203, personal 549, noise 227, automated 50, flagged 1, duplicates 39 (3,240 messages in all).',
    'Open loops: 153 in all, 21 recent.',
    'Contradictions dropped: 0.',
    `Logs: out/runs/${COLD}.jsonl, out/runs/${RESUME}.jsonl.`,
  ]);
  assert.deepEqual(lines.slice(15), [
    "Stages (each run's first event of the stage to its last, added up over the runs):",
    '  prepare     2.5 s; 1 run',
    '  taxonomy    1 min 55 s; 1 proposal accepted; 1 agent',
    '  extraction  3 min 56 s; 2 batches done; 4 agents; 1 fix round',
    '  merge       2 min 46 s; 1 proposal accepted; 2 agents; 1 fix round',
    '  rollup      0.8 s; 1 run',
    '  synthesis   1 min 58 s; 1 group done; 1 agent',
    '  score       0.4 s; 1 run',
    '  drafting    59.3 s; 1 draft done; 1 agent',
    '  build       1.5 s; 1 run',
  ]);
  assert.doesNotMatch(text, /opus|sonnet|haiku|fable|—/i, 'no model name, no em dash');
});

test('summary prints the lines; --json prints the report, which reads back as it was made', () => {
  const root = project();
  const human = capture(() => summaryCommand(root, []));
  assert.deepEqual([human.code, human.err], [0, []]);
  assert.equal(human.out.join('\n'), formatRunFacts(runFactsFor(root) as NonNullable<ReturnType<typeof runFactsFor>>));
  const json = capture(() => summaryCommand(root, ['--json']));
  assert.deepEqual([json.code, json.err, json.out.length], [0, [], 1]);
  assert.deepEqual(JSON.parse(json.out[0] as string), runFactsFor(root));
  assert.deepEqual(capture(() => summaryCommand(root, ['--verbose'])), { code: 1, out: [], err: ['summary: unexpected argument "--verbose". Usage: node obs.mjs summary [--json]'] });
});

test('summary without out/run-summary.json, or with one that is not a run summary, exits 1 with one line', () => {
  const missing = project({ summary: null });
  assert.equal(runFactsFor(missing), null);
  for (const args of [[], ['--json']]) {
    assert.deepEqual(capture(() => summaryCommand(missing, args)), { code: 1, out: [], err: ['summary: out/run-summary.json is missing: run node obs.mjs build first.'] });
  }
  assert.deepEqual(capture(() => summaryCommand(project({ summary: '{"version": 1, "run":' }), [])).err, ['summary: out/run-summary.json is not valid JSON: run node obs.mjs build again.']);
  const old = { ...SUMMARY, headline: { total_cents: 1 } };
  assert.deepEqual(capture(() => summaryCommand(project({ summary: JSON.stringify(old) }), [])).err, [
    'summary: out/run-summary.json is not a run summary this version reads: run node obs.mjs build again.',
  ]);
});

test('a later run that did work after the build: the facts stay the summary file\'s and a note says the logs moved on', () => {
  const later = [ev('14:00:00.000', 'run_start'), ev('14:00:02.000', 'prepare', { ms: 400, skipped: true }), agent('14:00:10.000', 'SubagentStart', 'synthesizer', 's9')];
  const r = runFactsFor(project({ extraRun: later })) as NonNullable<ReturnType<typeof runFactsFor>>;
  assert.equal(r.logs.length, 3);
  const lines = formatRunFacts(r).split('\n');
  assert.equal(lines[1], 'Wall time: 11 min 55 s.', 'the summary file\'s figure, never recomputed');
  const note = `Note: the run logs (${COLD}, ${RESUME}, 20261019T140000Z) have moved on since out/run-summary.json was built, and the stage lines are read from them as they are now; run node obs.mjs build to bring the two together.`;
  assert.equal(lines.at(-1), note);
  assert.ok(!formatRunFacts(runFactsFor(project()) as NonNullable<ReturnType<typeof runFactsFor>>).includes('Note:'));
  // The same runs, but the stage lines count an agent the summary file does not: the note too.
  const moreAgents = runFactsFor(project({ summary: JSON.stringify({ ...SUMMARY, run: { ...SUMMARY.run, agents: { ...SUMMARY.run.agents, drafter: 2 } } }) }));
  assert.match(formatRunFacts(moreAgents as NonNullable<ReturnType<typeof runFactsFor>>).split('\n').at(-1) ?? '', /^Note: the run logs \(/);
});

test('jobs done: each job once over the span, the ones a run start stamped included', () => {
  const root = join(tmp, `p${projects++}`);
  mkdirSync(join(root, 'out', 'runs'), { recursive: true });
  writeFileSync(join(root, 'out', 'run-summary.json'), JSON.stringify(SUMMARY));
  writeFileSync(
    join(root, 'out', 'runs', `${COLD}.jsonl`),
    jsonl([
      ev('10:00:00.000', 'run_start', { stamped: 0, recorded: [] }),
      ev('10:00:05.000', 'prepare', { ms: 2000, skipped: false }),
      advance('10:00:06.000', 'extraction', 'extraction', ['batch-000', 'batch-001'], 2),
      agent('10:00:10.000', 'SubagentStart', 'extractor', 'e1'),
      agent('10:00:10.100', 'SubagentStart', 'extractor', 'e2'),
      gate('10:01:00.000', 'extractor', 'e1', 'batch-000', 'done'),
    ]),
  );
  writeFileSync(
    join(root, 'out', 'runs', `${RESUME}.jsonl`),
    jsonl([
      // batch-001's extractor wrote a good file but its session ended before its gate: run start stamps it done.
      ev('12:00:00.000', 'run_start', { stamped: 1, recorded: [{ id: 'batch-001', status: 'done' }] }),
      ev('12:00:02.000', 'prepare', { ms: 500, skipped: true }),
      step('12:00:03.000', 'merge prompt', 5, 'attempt 1 of 4', 1),
      // The orchestrator names batch-000 again; it was done in the run before and counts once.
      advance('12:00:03.100', 'extraction', 'merge', [], 1, [{ id: 'batch-000', status: 'done' }]),
      agent('12:00:10.000', 'SubagentStart', 'merger', 'm1'),
    ]),
  );
  const extraction = runFactsFor(root)?.stages.find((s) => s.stage === 'extraction');
  assert.deepEqual(extraction, { stage: 'extraction', seconds: 54, jobs: 2, agents: 2, fix_rounds: 0 });
});
