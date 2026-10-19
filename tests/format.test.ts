// The one formatter (src/report/format.ts): money needs its kind, whole-dollar parts add up to the
// whole-dollar total by the largest remainder, dates are read by slicing, and every code-written
// sentence comes out as the spec words it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScoring } from '../src/config.ts';
import * as F from '../src/report/format.ts';
import type { Kind } from '../src/report/types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

test('money needs its kind: counted, estimated or total; anything else throws', () => {
  assert.equal(F.money(205047, 'total'), '$2,050');
  assert.equal(F.money(53885, 'counted'), '$539');
  assert.equal(F.money(50, 'estimated'), '$1', 'half up');
  assert.equal(F.money(49, 'estimated'), '$0');
  assert.equal(F.money(0, 'total'), '$0');
  assert.equal(F.money(123456789, 'total'), '$1,234,568');
  assert.equal(F.moneyExact(26520, 'total'), '$265.20');
  assert.equal(F.moneyExact(205047, 'total'), '$2,050.47');
  assert.equal(F.moneyExact(5, 'counted'), '$0.05');
  for (const bad of [undefined, null, 'cents', 'Counted', '']) {
    assert.throws(() => F.money(100, bad as unknown as Kind), /needs its kind/);
    assert.throws(() => F.moneyExact(100, bad as unknown as Kind), /needs its kind/);
  }
  assert.throws(() => F.money(10.5, 'total'), /whole number/);
});

test('hours, minutes, counts, times, plurals and percents', () => {
  assert.equal(F.hours(312), '3.1');
  assert.equal(F.hours(2412), '24.1');
  assert.equal(F.hours(2415), '24.2', 'half up');
  assert.equal(F.hours(0), '0.0');
  assert.equal(F.hours(123456), '1,234.6');
  assert.equal(F.minutes(16659), '166.59');
  assert.equal(F.minutes(238000), '2,380.00');
  assert.equal(F.minutes(5), '0.05');
  assert.equal(F.count(1827), '1,827');
  assert.equal(F.count(3240), '3,240');
  assert.equal(F.count(999), '999');
  assert.equal(F.times(61), '61 times');
  assert.equal(F.times(1), '1 time');
  assert.equal(F.plural(1, 'email'), '1 email');
  assert.equal(F.plural(2, 'process', 'processes'), '2 processes');
  assert.equal(F.pct(779, 2050), '38%');
  assert.equal(F.pct(1, 2), '50%', 'half up');
  assert.equal(F.pct(5, 0), '0%', 'no whole: 0%');
  assert.equal(F.percentTenths(44, 52), '84.6%');
  assert.equal(F.minutesOfSeconds(488), '8.1');
});

test('dates are read from the stored UTC string by slicing; no usable date says so', () => {
  assert.equal(F.date('2001-06-12T17:59:47Z'), '12 Jun 2001');
  assert.equal(F.date('2002-02-06T23:14:02Z'), '6 Feb 2002');
  assert.equal(F.date(null), 'no usable date');
  assert.equal(F.date('not a date'), 'no usable date');
  assert.equal(F.dateTime('2001-06-12T17:59:47Z'), '12 Jun 2001, 17:59 UTC');
  assert.equal(F.dateTime(null), 'no usable date');
  assert.equal(F.month('2001-06'), 'June 2001');
  assert.equal(F.month('1999-12-13T10:19:00Z'), 'December 1999');
  assert.equal(F.monthShort('2002-03'), 'Mar 2002');
  assert.equal(F.monthsSpanned('1999-12-13T10:19:00Z', '2002-03-25T23:13:29Z'), 28);
});

test('parts: whole dollars by the largest remainder add up to the whole-dollar total', () => {
  // This run's headline: naive rounding gives 539 + 1,512 = 2,051.
  assert.deepEqual(F.partDollars([53885, 151162], 205047), [539, 1511]);
  assert.deepEqual(F.parts([53885, 151162], 205047, ['counted', 'estimated']), ['$539', '$1,511']);
  // D = 527; the floors 27 + 499 = 526; the dollar left goes to the larger remainder, 86 over 60.
  assert.deepEqual(F.partDollars([2760, 49986], 52746), [27, 500]);
  // Ties go to the lower index.
  assert.deepEqual(F.partDollars([150, 150], 300), [2, 1]);
  assert.deepEqual(F.partDollars([0, 0], 0), [0, 0]);
  // Every split adds up, for many totals.
  for (let total = 0; total < 5000; total += 37) {
    for (const a of [0, 1, 49, 50, 51, 99, Math.floor(total / 3)]) {
      if (a > total) continue;
      const got = F.partDollars([a, total - a], total);
      assert.equal((got[0] as number) + (got[1] as number), Math.floor((total + 50) / 100), `${a} + ${total - a}`);
    }
  }
  assert.throws(() => F.parts([1, 2], 3, ['counted']), /one kind per part/);
  assert.throws(() => F.parts([1, 2], 3, ['counted', 'bogus' as Kind]), /needs its kind/);
  // A target the floors cannot reach is an error, never a silent mismatch.
  assert.throws(() => F.partDollars([100, 100], 50000), /cannot add up/);
  assert.throws(() => F.largestRemainder([500], 100, 3), /cannot add up/);
  assert.throws(() => F.largestRemainder([-5], 100, 0), /negative/);
});

test('largestRemainder against a shown total: rows to the headline, parts to a row, hours in tenths', () => {
  // Three rows of $610 shown, from cents; the running total is their prefix sum.
  assert.deepEqual(F.largestRemainder([23600, 20414, 17027], 100, 610), [236, 204, 170]);
  // A row shown one dollar up from its own rounding: its parts share the shown dollars.
  assert.deepEqual(F.partsOf([2760, 49986], 528, ['counted', 'estimated']), ['$28', '$500']);
  assert.deepEqual(F.partsOf([2760, 49986], 527, ['counted', 'estimated']), ['$27', '$500']);
  // Hours in hundredths, shown in tenths against the total's tenths.
  assert.deepEqual(F.largestRemainder([278, 240, 200], 10, 72), [28, 24, 20]);
  assert.equal(F.tenthsOfHours(241), '24.1');
  assert.equal(F.tenthsOfHours(3), '0.3');
});

test('share words', () => {
  assert.equal(F.shareWord(17, 37), 'about half');
  assert.equal(F.shareWord(26, 100), 'about a quarter');
  assert.equal(F.shareWord(35, 100), 'about a third');
  assert.equal(F.shareWord(65, 100), 'about two thirds');
  assert.equal(F.shareWord(74, 100), 'about three quarters');
  assert.equal(F.shareWord(80, 100), 'most');
  assert.equal(F.shareWord(5, 5), 'all');
  assert.equal(F.shareWord(0, 5), 'none');
  assert.equal(F.shareWord(3, 37), '3 of 37');
});

test('the code-written sentences', () => {
  assert.equal(
    F.seenSentence({ occurrences: 61, span_days: 232, active_months: 8, first_utc: '2001-06-12T17:59:47Z', last_utc: '2002-01-29T20:25:33Z', messages: 71 }),
    'Seen 61 times over 232 days (8 active months), 12 Jun 2001 to 29 Jan 2002, in 71 emails.',
  );
  assert.equal(F.seenSentence({ occurrences: 1, span_days: 0, active_months: 0, first_utc: null, last_utc: null, messages: 1 }), 'Seen 1 time, with no usable date, in 1 email.');
  assert.equal(
    F.concentrationSentence({ rows: 17, of: 37, worth: '$1,500', total: '$2,050' }),
    'About half of the processes in the total (17 of 37, worth $1,500 of the $2,050) draw 90% or more of their messages from one mailbox.',
  );
  assert.equal(F.concentrationSentence({ rows: 30, of: 37, worth: '$1,900', total: '$2,050' }).startsWith('Most of the processes in the total (30 of 37'), true);
  assert.equal(F.concentrationSentence({ rows: 1, of: 37, worth: '$90', total: '$2,050' }), '1 of the 37 processes in the total, worth $90 of the $2,050, draws 90% or more of its messages from one mailbox.');
  assert.equal(F.concentrationSentence({ rows: 0, of: 37, worth: '$0', total: '$2,050' }), 'No process in the total draws 90% or more of its messages from one mailbox.');
  assert.equal(F.cautionSentence({ drafted_one: 6, drafted: 6 }), 'All 6 processes with documents come almost only from one person’s mailbox. Read each finding as what one person’s mail shows.');
  assert.equal(F.cautionSentence({ drafted_one: 4, drafted: 6 }), '4 of the 6 processes with documents come almost only from one person’s mailbox. Read each finding as what one person’s mail shows.');
  assert.equal(F.cautionSentence({ drafted_one: 1, drafted: 6 }).startsWith('1 of the 6 processes with documents comes almost only'), true);
  assert.equal(F.cautionSentence({ drafted_one: 0, drafted: 6 }).startsWith('None of the 6 processes with documents comes almost only'), true);
  assert.equal(F.cautionSentence({ drafted_one: 1, drafted: 1 }).startsWith('The one process with a document comes almost only'), true);
  assert.equal(F.cautionSentence({ drafted_one: 0, drafted: 0 }), 'Read each finding as what one person’s mail shows.');
  assert.equal(F.scopeLabel({ mailboxes: 4, first_utc: '1999-12-13T10:19:00Z', last_utc: '2002-03-25T23:13:29Z' }), 'observed in 4 mailboxes, 1999-2002');
  assert.equal(F.scopeLabel({ mailboxes: 1, first_utc: '2001-01-15T10:00:00Z', last_utc: '2001-11-15T10:00:00Z' }), 'observed in 1 mailbox, 2001');
  assert.equal(F.scopeLine({ mailboxes: 4, first_utc: '1999-12-13T10:19:00Z', last_utc: '2002-03-25T23:13:29Z' }), 'Found in the email of 4 employees, December 1999 to March 2002.');
  assert.equal(F.rangeSentence(121365, 418341), 'The estimates put it between $1,214 and $4,183.');
  assert.equal(F.splitSentence(53885, 151162), 'About a quarter is email time counted from the messages; about three quarters is hands-on work estimated from them.');
  assert.equal(F.splitSentence(5000, 0), 'All of it is email time counted from the messages; no hands-on work was estimated.');
  assert.equal(F.splitSentence(0, 5000), 'All of it is hands-on work estimated from the messages; no email time was counted.');
  assert.equal(F.splitSentence(0, 0), 'Nothing is counted or estimated yet.');
  assert.equal(F.noReplySentence(), 'There is no later message in these mailboxes; the answer may have come by phone or in mail we do not have.');
  assert.equal(F.readingSentence(22376, { minutes: 1, automatable_pct: 50 }), '$224 of the counted part is reading time: one published minute per staff addressee, half of it automatable.');
  assert.equal(F.averagingSentence(762, 28), 'Each process is averaged over the time it was seen, from its first email to its last: one seen over 7.6 months counts as 7.6 months of work, not the 28 months the archive spans.');
  assert.equal(F.averagingSentence(100, 28), 'Each process is averaged over the time it was seen, from its first email to its last: one seen over 1 month counts as 1 month of work, not the 28 months the archive spans.');
  assert.equal(F.averagingSentence(0, 0), 'Each process is averaged over the time it was seen, from its first email to its last.');
  assert.equal(
    F.thresholdSensitivity([{ low: 9000, mid: 9000, high: 9000 }, { low: 100, mid: 9000, high: 20000 }, { low: 1, mid: 2, high: 9000 }], 8500),
    '1 process clears it with every estimate at its low end, 2 at the middle, 3 at the high end.',
  );
  assert.equal(F.thresholdSensitivity([], null), 'There is no dollar bar, so every process in the total clears it.');
});

test('A14: the threshold sentence is written from config/scoring.json, word for word as the spec states it', () => {
  const scoring = loadScoring(join(root, 'config', 'scoring.json'));
  assert.equal(
    F.thresholdSentence(scoring),
    'We draft a working document for every process seen 10 or more times over 3 or more months by 2 or more staff whose automatable work is worth one hour a month ($85) or more.',
  );
  assert.equal(F.thresholdSentence({ ...scoring, artifacts: { ...scoring.artifacts, min_automatable_cents: 17000 } }).endsWith('worth two hours a month ($170) or more.'), true);
  assert.equal(F.thresholdSentence({ ...scoring, artifacts: { ...scoring.artifacts, min_automatable_cents: 5000 } }).endsWith('worth $50 a month or more.'), true);
  assert.equal(F.thresholdSentence({ ...scoring, artifacts: { ...scoring.artifacts, min_automatable_cents: null } }).endsWith('by 2 or more staff, up to 8.'), true);
});
