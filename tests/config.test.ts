import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_TYPES, ConfigError, loadEffortRates, loadEstimatesOverride, loadScoring } from '../src/config.ts';

const configDir = fileURLToPath(new URL('../config/', import.meta.url));
const ratesFile = join(configDir, 'effort-rates.json');
const scoringFile = join(configDir, 'scoring.json');

const tmp = mkdtempSync(join(tmpdir(), 'obs-config-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let copies = 0;

// A temp copy of a committed config with one change applied; returns its path.
function changed(file: string, change: (cfg: any) => void): string {
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  change(cfg);
  const out = join(tmp, `cfg-${copies++}.json`);
  writeFileSync(out, JSON.stringify(cfg));
  return out;
}

const configError = (pattern: RegExp) => (e: unknown) => e instanceof ConfigError && pattern.test(e.message);

test('committed effort rates load and cover every action type', () => {
  const rates = loadEffortRates(ratesFile);
  for (const type of ACTION_TYPES) {
    assert.ok(rates.minutes[type] > 0, type);
    assert.ok(rates.automatable_pct[type] >= 0 && rates.automatable_pct[type] <= 100, type);
    assert.ok(rates.rationale[type].length > 0, type);
  }
  assert.deepEqual(rates.priced_domains, ['enron.com']);
});

test('committed scoring config loads; the artifact bar is unset until the first full run', () => {
  const scoring = loadScoring(scoringFile);
  assert.equal(scoring.artifacts.min_automatable_cents, null);
  assert.ok(scoring.artifacts.floor <= scoring.artifacts.cap);
});

test('effort rates reject a missing action type', () => {
  const file = changed(ratesFile, (c) => delete c.minutes.chaser);
  assert.throws(() => loadEffortRates(file), configError(/minutes\.chaser/));
});

test('effort rates reject fractional minutes and percentages over 100', () => {
  const file = changed(ratesFile, (c) => {
    c.minutes.read = 1.5;
    c.automatable_pct.forward = 120;
  });
  assert.throws(() => loadEffortRates(file), configError(/minutes\.read[\s\S]*automatable_pct\.forward/));
});

test('effort rates reject an unknown action type', () => {
  const file = changed(ratesFile, (c) => (c.minutes.meeting = 30));
  assert.throws(() => loadEffortRates(file), configError(/minutes\.meeting is not an action type/));
});

test('effort rates reject a domain that is not lowercase', () => {
  const file = changed(ratesFile, (c) => (c.priced_domains = ['Enron.com']));
  assert.throws(() => loadEffortRates(file), configError(/priced_domains entry "Enron\.com"/));
});

test('scoring rejects a floor above the cap', () => {
  const file = changed(scoringFile, (c) => (c.artifacts.floor = 9));
  assert.throws(() => loadScoring(file), configError(/floor must not exceed/));
});

test('committed scoring config: the approved tiers, promotion minimum and estimate limits (M5 shape)', () => {
  const s = loadScoring(scoringFile);
  assert.deepEqual(s.tiers, { A: { min_occurrences: 40, min_active_months: 6, min_staff: 3 }, B: { min_occurrences: 10, min_active_months: 3, min_staff: 2 } });
  assert.deepEqual(s.merge.promote_min, { messages: 3, occurrences: 3, threads: 2, active_months: 2 });
  assert.deepEqual(s.estimates, { max_minutes_per_occurrence: 480, max_automatable_pct: 80, min_occurrences: 3, min_evidence: 3, max_evidence: 12, min_senders: 2 });
  assert.deepEqual(s.artifacts, { min_automatable_cents: null, cap: 8, floor: 3 });
});

test('scoring rejects the M4 shape, naming the keys that are missing and the ones that are not settings', () => {
  const m4 = join(tmp, 'm4-scoring.json');
  writeFileSync(m4, JSON.stringify({ version: 1, tiers: { A: { min_occurrences: 10, min_participants: 3 }, B: { min_occurrences: 5 } }, artifacts: { min_automatable_cents: null, cap: 8, floor: 3 } }));
  assert.throws(() => loadScoring(m4), (e: unknown) => {
    assert.ok(e instanceof ConfigError);
    for (const expected of [
      'tiers.A.min_active_months is missing',
      'tiers.A.min_staff is missing',
      'tiers.A.min_participants is not a setting here',
      'tiers.B.min_active_months is missing',
      'merge is missing',
      'estimates is missing',
    ]) {
      assert.ok(e.message.includes(expected), `${expected} in ${e.message}`);
    }
    return true;
  });
});

test('scoring rejects a B rule above the A rule, non-integers, unknown settings and an unbounded estimate share', () => {
  for (const k of ['min_occurrences', 'min_active_months', 'min_staff']) {
    const file = changed(scoringFile, (c) => (c.tiers.B[k] = c.tiers.A[k] + 1));
    assert.throws(() => loadScoring(file), configError(new RegExp(`tiers\\.B\\.${k} must not exceed tiers\\.A\\.${k}`)), k);
  }
  assert.throws(() => loadScoring(changed(scoringFile, (c) => (c.merge.promote_min.threads = 2.5))), configError(/merge\.promote_min\.threads must be a whole number/));
  assert.throws(() => loadScoring(changed(scoringFile, (c) => (c.estimates.max_minutes_per_occurrence = '480'))), configError(/estimates\.max_minutes_per_occurrence must be a whole number/));
  assert.throws(() => loadScoring(changed(scoringFile, (c) => (c.estimates.max_automatable_pct = 101))), configError(/max_automatable_pct must be at most 100/));
  assert.throws(() => loadScoring(changed(scoringFile, (c) => (c.estimates.min_evidence = 13))), configError(/min_evidence must not exceed estimates\.max_evidence/));
  assert.throws(() => loadScoring(changed(scoringFile, (c) => (c.tiers.A.min_hours = 1))), configError(/tiers\.A\.min_hours is not a setting here/));
  assert.throws(() => loadScoring(changed(scoringFile, (c) => (c.weights = {}))), configError(/weights is not a setting here/));
});

test('the estimates override: E1 bounds on every entry, strict keys, ConfigError otherwise', () => {
  const bounds = loadScoring(scoringFile).estimates;
  const file = (estimates: unknown, extra: Record<string, unknown> = {}) => {
    const out = join(tmp, `est-${copies++}.json`);
    writeFileSync(out, JSON.stringify({ version: 1, estimates, ...extra }));
    return out;
  };
  const good = { minutes_per_occurrence: { low: 30, mid: 45, high: 60 }, automatable_pct: 60, rationale: 'Pull the meter list, reconcile, send the summary.' };
  assert.deepEqual(loadEstimatesOverride(file({ 'gas-nomination-handling': good }), bounds).estimates['gas-nomination-handling'], good);
  assert.deepEqual(loadEstimatesOverride(file({}), bounds).estimates, {});
  const bad: Array<[unknown, RegExp]> = [
    [{ ...good, minutes_per_occurrence: { low: 50, mid: 45, high: 60 } }, /1 <= low <= mid <= high <= 480, got 50\/45\/60/],
    [{ ...good, minutes_per_occurrence: { low: 30, mid: 45, high: 481 } }, /<= 480, got 30\/45\/481/],
    [{ ...good, minutes_per_occurrence: { low: 0, mid: 45, high: 60 } }, /1 <= low/],
    [{ ...good, minutes_per_occurrence: { low: 30, mid: 45.5, high: 60 } }, /whole minutes/],
    [{ ...good, automatable_pct: 81 }, /automatable_pct must be a whole percentage from 0 to 80, got 81/],
    [{ ...good, automatable_pct: 100 }, /from 0 to 80/],
    [{ ...good, rationale: '' }, /rationale must say why/],
    [{ ...good, source: 'me' }, /source is not a setting here/],
    [{ minutes_per_occurrence: { low: 30, mid: 45, high: 60 }, automatable_pct: 60 }, /rationale is missing/],
  ];
  for (const [entry, pattern] of bad) assert.throws(() => loadEstimatesOverride(file({ 'some-process': entry }), bounds), configError(pattern), JSON.stringify(entry));
  assert.throws(() => loadEstimatesOverride(file({ 'Bad Key': good }), bounds), configError(/"Bad Key" is not a process key/));
  assert.throws(() => loadEstimatesOverride(file({}, { version: 2 }), bounds), configError(/version must be 1/));
});

test('a file that is not JSON fails with the file name in the message', () => {
  const bad = join(tmp, 'bad.json');
  writeFileSync(bad, '{ not json');
  assert.throws(() => loadEffortRates(bad), (e: unknown) => e instanceof ConfigError && e.message.includes(bad));
});
