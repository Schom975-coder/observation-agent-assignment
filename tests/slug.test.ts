// The one slug function (CLAUDE.md, "Same output on every OS"): a name built from model output is
// valid on Windows, macOS and Linux, and a process key comes back unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_SLUG, SLUG_MAX_CHARS, isReservedName, slugify } from '../src/util/slug.ts';

test('a process key comes back unchanged', () => {
  for (const key of ['realtime-schedule-checkout', 'gas-nomination-handling', 'p-and-l-review', 'abc', 'q4-2001-close']) assert.equal(slugify(key), key);
});

test('Windows reserved device names get the p- prefix, in any case', () => {
  const cases: Array<[string, string]> = [
    ['CON', 'p-con'],
    ['nul', 'p-nul'],
    ['Aux', 'p-aux'],
    ['prn', 'p-prn'],
    ['com1', 'p-com1'],
    ['COM9', 'p-com9'],
    ['lpt9', 'p-lpt9'],
    ['LPT1', 'p-lpt1'],
    ['con.', 'p-con'],
    [' nul ', 'p-nul'],
  ];
  for (const [name, slug] of cases) assert.equal(slugify(name), slug, name);
  // Only the whole name is reserved: these are ordinary names.
  for (const name of ['console', 'com10', 'lpt0', 'con-desk', 'aux-power']) assert.equal(slugify(name), name);
  assert.equal(isReservedName('Com3'), true);
});

test('spaces, dots and the characters Windows forbids become single hyphens, none leading or trailing', () => {
  assert.equal(slugify('Gas Nomination: Daily / Weekly?'), 'gas-nomination-daily-weekly');
  assert.equal(slugify('a\\b/c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
  assert.equal(slugify('..trailing dots and spaces.. '), 'trailing-dots-and-spaces');
  assert.equal(slugify('--many---hyphens--'), 'many-hyphens');
  assert.equal(slugify('P&L\tReview\r\nQ4'), 'p-l-review-q4');
  for (const s of ['Gas Nomination: Daily / Weekly?', '..x..', 'a  b']) assert.match(slugify(s), /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});

test('accents are folded; other scripts drop out', () => {
  assert.equal(slugify('Café Réconciliation'), 'cafe-reconciliation');
  assert.equal(slugify('Ångström naïve façade'), 'angstrom-naive-facade');
  assert.equal(slugify('日本 power desk'), 'power-desk');
});

test(`longer than ${SLUG_MAX_CHARS} characters is cut at a hyphen, or where the limit falls in one long word`, () => {
  const long = 'confirming-and-correcting-hourly-power-schedules-with-the-iso';
  const slug = slugify(long);
  assert.ok(slug.length <= SLUG_MAX_CHARS, slug);
  assert.equal(slug, 'confirming-and-correcting-hourly-power-schedules');
  assert.equal(slugify('x'.repeat(60)), 'x'.repeat(SLUG_MAX_CHARS));
  assert.equal(slugify(`${'a'.repeat(47)}-bcd`), 'a'.repeat(47), 'no trailing hyphen after the cut');
});

test(`a text with no letter or digit is ${EMPTY_SLUG}`, () => {
  for (const s of ['', '   ', '---', '?*:', '日本']) assert.equal(slugify(s), EMPTY_SLUG, JSON.stringify(s));
});

test('slugify is idempotent', () => {
  for (const s of ['CON', '', 'Gas Nomination: Daily', 'confirming-and-correcting-hourly-power-schedules-with-the-iso', 'x'.repeat(60), 'Café', 'p-con', 'lpt9.']) {
    const once = slugify(s);
    assert.equal(slugify(once), once, JSON.stringify(s));
  }
});
