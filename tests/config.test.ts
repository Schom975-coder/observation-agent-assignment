import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_TYPES, ConfigError, loadEffortRates, loadScoring } from '../src/config.ts';

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

test('a file that is not JSON fails with the file name in the message', () => {
  const bad = join(tmp, 'bad.json');
  writeFileSync(bad, '{ not json');
  assert.throws(() => loadEffortRates(bad), (e: unknown) => e instanceof ConfigError && e.message.includes(bad));
});
