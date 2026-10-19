// The one formatter (ARCHITECTURE.md 5.10): every number string the dashboard and the report show is
// written here, from the integers the pipeline stores, and every sentence code writes about them is a
// function here, so the page and the report cannot drift. Money needs its kind (counted, estimated or
// total), so nothing estimated can be written as counted. Dates are read from the stored UTC strings
// by slicing: no date parsing, UTC always. Digit grouping is done by hand, not by the platform's
// locale data, so the same number gives the same text on every OS.
import type { Scoring } from '../config.ts';
import { CENTS_PER_HOUR } from '../metrics/score.ts';
import { roundHalfUp } from '../util/round.ts';
import type { Kind } from './types.ts';

export const KINDS: readonly Kind[] = ['counted', 'estimated', 'total'];

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

export class FormatError extends Error {
  override name = 'FormatError';
}

function needKind(kind: unknown): asserts kind is Kind {
  if (!KINDS.includes(kind as Kind)) throw new FormatError(`a money figure needs its kind (counted, estimated or total), got ${String(kind)}`);
}

function needInt(n: number, what: string): void {
  if (!Number.isInteger(n)) throw new FormatError(`${what} must be a whole number, got ${n}`);
}

// "1,827": thousands separated by commas, by hand.
function group(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Half up for either sign: -0.5 rounds to -1, as 0.5 rounds to 1.
const halfUp = (n: number, d: number): number => (n < 0 ? -roundHalfUp(-n, d) : roundHalfUp(n, d));

// "$2,050": whole dollars, half up.
export function money(cents: number, kind: Kind): string {
  needKind(kind);
  needInt(cents, 'cents');
  const d = halfUp(cents, 100);
  return d < 0 ? `-$${group(-d)}` : `$${group(d)}`;
}

// "$2,050.47"
export function moneyExact(cents: number, kind: Kind): string {
  needKind(kind);
  needInt(cents, 'cents');
  const a = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}$${group(Math.floor(a / 100))}.${String(a % 100).padStart(2, '0')}`;
}

// Whole dollars already rounded (a part from partDollars), with their kind.
export function dollars(whole: number, kind: Kind): string {
  needKind(kind);
  needInt(whole, 'dollars');
  return whole < 0 ? `-$${group(-whole)}` : `$${group(whole)}`;
}

// "24.1": hundredths of an hour to one decimal, half up.
export function hours(x100: number): string {
  needInt(x100, 'hundredths');
  const t = halfUp(x100, 10);
  const a = Math.abs(t);
  return `${t < 0 ? '-' : ''}${group(Math.floor(a / 10))}.${a % 10}`;
}

// "166.59": hundredths of a minute, two decimals.
export function minutes(x100: number): string {
  needInt(x100, 'hundredths');
  const a = Math.abs(x100);
  return `${x100 < 0 ? '-' : ''}${group(Math.floor(a / 100))}.${String(a % 100).padStart(2, '0')}`;
}

// Any hundredths with two decimals: "24.12" (hours), "59.50" (rounds after sharing).
export const hundredths = minutes;

// "84.6%": a share to one decimal, half up, from the counts.
export function percentTenths(part: number, whole: number): string {
  needInt(part, 'a part');
  needInt(whole, 'a whole');
  if (whole <= 0) return '0.0%';
  const t = halfUp(part * 1000, whole);
  return `${Math.floor(t / 10)}.${t % 10}%`;
}

// "8.1": seconds as minutes to one decimal, half up.
export function minutesOfSeconds(seconds: number): string {
  needInt(seconds, 'seconds');
  const t = halfUp(seconds, 6);
  return `${group(Math.floor(t / 10))}.${t % 10}`;
}

// "1,827"
export function count(n: number): string {
  needInt(n, 'a count');
  return n < 0 ? `-${group(-n)}` : group(n);
}

// "61 times", "1 time"
export const times = (n: number): string => (n === 1 ? '1 time' : `${count(n)} times`);

// "3 staff", "1 email", "2 emails"
export const plural = (n: number, one: string, many: string = `${one}s`): string => `${count(n)} ${n === 1 ? one : many}`;

// "38%": a whole percent, half up; "0%" when the whole is 0.
export function pct(part: number, whole: number): string {
  return `${pctValue(part, whole)}%`;
}
export function pctValue(part: number, whole: number): number {
  needInt(part, 'a part');
  needInt(whole, 'a whole');
  if (whole <= 0) return 0;
  return halfUp(part * 100, whole);
}

const STORED_DAY = /^(\d{4})-(\d{2})-(\d{2})/;
const STORED_TIME = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/;

// "12 Jun 2001"; "no usable date" for null.
export function date(utc: string | null): string {
  const m = utc === null ? null : STORED_DAY.exec(utc);
  if (m === null) return 'no usable date';
  return `${Number(m[3])} ${MONTHS_SHORT[Number(m[2]) - 1] ?? '?'} ${m[1]}`;
}

// "12 Jun 2001, 17:59 UTC"
export function dateTime(utc: string | null): string {
  const t = utc === null ? null : STORED_TIME.exec(utc);
  if (t === null) return date(utc);
  return `${date(utc)}, ${t[1]}:${t[2]} UTC`;
}

// "2001-06" -> "June 2001"
export function month(ym: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(ym);
  if (m === null) return ym;
  return `${MONTHS_LONG[Number(m[2]) - 1] ?? '?'} ${m[1]}`;
}

// "Jun 2001" from a stored UTC string or a "YYYY-MM" month.
export function monthShort(utcOrYm: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(utcOrYm);
  if (m === null) return utcOrYm;
  return `${MONTHS_SHORT[Number(m[2]) - 1] ?? '?'} ${m[1]}`;
}

// The largest remainder, in whole units (`unit`: 100 for cents to dollars, 10 for hundredths of an
// hour to tenths), against a target number of units: each value gets the floor of its units, and the
// units left over go one each to the values with the largest remainders, ties to the lower index.
// The result always adds up to the target; a target the floors cannot reach that way (below their
// sum, or more than one extra unit each) is an error, never a silent mismatch.
export function largestRemainder(values: readonly number[], unit: number, target: number): number[] {
  for (const v of values) {
    needInt(v, 'a part');
    if (v < 0) throw new FormatError(`a part must not be negative, got ${v}`);
  }
  needInt(unit, 'a unit');
  needInt(target, 'a target');
  const out = values.map((v) => Math.floor(v / unit));
  let left = target - out.reduce((s, x) => s + x, 0);
  if (left < 0 || left > values.length) throw new FormatError(`parts of ${values.join(' + ')} cannot add up to ${target} units of ${unit}`);
  const order = values.map((v, i) => ({ i, r: v - unit * Math.floor(v / unit) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const o of order) {
    if (left === 0) break;
    out[o.i] = (out[o.i] as number) + 1;
    left--;
  }
  const sum = out.reduce((s, x) => s + x, 0);
  if (sum !== target) throw new FormatError(`the parts add up to ${sum}, not ${target}`);
  return out;
}

// The whole-dollar parts of a total, by the largest remainder: D = round(total / 100); each part
// gets the floor of its dollars; the D - (sum of floors) dollars left go one each to the parts with
// the largest remainders, ties to the lower index. The parts add up to D, the whole-dollar total.
export const partDollars = (cents: readonly number[], totalCents: number): number[] => {
  needInt(totalCents, 'cents');
  return largestRemainder(cents, 100, halfUp(totalCents, 100));
};

// The parts as money strings, each with its kind: "$539", "$1,511" against "$2,050".
export function parts(cents: readonly number[], totalCents: number, kinds: readonly Kind[]): string[] {
  if (kinds.length !== cents.length) throw new FormatError('parts needs one kind per part');
  return partDollars(cents, totalCents).map((d, i) => dollars(d, kinds[i] as Kind));
}

// The parts as money strings against a whole-dollar total already shown (a row's dollars as the
// table shows them): they add up to it.
export function partsOf(cents: readonly number[], shownDollars: number, kinds: readonly Kind[]): string[] {
  if (kinds.length !== cents.length) throw new FormatError('parts needs one kind per part');
  return largestRemainder(cents, 100, shownDollars).map((d, i) => dollars(d, kinds[i] as Kind));
}

// "24.1" from tenths of an hour already rounded (a row's hours as the table shows them).
export function tenthsOfHours(tenths: number): string {
  needInt(tenths, 'tenths');
  const a = Math.abs(tenths);
  return `${tenths < 0 ? '-' : ''}${group(Math.floor(a / 10))}.${a % 10}`;
}

// ---- Words for shares ----

// "about half" (40% to 60%), "about a third", "about a quarter", "about two thirds", "about three
// quarters", "most" (over 75%), "all", "none"; otherwise "n of m".
export function shareWord(n: number, of: number): string {
  if (of <= 0 || n <= 0) return 'none';
  if (n >= of) return 'all';
  const p = (n * 100) / of;
  if (p > 75) return 'most';
  if (p >= 70) return 'about three quarters';
  if (p > 60) return 'about two thirds';
  if (p >= 40) return 'about half';
  if (p >= 30) return 'about a third';
  if (p >= 20) return 'about a quarter';
  return `${count(n)} of ${count(of)}`;
}

const isPhrase = (w: string): boolean => /^(?:about|most|all|none)/.test(w);
const cap = (s: string): string => (s === '' ? s : `${(s[0] as string).toUpperCase()}${s.slice(1)}`);
const smallNumber = (n: number): string => SMALL[n] ?? count(n);
// The verb for a count: "1 process clears", "4 processes clear".
const verb = (n: number, one: string, many: string): string => (n === 1 ? one : many);

// ---- Sentences built by code (section 2.2): the page and the report share them ----

export type SeenFacts = { occurrences: number; span_days: number; active_months: number; first_utc: string | null; last_utc: string | null; messages: number };

// "Seen 61 times over 232 days (8 active months), 12 Jun 2001 to 29 Jan 2002, in 71 emails."
export function seenSentence(r: SeenFacts): string {
  if (r.first_utc === null || r.last_utc === null) return `Seen ${times(r.occurrences)}, with no usable date, in ${plural(r.messages, 'email')}.`;
  return `Seen ${times(r.occurrences)} over ${plural(r.span_days, 'day')} (${plural(r.active_months, 'active month')}), ${date(r.first_utc)} to ${date(r.last_utc)}, in ${plural(r.messages, 'email')}.`;
}

// "About half of the processes in the total (17 of 37, worth $1,500 of the $2,050) draw 90% or more
// of their messages from one mailbox." `worth` and `total` are the dollar texts the page shows.
export function concentrationSentence(h: { rows: number; of: number; worth: string; total: string }): string {
  const word = shareWord(h.rows, h.of);
  const worth = `worth ${h.worth} of the ${h.total}`;
  if (word === 'none') return 'No process in the total draws 90% or more of its messages from one mailbox.';
  if (isPhrase(word)) return `${cap(word)} of the processes in the total (${count(h.rows)} of ${count(h.of)}, ${worth}) draw 90% or more of their messages from one mailbox.`;
  return `${count(h.rows)} of the ${count(h.of)} processes in the total, ${worth}, ${verb(h.rows, 'draws', 'draw')} 90% or more of ${verb(h.rows, 'its', 'their')} messages from one mailbox.`;
}

export const ONE_PERSON_CAUTION = 'Read each finding as what one person’s mail shows.';

// The caution about the documents: "All 6 processes with documents come almost only from one
// person’s mailbox. Read each finding as what one person’s mail shows."
export function cautionSentence(c: { drafted_one: number; drafted: number }): string {
  const d = c.drafted;
  const one = c.drafted_one;
  if (d === 0) return ONE_PERSON_CAUTION;
  const lead =
    one === d
      ? d === 1
        ? 'The one process with a document comes'
        : `All ${count(d)} processes with documents come`
      : one === 0
        ? d === 1
          ? 'The one process with a document does not come'
          : `None of the ${count(d)} processes with documents comes`
        : `${count(one)} of the ${count(d)} processes with documents ${verb(one, 'comes', 'come')}`;
  return `${lead} almost only from one person’s mailbox. ${ONE_PERSON_CAUTION}`;
}

// Whole hours in words for the drafting bar: "one hour", "two hours", "12 hours".
const hourWords = (n: number): string => (n === 1 ? 'one hour' : `${smallNumber(n)} hours`);

// "We draft a working document for every process seen 10 or more times over 3 or more months by 2
// or more staff whose automatable work is worth one hour a month ($85) or more."
export function thresholdSentence(scoring: Pick<Scoring, 'tiers' | 'artifacts'>): string {
  const b = scoring.tiers.B;
  const bar = scoring.artifacts.min_automatable_cents;
  const seen = `seen ${count(b.min_occurrences)} or more times over ${count(b.min_active_months)} or more months by ${count(b.min_staff)} or more staff`;
  if (bar === null) return `We draft a working document for every process ${seen}, up to ${count(scoring.artifacts.cap)}.`;
  const worth = bar % CENTS_PER_HOUR === 0 ? `${hourWords(bar / CENTS_PER_HOUR)} a month (${money(bar, 'total')})` : `${money(bar, 'total')} a month`;
  return `We draft a working document for every process ${seen} whose automatable work is worth ${worth} or more.`;
}

// "4 processes clear it with every estimate at its low end, 6 at the middle, 14 at the high end."
export function thresholdSensitivity(rows: ReadonlyArray<{ low: number; mid: number; high: number }>, bar: number | null): string {
  if (bar === null) return 'There is no dollar bar, so every process in the total clears it.';
  const n = (f: (r: { low: number; mid: number; high: number }) => number) => rows.filter((r) => f(r) >= bar).length;
  const low = n((r) => r.low);
  return `${plural(low, 'process', 'processes')} ${verb(low, 'clears', 'clear')} it with every estimate at its low end, ${count(n((r) => r.mid))} at the middle, ${count(n((r) => r.high))} at the high end.`;
}

// "Found in the email of 4 employees, December 1999 to March 2002."
export function scopeLine(scope: { mailboxes: number; first_utc: string; last_utc: string }): string {
  return `Found in the email of ${plural(scope.mailboxes, 'employee')}, ${month(scope.first_utc)} to ${month(scope.last_utc)}.`;
}

// The label printed beside every total: "observed in 4 mailboxes, 1999-2002".
export function scopeLabel(scope: { mailboxes: number; first_utc: string; last_utc: string }): string {
  const a = scope.first_utc.slice(0, 4);
  const b = scope.last_utc.slice(0, 4);
  const years = a === '' ? 'no usable dates' : a === b ? a : `${a}-${b}`;
  return `observed in ${plural(scope.mailboxes, 'mailbox', 'mailboxes')}, ${years}`;
}

// A share of money in words, else as a percent: "about a quarter", "12%".
function moneyShare(part: number, whole: number): string {
  const word = shareWord(part, whole);
  return isPhrase(word) ? word : pct(part, whole);
}

// "About a quarter is email time counted from the messages; about three quarters is hands-on work
// estimated from them." A part of nothing is said plainly.
export function splitSentence(counted: number, estimated: number): string {
  const total = counted + estimated;
  if (total <= 0) return 'Nothing is counted or estimated yet.';
  if (estimated <= 0) return 'All of it is email time counted from the messages; no hands-on work was estimated.';
  if (counted <= 0) return 'All of it is hands-on work estimated from the messages; no email time was counted.';
  return `${cap(moneyShare(counted, total))} is email time counted from the messages; ${moneyShare(estimated, total)} is hands-on work estimated from them.`;
}

// "The estimates put it between $1,214 and $4,183."
export const rangeSentence = (low: number, high: number): string => `The estimates put it between ${money(low, 'total')} and ${money(high, 'total')}.`;

export const NO_REPLY = 'There is no later message in these mailboxes; the answer may have come by phone or in mail we do not have.';
export const noReplySentence = (): string => NO_REPLY;

export const NOT_A_CONFIDENCE_INTERVAL = 'It is not a confidence interval.';

// "$224 of the counted part is reading time: one published minute per staff addressee, half of it
// automatable."
export function readingSentence(cents: number, read: { minutes: number; automatable_pct: number }): string {
  const minute = read.minutes === 1 ? 'one published minute' : `${smallNumber(read.minutes)} published minutes`;
  const share = read.automatable_pct === 50 ? 'half' : read.automatable_pct === 100 ? 'all' : `${read.automatable_pct}%`;
  return `${money(cents, 'counted')} of the counted part is reading time: ${minute} per staff addressee, ${share} of it automatable.`;
}

// Months to one decimal for the averaging sentence: "7.6 months", "1 month".
function monthsText(x100: number): string {
  const t = halfUp(x100, 10);
  return t === 10 ? '1 month' : t % 10 === 0 ? `${count(t / 10)} months` : `${tenthsOfHours(t)} months`;
}

// "Each process is averaged over the time it was seen, from its first email to its last: one seen
// over 7.6 months counts as 7.6 months of work, not the 28 months the archive spans." The example
// is a process's window (the span its counts are divided by).
export function averagingSentence(exampleMonthsX100: number, archiveMonths: number): string {
  const lead = 'Each process is averaged over the time it was seen, from its first email to its last';
  if (exampleMonthsX100 <= 0 || archiveMonths <= 0) return `${lead}.`;
  const m = monthsText(exampleMonthsX100);
  return `${lead}: one seen over ${m} counts as ${m} of work, not the ${plural(archiveMonths, 'month')} the archive spans.`;
}

// "20 processes seen too rarely to count ($167 a month), and 203 messages that fit no recurring
// process. Personal mail, newsletters, system notices and duplicates are read and set aside."
export function notIncludedSentence(belowRows: number, belowCents: number, unassigned: number): string {
  return (
    `${plural(belowRows, 'process', 'processes')} seen too rarely to count (${money(belowCents, 'total')} a month), and ${plural(unassigned, 'message')} that ${verb(unassigned, 'fits', 'fit')} no recurring process. ` +
    'Personal mail, newsletters, system notices and duplicates are read and set aside.'
  );
}

// The months from the first stored date's month to the last's, both counted: Dec 1999 to Mar 2002 is 28.
export function monthsSpanned(firstUtc: string, lastUtc: string): number {
  const a = Number(firstUtc.slice(0, 4)) * 12 + Number(firstUtc.slice(5, 7));
  const b = Number(lastUtc.slice(0, 4)) * 12 + Number(lastUtc.slice(5, 7));
  return b - a + 1;
}
