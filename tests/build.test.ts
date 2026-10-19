// The build stage (src/report/build.ts, data.ts, report.ts): a complete small project made by the
// pipeline fixture (tests/fixtures/pipeline.ts) in a temp folder whose path holds a space, run to
// its end by `advance`, which builds; then the build's files checked against the spec: byte-identical
// twice and pinned by hash (the same bytes on every OS, amendment 2), every input and output hashed,
// the money ties, the coverage buckets, the quotes against the corpus reader, the open-loop rule, the
// run facts from a fixed log, the escaping of hostile data, and the refusals. Tests that read the
// committed out/ (or the project OBS_BUILD_ROOT names) skip when its build inputs are not current.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCorpus } from '../src/corpus/reader.ts';
import { buildCommand, buildCurrent, buildStep, loadInputs, renderOutputs, runSpanOf, runSpanSha, type Rendered } from '../src/report/build.ts';
import { buildData, capGuard, cutAt, firstSentence, runFacts, type BuildInputs } from '../src/report/data.ts';
import { cents as scoreCents } from '../src/metrics/score.ts';
import { checkTargets } from '../src/report/targets.ts';
import { escapeHtml, escapeMdText } from '../src/report/text.ts';
import { renderArtifact } from '../src/model/artifacts.ts';
import { BODIES } from './fixtures/drafts.ts';
import { tierRuleWords } from '../src/report/words.ts';
import { foldPeople, foldReport } from '../src/normalize/identity.ts';
import { statusReport } from '../src/run/commands.ts';
import type { DashboardData, LoopItem, MethodData, ProcessData, QuoteRef } from '../src/report/types.ts';
import type { ArtifactBrief } from '../src/types.ts';
import { FIXED_RUN_ID, capture, fixRunLog, fixtureM5, runPipeline } from './fixtures/pipeline.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'obs build '));
after(() => rmSync(tmp, { recursive: true, force: true }));

// The sha256 of the three files CI compares across the OS jobs, for the fixture project with its
// fixed run log (tests/fixtures/pipeline.ts). A change to the build's output, the report CSS or the
// fixture changes them: print the new values with OBS_PRINT_PINS=1 and check the diff of the files
// before pinning them.
const PINS = {
  'dashboard/data.json': '358eeab50e38d95d77926699996d20d5a12b6e9f6ac495f77f10948f393c5aac',
  'report.md': 'a3966398b4312467dd38e1bc707a85d5cc3a4410bc48410c4fb90f590bb0b2a1',
  'report.html': 'b550035efc3393c924fbf4ac7ddc8c5f45ee28b71ce5134396c6b97d70653fe8',
};

let root = '';
let first: Map<string, Buffer>;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const outFile = (rel: string) => join(root, 'out', ...rel.split('/'));
const readOut = (rel: string) => readFileSync(outFile(rel));
const json = <T>(rel: string): T => JSON.parse(readOut(rel).toString('utf8')) as T;
// Every file under out/dashboard/ plus the report and the summary, by path under out/.
function written(r: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const dir = join(r, 'out', 'dashboard');
  for (const p of readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[]) {
    if (statSync(join(dir, p)).isFile()) files.set(`dashboard/${p.replaceAll('\\', '/')}`, readFileSync(join(dir, p)));
  }
  for (const f of ['report.md', 'report.html', 'run-summary.json']) files.set(f, readFileSync(join(r, 'out', f)));
  return files;
}

before(() => {
  root = fixtureM5(tmp, 'project');
  const reports = runPipeline(root);
  const last = reports.at(-1);
  assert.ok(last !== undefined && last.steps.some((s) => s.startsWith('build: ')), 'advance ran the build');
  fixRunLog(root);
  assert.match(buildStep(root), /^build: 7 processes \(7 in the total\), 6 documents, /);
  first = written(root);
});

test('the build is the stage after drafting: advance ran it, and the run is done once its files match', () => {
  assert.equal(statusReport(root).stage, 'done');
  assert.equal(buildCurrent(root), true);
});

test('A16: two builds are byte-identical, and the second rewrites nothing', () => {
  const line = buildStep(root);
  assert.match(line, /; 0 files changed\.$/);
  const second = written(root);
  assert.deepEqual([...second.keys()].sort(), [...first.keys()].sort());
  for (const [path, bytes] of first) assert.ok(bytes.equals(second.get(path) as Buffer), `${path} differs between two builds`);
});

test('A16 across OSes: data.json, report.md and report.html match their pinned hashes', (t) => {
  const got = Object.fromEntries(Object.keys(PINS).map((p) => [p, sha(readOut(p))]));
  if (process.env.OBS_PRINT_PINS === '1') console.log(JSON.stringify(got, null, 2));
  if (Object.values(PINS).includes('PIN')) {
    t.skip('no hashes pinned yet');
    return;
  }
  assert.deepEqual(got, PINS);
});

test('every file the build writes: the outputs map, LF endings, the fonts byte for byte, no external URL', () => {
  const data = json<DashboardData>('dashboard/data.json');
  const files = [...first.keys()].filter((p) => p !== 'dashboard/data.json').sort();
  assert.deepEqual(Object.keys(data.outputs), files, 'data.json lists every other file written');
  for (const p of files) {
    const bytes = readOut(p);
    if (p.endsWith('.woff2')) {
      assert.equal(data.outputs[p], sha(bytes));
      assert.equal(sha(bytes), sha(readFileSync(join(repo, 'dashboard', ...p.slice('dashboard/'.length).split('/')))), `${p} is copied byte for byte`);
    } else {
      assert.ok(!bytes.includes(13), `${p} has a carriage return`);
      assert.equal(data.outputs[p], sha(bytes.toString('utf8')));
    }
  }
  for (const p of ['dashboard/data.json', 'report.md', 'report.html']) assert.doesNotMatch(readOut(p).toString('utf8'), /https?:\/\//, `${p} names an external URL`);
  for (const name of files.map((p) => p.split('/').at(-1) as string)) assert.match(name, /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i, `${name} is a plain file name`);
  const process = readdirSync(join(root, 'out', 'dashboard', 'process')).sort();
  assert.deepEqual(process, ['alpha-work.json', 'bravo-work.json', 'charlie-work.json', 'delta-work.json', 'echo-work.json', 'foxtrot-work.json', 'widget-checks.json']);
});

test('buildCurrent: an edited output or a changed input makes the build stale; a process gone from the run loses its file', () => {
  const file = outFile('dashboard/loops.json');
  const good = readFileSync(file);
  writeFileSync(file, `${good.toString('utf8')} `);
  assert.equal(buildCurrent(root), false, 'an edited output');
  writeFileSync(file, good);
  assert.equal(buildCurrent(root), true);
  const people = join(root, 'out', 'people.json');
  const before = readFileSync(people, 'utf8');
  writeFileSync(people, before.replace(/\r?\n?$/, '\n').replace(/^/, ' '));
  assert.equal(buildCurrent(root), false, 'a changed input');
  writeFileSync(people, before);
  assert.equal(buildCurrent(root), true);
  // CRLF in a text input is the same input: a Windows checkout without the eol rule stays current.
  const css = join(root, 'dashboard', 'report.css');
  const cssText = readFileSync(css, 'utf8');
  writeFileSync(css, cssText.replace(/\n/g, '\r\n'));
  assert.equal(buildCurrent(root), true, 'CRLF in an asset changes nothing');
  writeFileSync(css, cssText);
  // A left-over process file goes.
  writeFileSync(outFile('dashboard/process/gone-work.json'), '{}\n');
  assert.match(buildStep(root), /, 1 file removed\.$/);
  assert.equal(existsSync(outFile('dashboard/process/gone-work.json')), false);
  // The server's state file is the server's: never removed.
  writeFileSync(outFile('dashboard/.server.json'), '{}\n');
  assert.match(buildStep(root), /; 0 files changed\.$/);
  assert.equal(existsSync(outFile('dashboard/.server.json')), true);
  rmSync(outFile('dashboard/.server.json'));
});

test('refusals: an empty project, an argument, a missing asset, a file it cannot write', () => {
  const empty = join(tmp, 'empty project');
  mkdirSync(empty, { recursive: true });
  assert.deepEqual(capture(() => buildCommand(empty, [])), { code: 1, out: [], err: ['build: out/opportunities.json is missing or not current: run node obs.mjs score first.'] });
  assert.deepEqual(capture(() => buildCommand(root, ['--force'])), { code: 1, out: [], err: ['build: unexpected argument "--force". Usage: node obs.mjs build'] });
  const css = join(root, 'dashboard', 'report.css');
  const text = readFileSync(css);
  rmSync(css);
  try {
    assert.deepEqual(capture(() => buildCommand(root, [])), { code: 1, out: [], err: ['build: dashboard/report.css is missing from the repo.'] });
    assert.equal(buildCurrent(root), false);
  } finally {
    writeFileSync(css, text);
  }
  assert.equal(buildCurrent(root), true);
  // A file the build cannot write: one line naming it, with the system's reason in plain words.
  const report = outFile('report.md');
  const reportBytes = readFileSync(report);
  rmSync(report);
  mkdirSync(join(report, 'in the way'), { recursive: true });
  try {
    assert.deepEqual(capture(() => buildCommand(root, [])), {
      code: 1,
      out: [],
      err: ['build: cannot write out/report.md: a folder stands at that path (EISDIR). Fix that and run the build again.'],
    });
  } finally {
    rmSync(report, { recursive: true, force: true });
    writeFileSync(report, reportBytes);
  }
  assert.equal(buildCurrent(root), true);
});

test('A6, A8, reviewers 10 and 12: rows in rank order tie to the opportunities and the headline', () => {
  const data = json<DashboardData>('dashboard/data.json');
  const opp = json<{ opportunities: Array<{ key: string; rank: number; range_cents: { low: number; high: number }; dollars_per_month_cents: { automatable: number } }>; headline: { tiers_ab_cents: { total: number; low: number; high: number } } }>('opportunities.json');
  assert.deepEqual(data.rows.map((r) => r.key), opp.opportunities.map((o) => o.key));
  assert.deepEqual(data.rows.map((r) => r.rank), data.rows.map((_, i) => i + 1));
  assert.equal(data.rows.length, opp.opportunities.length);
  assert.equal(data.headline.rows_in_total.v + data.headline.rows_below.v, data.rows.length);
  for (const r of data.rows) {
    const o = opp.opportunities.find((x) => x.key === r.key);
    assert.deepEqual([r.low.v, r.high.v, r.total.v], [o?.range_cents.low, o?.range_cents.high, o?.dollars_per_month_cents.automatable]);
    assert.equal(r.counted.v + r.estimated.v, r.total.v);
    assert.equal(r.counted.k, 'counted');
    assert.equal(r.estimated.k, 'estimated');
  }
  const h = opp.headline.tiers_ab_cents;
  assert.deepEqual([data.headline.total.v, data.headline.low.v, data.headline.high.v], [h.total, h.low, h.high]);
  assert.equal(data.headline.counted.v + data.headline.estimated.v, data.headline.total.v);
  assert.equal(data.cumulative.at(-1)?.cents.v, data.headline.total.v);
  assert.equal(data.rows.filter((r) => r.in_total).reduce((n, r) => n + r.total.v, 0), data.headline.total.v);
  assert.equal(tierRuleWords('C', { A: { min_occurrences: 40, min_active_months: 6, min_staff: 3 }, B: { min_occurrences: 10, min_active_months: 3, min_staff: 2 } }), 'seen too rarely to count, not in the total');
});

test('A10, A11, reviewer 5: people, the seen facts, and every quote placed exactly in its message', () => {
  const corpus = openCorpus(root);
  const processes = readdirSync(join(root, 'out', 'dashboard', 'process')).map((f) => json<ProcessData>(`dashboard/process/${f}`));
  const quotes: QuoteRef[] = [];
  for (const p of processes) {
    const staff = p.participants.filter((x) => x.staff);
    assert.equal(p.row.staff.v, staff.length);
    assert.equal(p.row.writers.v, staff.filter((x) => x.authored + x.forwards + x.chasers > 0).length);
    assert.equal(p.row.copied.v, staff.length - p.row.writers.v);
    assert.equal(p.row.occurrences.v, p.occurrences.length);
    assert.equal(p.row.messages.v, p.occurrences.reduce((n, o) => n + o.message_ids.length, 0));
    quotes.push(...p.evidence, ...p.stall_quotes, ...p.estimate_quotes, ...p.claims.map((c) => c.quote), ...p.stall_groups.flatMap((g) => g.quotes));
  }
  assert.ok(quotes.length > 0);
  for (const q of quotes) {
    for (const k of ['sender_label', 'date_utc', 'message_id'] as const) assert.ok(k in q, `${q.id} has ${k}`);
    const text = corpus.read(q.message_id).toString('utf8');
    assert.equal(text.slice(q.start, q.end), q.raw_text, `${q.id} sits at its offsets`);
  }
  const data = json<DashboardData>('dashboard/data.json');
  const alpha = data.rows.find((r) => r.key === 'alpha-work');
  assert.equal(alpha?.stall_label, 'Requests wait a day for the desk.', 'the most-cited stall summary, cut at its first sentence');
  assert.equal(alpha?.stall_summary, 'Requests wait a day for the desk. Then they are confirmed.');
  assert.equal(alpha?.fix, 'A request tracker with a confirmation template');
});

test('A13: the seven coverage buckets hold every message once', () => {
  const method = json<MethodData>('dashboard/method.json');
  assert.deepEqual(method.coverage.map((c) => c.bucket), ['counted', 'unassigned', 'personal', 'noise', 'automated', 'flagged', 'duplicates']);
  const ids = method.coverage.flatMap((c) => c.ids);
  assert.equal(ids.length, 30);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of method.coverage) assert.equal(c.count.v, c.ids.length);
  assert.deepEqual(method.coverage.map((c) => c.ids.length), [29, 1, 0, 0, 0, 0, 0]);
});

test('A14: one threshold sentence in data.json, report.md and report.html; every eligible row has a document status', () => {
  const data = json<DashboardData>('dashboard/data.json');
  for (const f of ['report.md', 'report.html']) assert.ok(readOut(f).toString('utf8').includes(data.sentences.threshold), f);
  assert.equal(data.documents.length, 7);
  for (const d of data.documents) assert.ok(['done', 'skipped', 'exhausted', 'failed', 'pending', 'running'].includes(d.status));
  const echo = data.rows.find((r) => r.key === 'echo-work');
  assert.equal(echo?.status_line, 'Not drafted: no document type was chosen for this process');
  const drafted = data.rows.filter((r) => r.document?.status === 'done');
  for (const r of drafted) assert.match(r.status_line, /^Drafted: (?:SOP|Checklist|Email template|Template), \d+ items? to confirm$/);
});

test('the shown rank: the rows in the total come first, 1 to n, then those seen too rarely, even when one of those earns more', () => {
  const { inputs } = loadInputs(root);
  const x = structuredClone(inputs);
  // The score's rank 1 becomes a process seen too rarely to count; the headline loses its share.
  const top = x.opportunities.opportunities.find((o) => o.rank === 1) as BuildInputs['opportunities']['opportunities'][number];
  top.tier = 'C';
  // The headline in the total, summed again over the rest the way the score sums it.
  const rest = x.opportunities.opportunities.filter((o) => o.tier !== 'C');
  const sum = (f: (o: (typeof rest)[number]) => number) => rest.reduce((t, o) => t + f(o), 0);
  const h = x.opportunities.headline.tiers_ab_cents;
  h.counted_email = sum((o) => scoreCents(o.counted.email_per_month_x100.automatable));
  h.estimated_work = sum((o) => (o.estimated === null ? 0 : scoreCents(o.estimated.work_per_month_x100.automatable)));
  h.total = h.counted_email + h.estimated_work;
  h.low = sum((o) => o.range_cents.low);
  h.high = sum((o) => o.range_cents.high);
  h.today = sum((o) => o.dollars_per_month_cents.today);
  h.hours_x100 = { today: sum((o) => o.hours_per_month_x100.today), automatable: sum((o) => o.hours_per_month_x100.automatable) };
  const { data, method, processes } = buildData(x);
  const inTotal = data.rows.filter((r) => r.in_total);
  assert.deepEqual(data.rows.map((r) => r.rank), data.rows.map((_, i) => i + 1), 'contiguous from 1');
  assert.deepEqual(data.rows.slice(0, inTotal.length).map((r) => r.in_total), inTotal.map(() => true), 'the total first');
  assert.equal(data.rows.find((r) => r.key === top.key)?.rank, inTotal.length + 1, 'the score’s rank 1 follows the total');
  // Every list that shows a rank shows the same one.
  for (const d of data.documents) {
    const r = data.rows.find((row) => row.key === d.key);
    assert.ok(r !== undefined, d.key);
  }
  assert.deepEqual(data.documents.map((d) => d.key), [...data.documents].sort((a, b) => (data.rows.find((r) => r.key === a.key)?.rank ?? 0) - (data.rows.find((r) => r.key === b.key)?.rank ?? 0)).map((d) => d.key), 'documents in shown-rank order');
  for (const e of method.estimates) assert.equal(e.rank, data.rows.find((r) => r.key === e.key)?.rank, e.key);
  for (const p of processes) assert.equal(p.rank, data.rows.find((r) => r.key === p.key)?.rank, p.key);
});

test('A14 with a dollar bar: a row under it says so, in exact cents where its whole dollars would read as at the line', () => {
  const { inputs } = loadInputs(root);
  const cents = inputs.opportunities.opportunities[2]?.dollars_per_month_cents.automatable as number;
  const withBar = (bar: number): BuildInputs => ({ ...inputs, scoring: { ...inputs.scoring, artifacts: { ...inputs.scoring.artifacts, min_automatable_cents: bar } }, artifacts: { version: 1, artifacts: [] } });
  // One cent over the row: its shown dollars would read as at the line, so the line gives exact cents.
  const near = buildData(withBar(cents + 1));
  const row = near.data.rows.find((r) => r.total.v === cents) as DashboardData['rows'][number];
  assert.equal(row.status_line, `Not drafted: ${row.total.x} a month is under the ${near.data.scoring.threshold?.x} drafting line`);
  // A bar far above it: whole dollars.
  const far = buildData(withBar(cents + 10_000));
  const row2 = far.data.rows.find((r) => r.total.v === cents) as DashboardData['rows'][number];
  assert.equal(row2.status_line, `Not drafted: ${row2.total.t} a month is under the ${far.data.scoring.threshold?.t} drafting line`);
});

test('A18: the run facts come from the run log, to its last step of work, the builds left out', () => {
  const data = json<DashboardData>('dashboard/data.json');
  assert.deepEqual([data.run.id, data.run.date, data.run.log, data.run.later_runs?.v], [FIXED_RUN_ID, '2026-10-19', `out/runs/${FIXED_RUN_ID}.jsonl`, 0]);
  // From the run's first event to the agent started at 00:20, past the build at 00:12:30.
  assert.deepEqual([data.run.agents?.v, data.run.fix_rounds?.v, data.run.minutes?.v, data.run.minutes?.t], [4, 2, 1200, '20.0']);
  const method = json<MethodData>('dashboard/method.json');
  assert.deepEqual(method.run.agents, [{ type: 'extractor', count: 3 }, { type: 'synthesizer', count: 1 }]);
  assert.deepEqual(method.run.fix_rounds, [{ job: 'batch-001', rounds: 2 }]);
  assert.deepEqual(method.run.stages.map((s) => [s.name, s.ms]), [['rollup', 702], ['score', 252]]);
  assert.deepEqual(method.run.later_runs, []);
  assert.deepEqual(method.run.synthesizer, { model: 'opus', effort: 'medium' });
  assert.equal(runFacts(null).minutes, null);
  const summary = json<{ run: { agents: Record<string, number>; fix_rounds: number } }>('run-summary.json');
  assert.deepEqual(summary.run, { id: FIXED_RUN_ID, later_runs: [], wall_seconds: 1200, agents: { extractor: 3, synthesizer: 1 }, fix_rounds: 2 });
  const md = readOut('report.md').toString('utf8');
  assert.ok(md.includes(`- Run \`${FIXED_RUN_ID}\` of 19 Oct 2026.\n- 20.0 minutes from the run’s first event to its last step of work`));
  assert.ok(md.includes(`- The run’s log: \`out/runs/${FIXED_RUN_ID}.jsonl\`.`));
});

test('reviewer 17 and 18: the label beside the value; the Methodology data', () => {
  const data = json<DashboardData>('dashboard/data.json');
  const md = readOut('report.md').toString('utf8');
  assert.ok(md.includes(`**${data.headline.total.t} a month**\n\n${data.headline.label}\n`), 'the label right under the value');
  const method = json<MethodData>('dashboard/method.json');
  assert.equal(data.rates.sha, json<{ inputs: { rates_sha: string } }>('opportunities.json').inputs.rates_sha);
  assert.equal(data.rates.hourly.t, '$85');
  assert.ok(method.words.rounding.length > 0 && method.words.estimates.some((w) => w.includes('model opus, effort medium, set in its agent definition')));
  assert.ok(method.identity.folds.length === 5 && method.merge.counts.slugs === 4 && (method.quotes.counts.total?.exact ?? 0) > 0);
  assert.equal(method.contradictions_dropped, 0);
});

// The fixture's threads are one message each and every message is a request: three are turned into
// a chaser-ended thread, a thread ending on a validated "waiting on a reply" quote, and one left as
// a request, which the rule excludes.
test('reviewer 19: the open-loop rule', () => {
  const { inputs } = loadInputs(root);
  const x = structuredClone(inputs);
  const p = x.rollup.processes.find((q) => q.key === 'alpha-work') as BuildInputs['rollup']['processes'][number];
  const [chased, waiting, plain] = p.message_ids as [string, string, string];
  for (const s of p.action_sources) if (s.message_id === chased && s.type !== 'read') s.type = 'chaser';
  const batch = x.validated.find((v) => v.messages.some((m) => m.id === waiting)) as BuildInputs['validated'][number];
  const entry = batch.messages.find((m) => m.id === waiting) as BuildInputs['validated'][number]['messages'][number];
  const text = openCorpus(root).read(waiting).toString('utf8');
  const quote = 'Please handle';
  const start = text.indexOf(quote);
  entry.stall = { kind: 'waiting_on_reply', quote };
  batch.stall_checks.push({ message_id: waiting, match: 'exact', start, end: start + quote.length, segment: 'own', raw_text: quote, reason: null });
  p.stalls.push({ message_id: waiting, kind: 'waiting_on_reply', quote, start, end: start + quote.length });
  const loops: LoopItem[] = buildData(x).loops;
  assert.deepEqual(loops.map((l) => [l.message_id, l.why]).sort(), [[chased, 'chase'], [waiting, 'waiting']].sort());
  assert.ok(!loops.some((l) => l.message_id === plain));
  for (const l of loops) {
    assert.ok(l.thread_id !== '' && l.date_utc !== null && l.mailbox_end_utc !== null);
    assert.deepEqual(l.processes, ['alpha-work']);
  }
  assert.equal(loops.find((l) => l.why === 'waiting')?.quote?.raw_text, quote);
  assert.equal(loops.find((l) => l.why === 'chase')?.quote, null);
});

test('reviewer 14 on the fixture: identities once, lists never staff, claims and conflicts', () => {
  for (const f of readdirSync(join(root, 'out', 'dashboard', 'process'))) {
    const p = json<ProcessData>(`dashboard/process/${f}`);
    assert.equal(new Set(p.participants.map((x) => x.email)).size, p.participants.length);
    assert.ok(!p.participants.some((x) => x.kind !== 'person' && x.staff));
  }
});

test('A15: hostile data shows as text in report.html and report.md, never as markup', () => {
  const hostile = JSON.parse(readFileSync(join(repo, 'tests', 'fixtures', 'dashboard', 'hostile.json'), 'utf8')) as Record<string, string>;
  const { inputs, assets, shas } = loadInputs(root);
  const x = structuredClone(inputs);
  const o = x.opportunities.opportunities[0] as BuildInputs['opportunities']['opportunities'][number];
  o.name = hostile.name as string;
  const p = x.rollup.processes.find((q) => q.key === o.key) as BuildInputs['rollup']['processes'][number];
  const m = x.messages.find((q) => q.id === p.message_ids[0]) as BuildInputs['messages'][number];
  m.subject = hostile.subject as string;
  for (const v of x.validated) for (const e of v.evidence) if (p.evidence_ids.includes(e.evidence_id)) e.raw_text = hostile.quote as string;
  const art = x.artifacts.artifacts.find((a) => a.status === 'done');
  assert.ok(art !== undefined && art.path !== null);
  const texts = new Map(x.artifactText);
  texts.set(art.path, hostile.markdown as string);
  const out: Rendered = renderOutputs({ ...x, artifactText: texts }, assets, shas);
  const html = out.files.get('report.html') as string;
  const md = out.files.get('report.md') as string;
  assert.ok(html.includes(escapeHtml(hostile.name as string)), 'the name, escaped');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the quote, escaped');
  assert.ok(html.includes('&lt;script&gt;alert(&#39;doc&#39;)&lt;/script&gt;'), 'the document, escaped');
  assert.doesNotMatch(html, /<script|<img|<b>bold|<i>it|<\/blockquote><script|href=/i, 'no markup from the data');
  assert.ok(html.includes('<mark class="blank">[owner to confirm]</mark>'));
  // report.md: no HTML tag outside fenced blocks; the name shows as written.
  const outsideFences = md.replace(/^```[\s\S]*?^```$/gm, '');
  assert.doesNotMatch(outsideFences, /<\/?[A-Za-z][^>]*>/);
  assert.ok(md.includes(escapeMdText(hostile.name as string)), 'the name in report.md, escaped as one line');
  const data = JSON.parse(out.files.get('dashboard/data.json') as string) as DashboardData;
  assert.equal(data.rows[0]?.name, hostile.name, 'data.json carries the name as data');
});

// ---- The committed out/ (or OBS_BUILD_ROOT): skipped while its build inputs are stale ----

const real = process.env.OBS_BUILD_ROOT ?? repo;

test('time budget and reviewer 14 on the real build', (t) => {
  let loaded: ReturnType<typeof loadInputs>;
  try {
    loaded = loadInputs(real);
  } catch (err) {
    t.skip(`the build inputs there are not current: ${(err as Error).message}`);
    return;
  }
  const started = performance.now();
  const out = renderOutputs(loaded.inputs, loaded.assets, loaded.shas);
  const ms = performance.now() - started;
  assert.ok(ms < 10_000, `the build took ${Math.round(ms)} ms`);
  for (const p of out.built.processes) {
    assert.equal(new Set(p.participants.map((x) => x.email)).size, p.participants.length, p.key);
    assert.ok(!p.participants.some((x) => x.kind !== 'person' && x.staff), p.key);
    const status = new Map(p.claims.map((c) => [c.message_id, c.status]));
    for (const c of p.conflicts) for (const id of [c.a, c.b]) assert.notEqual(status.get(id) ?? 'matched', 'unmatched', `${p.key}: an unmatched claim in a conflict`);
    for (const c of p.contradictions) {
      const people = c.claims.filter((x) => x.status === 'matched').map((x) => x.name);
      assert.ok(c.claims.length < 2 || c.claims.some((x) => x.status !== 'matched') || new Set(people).size > 1, `${p.key}: a contradiction of one person`);
    }
  }
  const shares = out.built.data.cumulative.map((c) => c.share.t);
  assert.ok(shares.length > 0);
});

// The Methodology's "left apart" lists (src/normalize/identity.ts foldReport): each priced m..last
// address that folded nowhere, under the reason the rules gave.
test('foldReport: why each m..last address was left apart', () => {
  const rates = { priced_domains: ['enron.com'], system_senders: [] };
  const p = (email: string, name: string | null = null) => ({ email, name, sent: 1, received: 1, priced: true });
  const people = [
    p('a..smith@enron.com'),
    p('john.a.smith@enron.com'),
    p('jane.a.smith@enron.com'),
    p('b..jones@enron.com'),
    p('mary.jones@enron.com', 'Jones, Mary'),
    p('c..brown@enron.com'),
    p('tom.brown@enron.com', 'Brown, Tom C'),
    p('d..green@enron.com'),
    p('e..white@enron.com'),
    p('sam.white@enron.com', 'White, Sam E'),
  ];
  const together = (x: string, y: string) => [x, y].sort().join(' ') === 'c..brown@enron.com tom.brown@enron.com';
  const folded = foldPeople(people, rates, together);
  assert.equal(folded.find((x) => x.email === 'e..white@enron.com')?.fold, 'last_name', 'the one with the initial shown folds');
  assert.deepEqual(foldReport(folded, rates, together), {
    ambiguous: ['a..smith@enron.com'],
    no_initial: ['b..jones@enron.com'],
    shared_message: ['c..brown@enron.com'],
    no_candidate: ['d..green@enron.com'],
  });
});

test('a mailbox owner comes from its sent folder only when one staff person sent at least half of it; else from its staff addressee', () => {
  const { inputs, assets, shas } = loadInputs(root);
  // The fixture's mailbox m5, every message from Ann Lee (odd) or Bob Ray (even) to desk@enron.com,
  // with the folders and senders edited.
  const ownerWith = (sent: readonly number[], outsiders: readonly number[] = []): string | undefined => {
    const x = structuredClone(inputs);
    for (const m of x.messages) {
      const n = Number(m.id.slice(-2));
      m.folder = sent.includes(n) ? 'sent' : 'inbox';
      if (outsiders.includes(n)) m.from = { email: 'someone@outside.example', name: 'Some One' };
    }
    return renderOutputs(x, assets, shas).built.data.scope.mailboxes.find((b) => b.key === 'm5')?.owner;
  };
  assert.equal(ownerWith([1, 3, 5]), 'Ann Lee', 'all of it');
  assert.equal(ownerWith([1, 2, 3, 4]), 'Ann Lee', 'half of it (a tie goes by address)');
  assert.equal(ownerWith([1, 2, 3], [3]), 'desk@enron.com', 'a third each: nobody sent half, so the staff addressee');
  assert.equal(ownerWith([1, 3], [1, 3]), 'desk@enron.com', 'sent by someone outside the company: not the owner');
});

// ---- The real data's logic, from hand-edited fixture inputs (item 4 of the Task 1 review) ----
//
// The fixture has one mailbox and none of the cases the real run has, so its inputs are edited in
// memory: two mailboxes (one with a sent folder, one without) and a third whose owner is unknown, a
// matched owner claim and a conflict pair, a contradiction dropped and one kept, reply gaps at 4 and
// 5, an undated message, a failed draft, a duplicate, a flagged message, the stall-label fallbacks
// and long text to cut. CI never sees the real run, so this is where its logic is tested.
test('the real data’s cases on edited inputs: owners, claims, contradictions, reply gaps, dates, drafts, coverage, labels', () => {
  const { inputs, assets, shas } = loadInputs(root);
  const corpus = openCorpus(root);
  const x = structuredClone(inputs);
  const id = (n: number) => `corpus/m5/inbox/${String(n).padStart(2, '0')}`;
  const msg = (n: number) => x.messages.find((m) => m.id === id(n)) as BuildInputs['messages'][number];
  const proc = (key: string) => x.rollup.processes.find((p) => p.key === key) as BuildInputs['rollup']['processes'][number];
  const opp = (key: string) => x.opportunities.opportunities.find((o) => o.key === key) as BuildInputs['opportunities']['opportunities'][number];
  const batchOf = (n: number) => x.validated.find((v) => v.messages.some((m) => m.id === id(n))) as BuildInputs['validated'][number];
  const span = (n: number) => {
    const at = corpus.read(id(n)).toString('utf8').indexOf('Please handle');
    return { start: at, end: at + 'Please handle'.length };
  };

  // Mailboxes: Ann's mail in m5's sent folder, Bob's (and two of Ann's) in m6's inbox with no sent
  // folder, the one-off in m7 addressed outside the company.
  for (const m of x.messages) {
    const n = Number(m.id.slice(-2));
    if (n % 2 === 0 || n === 9 || n === 11) {
      m.mailbox = 'm6';
      m.folder = 'inbox';
    } else m.folder = 'sent';
  }
  Object.assign(msg(30), { mailbox: 'm7', folder: 'inbox', to: [{ email: 'someone@outside.example', name: null }], cc: [] });

  // Two owner claims on alpha, matched to two people 59 days apart: a conflict pair.
  const b0 = batchOf(1);
  for (const [n, person] of [[1, 'Ann Lee'], [2, 'Bob Ray']] as const) {
    b0.ownership_checks.push({ message_id: id(n), person, match: 'exact', ...span(n), segment: 'own', raw_text: 'Please handle', reason: null });
    (b0.messages.find((m) => m.id === id(n)) as (typeof b0.messages)[number]).ownership_claim = { person, quote: 'Please handle' };
  }
  const alpha = proc('alpha-work');
  alpha.ownership_claims = [
    { message_id: id(1), person: 'Ann Lee', date_utc: msg(1).date_utc, quote: 'Please handle', match: { status: 'matched', people: ['ann.lee@enron.com'], name: 'Ann Lee' } },
    { message_id: id(2), person: 'Bob Ray', date_utc: msg(2).date_utc, quote: 'Please handle', match: { status: 'matched', people: ['bob.ray@enron.com'], name: 'Bob Ray' } },
  ];
  alpha.ownership_conflicts = [{ a: id(1), b: id(2), days_apart: 59 }];
  const o0 = `${b0.batch_id}:o0`;
  const o1 = `${b0.batch_id}:o1`;
  const alphaSynth = opp('alpha-work').synthesis as NonNullable<BuildInputs['opportunities']['opportunities'][number]['synthesis']>;
  alphaSynth.contradictions = [
    { summary: 'The owner is unclear.', evidence_ids: [o0] },
    { summary: 'Two people are named as owner.', evidence_ids: [o0, o1] },
  ];
  // Long text, cut by code.
  alphaSynth.stalls = [{ summary: `${'The nomination requests wait '.repeat(5)}for days. Then more.`, evidence_ids: alphaSynth.stalls[0]?.evidence_ids ?? [] }];
  alphaSynth.automation.approach = `${'Track every request in one shared list and confirm it back '.repeat(8)}today. Then more.`;

  // Reply gaps: 4 measured on bravo (not shown), 5 on charlie (shown).
  for (const [key, n] of [['bravo-work', 4], ['charlie-work', 5]] as const) {
    const p = proc(key);
    p.reply_gaps = Array.from({ length: n }, (_, i) => ({ from: id(5 + i), to: id(6 + i), hours_x10: 25 }));
    p.reply_gap_n = n;
    p.median_reply_gap_h = 2.5;
  }

  // An undated message (foxtrot's first round), a failed draft (foxtrot's).
  Object.assign(msg(21), { date_status: 'missing', date_utc: null, date_raw: null });
  const fox = x.artifacts.artifacts.find((a) => a.key === 'foxtrot-work') as BuildInputs['artifacts']['artifacts'][number];
  Object.assign(fox, { status: 'exhausted', path: null, reason: 'no usable draft after 2 attempts; see the problems in out/ledger/draft-005.json' });

  // A duplicate of message 5, and a flagged message.
  x.messages.push({ ...structuredClone(msg(5)), id: 'corpus/m5/inbox/31', mailbox: 'm6', folder: 'inbox' });
  x.dedup.groups.push({ canonical: id(5), duplicates: [{ id: 'corpus/m5/inbox/31', rule: 'content', recipients_differ: false }] });
  const flagged = { ...structuredClone(msg(1)), id: 'corpus/m5/inbox/32' };
  flagged.flags = { ...flagged.flags, suspected_injection: true, injection_markers: ['addressed_to_ai'] };
  x.messages.push(flagged);
  b0.messages.push({ id: flagged.id, processes: [], role: 'injection_attempt', stall: null, ownership_claim: null });
  x.validation.flagged.push({ message_id: flagged.id, markers: ['addressed_to_ai'], role: 'injection_attempt', tags: [], merged_keys: [] });

  // Stall labels: delta with one validated quote and no summary, echo with neither.
  for (const key of ['delta-work', 'echo-work']) (opp(key).synthesis as { stalls: unknown[] }).stalls = [];
  const b2 = batchOf(13);
  b2.stall_checks.push({ message_id: id(13), match: 'exact', ...span(13), segment: 'own', raw_text: 'Please handle', reason: null });
  (b2.messages.find((m) => m.id === id(13)) as (typeof b2.messages)[number]).stall = { kind: 'rework', quote: 'Please handle' };
  proc('delta-work').stalls.push({ message_id: id(13), kind: 'rework', quote: 'Please handle', ...span(13) });

  const out = renderOutputs(x, assets, shas);
  const built = out.built;
  const row = (key: string) => built.data.rows.find((r) => r.key === key) as DashboardData['rows'][number];
  const file = (key: string) => built.processes.find((p) => p.key === key) as ProcessData;

  // Owners: from the sent folder; from the staff addressee where there is none; unknown otherwise.
  const mb = new Map(built.data.scope.mailboxes.map((m) => [m.key, m]));
  assert.deepEqual([mb.get('m5')?.owner, mb.get('m5')?.received_only], ['Ann Lee', false]);
  assert.deepEqual([mb.get('m6')?.owner, mb.get('m6')?.own_messages, mb.get('m6')?.received_only], ['desk@enron.com', 0, true]);
  assert.deepEqual([mb.get('m7')?.owner, mb.get('m7')?.received_only], ['m7', false]);
  assert.deepEqual([row('charlie-work').top_mailbox, row('charlie-work').one_mailbox, row('charlie-work').seen_in], ['m6', true, 'Mostly seen in: desk@enron.com (100%)']);
  const md = out.files.get('report.md') as string;
  assert.ok(md.includes('desk@enron.com’s replies are not in this archive.'), 'the received-only owner’s caution under charlie');
  assert.ok(!md.includes('m7’s'), 'nothing is said of an unknown owner’s mail');

  // Claims, the conflict pair, one contradiction dropped and one kept with its claims.
  assert.deepEqual(file('alpha-work').claims.map((c) => [c.status, c.name, c.status_words]), [
    ['matched', 'Ann Lee', 'matched to someone on the threads'],
    ['matched', 'Bob Ray', 'matched to someone on the threads'],
  ]);
  assert.deepEqual([row('alpha-work').claims.v, row('alpha-work').conflicts.v], [2, 1]);
  assert.equal(file('alpha-work').contradictions_dropped, 1);
  assert.deepEqual(file('alpha-work').contradictions.map((c) => [c.summary, c.claims.length]), [['Two people are named as owner.', 2]]);
  assert.equal(built.method.contradictions_dropped, 1);
  assert.equal(built.summary.contradictions_dropped, 1);

  // Reply gaps: none shown under 5; shown at 5.
  assert.equal(row('bravo-work').reply_gap, null);
  assert.deepEqual([row('charlie-work').reply_gap?.n.v, row('charlie-work').reply_gap?.median_h], [5, '2.5']);

  // The undated message: an undated round, listed with the unusable dates.
  assert.equal(file('foxtrot-work').undated_occurrences.length, 1);
  assert.equal(built.index.find((m) => m.id === id(21))?.date_status, 'missing');
  assert.ok(built.method.dates.some((d) => d.message_id === id(21) && d.words === 'no Date header'));
  // The failed draft.
  assert.equal(row('foxtrot-work').status_line, 'Draft failed: no usable draft after 2 attempts; see the problems in out/ledger/draft-005.json');
  assert.equal(row('foxtrot-work').document?.status, 'exhausted');

  // Coverage: the duplicate and the flagged message in their buckets; every message once.
  const cov = new Map(built.method.coverage.map((c) => [c.bucket, c.ids]));
  assert.deepEqual([cov.get('duplicates'), cov.get('flagged')], [['corpus/m5/inbox/31'], ['corpus/m5/inbox/32']]);
  assert.equal(built.method.coverage.reduce((n, c) => n + c.ids.length, 0), 32);
  assert.equal(built.index.find((m) => m.id === 'corpus/m5/inbox/31')?.duplicate_of, id(5));
  assert.deepEqual(built.index.find((m) => m.id === 'corpus/m5/inbox/32')?.flags, ['flagged']);

  // Stall labels: the cut summary, the count of the one quote's kind, none quoted.
  assert.match(row('alpha-work').stall_label, /…$/);
  assert.ok([...row('alpha-work').stall_label].length <= 90);
  assert.equal(row('delta-work').stall_label, '1 quote: rework');
  assert.equal(row('echo-work').stall_label, 'none quoted');
  assert.match(row('alpha-work').fix ?? '', /…$/);
  assert.ok([...(row('alpha-work').fix ?? '')].length <= 400);

  // The last three months of the top mailbox's record: m5 ends on 15 Sep 2001; of bravo's rounds
  // (Jan, Mar, May, Jul) only July falls within 90 days of it.
  assert.equal(mb.get('m5')?.last_utc.slice(0, 10), '2001-09-15');
  assert.deepEqual([row('bravo-work').top_mailbox, row('bravo-work').last_three_months_share?.t], ['m5', '1 of 4']);

  // And the walk holds on all of it.
  assert.deepEqual(checkTargets({ data: built.data, method: built.method, loops: built.loops, processes: built.processes, index: built.index }), []);
});

test('cutAt and firstSentence: the first sentence, cut at the last word before the limit with an ellipsis', () => {
  assert.equal(firstSentence('Rounds wait. Then more.'), 'Rounds wait.');
  assert.equal(firstSentence('No end mark here'), 'No end mark here');
  assert.equal(cutAt('short', 90), 'short');
  const long = 'The nomination requests wait for days because nobody owns the shared queue of the desk at all';
  const cut = cutAt(long, 40);
  assert.equal(cut, 'The nomination requests wait for days…');
  assert.ok([...cut].length <= 40);
});

test('capGuard: whether the cap or the minimum bound the run', () => {
  const scoring = { ...JSON.parse(readFileSync(join(repo, 'config', 'scoring.json'), 'utf8')), artifacts: { min_automatable_cents: 8500, cap: 2, floor: 1 } };
  const rowsOf = (cents: number[]) => cents.map((c) => ({ in_total: true, total: { v: c } })) as unknown as DashboardData['rows'];
  assert.equal(capGuard(rowsOf([9000, 100]), scoring), 'The cap of 2 documents and the minimum of 1 are run-time guards; neither bound this run.');
  assert.match(capGuard(rowsOf([9000, 9000, 9000]), scoring), /the cap bound this run: 3 processes cleared the bar and the first 2 were drafted\.$/);
  assert.match(capGuard(rowsOf([100, 100]), scoring), /the minimum bound this run: 0 cleared the bar, so the top 1 in the total were drafted\.$/);
});

// ---- Run facts: the span from the latest cold run to the last step of work (second review, item 4) ----

const logLines = (events: ReadonlyArray<Record<string, unknown>>): string => events.map((e) => `${JSON.stringify(e)}\n`).join('');
// A project holding only run logs, by run id.
function runsProject(name: string, logs: Record<string, Array<Record<string, unknown>>>): string {
  const dir = join(tmp, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'out', 'runs'), { recursive: true });
  for (const [id, events] of Object.entries(logs)) writeFileSync(join(dir, 'out', 'runs', `${id}.jsonl`), logLines(events));
  return dir;
}
const ev = (ts: string, event: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({ ts: `2026-10-${ts}Z`, event, ...more });
function factsOf(dir: string) {
  const f = runFacts(runSpanOf(dir));
  return { id: f.id, later: f.later.map((r) => r.id), agents: f.agentsNum?.v, fix: f.fixNum?.v, seconds: f.minutes?.v, stages: f.stages.map((s) => s.name) };
}

test('run facts: a usage-limit resume continues the cold run, and the wait before it is not counted', () => {
  const dir = runsProject('resumed', {
    '20261019T000000Z': [
      ev('19T00:00:00.000', 'run_start'),
      ev('19T00:00:02.000', 'prepare', { skipped: false }),
      ev('19T00:01:00.000', 'SubagentStart', { agent_type: 'extractor' }),
      ev('19T00:10:00.000', 'gate', { batch_id: 'batch-000', status: 'failed' }),
      ev('19T00:10:30.000', 'SubagentStop'),
    ],
    '20261019T030000Z': [
      ev('19T03:00:00.000', 'run_start'),
      ev('19T03:00:02.000', 'prepare', { skipped: true }),
      ev('19T03:01:00.000', 'SubagentStart', { agent_type: 'extractor' }),
      ev('19T03:05:00.000', 'gate', { batch_id: 'batch-000', status: 'done' }),
      ev('19T03:05:00.000', 'stage', { name: 'rollup', ms: 5 }),
      ev('19T03:06:00.000', 'stage', { name: 'build', ms: 5 }),
      ev('19T03:06:01.000', 'stage', { name: 'run end', ms: 1 }),
    ],
  });
  // Ten minutes to the first run's last step of work, five to the resume's; not the three hours between.
  assert.deepEqual(factsOf(dir), { id: '20261019T000000Z', later: ['20261019T030000Z'], agents: 2, fix: 1, seconds: 900, stages: ['rollup'] });
});

test('run facts: a re-score after a full run keeps the full run and adds the score step', () => {
  const dir = runsProject('rescored', {
    '20261019T000000Z': [
      ev('19T00:00:00.000', 'run_start'),
      ev('19T00:00:02.000', 'prepare', { skipped: false }),
      ev('19T00:01:00.000', 'SubagentStart', { agent_type: 'extractor' }),
      ev('19T00:02:00.000', 'SubagentStart', { agent_type: 'extractor' }),
      ev('19T00:05:00.000', 'gate', { batch_id: 'batch-001', status: 'failed' }),
      ev('19T00:20:00.000', 'SubagentStart', { agent_type: 'synthesizer' }),
      ev('19T00:30:00.000', 'stage', { name: 'score', ms: 40 }),
      ev('19T00:40:00.000', 'stage', { name: 'artifacts collect', ms: 30 }),
      ev('19T00:41:00.000', 'stage', { name: 'build', ms: 900 }),
      ev('19T00:41:30.000', 'stage', { name: 'run end', ms: 2 }),
    ],
    // The next day an override changed and the score ran again.
    '20261020T090000Z': [ev('20T09:00:00.000', 'run_start'), ev('20T09:00:02.000', 'prepare', { skipped: true }), ev('20T09:00:05.000', 'advance'), ev('20T09:00:10.000', 'stage', { name: 'score', ms: 40 }), ev('20T09:00:11.000', 'stage', { name: 'build', ms: 900 }), ev('20T09:00:12.000', 'stage', { name: 'run end', ms: 2 })],
  });
  assert.deepEqual(factsOf(dir), { id: '20261019T000000Z', later: ['20261020T090000Z'], agents: 3, fix: 1, seconds: 2410, stages: ['score', 'artifacts collect', 'score'] });
});

test('run facts: a manual build in the middle of a run cuts nothing; a warm run with no work adds nothing; a later cold run starts the span again; with no cold run, the first run', () => {
  const midBuild = runsProject('mid build', {
    '20261019T000000Z': [
      ev('19T00:00:00.000', 'run_start'),
      ev('19T00:00:02.000', 'prepare', { skipped: false }),
      ev('19T00:01:00.000', 'SubagentStart', { agent_type: 'extractor' }),
      ev('19T00:05:00.000', 'stage', { name: 'build', ms: 900, summary: 'a build typed by hand' }),
      ev('19T00:08:00.000', 'SubagentStart', { agent_type: 'extractor' }),
      ev('19T00:09:00.000', 'stage', { name: 'rollup', ms: 5 }),
    ],
  });
  const expected = { id: '20261019T000000Z', later: [], agents: 2, fix: 0, seconds: 540, stages: ['rollup'] };
  assert.deepEqual(factsOf(midBuild), expected);
  const before = runSpanSha(runSpanOf(midBuild));
  writeFileSync(join(midBuild, 'out', 'runs', '20261019T010000Z.jsonl'), logLines([ev('19T01:00:00.000', 'run_start'), ev('19T01:00:02.000', 'prepare', { skipped: true }), ev('19T01:00:03.000', 'advance'), ev('19T01:00:04.000', 'stage', { name: 'build', ms: 900 }), ev('19T01:00:05.000', 'stage', { name: 'run end', ms: 1 })]));
  assert.deepEqual(factsOf(midBuild), expected, 'the warm run');
  assert.equal(runSpanSha(runSpanOf(midBuild)), before, 'nor its hash');
  writeFileSync(join(midBuild, 'out', 'runs', '20261019T020000Z.jsonl'), logLines([ev('19T02:00:00.000', 'run_start'), ev('19T02:00:02.000', 'prepare', { skipped: false }), ev('19T02:00:30.000', 'SubagentStart', { agent_type: 'drafter' })]));
  assert.deepEqual(factsOf(midBuild), { id: '20261019T020000Z', later: [], agents: 1, fix: 0, seconds: 30, stages: [] }, 'a later cold run');
  assert.notEqual(runSpanSha(runSpanOf(midBuild)), before);
  const noCold = runsProject('no cold run', {
    '20261019T000000Z': [ev('19T00:00:00.000', 'run_start'), ev('19T00:00:20.000', 'SubagentStart', { agent_type: 'extractor' })],
    '20261019T010000Z': [ev('19T01:00:00.000', 'run_start'), ev('19T01:00:02.000', 'prepare', { skipped: true }), ev('19T01:00:10.000', 'stage', { name: 'score', ms: 3 })],
  });
  assert.deepEqual(factsOf(noCold), { id: '20261019T000000Z', later: ['20261019T010000Z'], agents: 1, fix: 0, seconds: 30, stages: ['score'] });
  // A cold run that stopped before any work: its id, nothing counted.
  const idle = runsProject('cold and idle', { '20261019T000000Z': [ev('19T00:00:00.000', 'run_start'), ev('19T00:00:02.000', 'prepare', { skipped: false })] });
  assert.deepEqual(factsOf(idle), { id: '20261019T000000Z', later: [], agents: 0, fix: 0, seconds: 0, stages: [] });
  assert.equal(runSpanOf(join(tmp, 'no such project')), null);
  assert.equal(runSpanSha(null), runSpanSha(runSpanOf(join(tmp, 'no such project'))));
});

test('run facts on the built project: a build during the run and one after it write the same bytes; a warm run with no work leaves the build current and a run with work makes it stale', () => {
  const runs = join(root, 'out', 'runs');
  const fixed = join(runs, `${FIXED_RUN_ID}.jsonl`);
  const full = readFileSync(fixed, 'utf8');
  const warm = join(runs, '20261019T010000Z.jsonl');
  const render = () => {
    const { inputs, assets, shas } = loadInputs(root);
    return renderOutputs(inputs, assets, shas).files;
  };
  try {
    // During the run: the log as it stood when the run's own build began, after its last step of work.
    const lines = full.split('\n').filter((l) => l !== '');
    const lastWork = lines.findLastIndex((l) => l.includes('"SubagentStart"'));
    assert.ok(lastWork > 0 && lastWork < lines.length - 1);
    writeFileSync(fixed, lines.slice(0, lastWork + 1).map((l) => `${l}\n`).join(''));
    const during = render();
    writeFileSync(fixed, full);
    const afterRun = render();
    assert.deepEqual([...during.keys()], [...afterRun.keys()]);
    for (const [path, content] of afterRun) assert.deepEqual(during.get(path), content, path);
    assert.equal(buildCurrent(root), true);
    // A warm run that found everything done.
    writeFileSync(warm, logLines([ev('19T01:00:00.000', 'run_start'), ev('19T01:00:02.000', 'prepare', { skipped: true }), ev('19T01:00:03.000', 'advance'), ev('19T01:00:04.000', 'stage', { name: 'run end', ms: 1 })]));
    assert.equal(buildCurrent(root), true, 'a warm run with no work leaves the build current');
    writeFileSync(warm, logLines([ev('19T01:00:00.000', 'run_start'), ev('19T01:00:02.000', 'prepare', { skipped: true }), ev('19T01:00:10.000', 'stage', { name: 'score', ms: 40, summary: 'score: again.' })]));
    assert.equal(buildCurrent(root), false, 'a run with work makes it stale');
    buildStep(root);
    const data = json<DashboardData>('dashboard/data.json');
    assert.deepEqual([data.run.id, data.run.later_runs?.v, data.run.agents?.v, data.run.minutes?.v], [FIXED_RUN_ID, 1, 4, 1210]);
    assert.ok(readOut('report.md').toString('utf8').includes(`- Run \`${FIXED_RUN_ID}\` of 19 Oct 2026, continued in 1 later run.`));
    const { inputs, assets, shas } = loadInputs(root);
    const { built } = renderOutputs(inputs, assets, shas);
    assert.deepEqual(checkTargets({ data: built.data, method: built.method, loops: built.loops, processes: built.processes, index: built.index }), [], 'the later-runs count ties to its list');
  } finally {
    rmSync(warm, { force: true });
    writeFileSync(fixed, full);
    buildStep(root);
  }
  const again = written(root);
  for (const [path, content] of first) assert.ok(again.get(path)?.equals(content), `${path} is as the first build wrote it`);
});

// ---- A drafted file with hostile text in its body and quotes (item 1) ----

test('a drafted file is written inert: an image, a link, a reference definition and a bare ~~~ in the body and in a quote stay text', () => {
  const brief = JSON.parse(readFileSync(join(root, 'out', 'artifacts', 'input', 'draft-000.json'), 'utf8')) as ArtifactBrief;
  const hostile = 'See ![pixel](http://example.invalid/p.png) and [click](javascript:alert(1)) <img src=x>\n[ref]: http://example.invalid\n~~~\nthe rest';
  const withQuote = { ...brief, evidence: brief.evidence.map((e, i) => (i === 0 ? { ...e, quote: hostile } : e)) };
  const body = BODIES[brief.artifact_type as keyof typeof BODIES].replace('## Purpose\n', `## Purpose\n\n${hostile}\n`);
  const text = renderArtifact(withQuote, body);
  let open = false;
  for (const line of text.split('\n')) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      open = !open;
      continue;
    }
    if (open) continue;
    assert.doesNotMatch(line, /<[A-Za-z!/?]|(?<!\\)\]\(|(?<!\\)!\[|^ {0,3}(?:>\s*)*\[[^\]]*\]:/, line);
  }
  assert.equal(open, false, 'no fence is left open');
  assert.ok(text.includes('pixel') && text.includes('javascript:alert(1)'), 'the text is kept, as text');
  // The gate checks the body as the drafter wrote it, and the collected file is re-rendered the same way.
  assert.equal(renderArtifact(withQuote, body), text);
});
