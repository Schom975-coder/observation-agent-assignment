// The score without a model: exact cents from known counts and estimates with the counted and
// estimated parts pinned separately (the ARCHITECTURE.md 5.4 example verbatim), one rounding per
// quantity, tiers at each threshold edge, ranking, the headline, the artifact threshold, which
// numbers of a synthesis file the score reads, and the score command with --rates and --estimates.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_TYPES, loadEffortRates, loadScoring, type ActionType, type Scoring } from '../src/config.ts';
import { CENTS_PER_HOUR, cents, hoursX100, modelEstimate, perMonthX100, score, tierOf, type ScoreInputs } from '../src/metrics/score.ts';
import { currentRollupInputs } from '../src/run/rollup.ts';
import { scoreCommand, scoreFreshness, scoreStep } from '../src/run/score.ts';
import { extractionsSha } from '../src/run/merge.ts';
import type { ActionCounts, ActionSource, EstimatesOverride, Opportunities, ProcessRollup, Rollup, ValidatedSynthesis } from '../src/types.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'obs-score-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const rates = loadEffortRates(join(repo, 'config', 'effort-rates.json'));
const scoring = loadScoring(join(repo, 'config', 'scoring.json'));

const zero = (): ActionCounts => Object.fromEntries(ACTION_TYPES.map((t) => [t, 0])) as ActionCounts;

// A process with `counts` priced actions, each from its own message at `share`.
function proc(key: string, opts: { occurrences?: number; share_x100?: number; span?: number; months_x100?: number; active_months?: number; staff?: number; counts?: Partial<ActionCounts>; share?: number } = {}): ProcessRollup {
  const counts = { ...zero(), ...opts.counts };
  const sources: ActionSource[] = [];
  let n = 0;
  for (const t of ACTION_TYPES) for (let i = 0; i < counts[t]; i++) sources.push({ message_id: `corpus/k/inbox/${key}-${n++}`, type: t, person: 'a@enron.com', address: 'a@enron.com', priced: true, share_x100: opts.share ?? 100 });
  const occurrences = opts.occurrences ?? 10;
  return {
    key,
    name: `Process ${key}`,
    origin: 'taxonomy',
    definition: 'Recurring work.',
    message_ids: [],
    thread_ids: [],
    occurrence_ids: [],
    occurrences,
    occurrence_share_x100: opts.share_x100 ?? occurrences * 100,
    shared_occurrences: 0,
    window: { first_utc: '2001-06-05T10:00:00Z', last_utc: '2002-01-31T10:00:00Z', span_days: opts.span ?? 241, months_x100: opts.months_x100 ?? 792, active_months: opts.active_months ?? 9, undated_occurrences: 0 },
    monthly: [],
    actions: { priced: counts, unpriced: zero() },
    action_sources: sources,
    email_x100: { today: 0, automatable: 0 },
    participants: [],
    staff_participants: opts.staff ?? 5,
    reply_gaps: [],
    reply_gap_n: 0,
    median_reply_gap_h: null,
    chasers: counts.chaser,
    stalls: [],
    ownership_claims: [],
    ownership_conflicts: [],
    evidence_ids: [],
    flags: [],
  };
}
const rollupOf = (processes: ProcessRollup[]): Rollup => ({
  version: 1,
  inputs: { extractions_sha: 'x', merge_sha: 'm', corpus_hash: 'c', rates_sha: 'r' },
  processes,
  unassigned: { messages: 645, message_ids: [], slugs: [{ slug: 'new:a', messages: 1, status: 'unassigned', reason: null }] },
  coverage: { files: 0, unique: 0, classified: 0, tagged: 0, counted: 0, unassigned: 0, role_only: {} },
});
const synthOf = (key: string, est: { low: number; mid: number; high: number; pct: number; ids?: number; occ?: number } | null): ValidatedSynthesis['processes'][number] => ({
  key,
  description: 'A description of the work as the mail shows it.',
  steps: ['Step'],
  stalls: [],
  contradictions: [],
  automation: { approach: 'A tracker', artifact_type: 'checklist', rationale: 'Because.' },
  work_estimate:
    est === null
      ? null
      : { minutes_per_occurrence: { low: est.low, mid: est.mid, high: est.high }, automatable_pct: est.pct, basis: 'observed', rationale: 'Steps named.', evidence_ids: Array.from({ length: est.ids ?? 6 }, (_, i) => `batch-000:e${i}`) },
  estimate_check: est === null ? null : { occurrences_cited: est.occ ?? 5, senders_cited: 3 },
});
const groupOf = (...processes: ValidatedSynthesis['processes']): ValidatedSynthesis => ({ group_id: 'synth-000', content_sha: 'g', processes });
const SHAS = { rollup_sha: 'r', synthesis_sha: 's', rates_sha: 'rt', scoring_sha: 'sc', estimates_sha: null };
const run = (overrides: Partial<ScoreInputs> & Pick<ScoreInputs, 'rollup'>): Opportunities =>
  score({ synthesis: [], rates, scoring, estimates: null, files: { rates: 'config/effort-rates.json', estimates: null }, shas: SHAS, ...overrides });

// The ARCHITECTURE.md 5.4 example: 104 occurrences (103.50 after sharing) over 241 days, 12 short,
// 20 medium, 6 long, 9 forwards, 5 chasers and 71 reads, and an estimate of 30-45-60 minutes, 60%.
const EXAMPLE = proc('realtime-schedule-checkout', { occurrences: 104, share_x100: 10350, span: 241, months_x100: 792, counts: { authored_short: 12, authored_medium: 20, authored_long: 6, forward: 9, chaser: 5, read: 71 } });

test('the 5.4 example, to the character: the counted part, the estimated part and the total, pinned separately', () => {
  const o = run({ rollup: rollupOf([EXAMPLE]), synthesis: [groupOf(synthOf(EXAMPLE.key, { low: 30, mid: 45, high: 60, pct: 60 }))] }).opportunities[0] as Opportunities['opportunities'][number];
  assert.equal(
    o.formula.counted,
    '104 occ (103.50 after sharing) over 241 d = 7.92 mo; email: 12 short x2 + 20 medium x6 + 6 long x15 + 9 fwd x2 + 5 chaser x3 + 71 read x1 = 338.00 min = 42.68 min/mo; ' +
      'automatable 60/40/30/80/100/50% = 154.30 min = 19.48 min/mo',
  );
  assert.equal(
    o.formula.estimated,
    '103.50 occ x 45 min/occ (estimate, mid of 30-60, basis observed, 6 quotes from 5 occurrences) = 4,657.50 min = 588.07 min/mo; automatable 60% (estimate) = 352.84 min/mo; ' +
      "at the low end 30 min/occ = $360.84/mo, at the high end 60 min/occ = $694.07/mo (the row's automatable total)",
  );
  assert.equal(
    o.formula.total,
    'today 630.75 min/mo = 10.51 h/mo = $893.56/mo (email 42.68 min/mo = $60.46 + work 588.07 min/mo = $833.10); ' +
      'automatable 372.32 min/mo = 6.21 h/mo = $527.46/mo (counted email 19.48 min/mo = $27.60 + estimated work 352.84 min/mo = $499.86)',
  );
  assert.deepEqual(o.counted.email_x100, { today: 33800, automatable: 15430 });
  assert.deepEqual(o.counted.email_per_month_x100, { today: 4268, automatable: 1948 });
  assert.deepEqual(o.estimated?.work_per_month_x100, { today: 58807, automatable: 35284 });
  // The dollars are the parts' cents added: 6,046 + 83,310 today, 2,760 + 49,986 automatable (one
  // cent over the cents of the summed minutes, 52,745).
  assert.deepEqual([o.per_month_x100, o.hours_per_month_x100, o.dollars_per_month_cents], [{ today: 63075, automatable: 37232 }, { today: 1051, automatable: 621 }, { today: 89356, automatable: 52746 }]);
  // The range: the estimate at 30 and at 60 minutes, 60% automatable throughout. Low: 103.50 x 30 =
  // 3,105.00 min, 1,863.00 automatable, 235.23 min/mo; high: 6,210.00 min, 3,726.00 automatable,
  // 470.45 min/mo; each plus the counted email's 19.48 min/mo, in cents part by part.
  assert.deepEqual(o.range_per_month_x100, { low: 1948 + 23523, high: 1948 + 47045 });
  assert.deepEqual(o.range_cents, { low: cents(1948) + cents(23523), high: cents(1948) + cents(47045) });
  assert.deepEqual(o.range_cents, { low: 36084, high: 69407 });
});

test('the counted formula shows the plain sum and the shared one when shares cut the minutes', () => {
  const shared = proc('shared', { occurrences: 4, share_x100: 250, counts: { authored_short: 2, read: 2 }, share: 50 });
  const o = run({ rollup: rollupOf([shared]) }).opportunities[0];
  // 2 short x 2 min + 2 reads x 1 min = 6.00 min plainly, 3.00 at a 50% share; automatable 1.20 x2 + 0.50 x2 = 3.40, 1.70 shared.
  assert.equal(
    o?.formula.counted,
    '4 occ (2.50 after sharing) over 241 d = 7.92 mo; email: 2 short x2 + 0 medium x6 + 0 long x15 + 0 fwd x2 + 0 chaser x3 + 2 read x1 = 6.00 min, 3.00 min after sharing = 0.38 min/mo; ' +
      'automatable 60/40/30/80/100/50% = 3.40 min, 1.70 min after sharing = 0.21 min/mo',
  );
});

test('process keys that name Object.prototype members are ordinary keys', () => {
  const procs = [proc('constructor'), proc('to-string'), proc('valueof')];
  const r = run({ rollup: rollupOf(procs), estimates: { version: 1, estimates: {} } });
  assert.deepEqual(r.opportunities.map((o) => [o.key, o.estimated]), [['constructor', null], ['to-string', null], ['valueof', null]].sort());
  const est: EstimatesOverride = { version: 1, estimates: JSON.parse('{"constructor": {"minutes_per_occurrence": {"low": 10, "mid": 20, "high": 30}, "automatable_pct": 40, "rationale": "x"}}') };
  assert.equal(run({ rollup: rollupOf(procs), estimates: est }).opportunities.find((o) => o.key === 'constructor')?.estimated?.source, 'override');
});

test('one rounding per quantity, half up, from integers', () => {
  assert.equal(CENTS_PER_HOUR, 8500);
  assert.deepEqual([perMonthX100(33800, 792), perMonthX100(15430, 792), perMonthX100(0, 100), perMonthX100(50, 100)], [4268, 1948, 0, 50]);
  assert.deepEqual([hoursX100(63075), hoursX100(30), hoursX100(29)], [1051, 1, 0], '0.5 rounds up');
  assert.deepEqual([cents(63075), cents(6000), cents(3)], [89356, 8500, 4]);
  // The per-month minutes are the two rounded parts added, and so are the dollars: each part's
  // cents, so the parts shown add up to the total exactly.
  const o = run({ rollup: rollupOf([EXAMPLE]), synthesis: [groupOf(synthOf(EXAMPLE.key, { low: 30, mid: 45, high: 60, pct: 60 }))] }).opportunities[0];
  assert.equal(o?.dollars_per_month_cents.automatable, cents(1948) + cents(35284));
  assert.equal(o?.dollars_per_month_cents.today, cents(4268) + cents(58807));
});

test('no estimate: the work part is 0 and flagged; an exhausted group\'s processes carry synthesis_missing and their counted parts', () => {
  const p = proc('a', { counts: { authored_short: 10 } });
  const none = run({ rollup: rollupOf([p]), synthesis: [groupOf(synthOf('a', null))] }).opportunities[0];
  assert.deepEqual([none?.estimated, none?.flags, none?.per_month_x100.today], [null, ['estimate_missing'], perMonthX100(2000, 792)]);
  assert.equal(none?.formula.estimated, null);
  assert.match(none?.formula.total ?? '', /^today [\d.,]+ min\/mo = [\d.,]+ h\/mo = \$[\d.,]+\/mo \(email [\d.,]+ min\/mo = \$[\d.,]+; no work estimate\); /);
  assert.match(none?.formula.total ?? '', /\(counted email [\d.,]+ min\/mo = \$[\d.,]+; no work estimate\)$/);
  // With no estimate the range is the counted email alone, at both ends.
  assert.deepEqual([none?.range_per_month_x100, none?.range_cents], [
    { low: none?.per_month_x100.automatable, high: none?.per_month_x100.automatable },
    { low: none?.dollars_per_month_cents.automatable, high: none?.dollars_per_month_cents.automatable },
  ]);
  const missing = run({ rollup: rollupOf([p]), synthesis: [] }).opportunities[0];
  assert.deepEqual([missing?.synthesis, missing?.flags], [null, ['synthesis_missing', 'estimate_missing']]);
  assert.equal(missing?.counted.email_x100.today, 2000, 'still priced from the counts');
  // Under three occurrences no estimate is used, the model's or an override.
  const rare = proc('r', { occurrences: 2 });
  const est: EstimatesOverride = { version: 1, estimates: { r: { minutes_per_occurrence: { low: 10, mid: 20, high: 30 }, automatable_pct: 50, rationale: 'x' } } };
  assert.equal(run({ rollup: rollupOf([rare]), synthesis: [groupOf(synthOf('r', { low: 1, mid: 2, high: 3, pct: 10 }))], estimates: est }).opportunities[0]?.estimated, null);
  // An estimate outside the bounds in force now is not used.
  assert.equal(run({ rollup: rollupOf([p]), synthesis: [groupOf(synthOf('a', { low: 1, mid: 500, high: 600, pct: 10 }))] }).opportunities[0]?.estimated, null);
});

test('the override file beats the model estimate and says so; the model estimate is used for the keys it does not name', () => {
  const est: EstimatesOverride = { version: 1, estimates: { a: { minutes_per_occurrence: { low: 10, mid: 20, high: 30 }, automatable_pct: 40, rationale: 'Scott timed it.' } } };
  const opps = run({
    rollup: rollupOf([proc('a'), proc('b')]),
    synthesis: [groupOf(synthOf('a', { low: 30, mid: 45, high: 60, pct: 60 }), synthOf('b', { low: 30, mid: 45, high: 60, pct: 60 }))],
    estimates: est,
    files: { rates: 'config/effort-rates.json', estimates: 'config/estimates.json' },
  }).opportunities;
  const a = opps.find((o) => o.key === 'a');
  const b = opps.find((o) => o.key === 'b');
  assert.deepEqual([a?.estimated?.source, a?.estimated?.minutes_per_occurrence.mid, a?.estimated?.basis, a?.flags], ['override', 20, 'override', ['estimate_override']]);
  assert.match(a?.formula.estimated ?? '', /^10\.00 occ x 20 min\/occ \(override, mid of 10-30, from config\/estimates\.json\) = 200\.00 min = .* automatable 40% \(override\)/);
  assert.deepEqual([b?.estimated?.source, b?.estimated?.minutes_per_occurrence.mid], ['model', 45]);
});

test('tiers from occurrences, active months and staff only, at each threshold edge', () => {
  const t = (occurrences: number, active_months: number, staff_participants: number) => tierOf({ occurrences, staff_participants, window: { active_months } }, scoring);
  assert.equal(t(40, 6, 3), 'A');
  assert.deepEqual([t(39, 6, 3), t(40, 5, 3), t(40, 6, 2)], ['B', 'B', 'B']);
  assert.equal(t(10, 3, 2), 'B');
  assert.deepEqual([t(9, 3, 2), t(10, 2, 2), t(10, 3, 1)], ['C', 'C', 'C']);
  const other: Scoring = { ...scoring, tiers: { A: { min_occurrences: 5, min_active_months: 1, min_staff: 1 }, B: { min_occurrences: 2, min_active_months: 1, min_staff: 1 } } };
  assert.equal(tierOf({ occurrences: 5, staff_participants: 1, window: { active_months: 1 } }, other), 'A', 'from the config, not constants');
});

test('ranking by automatable cents, ties by key; the headline over A+B with both parts, all tiers beside', () => {
  const procs = [proc('zeta', { occurrences: 50, counts: { chaser: 10 } }), proc('alpha', { occurrences: 50, counts: { chaser: 10 } }), proc('mid', { occurrences: 12, active_months: 3, staff: 2, counts: { chaser: 30 } }), proc('lead', { occurrences: 3, counts: { chaser: 100 } })];
  const r = run({ rollup: rollupOf(procs), synthesis: [groupOf(synthOf('alpha', { low: 5, mid: 10, high: 20, pct: 50 }))] });
  assert.deepEqual(r.opportunities.map((o) => [o.rank, o.key, o.tier]), [[1, 'lead', 'C'], [2, 'alpha', 'A'], [3, 'mid', 'B'], [4, 'zeta', 'A']]);
  const ab = r.opportunities.filter((o) => o.tier !== 'C');
  assert.equal(r.headline.tiers_ab_cents.total, ab.reduce((n, o) => n + o.dollars_per_month_cents.automatable, 0));
  assert.equal(r.headline.tiers_ab_cents.counted_email, ab.reduce((n, o) => n + cents(o.counted.email_per_month_x100.automatable), 0));
  assert.equal(r.headline.tiers_ab_cents.estimated_work, cents(r.opportunities.find((o) => o.key === 'alpha')?.estimated?.work_per_month_x100.automatable ?? 0));
  assert.equal(r.headline.all_tiers_cents.total, r.opportunities.reduce((n, o) => n + o.dollars_per_month_cents.automatable, 0));
  assert.equal(r.headline.label, 'observed in 4 mailboxes, 1999-2002');
  assert.deepEqual(r.unassigned, { messages: 645, slugs: 1 });
  // Both blocks: the parts add up to the total exactly; the range brackets it; today and the hours
  // are the rows' sums.
  for (const [h, rows] of [[r.headline.tiers_ab_cents, ab], [r.headline.all_tiers_cents, r.opportunities]] as const) {
    assert.equal(h.total, h.counted_email + h.estimated_work);
    assert.ok(h.low <= h.total && h.total <= h.high, `${h.low} <= ${h.total} <= ${h.high}`);
    assert.equal(h.low, rows.reduce((n, o) => n + o.range_cents.low, 0));
    assert.equal(h.high, rows.reduce((n, o) => n + o.range_cents.high, 0));
    assert.equal(h.today, rows.reduce((n, o) => n + o.dollars_per_month_cents.today, 0));
    assert.deepEqual(h.hours_x100, {
      today: rows.reduce((n, o) => n + o.hours_per_month_x100.today, 0),
      automatable: rows.reduce((n, o) => n + o.hours_per_month_x100.automatable, 0),
    });
  }
  // A row without an estimate adds its automatable cents to both ends; alpha's estimate widens them.
  const zeta = r.opportunities.find((o) => o.key === 'zeta') as Opportunities['opportunities'][number];
  assert.deepEqual(zeta.range_cents, { low: zeta.dollars_per_month_cents.automatable, high: zeta.dollars_per_month_cents.automatable });
  const alpha = r.opportunities.find((o) => o.key === 'alpha') as Opportunities['opportunities'][number];
  assert.ok(alpha.range_cents.low < alpha.dollars_per_month_cents.automatable && alpha.dollars_per_month_cents.automatable < alpha.range_cents.high);
});

test('the artifact threshold: tier A or B only, at most the cap, at least the floor; the bar applies once set', () => {
  const procs = Array.from({ length: 12 }, (_, i) => proc(`p${String(i).padStart(2, '0')}`, { occurrences: 50, counts: { chaser: 10 * (i + 1) } }));
  procs.push(proc('lead', { occurrences: 2, counts: { chaser: 1000 } }));
  const eligible = (s: Scoring) => run({ rollup: rollupOf(procs), scoring: s }).opportunities.filter((o) => o.artifact_eligible).map((o) => o.key);
  const with_ = (bar: number | null) => ({ ...scoring, artifacts: { ...scoring.artifacts, min_automatable_cents: bar } });
  assert.deepEqual(eligible(with_(null)), ['p11', 'p10', 'p09', 'p08', 'p07', 'p06', 'p05', 'p04'], 'no bar: the top 8 of A/B; the tier C lead never');
  const all = run({ rollup: rollupOf(procs) }).opportunities;
  const cutoff = all.find((o) => o.key === 'p07')?.dollars_per_month_cents.automatable as number;
  assert.deepEqual(eligible(with_(cutoff)), ['p11', 'p10', 'p09', 'p08', 'p07'], 'the bar keeps five');
  assert.deepEqual(eligible(with_(10 ** 9)), ['p11', 'p10', 'p09'], 'nothing passes: the floor of three');
});

test('the artifact threshold with the committed config: 8,500 cents (one hour a month at $85) is eligible, 8,499 is not', () => {
  assert.deepEqual(scoring.artifacts, { min_automatable_cents: 8500, cap: 8, floor: 3 });
  // One month (months_x100 100), no email part: the work part alone sets the cents. 10 occurrences x
  // 10 min at 60% = 60.00 min/mo = 8,500 cents; 119.98 occurrences x 1 min at 50% = 59.99 min/mo =
  // 8,499 cents (59.99 x 8,500 / 6,000 = 8,498.58, rounded half up).
  const month = { span: 30, months_x100: 100 };
  const at = proc('at-bar', { occurrences: 10, ...month });
  const under = proc('under-bar', { occurrences: 120, share_x100: 11998, ...month });
  const over = ['over-a', 'over-b', 'over-c'].map((k) => proc(k, { occurrences: 50, ...month }));
  const estimate = (key: string, mid: number, pct: number) => synthOf(key, { low: mid, mid, high: mid, pct });
  const r = run({
    rollup: rollupOf([at, under, ...over]),
    synthesis: [groupOf(estimate('at-bar', 10, 60), estimate('under-bar', 1, 50), ...over.map((p) => estimate(p.key, 30, 60)))],
  });
  const cents_ = (key: string) => r.opportunities.find((o) => o.key === key)?.dollars_per_month_cents.automatable;
  assert.deepEqual([cents_('at-bar'), cents_('under-bar')], [8500, 8499]);
  assert.deepEqual(r.opportunities.filter((o) => o.artifact_eligible).map((o) => o.key), ['over-a', 'over-b', 'over-c', 'at-bar']);
  // The cap and the floor stand as before: twelve over the bar make eight; none over it, three.
  const many = Array.from({ length: 12 }, (_, i) => proc(`m${String(i).padStart(2, '0')}`, { occurrences: 50, ...month }));
  const manyRun = run({ rollup: rollupOf(many), synthesis: [groupOf(...many.map((p) => estimate(p.key, 30, 60)))] });
  assert.equal(manyRun.opportunities.filter((o) => o.artifact_eligible).length, 8);
  const thin = Array.from({ length: 5 }, (_, i) => proc(`t${i}`, { occurrences: 50, ...month, counts: { read: i + 1 } }));
  assert.deepEqual(run({ rollup: rollupOf(thin) }).opportunities.filter((o) => o.artifact_eligible).map((o) => o.key), ['t4', 't3', 't2']);
});

test('--rates changes only the email part, --estimates only the work part', () => {
  const synthesis = [groupOf(synthOf(EXAMPLE.key, { low: 30, mid: 45, high: 60, pct: 60 }))];
  const base = run({ rollup: rollupOf([EXAMPLE]), synthesis }).opportunities[0];
  const doubled = { ...rates, minutes: Object.fromEntries(ACTION_TYPES.map((t) => [t, rates.minutes[t] * 2])) as Record<ActionType, number> };
  const reRated = run({ rollup: rollupOf([EXAMPLE]), synthesis, rates: doubled }).opportunities[0];
  assert.deepEqual(reRated?.estimated, base?.estimated, 'the work part is untouched');
  assert.equal(reRated?.counted.email_x100.today, 2 * (base?.counted.email_x100.today ?? 0));
  const est: EstimatesOverride = { version: 1, estimates: { [EXAMPLE.key]: { minutes_per_occurrence: { low: 10, mid: 15, high: 20 }, automatable_pct: 30, rationale: 'x' } } };
  const reEstimated = run({ rollup: rollupOf([EXAMPLE]), synthesis, estimates: est }).opportunities[0];
  assert.deepEqual(reEstimated?.counted, base?.counted, 'the counted part is untouched');
  assert.notDeepEqual(reEstimated?.estimated, base?.estimated);
});

test('the total reads mid and automatable_pct of a synthesis estimate; low and high set only the range; the other numbers are copied for display', () => {
  // Which numeric fields of the validated record are read at all.
  const read = new Set<string>();
  const watch = <T extends object>(o: T, path: string): T =>
    new Proxy(o, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver) as unknown;
        // A field, not the length of a list being copied.
        if (typeof prop === 'string' && typeof v === 'number' && !(Array.isArray(target) && prop === 'length')) read.add(`${path}${prop}`);
        return typeof v === 'object' && v !== null ? watch(v as object, `${path}${String(prop)}.`) : v;
      },
    });
  const rec = synthOf(EXAMPLE.key, { low: 30, mid: 45, high: 60, pct: 60 });
  run({ rollup: rollupOf([EXAMPLE]), synthesis: [groupOf(watch(rec, ''))] });
  assert.deepEqual([...read].sort(), [
    'estimate_check.occurrences_cited',
    'estimate_check.senders_cited',
    'work_estimate.automatable_pct',
    'work_estimate.minutes_per_occurrence.high',
    'work_estimate.minutes_per_occurrence.low',
    'work_estimate.minutes_per_occurrence.mid',
  ]);
  // Of those, only mid and automatable_pct change the total, the rank, the tier, the eligibility or
  // the headline total; low and high set the range shown beside the total and nothing else.
  const numbers = (r: Opportunities) => {
    const o = r.opportunities[0] as Opportunities['opportunities'][number];
    const { low: _low, high: _high, ...headline } = r.headline.tiers_ab_cents;
    return [o.per_month_x100, o.hours_per_month_x100, o.dollars_per_month_cents, o.estimated?.work_per_month_x100, o.rank, o.tier, o.artifact_eligible, headline];
  };
  const baseRun = run({ rollup: rollupOf([EXAMPLE]), synthesis: [groupOf(rec)] });
  const display = { ...rec, work_estimate: { ...(rec.work_estimate as NonNullable<typeof rec.work_estimate>), minutes_per_occurrence: { low: 1, mid: 45, high: 480 } }, estimate_check: { occurrences_cited: 99, senders_cited: 99 } };
  const displayRun = run({ rollup: rollupOf([EXAMPLE]), synthesis: [groupOf(display)] });
  assert.deepEqual(numbers(displayRun), numbers(baseRun));
  const range = (r: Opportunities) => (r.opportunities[0] as Opportunities['opportunities'][number]).range_cents;
  assert.ok(range(displayRun).low < range(baseRun).low && range(displayRun).high > range(baseRun).high, 'the range follows low and high');
  assert.equal(modelEstimate(rec)?.minutes_per_occurrence.mid, 45);
});

test('the same inputs give the same bytes', () => {
  const inputs = { rollup: rollupOf([EXAMPLE, proc('b')]), synthesis: [groupOf(synthOf(EXAMPLE.key, { low: 30, mid: 45, high: 60, pct: 60 }))] };
  assert.equal(JSON.stringify(run(inputs)), JSON.stringify(run(inputs)));
});

// ---- The command ----

// A project whose rollup is current: an empty batch index, no merge, a hand-made rollup.
function project(): string {
  const root = join(tmp, `p${Math.random().toString(16).slice(2)}`);
  for (const dir of ['out/batches', 'out/synthesis', 'config']) mkdirSync(join(root, dir), { recursive: true });
  for (const f of ['effort-rates.json', 'scoring.json']) writeFileSync(join(root, 'config', f), readFileSync(join(repo, 'config', f)));
  writeFileSync(join(root, 'out', 'batches', 'index.json'), '[]');
  writeFileSync(join(root, 'out', 'synthesis', 'index.json'), '[]');
  writeFileSync(join(root, 'out', 'rollup.json'), JSON.stringify({ ...rollupOf([EXAMPLE, proc('b', { occurrences: 12, active_months: 3, staff: 2, counts: { chaser: 4 } })]), inputs: currentRollupInputs(root, extractionsSha(root)) }));
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
const read = (root: string, name: string) => JSON.parse(readFileSync(join(root, 'out', name), 'utf8')) as Opportunities;

test('score command: writes out/opportunities.json and the headline line; current until an input changes; byte-identical on rerun', () => {
  const root = project();
  assert.equal(scoreFreshness(root), 'missing');
  const r = capture(() => scoreCommand(root, []));
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.match(r.out[0] ?? '', /^score: tiers A\+B \$[\d,]+\.\d\d\/mo automatable \(counted email \$[\d,.]+ \+ estimated work \$0\.00\), all tiers \$[\d,.]+\/mo, observed in 4 mailboxes, 1999-2002; 2 opportunities \(1 A, 1 B, 0 C\); 2 estimates missing; wrote out\/opportunities\.json\.$/);
  assert.equal(scoreFreshness(root), 'current');
  const first = readFileSync(join(root, 'out', 'opportunities.json'));
  capture(() => scoreCommand(root, []));
  assert.ok(readFileSync(join(root, 'out', 'opportunities.json')).equals(first));
  const o = read(root, 'opportunities.json');
  assert.deepEqual([o.rates_file, o.estimates_file, o.inputs.estimates_sha], ['config/effort-rates.json', null, null]);
  writeFileSync(join(root, 'config', 'scoring.json'), JSON.stringify({ ...scoring, artifacts: { ...scoring.artifacts, cap: 7 } }));
  assert.equal(scoreFreshness(root), 'stale');
});

test('score command: --rates and --estimates write their own files and change only their part; config/estimates.json applies by default and fails loudly out of bounds', () => {
  const root = project();
  capture(() => scoreCommand(root, []));
  const base = read(root, 'opportunities.json');
  const alt = JSON.parse(readFileSync(join(repo, 'config', 'effort-rates.json'), 'utf8'));
  alt.minutes.chaser = 6;
  writeFileSync(join(root, 'config', 'alt-rates.json'), JSON.stringify(alt));
  const r = capture(() => scoreCommand(root, ['--rates', join(root, 'config', 'alt-rates.json')]));
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.match(r.out[0] ?? '', /wrote out\/opportunities\.alt-rates\.json\.$/);
  const reRated = read(root, 'opportunities.alt-rates.json');
  assert.deepEqual(read(root, 'opportunities.json'), base, 'the run\'s own file is untouched');
  assert.equal(reRated.rates_file, 'config/alt-rates.json');
  const bOf = (x: Opportunities) => x.opportunities.find((o) => o.key === 'b');
  assert.equal(bOf(reRated)?.counted.email_x100.today, 2 * (bOf(base)?.counted.email_x100.today ?? 0));

  const est = { version: 1, estimates: { b: { minutes_per_occurrence: { low: 10, mid: 20, high: 30 }, automatable_pct: 40, rationale: 'Timed by hand.' } } };
  writeFileSync(join(root, 'config', 'alt-estimates.json'), JSON.stringify(est));
  assert.equal(capture(() => scoreCommand(root, ['--estimates', join(root, 'config', 'alt-estimates.json')])).code, 0);
  const reEstimated = read(root, 'opportunities.alt-estimates.json');
  assert.deepEqual(bOf(reEstimated)?.counted, bOf(base)?.counted);
  assert.deepEqual([bOf(reEstimated)?.estimated?.source, bOf(base)?.estimated], ['override', null]);

  // A committed config/estimates.json applies by default and makes the old score stale.
  writeFileSync(join(root, 'config', 'estimates.json'), JSON.stringify(est));
  assert.equal(scoreFreshness(root), 'stale');
  capture(() => scoreCommand(root, []));
  assert.deepEqual([bOf(read(root, 'opportunities.json'))?.estimated?.source, read(root, 'opportunities.json').estimates_file], ['override', 'config/estimates.json']);
  writeFileSync(join(root, 'config', 'estimates.json'), JSON.stringify({ version: 1, estimates: { b: { ...est.estimates.b, automatable_pct: 95 } } }));
  const loud = capture(() => scoreCommand(root, []));
  assert.equal(loud.code, 1);
  assert.match(loud.err[0] ?? '', /^score: .*estimates\.json is invalid: - estimates\.b\.automatable_pct must be a whole percentage from 0 to 80, got 95/);
});

test('score command: an override for a process seen fewer than 3 times, or for no process, is ignored with one line each', () => {
  const root = project();
  const rollup = JSON.parse(readFileSync(join(root, 'out', 'rollup.json'), 'utf8')) as Rollup;
  rollup.processes.push(proc('rare', { occurrences: 2 }));
  writeFileSync(join(root, 'out', 'rollup.json'), JSON.stringify(rollup));
  const entry = { minutes_per_occurrence: { low: 10, mid: 20, high: 30 }, automatable_pct: 40, rationale: 'x' };
  writeFileSync(join(root, 'config', 'estimates.json'), JSON.stringify({ version: 1, estimates: { rare: entry, gone: entry } }));
  const r = capture(() => scoreCommand(root, []));
  assert.equal(r.code, 0, r.err.join('\n'));
  const notes = [
    'score: config/estimates.json sets an estimate for "rare", seen 2 times; an estimate needs at least 3 occurrences, so it is ignored.',
    'score: config/estimates.json names "gone", which is not a process of this rollup; it is ignored.',
  ];
  assert.deepEqual(r.err, notes);
  assert.equal(read(root, 'opportunities.json').opportunities.find((o) => o.key === 'rare')?.estimated, null);
  // The step itself returns them as notes and prints nothing: advance lists them in its steps, so
  // nothing reaches stderr ahead of its JSON.
  const step = capture(() => {
    const result = scoreStep(root);
    assert.deepEqual([result.notes, result.summary], [notes, r.out[0]]);
    return 0;
  });
  assert.deepEqual([step.out, step.err], [[], []]);
});

test('score command: refuses a stale rollup, alternative rates that change how actions are counted, and stray arguments', () => {
  const root = project();
  const alt = JSON.parse(readFileSync(join(repo, 'config', 'effort-rates.json'), 'utf8'));
  alt.read_cap_per_message = 9;
  writeFileSync(join(root, 'config', 'alt-rates.json'), JSON.stringify(alt));
  assert.match(capture(() => scoreCommand(root, ['--rates', join(root, 'config', 'alt-rates.json')])).err[0] ?? '', /changes how actions are counted .* --rates may change minutes and automatable shares only/);
  assert.match(capture(() => scoreCommand(root, ['--rates'])).err[0] ?? '', /^score: unexpected argument "--rates"\. Usage: node obs\.mjs score \[--rates <file>\] \[--estimates <file>\]/);
  writeFileSync(join(root, 'config', 'effort-rates.json'), JSON.stringify({ ...alt, read_cap_per_message: 5, minutes: { ...alt.minutes, read: 3 } }));
  assert.deepEqual(capture(() => scoreCommand(root, [])).err, ['score: out/rollup.json is not current: run node obs.mjs rollup first.']);
  assert.ok(!existsSync(join(root, 'out', 'opportunities.json')));
});
