import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openCorpus } from '../src/corpus/reader.ts';
import { isLeapYear, parseDate, USABLE_WINDOW } from '../src/parse/dates.ts';
import type { DateStatus } from '../src/types.ts';

const usable = (utc: string) => ({ utc, status: 'usable' });
const unparseable = { utc: null, status: 'unparseable' };
const outOfRange = { utc: null, status: 'out_of_range' };
const missing = { utc: null, status: 'missing' };

function expectAll(cases: Array<[string | null, object]>): void {
  for (const [raw, expected] of cases) assert.deepEqual(parseDate(raw), expected, JSON.stringify(raw));
}

test("the corpus's usual shapes convert to UTC", () => {
  expectAll([
    ['Fri, 14 Dec 2001 08:11:23 -0800 (PST)', usable('2001-12-14T16:11:23Z')],
    ['Mon, 9 Jul 2001 10:05:00 -0700 (PDT)', usable('2001-07-09T17:05:00Z')],
    ['Mon, 12 Mar 2001 08:14:00 -0600 (CST)', usable('2001-03-12T14:14:00Z')],
    ['Thu, 1 Feb 2001 07:00:00 -0800 (PST)', usable('2001-02-01T15:00:00Z')],
    ['Thu, 01 Feb 2001 07:00:00 -0800', usable('2001-02-01T15:00:00Z')],
    ['14 Dec 2001 08:11:23 -0800', usable('2001-12-14T16:11:23Z')],
    ['Fri, 14 Dec 2001 08:11 -0800 (PST)', usable('2001-12-14T16:11:00Z')],
    ['Fri, 14 Dec 2001 08:11:23 +0000', usable('2001-12-14T08:11:23Z')],
    ['Fri, 14 Dec 2001 08:11:23 -0000', usable('2001-12-14T08:11:23Z')],
    ['Fri, 14 Dec 2001 08:11:23 +0530', usable('2001-12-14T02:41:23Z')],
  ]);
});

test('accepts RFC 2822 spelling variants: any case, extra blanks, comment without a space', () => {
  expectAll([
    ['FRI, 14 DEC 2001 08:11:23 -0800 (PST)', usable('2001-12-14T16:11:23Z')],
    ['fri, 14 dec 2001 08:11:23 -0800', usable('2001-12-14T16:11:23Z')],
    ['Fri,14 Dec 2001 08:11:23 -0800', usable('2001-12-14T16:11:23Z')],
    ['Fri,  14  Dec\t2001 08:11:23   -0800  (PST)', usable('2001-12-14T16:11:23Z')],
    ['Fri, 14 Dec 2001 08:11:23 -0800(PST)', usable('2001-12-14T16:11:23Z')],
    ['Fri, 14 Dec 2001 08:11:23 -0800 ()', usable('2001-12-14T16:11:23Z')],
    ['  Fri, 14 Dec 2001 08:11:23 -0800 (PST)\r', usable('2001-12-14T16:11:23Z')],
  ]);
});

test('the weekday is ignored, not checked against the date', () => {
  // 14 Dec 2001 was a Friday.
  assert.deepEqual(parseDate('Mon, 14 Dec 2001 08:11:23 -0800'), usable('2001-12-14T16:11:23Z'));
});

test('offsets carry the time across midnight, month ends, year ends and leap days', () => {
  expectAll([
    ['Mon, 31 Dec 2001 20:00:00 -0800 (PST)', usable('2002-01-01T04:00:00Z')],
    ['Tue, 1 Jan 2002 05:00:00 +0900', usable('2001-12-31T20:00:00Z')],
    ['Mon, 30 Apr 2001 23:30:00 -0700', usable('2001-05-01T06:30:00Z')],
    ['Mon, 28 Feb 2000 20:00:00 -0800', usable('2000-02-29T04:00:00Z')],
    ['Wed, 28 Feb 2001 20:00:00 -0800', usable('2001-03-01T04:00:00Z')],
    ['Wed, 1 Mar 2000 01:00:00 +0200', usable('2000-02-29T23:00:00Z')],
    ['Sat, 1 Jan 2000 00:00:00 +1400', usable('1999-12-31T10:00:00Z')],
    ['Fri, 31 Dec 1999 23:59:59 -1459', usable('2000-01-01T14:58:59Z')],
  ]);
});

test('leap years follow the Gregorian century rule', () => {
  expectAll([
    ['Tue, 29 Feb 2000 12:00:00 -0800', usable('2000-02-29T20:00:00Z')],
    ['Thu, 29 Feb 2001 12:00:00 -0800', unparseable],
    ['Wed, 30 Feb 2000 12:00:00 -0800', unparseable],
    // Outside the window either way, but the status shows whether the day exists.
    ['Thu, 29 Feb 1900 12:00:00 +0000', unparseable],
    ['Wed, 28 Feb 1900 12:00:00 +0000', outOfRange],
    ['Tue, 29 Feb 2400 12:00:00 +0000', outOfRange],
  ]);
  for (const [year, leap] of [[1900, false], [1996, true], [2000, true], [2001, false], [2004, true], [2100, false], [2400, true]] as const) {
    assert.equal(isLeapYear(year), leap, String(year));
  }
});

test('days past the end of the month are rejected, never rolled into the next month', () => {
  expectAll([
    ['Tue, 31 Apr 2001 10:00:00 -0700', unparseable],
    ['Sun, 31 Jun 2001 10:00:00 -0700', unparseable],
    ['Mon, 31 Sep 2001 10:00:00 -0700', unparseable],
    ['Sat, 31 Nov 2001 10:00:00 -0800', unparseable],
    ['Mon, 32 Jan 2001 10:00:00 -0800', unparseable],
    ['Mon, 0 Jan 2001 10:00:00 -0800', unparseable],
    ['Mon, 00 Jan 2001 10:00:00 -0800', unparseable],
    ['Mon, 30 Apr 2001 10:00:00 -0700', usable('2001-04-30T17:00:00Z')],
    ['Tue, 31 Jul 2001 10:00:00 -0700', usable('2001-07-31T17:00:00Z')],
  ]);
});

test("a replica of the corpus's bad date is unparseable, and so is each of its faults alone", () => {
  expectAll([
    ['Tues, 32 Febuary 2001 25:61:00', unparseable],
    ['Tue, 32 Feb 2001 10:00:00 -0800', unparseable],
    ['Tue, 13 Febuary 2001 10:00:00 -0800', unparseable],
    ['Tue, 13 Feb 2001 25:00:00 -0800', unparseable],
    ['Tue, 13 Feb 2001 10:61:00 -0800', unparseable],
    ['Tue, 13 Feb 2001 10:00:60 -0800', unparseable],
    ['Tue, 13 Feb 2001 10:00:00', unparseable],
    // RFC 2822 weekdays are three letters; a longer one means the header was not machine-written.
    ['Tues, 13 Feb 2001 10:00:00 -0800', unparseable],
  ]);
});

test('anything off the shape is unparseable', () => {
  expectAll([
    ['Tue, 13 Feb 2001 10:00:00 PST', unparseable],
    ['Tue, 13 Feb 2001 10:00:00 GMT', unparseable],
    ['Tue, 13 Feb 2001 10:00:00 Z', unparseable],
    ['Tue, 13 Feb 2001 10:00:00 -08:00', unparseable],
    ['Tue, 13 Feb 2001 10:00:00 -800', unparseable],
    ['Tue, 13 Feb 2001 10:00:00 +1500', unparseable],
    ['Tue, 13 Feb 2001 10:00:00 -0860', unparseable],
    ['Tue, 13 Feb 01 10:00:00 -0800', unparseable],
    ['Tue, 13 Feb 02001 10:00:00 -0800', unparseable],
    ['Tue, 13 Feb 2001 9:00:00 -0800', unparseable],
    ['Tue, 13 Feb 2001 10:00:00.5 -0800', unparseable],
    ['Tue, 113 Feb 2001 10:00:00 -0800', unparseable],
    ['Tue, 13 February 2001 10:00:00 -0800', unparseable],
    ['Tue, 13 Fbe 2001 10:00:00 -0800', unparseable],
    ['Tue 13 Feb 2001 10:00:00 -0800', unparseable],
    ['Xyz, 13 Feb 2001 10:00:00 -0800', unparseable],
    ['Tue, 13 Feb 2001 10:00:00 -0800 (PST) extra', unparseable],
    ['Tue, 13 Feb 2001 10:00:00 -0800 junk', unparseable],
    ['Tue, 13 Feb 2001 10:00:00 -0800 (PST', unparseable],
    ['Tue, 13 Feb 2001 10:00:00 -0800 ((PST))', unparseable],
    ['Date: Tue, 13 Feb 2001 10:00:00 -0800', unparseable],
    ['2001-02-13T10:00:00Z', unparseable],
    ['13/02/2001 10:00', unparseable],
    ['Tue, 13 Feb 2001 10:00:00 －0800', unparseable],
    ['Tue, ١٣ Feb 2001 10:00:00 -0800', unparseable],
  ]);
});

test('valid dates outside the usable window are out_of_range, edges included in the window', () => {
  assert.deepEqual(USABLE_WINDOW, { from: '1998-01-01T00:00:00Z', to: '2002-12-31T23:59:59Z' });
  expectAll([
    ['Wed, 12 Mar 2031 08:14:00 -0600 (CST)', outOfRange],
    // Year 1 is a real calendar date, so out_of_range rather than unparseable; never guessed as 2001.
    ['Sat, 26 Nov 0001 07:35:14 -0800 (PST)', outOfRange],
    ['Thu, 1 Jan 1998 00:00:00 +0000', usable('1998-01-01T00:00:00Z')],
    ['Tue, 31 Dec 2002 23:59:59 +0000', usable('2002-12-31T23:59:59Z')],
    ['Wed, 31 Dec 1997 23:59:59 +0000', outOfRange],
    ['Wed, 1 Jan 2003 00:00:00 +0000', outOfRange],
    // The window applies to the UTC instant, not the local date.
    ['Tue, 31 Dec 2002 20:00:00 -0800', outOfRange],
    ['Thu, 1 Jan 1998 05:00:00 +0600', outOfRange],
    ['Sat, 1 Jan 0000 00:00:00 +0100', outOfRange],
    ['Fri, 31 Dec 9999 23:00:00 -1400', outOfRange],
  ]);
});

test('no header or a blank one is missing', () => {
  expectAll([
    [null, missing],
    ['', missing],
    ['   ', missing],
    ['\t\r\n', missing],
  ]);
});

test('every day of the window, at both offset extremes, matches Date.UTC arithmetic', () => {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const times: Array<[number, number, number, string]> = [
    [0, 0, 0, '+1459'],
    [23, 59, 59, '-1459'],
    [12, 34, 56, '-0800'],
    [0, 30, 0, '+0100'],
  ];
  const DAY_MS = 86_400_000;
  const pad = (n: number) => String(n).padStart(2, '0');
  let checked = 0;
  for (let ms = Date.UTC(1997, 11, 25); ms <= Date.UTC(2003, 0, 7); ms += DAY_MS) {
    const day = new Date(ms); // date-ok: epoch ms
    const [y, mo, d] = [day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()];
    for (const [h, mi, s, offset] of times) {
      const offsetMin = (offset.startsWith('-') ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3)));
      const iso = new Date(Date.UTC(y, mo, d, h, mi, s) - offsetMin * 60_000).toISOString().replace('.000Z', 'Z'); // date-ok: epoch ms
      const expected = iso >= USABLE_WINDOW.from && iso <= USABLE_WINDOW.to ? usable(iso) : outOfRange;
      const raw = `${d} ${MONTHS[mo]} ${y} ${pad(h)}:${pad(mi)}:${pad(s)} ${offset}`;
      assert.deepEqual(parseDate(raw), expected, raw);
      checked++;
    }
  }
  assert.ok(checked > 7000);
});

// The Date header value from the header block (everything before the first empty line),
// unfolded; null when the message has none.
function dateHeader(message: string): string | null {
  const fields: string[] = [];
  for (const line of message.split(/\r?\n/)) {
    if (line === '') break;
    if (/^[ \t]/.test(line) && fields.length > 0) fields[fields.length - 1] += line;
    else fields.push(line);
  }
  const field = fields.find((f) => /^date:/i.test(f));
  return field === undefined ? null : field.slice('date:'.length);
}

// The design expected one out_of_range date (2031). Measured, there are two: the corpus also
// has an expense notice dated year 0001, an export fault in the original archive.
test('corpus: every message gets a status, and only the four known bad dates are unusable', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const counts: Record<DateStatus, number> = { usable: 0, missing: 0, unparseable: 0, out_of_range: 0 };
  const unusable: Record<string, DateStatus> = {};
  for (const [id, bytes] of openCorpus(root).readAll()) {
    const { utc, status } = parseDate(dateHeader(bytes.toString('utf8')));
    counts[status]++;
    if (status === 'usable') assert.match(utc as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, id);
    else unusable[id] = status;
  }
  assert.deepEqual(counts, { usable: 3236, missing: 1, unparseable: 1, out_of_range: 2 });
  assert.deepEqual(unusable, {
    'corpus/giron-d/sent/795.': 'missing',
    'corpus/lokay-m/inbox/50.': 'out_of_range',
    'corpus/lokay-m/inbox/74.': 'out_of_range',
    'corpus/williams-w3/inbox/142.': 'unparseable',
  });
});
