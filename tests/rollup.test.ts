// The rollup and the synthesis inputs without a model: counting on the merged membership (mapped,
// promoted and unassigned keys), occurrence shares, windows, email minutes split by share,
// participants, reply gaps, chasers, stall quotes, ownership conflicts, coverage, and the group
// files the synthesizers read; then the rollup command on a temp project.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evenSteps } from '../src/batch/digest.ts';
import { loadEffortRates, loadScoring } from '../src/config.ts';
import { GROUP_WORDS, NAME_MAX_WORDS, buildRollup, claimant, messageShares, nameTokens, ownershipConflict, rollupWithNotes, spanDays, windowMonthsX100 } from '../src/metrics/rollup.ts';
import { canonicalMergeTable, slugFacts } from '../src/model/merge.ts';
import { canonicalTaxonomy } from '../src/model/taxonomy.ts';
import { score, tierOf } from '../src/metrics/score.ts';
import { EVIDENCE_SAMPLE, OWNERSHIP_SAMPLE, SAMPLE_MIN_SENDERS, STALL_SAMPLE, SYNTH_GROUP_MAX, SYNTH_INPUT_MAX_TOKENS, buildSynthesisInputs } from '../src/model/synthesis-input.ts';
import { SELF_REPORTED_MIN_SENDERS } from '../src/model/synthesis.ts';
import { buildPeople } from '../src/normalize/people.ts';
import { buildThreads } from '../src/normalize/threads.ts';
import { parseMessage } from '../src/parse/message.ts';
import { batchJob, markDispatched, recordValidation } from '../src/run/ledger.ts';
import { currentMergeShas } from '../src/run/merge.ts';
import { RollupError, currentRollupInputs, rollupCommand, rollupFreshness } from '../src/run/rollup.ts';
import { gitBlobSha, sha256 } from '../src/util/hash.ts';
import { DAY_MS, HOUR_MS, utcMs } from '../src/util/time.ts';
import type { BatchEntry, MergeTable, ParsedMessage, Person, ProcessRollup, QuoteCheck, Rollup, SynthSidecar, Thread, ValidatedEvidence, ValidatedExtraction } from '../src/types.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'obs-rollup-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const rates = loadEffortRates(join(repo, 'config', 'effort-rates.json'));

// ---- Exact arithmetic ----

test('spanDays and windowMonthsX100: the documented cases', () => {
  assert.equal(spanDays('2001-06-05T10:00:00Z', '2001-06-05T23:00:00Z'), 1, 'the same day is one day');
  const day = (n: number) => new Date(Date.UTC(2001, 0, 1) + n * DAY_MS).toISOString().replace(/\.\d+Z$/, 'Z');
  assert.equal(spanDays(day(0), day(29)), 30);
  for (const [days, x100] of [[1, 100], [30, 100], [31, 102], [241, 792], [828, 2720], [487, 1600]] as const) assert.equal(windowMonthsX100(days), x100, `${days} days`);
});

test('messageShares: 1/k in hundredths, the remainder one each to the keys in sort order', () => {
  assert.deepEqual([...messageShares(['p'])], [['p', 100]]);
  assert.deepEqual([...messageShares(['q', 'p'])], [['p', 50], ['q', 50]]);
  assert.deepEqual([...messageShares(['r', 'p', 'q'])], [['p', 34], ['q', 33], ['r', 33]]);
  assert.deepEqual([...messageShares(['a', 'b', 'c', 'd', 'e', 'f', 'g'])].map(([, s]) => s), [15, 15, 14, 14, 14, 14, 14]);
  assert.equal([...messageShares(['a', 'b', 'c', 'd', 'e', 'f', 'g']).values()].reduce((a, b) => a + b, 0), 100);
  assert.deepEqual([...messageShares([])], []);
});

const claim = (person: string, date: string | null, n: number) => ({ message_id: `corpus/r/inbox/${70 + n}`, person, date_utc: date, quote: 'q' });
// Participants as the rollup lists them: an address, and the display name when the archive has one.
const PARTIES = [
  { email: 'ann.lee@enron.com', name: 'Ann Lee' },
  { email: 'bob.ray@enron.com', name: null },
  { email: 'william.ash@enron.com', name: 'Bill Ash' },
  { email: 'darron.c.giron@enron.com', name: null },
  { email: 'mary.poe@enron.com', name: 'Mary Poe' },
  { email: 'mary.smith@enron.com', name: 'Mary Smith' },
  { email: 'pat.oneal@calpine.com', name: "Pat O'Neal" },
];

test('ownershipConflict: different participants within 60 days conflict; the same one, or 61 days apart, does not', () => {
  assert.deepEqual(ownershipConflict([claim('Ann Lee', '2001-04-01T10:00:00Z', 1), claim('Bob Ray', '2001-04-02T10:00:00Z', 2)], PARTIES), {
    claims: [
      { person: 'Ann Lee', message_id: 'corpus/r/inbox/71', date_utc: '2001-04-01T10:00:00Z' },
      { person: 'Bob Ray', message_id: 'corpus/r/inbox/72', date_utc: '2001-04-02T10:00:00Z' },
    ],
  });
  assert.equal(ownershipConflict([claim('Ann Lee', '2001-04-01T10:00:00Z', 1), claim('ann  LEE.', '2001-04-02T10:00:00Z', 2)], PARTIES), null, 'the same person spelled differently');
  assert.equal(ownershipConflict([claim('Ann Lee', '2001-05-01T10:00:00Z', 1), claim('Bob Ray', '2001-07-01T10:00:00Z', 2)], PARTIES), null, '61 days apart');
  assert.notEqual(ownershipConflict([claim('Ann Lee', '2001-05-01T10:00:00Z', 1), claim('Bob Ray', '2001-06-30T10:00:00Z', 2)], PARTIES), null, 'exactly 60 days');
  assert.equal(ownershipConflict([claim('Ann Lee', null, 1), claim('Bob Ray', '2001-04-02T10:00:00Z', 2)], PARTIES), null, 'an undated claim has no distance');
});

// The archive's people directory beyond the participants: people who never took part in the process.
const DIRECTORY = [
  ...PARTIES,
  { email: 'heidi.walker@enron.com', name: 'Heidi Walker' },
  { email: 'mary.jones@enron.com', name: null },
  { email: 'bill.stone@calpine.com', name: 'Bill Stone' },
];

test('ownershipConflict: a group claim never makes a conflict; a person counts whether or not they took part; spelling variants are one person', () => {
  const day = (d: number) => `2001-11-${String(d).padStart(2, '0')}T15:00:00Z`;
  const conflict = (a: string, b: string, people = DIRECTORY) => ownershipConflict([claim(a, day(1), 1), claim(b, day(2), 2)], PARTIES, people);
  // The planted pair's shape, with ordinary IDs: a first name in each of two messages a day apart,
  // each matching one participant of the process. Still a conflict.
  assert.deepEqual(ownershipConflict([claim('Bill', day(16), 1), claim('Darron', day(15), 2)], PARTIES, DIRECTORY)?.claims.map((c) => c.person), ['Darron', 'Bill']);
  // A claim that names a group, a role or a quantity of people is listed but never conflicts.
  for (const group of ['each trader', 'Volume Management group', 'the desk', 'the scheduling team', 'everyone on nights', '', 'C.']) {
    assert.equal(conflict('Ann Lee', group), null, JSON.stringify(group));
  }
  assert.notEqual(ownershipConflict([claim('Ann Lee', day(1), 1), claim('each trader', day(2), 2), claim('Bob', day(3), 3)], PARTIES, DIRECTORY), null, 'the people still do');
  // Someone in the directory who is not on this process's trail, and a name found only in a body
  // (in nobody's display name or address): each is a person, so each conflicts with Ann Lee.
  assert.notEqual(conflict('Ann Lee', 'Heidi Walker'), null, 'in the directory, not a participant');
  assert.notEqual(conflict('Ann Lee', 'Zed Quill'), null, 'a name only a message body carries');
  assert.notEqual(conflict('Ann Lee', 'Darren'), null, 'a first name nobody carries is still a name');
  assert.equal(conflict('Ann Lee', 'the night shift supervisor on call'), null, 'more than three words is a phrase, not a name');
  // Spelling variants of one person: display name, address, initials, punctuation, case; and two
  // spellings of one name nobody carries.
  for (const [a, b] of [['Darron', 'Darron C Giron'], ['Bill', 'William Ash'], ['Bill Ash', 'ASH, BILL'], ['Pat ONeal', "O'Neal"], ['Lee, Ann M.', 'ann'], ['Zed Quill', 'Zed'], ['Heidi', 'Heidi Walker']] as const) {
    assert.equal(conflict(a, b), null, `${a} / ${b}`);
  }
  // A first name two participants share could be either of them: never a conflict with the full
  // name of one; two full names are two people.
  assert.equal(conflict('Mary', 'Mary Smith'), null);
  assert.notEqual(conflict('Mary Poe', 'Mary Smith'), null);
});

test('claimant and nameTokens: the directory person sharing the most words, participants first on ties; else a name of one to three words', () => {
  assert.deepEqual(nameTokens("  Love, Phillip  M. O'Hara-Smith "), ['love', 'phillip', 'ohara', 'smith']);
  assert.deepEqual(nameTokens('darron.c.giron'), ['darron', 'giron']);
  // Participants win a tie with people who never took part; among participants all ties are kept.
  assert.deepEqual(claimant('Mary', PARTIES, DIRECTORY), { known: ['mary.poe@enron.com', 'mary.smith@enron.com'] });
  assert.deepEqual(claimant('Bill', PARTIES, DIRECTORY), { known: ['william.ash@enron.com'] }, 'not Bill Stone of Calpine');
  assert.deepEqual(claimant('Mary Smith', PARTIES, DIRECTORY), { known: ['mary.smith@enron.com'] }, 'the most shared words win');
  assert.deepEqual(claimant('Bob', PARTIES, DIRECTORY), { known: ['bob.ray@enron.com'] }, 'by the address when there is no display name');
  // The most shared words beat being a participant.
  assert.deepEqual(claimant('Bill Stone', PARTIES, DIRECTORY), { known: ['bill.stone@calpine.com'] });
  assert.deepEqual(claimant('Heidi', PARTIES, DIRECTORY), { known: ['heidi.walker@enron.com'] });
  assert.deepEqual(claimant('Zed  Quill.', PARTIES, DIRECTORY), { named: ['quill', 'zed'] });
  for (const none of ['each trader', 'all of us', 'the desk', 'Volume Management', 'C', 'one two three four']) assert.equal(claimant(none, PARTIES, DIRECTORY), null, none);
  assert.ok(GROUP_WORDS.includes('each') && GROUP_WORDS.includes('group') && NAME_MAX_WORDS === 3);
});

// ---- A small archive (ordinary IDs; replicas of the ownership trap with ordinary content) ----

type Mail = { n: number; subject: string; date: string | null; from: string; to: string[]; tags: string[]; body?: string };
const MAILS: Mail[] = [
  { n: 1, subject: 'Alpha report', date: 'Wed, 10 Jan 2001 09:00:00 -0600', from: 'ann.lee@enron.com', to: ['bob.ray@enron.com'], tags: ['alpha-work'] },
  { n: 2, subject: 'RE: Alpha report', date: 'Wed, 10 Jan 2001 11:00:00 -0600', from: 'bob.ray@enron.com', to: ['ann.lee@enron.com'], tags: ['alpha-work', 'beta-work'] },
  { n: 3, subject: 'RE: Alpha report', date: 'Wed, 10 Jan 2001 13:00:00 -0600', from: 'bob.ray@enron.com', to: ['ann.lee@enron.com'], tags: ['new:alpha-extra'] },
  { n: 4, subject: 'Alpha report', date: 'Thu, 15 Feb 2001 09:00:00 -0600', from: 'ann.lee@enron.com', to: ['bob.ray@enron.com'], tags: ['alpha-work'] },
  { n: 5, subject: 'Gamma check', date: 'Thu, 1 Mar 2001 09:00:00 -0600', from: 'carl@calpine.com', to: ['ann.lee@enron.com', 'dan.fox@enron.com'], tags: ['alpha-work', 'beta-work', 'gamma-work'] },
  { n: 6, subject: 'Alpha notes', date: null, from: 'ann.lee@enron.com', to: ['bob.ray@enron.com'], tags: ['alpha-work'] },
  { n: 7, subject: 'Imbalance check', date: 'Sun, 1 Apr 2001 09:00:00 -0500', from: 'ann.lee@enron.com', to: ['bob.ray@enron.com'], tags: ['beta-work'] },
  { n: 8, subject: 'Daily imbalance check', date: 'Mon, 2 Apr 2001 09:00:00 -0500', from: 'bob.ray@enron.com', to: ['ann.lee@enron.com'], tags: ['beta-work'] },
  { n: 9, subject: 'Gamma desk', date: 'Tue, 1 May 2001 09:00:00 -0500', from: 'ann.lee@enron.com', to: ['bob.ray@enron.com'], tags: ['gamma-work'] },
  { n: 10, subject: 'Gamma rota', date: 'Sun, 1 Jul 2001 09:00:00 -0500', from: 'bob.ray@enron.com', to: ['ann.lee@enron.com'], tags: ['gamma-work'] },
  { n: 11, subject: 'Delta one', date: 'Fri, 5 Jan 2001 09:00:00 -0600', from: 'eve.ng@enron.com', to: ['ann.lee@enron.com'], tags: ['new:delta-one'] },
  { n: 12, subject: 'Delta two', date: 'Mon, 5 Feb 2001 09:00:00 -0600', from: 'eve.ng@enron.com', to: ['ann.lee@enron.com'], tags: ['new:delta-two'] },
  { n: 13, subject: 'Delta three', date: 'Mon, 5 Mar 2001 09:00:00 -0600', from: 'eve.ng@enron.com', to: ['ann.lee@enron.com'], tags: ['new:delta-one'] },
  { n: 14, subject: 'Stray', date: 'Tue, 6 Mar 2001 09:00:00 -0600', from: 'eve.ng@enron.com', to: ['ann.lee@enron.com'], tags: ['new:stray'] },
  { n: 15, subject: 'Lunch', date: 'Wed, 7 Mar 2001 09:00:00 -0600', from: 'eve.ng@enron.com', to: ['ann.lee@enron.com'], tags: [] },
];
const idOf = (n: number) => `corpus/r/inbox/${String(n).padStart(2, '0')}`;
const bodyOf = (m: Mail) => m.body ?? `Please see the ${m.subject.replace(/^RE: /, '').toLowerCase()} for item ${m.n}, as discussed.`;
function raw(m: Mail): string {
  const head = [`Message-ID: <${m.n}.rollup@example.invalid>`, ...(m.date === null ? [] : [`Date: ${m.date}`]), `From: ${m.from}`, `To: ${m.to.join(', ')}`, `Subject: ${m.subject}`];
  return `${head.join('\r\n')}\r\n\r\n${bodyOf(m)}\n`;
}
const TEXTS = new Map(MAILS.map((m) => [idOf(m.n), raw(m)]));
const MESSAGES = new Map<string, ParsedMessage>(
  MAILS.map((m) => {
    const bytes = Buffer.from(raw(m), 'utf8');
    return [idOf(m.n), parseMessage(idOf(m.n), gitBlobSha(bytes), bytes)];
  }),
);
const THREADS = buildThreads([...MESSAGES.values()]);
const PEOPLE = buildPeople([...MESSAGES.values()], rates.priced_domains);
const TAXONOMY = canonicalTaxonomy(
  ['alpha-work', 'beta-work', 'gamma-work'].map((key) => ({ key, name: `${key[0]?.toUpperCase()}${key.slice(1, -5)} work`, definition: `The recurring ${key.slice(0, -5)} work of the desk.`, include: [], exclude: [], example_subjects: ['x'] })),
  'd'.repeat(64),
  'a'.repeat(64),
);

// A quote check located in the message body (the rollup reads only match, offsets and raw text).
function located(n: number, match: QuoteCheck['match'] = 'exact'): QuoteCheck {
  const text = TEXTS.get(idOf(n)) as string;
  const body = bodyOf(MAILS[n - 1] as Mail);
  const start = text.indexOf(body);
  return match === 'rejected'
    ? { match, start: null, end: null, segment: null, raw_text: null, reason: 'not_found' }
    : { match, start, end: start + body.length, segment: 'own', raw_text: body, reason: null };
}

// Two batches; every tag has an accepted quote; message 4's stall quote and one extra evidence quote
// were rejected; ownership claims on messages 7-10.
function validatedSet(): ValidatedExtraction[] {
  const batches: Record<string, number[]> = { 'batch-000': [1, 2, 3, 4, 5, 6, 7, 8], 'batch-001': [9, 10, 11, 12, 13, 14, 15] };
  const claims: Record<number, string> = { 7: 'Ann Lee', 8: 'Bob Ray', 9: 'Ann Lee', 10: 'Bob Ray' };
  return Object.entries(batches).map(([batch_id, ns]) => {
    const evidence: ValidatedEvidence[] = [];
    for (const n of ns) {
      for (const p of (MAILS[n - 1] as Mail).tags) {
        evidence.push({ evidence_id: `${batch_id}:e${evidence.length}`, process: p, message_id: idOf(n), field: 'body', quote: bodyOf(MAILS[n - 1] as Mail), note: 'n', ...located(n) });
      }
    }
    if (batch_id === 'batch-000') evidence.push({ evidence_id: `${batch_id}:e${evidence.length}`, process: 'alpha-work', message_id: idOf(1), field: 'body', quote: 'A quote the model made up.', note: 'n', ...located(1, 'rejected') });
    const stalled: number[] = ns.filter((n) => n === 1 || n === 4);
    const owned = ns.filter((n) => claims[n] !== undefined);
    return {
      batch_id,
      content_sha: sha256(batch_id),
      messages: ns.map((n) => {
        const m = MAILS[n - 1] as Mail;
        return {
          id: idOf(n),
          processes: m.tags,
          role: m.tags.length === 0 ? 'personal' : 'request',
          stall: stalled.includes(n) ? { kind: 'waiting_on_reply' as const, quote: bodyOf(m) } : null,
          ownership_claim: claims[n] === undefined ? null : { person: claims[n] as string, quote: bodyOf(m) },
        };
      }),
      evidence,
      stall_checks: stalled.map((n) => ({ message_id: idOf(n), ...located(n, n === 4 ? 'rejected' : 'exact') })),
      ownership_checks: owned.map((n) => ({ message_id: idOf(n), person: claims[n] as string, ...located(n) })),
      new_processes: [],
      batch_notes: '',
      quote_stats: { exact: 0, repaired: 0, rejected: 0 },
    };
  });
}
const VALIDATED = validatedSet();

const MERGE: MergeTable = {
  version: 1,
  extractions_sha: 'e',
  taxonomy_sha: 't',
  agent_sha: 'a',
  promote_min: { messages: 3, occurrences: 3, threads: 2, active_months: 2 },
  slugs: [
    { slug: 'new:alpha-extra', messages: 1, batches: 1, status: 'mapped', to: 'alpha-work', reason: null },
    { slug: 'new:delta-one', messages: 2, batches: 1, status: 'promoted', to: 'delta-one', reason: null },
    { slug: 'new:delta-two', messages: 1, batches: 1, status: 'alias', to: 'delta-one', reason: null },
    { slug: 'new:stray', messages: 1, batches: 1, status: 'unassigned', to: null, reason: null },
  ],
  promoted: [{ key: 'delta-one', name: 'Delta work', definition: 'The recurring delta work of the desk.', include: [], exclude: [], aliases: ['new:delta-one', 'new:delta-two'], messages: 3, occurrences: 3, threads: 3, active_months: 3 }],
  counts: { slugs: 4, mapped: 1, promoted: 1, aliases: 2, unassigned: 1, demoted: 0, messages_mapped: 1, messages_promoted: 3, messages_unassigned: 1 },
};
const SHAS = { extractions_sha: 'x', merge_sha: 'm', corpus_hash: 'c', rates_sha: 'r' };
const rollupOf = (overrides: Partial<Parameters<typeof buildRollup>[0]> = {}): Rollup =>
  buildRollup({ validated: VALIDATED, merge: MERGE, threads: THREADS, messages: MESSAGES, people: PEOPLE, rates, taxonomy: TAXONOMY, flagged: new Set(), shas: SHAS, ...overrides });
const ROLLUP = rollupOf();
const proc = (key: string) => ROLLUP.processes.find((p) => p.key === key) as ProcessRollup;
const at = (date: string): number => utcMs(date);

test('membership: a mapped new: key counts under its target, a promotion with two aliases is a process, an unassigned key counts nowhere', () => {
  assert.deepEqual(ROLLUP.processes.map((p) => [p.key, p.origin, p.message_ids.length]), [
    ['alpha-work', 'taxonomy', 6],
    ['beta-work', 'taxonomy', 4],
    ['delta-one', 'promoted', 3],
    ['gamma-work', 'taxonomy', 3],
  ]);
  assert.ok(proc('alpha-work').message_ids.includes(idOf(3)), 'new:alpha-extra counted under alpha-work');
  assert.deepEqual(proc('delta-one').message_ids, [idOf(11), idOf(12), idOf(13)]);
  assert.deepEqual(ROLLUP.unassigned, { messages: 1, message_ids: [idOf(14)], slugs: [{ slug: 'new:stray', messages: 1, status: 'unassigned', reason: null }] });
  assert.deepEqual(ROLLUP.coverage, { files: 15, unique: 15, classified: 15, tagged: 14, counted: 13, unassigned: 1, role_only: { personal: 1 } });
  const c = ROLLUP.coverage;
  assert.equal(c.counted + c.unassigned + Object.values(c.role_only).reduce((a, b) => a + b, 0), c.unique, 'every unique message ends somewhere, once');
});

test('occurrence shares: a whole round for a single tag, 50/50 and 34/33/33 for shared messages, the largest share per occurrence', () => {
  const alpha = proc('alpha-work');
  // Thread "alpha report": {alpha} and {alpha, beta} in one round -> alpha 100, beta 50; then a
  // second round (a fresh send in February); "gamma check": {alpha, beta, gamma} -> 34/33/33; one undated round.
  assert.deepEqual([alpha.occurrences, alpha.occurrence_share_x100, alpha.shared_occurrences], [4, 100 + 100 + 34 + 100, 1]);
  const beta = proc('beta-work');
  assert.deepEqual([beta.occurrences, beta.occurrence_share_x100, beta.shared_occurrences], [4, 50 + 33 + 100 + 100, 2]);
  assert.deepEqual([proc('gamma-work').occurrence_share_x100, proc('gamma-work').shared_occurrences], [33 + 100 + 100, 1]);
  assert.ok(alpha.flags.includes('shared_occurrences:1') && beta.flags.includes('shared_occurrences:2'));
});

test('the window: usable dates only, an undated message counted but not dated, active months and the monthly series', () => {
  const alpha = proc('alpha-work');
  assert.equal(alpha.window.first_utc, '2001-01-10T15:00:00Z');
  assert.equal(alpha.window.last_utc, '2001-03-01T15:00:00Z');
  assert.equal(alpha.window.span_days, 51);
  assert.equal(alpha.window.months_x100, windowMonthsX100(51));
  assert.deepEqual([alpha.window.active_months, alpha.window.undated_occurrences], [3, 1]);
  assert.ok(alpha.message_ids.includes(idOf(6)), 'the undated message is still a member');
  assert.ok(alpha.flags.includes('undated_occurrences:1'));
  assert.deepEqual(alpha.monthly, [
    { month: '2001-01', occurrences: 1, messages: 3 },
    { month: '2001-02', occurrences: 1, messages: 1 },
    { month: '2001-03', occurrences: 1, messages: 1 },
  ]);
  const undatedOnly = rollupOf({ messages: new Map([...MESSAGES].map(([id, m]) => [id, id === idOf(6) ? m : { ...m, date_utc: null, date_status: 'missing' as const }])) });
  const a = undatedOnly.processes.find((p) => p.key === 'alpha-work') as ProcessRollup;
  assert.deepEqual([a.window.first_utc, a.window.span_days, a.window.months_x100, a.flags.includes('undated_only')], [null, 0, 100, true]);
});

test('actions and email minutes: each type counted from its messages, priced only for staff, minutes split by share in hundredths', () => {
  const alpha = proc('alpha-work');
  assert.deepEqual(alpha.actions.priced, { authored_short: 4, authored_medium: 0, authored_long: 0, forward: 0, chaser: 1, read: 7 });
  assert.deepEqual(alpha.actions.unpriced, { authored_short: 1, authored_medium: 0, authored_long: 0, forward: 0, chaser: 0, read: 0 });
  assert.equal(alpha.chasers, 1);
  // Message 2 (shared with beta) at 50, message 5 (three keys) at 34, the rest whole; the
  // external sender of message 5 is not priced, its two staff readers are.
  const today = 2 * 100 + 1 * 100 + (2 * 50 + 1 * 50) + (3 * 100 + 1 * 100) + (2 * 100 + 1 * 100) + 2 * (1 * 34) + (2 * 100 + 1 * 100);
  const auto100 = 120 * 100 + 50 * 100 + (120 * 50 + 50 * 50) + (300 * 100 + 50 * 100) + (120 * 100 + 50 * 100) + 2 * (50 * 34) + (120 * 100 + 50 * 100);
  assert.deepEqual(alpha.email_x100, { today, automatable: Math.floor((2 * auto100 + 100) / 200) });
  const fromSources = alpha.action_sources.filter((s) => s.priced).reduce((n, s) => n + rates.minutes[s.type] * s.share_x100, 0);
  assert.equal(fromSources, today, 'the minutes tie to the action sources');
  assert.deepEqual(
    alpha.action_sources.filter((s) => s.message_id === idOf(5)),
    [
      { message_id: idOf(5), type: 'authored_short', person: 'carl@calpine.com', priced: false, share_x100: 34 },
      { message_id: idOf(5), type: 'read', person: 'ann.lee@enron.com', priced: true, share_x100: 34 },
      { message_id: idOf(5), type: 'read', person: 'dan.fox@enron.com', priced: true, share_x100: 34 },
    ],
  );
  // The whole of each shared message's minutes, over its processes, adds up to the message.
  const minutesOf = (key: string, id: string) => proc(key).action_sources.filter((s) => s.message_id === id && s.priced).reduce((n, s) => n + rates.minutes[s.type] * s.share_x100, 0);
  assert.equal(minutesOf('alpha-work', idOf(5)) + minutesOf('beta-work', idOf(5)) + minutesOf('gamma-work', idOf(5)), 2 * 100, 'two staff reads, 1 minute each');
});

test('participants: by actions with the staff flag and per-person counts; reply gaps; single source', () => {
  const alpha = proc('alpha-work');
  assert.deepEqual(alpha.participants.map((p) => [p.email, p.staff, p.authored, p.forwards, p.chasers, p.reads]), [
    ['ann.lee@enron.com', true, 3, 0, 0, 3],
    ['bob.ray@enron.com', true, 1, 0, 1, 3],
    ['carl@calpine.com', false, 1, 0, 0, 0],
    ['dan.fox@enron.com', true, 0, 0, 0, 1],
  ]);
  assert.equal(alpha.staff_participants, 3);
  // From 1 to 2 (two hours), from 2 and 3 to 4 (the next message by someone else).
  const gaps = [at('2001-01-10T17:00:00Z') - at('2001-01-10T15:00:00Z'), at('2001-02-15T15:00:00Z') - at('2001-01-10T17:00:00Z'), at('2001-02-15T15:00:00Z') - at('2001-01-10T19:00:00Z')].sort((a, b) => a - b);
  assert.equal(alpha.median_reply_gap_h, Math.round((gaps[1] as number) / (HOUR_MS / 10)) / 10);
  assert.ok(proc('delta-one').flags.includes('single_source'));
  assert.ok(!alpha.flags.includes('single_source'));
});

test('stalls only when their quote passed; ownership claims with a conflict a day apart and none 61 days apart; evidence re-keyed', () => {
  const alpha = proc('alpha-work');
  assert.deepEqual(alpha.stalls.map((s) => [s.message_id, s.kind]), [[idOf(1), 'waiting_on_reply']], "message 4's stall quote was rejected");
  assert.equal(alpha.stalls[0]?.quote, bodyOf(MAILS[0] as Mail));
  const beta = proc('beta-work');
  assert.deepEqual(beta.ownership_conflict, {
    claims: [
      { person: 'Ann Lee', message_id: idOf(7), date_utc: '2001-04-01T14:00:00Z' },
      { person: 'Bob Ray', message_id: idOf(8), date_utc: '2001-04-02T14:00:00Z' },
    ],
  });
  assert.equal(proc('gamma-work').ownership_claims.length, 2);
  assert.equal(proc('gamma-work').ownership_conflict, null, '61 days apart');
  assert.ok(alpha.evidence_ids.includes('batch-000:e3'), 'the new:alpha-extra quote counts for alpha-work');
  assert.ok(!alpha.evidence_ids.includes('batch-000:e11'), 'the rejected quote does not');
  assert.deepEqual(proc('delta-one').evidence_ids, ['batch-001:e2', 'batch-001:e3', 'batch-001:e4']);
});

test('ownership conflicts in the rollup: a claim naming a group, or the other claimant again, is listed but makes no conflict', () => {
  const withClaim = (n: number, person: string): ValidatedExtraction[] =>
    VALIDATED.map((v) => ({ ...v, messages: v.messages.map((m) => (m.id === idOf(n) && m.ownership_claim !== null ? { ...m, ownership_claim: { ...m.ownership_claim, person } } : m)) }));
  const beta = (validated: ValidatedExtraction[]) => rollupOf({ validated }).processes.find((p) => p.key === 'beta-work') as ProcessRollup;
  assert.ok(proc('beta-work').participants.some((p) => p.email === 'bob.ray@enron.com'), 'the claimants took part');
  for (const [person, why] of [['each trader', 'a group'], ['the scheduling desk', 'a role'], ['ann', 'the other claimant, by her address'], ['LEE, A.', 'the same, surname first']] as const) {
    const b = beta(withClaim(8, person));
    assert.deepEqual(b.ownership_claims.map((c) => c.person), ['Ann Lee', person], why);
    assert.equal(b.ownership_conflict, null, why);
  }
  assert.deepEqual(beta(withClaim(8, 'Bob')).ownership_conflict?.claims.map((c) => c.person), ['Ann Lee', 'Bob'], 'a first name of a participant still counts');
  assert.deepEqual(beta(withClaim(8, 'Eve Ng')).ownership_conflict?.claims.map((c) => c.person), ['Ann Lee', 'Eve Ng'], 'someone in the archive who is not on this trail');
  assert.deepEqual(beta(withClaim(8, 'Zed Quill')).ownership_conflict?.claims.map((c) => c.person), ['Ann Lee', 'Zed Quill'], 'a name only a message body carries');
});

test('a process every message of which is a flagged injection is quarantined, not counted; one flagged message flags the process', () => {
  const { rollup, notes } = rollupWithNotes({ validated: VALIDATED, merge: MERGE, threads: THREADS, messages: MESSAGES, people: PEOPLE, rates, taxonomy: TAXONOMY, flagged: new Set([idOf(9), idOf(10)]), shas: SHAS });
  assert.ok(rollup.processes.some((p) => p.key === 'gamma-work'), 'gamma still has an unflagged message');
  const gamma = rollup.processes.find((p) => p.key === 'gamma-work') as ProcessRollup;
  assert.ok(gamma.flags.includes('injection_adjacent'));
  const only = rollupWithNotes({ validated: VALIDATED, merge: MERGE, threads: THREADS, messages: MESSAGES, people: PEOPLE, rates, taxonomy: TAXONOMY, flagged: new Set([idOf(11), idOf(12), idOf(13)]), shas: SHAS });
  assert.deepEqual(only.notes.quarantined, [{ key: 'delta-one', messages: [idOf(11), idOf(12), idOf(13)] }]);
  assert.ok(!only.rollup.processes.some((p) => p.key === 'delta-one'));
  assert.ok(only.rollup.unassigned.message_ids.includes(idOf(11)), 'its messages are tagged but counted nowhere');
  assert.deepEqual(notes.quarantined, []);
});

test('the rollup is byte-identical on the same inputs', () => {
  assert.equal(JSON.stringify(rollupOf()), JSON.stringify(ROLLUP));
});

// ---- The committed M4 outputs (the WP-D acceptance, pinned) ----

test('on the committed M4 outputs, with every proposed key unassigned: the approved counts, tiers and windows', (t) => {
  const out = join(repo, 'out');
  const needed = ['validated', 'threads.json', 'messages.jsonl', 'people.json', 'taxonomy.json', 'prepare-stats.json'];
  if (!needed.every((f) => existsSync(join(out, f)))) {
    t.skip('the committed run outputs are not here');
    return;
  }
  const json = (f: string) => JSON.parse(readFileSync(join(out, f), 'utf8'));
  const validated = readdirSync(join(out, 'validated'))
    .filter((f) => /^batch-\d{3}\.json$/.test(f))
    .sort()
    .map((f) => json(join('validated', f)) as ValidatedExtraction);
  const threads = json('threads.json') as Thread[];
  const messages = new Map<string, ParsedMessage>();
  for (const line of readFileSync(join(out, 'messages.jsonl'), 'utf8').split('\n')) {
    if (line === '') continue;
    const m = JSON.parse(line) as ParsedMessage;
    messages.set(m.id, m);
  }
  const stats = json('prepare-stats.json') as { suspected_injection: string[] };
  const facts = slugFacts(validated, threads, messages);
  const table = canonicalMergeTable({ mapped: {}, unassigned: facts.map((f) => f.slug), promoted: [] }, facts, { messages: 3, occurrences: 3, threads: 2, active_months: 2 }, new Set(stats.suspected_injection), {
    extractions_sha: 'e',
    taxonomy_sha: 't',
    agent_sha: 'a',
  });
  const rollup = buildRollup({ validated, merge: table, threads, messages, people: json('people.json') as Person[], rates, taxonomy: json('taxonomy.json'), flagged: new Set(stats.suspected_injection), shas: SHAS });
  const scoring = loadScoring(join(repo, 'config', 'scoring.json'));
  const byOccurrences = [...rollup.processes].sort((a, b) => b.occurrences - a.occurrences);
  assert.equal(rollup.processes.length, 25);
  assert.deepEqual(byOccurrences.slice(0, 5).map((p) => p.occurrences), [204, 129, 125, 104, 92]);
  const tiers = { A: 0, B: 0, C: 0 };
  for (const p of rollup.processes) tiers[tierOf(p, scoring)]++;
  assert.deepEqual(tiers, { A: 14, B: 9, C: 2 });
  const get = (key: string) => rollup.processes.find((p) => p.key === key) as ProcessRollup;
  assert.deepEqual([get('realtime-schedule-checkout').window.span_days, get('realtime-schedule-checkout').window.months_x100], [241, 792]);
  assert.deepEqual([get('volume-imbalance-reconciliation').window.span_days, get('volume-imbalance-reconciliation').window.months_x100], [828, 2720]);
  assert.deepEqual([rollup.coverage.tagged, rollup.coverage.counted, rollup.coverage.unassigned], [2345, 1700, 645]);
  // Ownership conflicts: a claim counts when it names one person (the people directory, the
  // process's participants first; or a personal name found nowhere else), never a group, and claims
  // naming the same person count once. 6 of 25 (7 under plain string comparison): the only claims
  // of the 51 that name no one person are the three group claims, realtime-schedule-checkout's
  // ("each trader", "volume management group") and "Volume Management". Three claimants who are
  // not on their process's trail resolve through the directory, and two of them now take part in
  // desk-coverage-on-call's conflict. The planted pair, a day apart, still conflicts.
  assert.deepEqual(
    rollup.processes.filter((p) => p.ownership_conflict !== null).map((p) => p.key),
    ['counterparty-settlement-review', 'deal-book-transfer', 'deal-record-correction', 'desk-coverage-on-call', 'meter-flow-deal-coverage', 'volume-imbalance-reconciliation'],
  );
  const people = json('people.json') as Person[];
  const claims = rollup.processes.flatMap((p) => p.ownership_claims.map((c) => ({ p, c, who: claimant(c.person, p.participants, people) })));
  assert.equal(claims.length, 51);
  assert.deepEqual(claims.filter((x) => x.who === null).map((x) => x.c.person).sort(), ['Volume Management', 'each trader', 'volume management group']);
  const resolved = (person: string) => {
    const x = claims.find((y) => y.c.person === person);
    assert.ok(x !== undefined && x.who !== null && 'known' in x.who, person);
    return { known: (x.who as { known: string[] }).known, participant: x.p.participants.some((q) => (x.who as { known: string[] }).known.includes(q.email)) };
  };
  assert.deepEqual(resolved('Heidi Withers'), { known: ['heidi.withers@enron.com'], participant: false });
  assert.deepEqual(resolved('Ryan Slinger'), { known: ['ryan.slinger@enron.com'], participant: false });
  assert.deepEqual(resolved('Souad'), { known: ['souad.mahmassani@enron.com'], participant: false });
  const desk = get('desk-coverage-on-call').ownership_conflict?.claims.map((c) => c.person) ?? [];
  assert.ok(desk.includes('Ryan Slinger') && desk.includes('Souad'), desk.join(', '));
  assert.equal(get('realtime-schedule-checkout').ownership_claims.length, 3, 'the claims stay listed');
  assert.equal(get('realtime-schedule-checkout').ownership_conflict, null);
  const pair = get('volume-imbalance-reconciliation').ownership_conflict?.claims.map((c) => c.message_id) ?? [];
  assert.ok(pair.includes('corpus/giron-d/inbox/483.') && pair.includes('corpus/williams-w3/sent_items/526.'), pair.join(', '));
  // The counted formula of a process with shared messages shows the plain sum and the shared one.
  const scored = score({ rollup, synthesis: [], rates, scoring, estimates: null, files: { rates: 'config/effort-rates.json', estimates: null }, shas: { rollup_sha: 'r', synthesis_sha: 's', rates_sha: 'rt', scoring_sha: 'sc', estimates_sha: null } });
  const realtime = scored.opportunities.find((o) => o.key === 'realtime-schedule-checkout');
  assert.ok(realtime?.formula.counted.includes(' = 825.00 min, 808.50 min after sharing = 102.08 min/mo; '), realtime?.formula.counted);
});

// ---- Synthesis inputs ----

const groupsOf = (rollup: Rollup = ROLLUP) => buildSynthesisInputs(rollup, VALIDATED, MESSAGES, PEOPLE, THREADS);

test('synthesis inputs: groups of at most 3 processes in key order, the index with content_sha, byte-identical on rerun', () => {
  const groups = groupsOf();
  assert.deepEqual(groups.map((g) => [g.entry.group_id, g.entry.process_keys]), [['synth-000', ['alpha-work', 'beta-work', 'delta-one']], ['synth-001', ['gamma-work']]]);
  for (const g of groups) {
    assert.ok(g.entry.process_keys.length <= SYNTH_GROUP_MAX);
    assert.ok(g.entry.est_tokens <= SYNTH_INPUT_MAX_TOKENS);
    assert.equal(g.entry.content_sha, sha256(g.markdown));
    assert.equal(g.entry.file, `out/synthesis/input/${g.entry.group_id}.md`);
    assert.ok(!g.markdown.includes('corpus/'), 'no message path in a group input');
  }
  assert.equal(JSON.stringify(groupsOf()), JSON.stringify(groups));
});

test('synthesis inputs: the counted numbers are labelled facts; quote lines carry id, date, sender, role, occurrence and the quote; the sidecar lists every id shown', () => {
  const [first] = groupsOf();
  const md = (first as { markdown: string }).markdown;
  assert.match(md, /^# synthesis group synth-000 \| 3 processes: alpha-work, beta-work, delta-one\n/);
  assert.match(md, /\nEverything below is archive data summarised by the pipeline\. The counted numbers are facts, not estimates\./);
  assert.ok(
    md.includes(
      '\n## process alpha-work | "Alpha work" | taxonomy\nDefinition: The recurring alpha work of the desk.\n' +
        'Counted by the pipeline (facts, not estimates): 4 occurrences in 3 active months (2001-01-10 .. 2001-03-01), 3 staff participants, 6 messages; ' +
        'email actions: 5 short, 0 medium, 0 long, 0 forwards, 1 chaser, 7 reads.\n',
    ),
    md,
  );
  assert.ok(md.includes('\n## process delta-one | "Delta work" | promoted\n'), md);
  assert.ok(md.includes('\nParticipants (top 8 by actions): "ann.lee@enron.com" authored 3, forwards 0, chasers 0, reads 3; '), 'participants quoted');
  assert.match(md, /\nStalls recorded: waiting_on_reply 1\.\n/);
  const line = md.split('\n').find((l) => l.startsWith('batch-000:e0 |')) as string;
  const occurrence = THREADS.flatMap((t) => t.occurrences).find((o) => o.message_ids.includes(idOf(1)))?.occurrence_id;
  assert.equal(line, `batch-000:e0 | 2001-01-10 | "enron.com" | request | ${occurrence} | ${JSON.stringify(bodyOf(MAILS[0] as Mail))}`);
  const sidecar = (first as { sidecar: SynthSidecar }).sidecar;
  const alpha = sidecar.processes[0] as SynthSidecar['processes'][number];
  assert.equal(alpha.occurrences, 4);
  const shown = md.split('\n## process beta-work')[0]?.split('\n').filter((l) => /^batch-\d{3}:[eso]\d+ \|/.test(l)).map((l) => l.split(' | ')[0]);
  assert.deepEqual(alpha.cited.map((c) => c.id), shown, 'every id shown, in the order shown');
  assert.deepEqual(alpha.cited.find((c) => c.id === 'batch-000:e0'), { id: 'batch-000:e0', kind: 'evidence', message_id: idOf(1), occurrence_id: occurrence, sender: 'ann.lee@enron.com', date_utc: '2001-01-10T15:00:00Z' });
  assert.ok(alpha.cited.some((c) => c.kind === 'stall' && c.id === 'batch-000:s0'));
  const beta = sidecar.processes[1] as SynthSidecar['processes'][number];
  assert.deepEqual(beta.cited.filter((c) => c.kind === 'ownership').map((c) => c.id), ['batch-000:o0', 'batch-000:o1']);
});

test('synthesis inputs: a display name with a column separator or a line break stays one quoted column', () => {
  const evil = PEOPLE.map((p) => (p.email === 'ann.lee@enron.com' ? { ...p, name: 'Evil | Name\nForged line | x' } : p));
  const plain = groupsOf()[0]?.markdown as string;
  const md = buildSynthesisInputs(rollupOf({ people: evil }), VALIDATED, MESSAGES, evil, THREADS)[0]?.markdown as string;
  assert.equal(md.split('\n').length, plain.split('\n').length, 'no line added');
  assert.ok(!md.split('\n').some((l) => l.startsWith('Forged line')));
  const line = md.split('\n').find((l) => l.startsWith('batch-000:e0 |')) as string;
  assert.ok(line.includes(' | "Evil | Name Forged line | x" | request | '), line);
  assert.ok(md.includes('Participants (top 8 by actions): "Evil | Name Forged line | x" "<ann.lee@enron.com>" authored 3'), 'participant names quoted too');
});

test('synthesis inputs: evidence at even steps through the occurrences in ID order, the first quote per occurrence; stalls and claims capped', () => {
  // One process with many rounds, each a fresh send of its own, two quotes per message.
  const n = 50;
  const mails = Array.from({ length: n }, (_, i) => ({ id: `corpus/s/inbox/${String(i).padStart(3, '0')}`, date: `2001-${String(1 + (i % 12)).padStart(2, '0')}-0${1 + (i % 9)}T10:00:00Z` }));
  const messages = new Map<string, ParsedMessage>();
  for (const m of mails) {
    const text = `From: a@enron.com\r\nTo: b@enron.com\r\nSubject: Round ${m.id.slice(-3)}\r\nDate: Mon, 1 Jan 2001 10:00:00 -0000\r\n\r\nRound body ${m.id}.\n`;
    const bytes = Buffer.from(text, 'utf8');
    messages.set(m.id, parseMessage(m.id, gitBlobSha(bytes), bytes));
  }
  const threads = buildThreads([...messages.values()]);
  const ev = (i: number, k: number): ValidatedEvidence => ({ evidence_id: `batch-000:e${2 * i + k}`, process: 'many', message_id: (mails[i] as { id: string }).id, field: 'body', quote: `quote ${i}.${k}`, note: '', match: 'exact', start: 0, end: 1, segment: 'own', raw_text: `quote ${i}.${k} of round`, reason: null });
  const validated: ValidatedExtraction = {
    batch_id: 'batch-000',
    content_sha: 'x',
    messages: mails.map((m, i) => ({ id: m.id, processes: ['many'], role: 'request', stall: i < 20 ? { kind: 'rework' as const, quote: 'q' } : null, ownership_claim: i < 15 ? { person: `P${i}`, quote: 'q' } : null })),
    evidence: mails.flatMap((_, i) => [ev(i, 0), ev(i, 1)]),
    stall_checks: mails.slice(0, 20).map((m) => ({ message_id: m.id, match: 'exact' as const, start: 0, end: 1, segment: 'own' as const, raw_text: 'stalled', reason: null })),
    ownership_checks: mails.slice(0, 15).map((m, i) => ({ message_id: m.id, person: `P${i}`, match: 'exact' as const, start: 0, end: 1, segment: 'own' as const, raw_text: 'owns it', reason: null })),
    new_processes: [],
    batch_notes: '',
    quote_stats: { exact: 0, repaired: 0, rejected: 0 },
  };
  const taxonomy = canonicalTaxonomy([{ key: 'many', name: 'Many rounds', definition: 'Work that comes round fifty times.', include: [], exclude: [], example_subjects: ['x'] }], 'd'.repeat(64), 'a'.repeat(64));
  const empty: MergeTable = { ...MERGE, slugs: [], promoted: [] };
  const rollup = buildRollup({ validated: [validated], merge: empty, threads, messages, people: [], rates, taxonomy, flagged: new Set(), shas: SHAS });
  const [g] = buildSynthesisInputs(rollup, [validated], messages, [], threads);
  const cited = (g as { sidecar: SynthSidecar }).sidecar.processes[0]?.cited ?? [];
  const evidence = cited.filter((c) => c.kind === 'evidence');
  assert.equal(evidence.length, EVIDENCE_SAMPLE);
  const occurrences = (rollup.processes[0] as ProcessRollup).occurrence_ids;
  assert.deepEqual(evidence.map((c) => c.occurrence_id), evenSteps(occurrences.length, EVIDENCE_SAMPLE).map((i) => occurrences[i]));
  for (const c of evidence) assert.match(c.id, /^batch-000:e\d*[02468]$/, 'the first quote of its occurrence (even index)');
  assert.equal(cited.filter((c) => c.kind === 'stall').length, STALL_SAMPLE);
  assert.equal(cited.filter((c) => c.kind === 'ownership').length, OWNERSHIP_SAMPLE);
  assert.match((g as { markdown: string }).markdown, /\n### Evidence \(40 of 100 accepted quotes: one per occurrence at even steps through the occurrences in ID order\)\n/);
  assert.match((g as { markdown: string }).markdown, /\n### Stall quotes \(10 of 20, even steps\)\n/);
});

test('synthesis inputs: when the first quotes of the sampled rounds are all one sender, the first quote of up to two more senders is added', () => {
  // Ten rounds, each a fresh send by a@ and a reply in the same round by b@ (even rounds) or c@
  // (odd ones). The sample takes the first quote of each round: all a@'s.
  const messages = new Map<string, ParsedMessage>();
  const mail = (id: string, from: string, subject: string, day: number, hour: number) => {
    const text = `From: ${from}\r\nTo: desk@enron.com\r\nSubject: ${subject}\r\nDate: ${day} Jan 2001 ${hour}:00:00 -0000\r\n\r\nBody of ${id}.\n`;
    const bytes = Buffer.from(text, 'utf8');
    messages.set(id, parseMessage(id, gitBlobSha(bytes), bytes));
  };
  for (let i = 0; i < 10; i++) {
    mail(`corpus/d/inbox/${i}0`, 'a@enron.com', `Round ${i}`, i + 1, 10);
    mail(`corpus/d/inbox/${i}1`, i % 2 === 0 ? 'b@enron.com' : 'c@enron.com', `RE: Round ${i}`, i + 1, 11);
  }
  const ids = [...messages.keys()].sort();
  const threads = buildThreads([...messages.values()]);
  const validated: ValidatedExtraction = {
    batch_id: 'batch-000',
    content_sha: 'x',
    messages: ids.map((id) => ({ id, processes: ['rounds'], role: 'request', stall: null, ownership_claim: null })),
    evidence: ids.map((id, k) => ({ evidence_id: `batch-000:e${k}`, process: 'rounds', message_id: id, field: 'body', quote: `Body of ${id}.`, note: '', match: 'exact', start: 0, end: 1, segment: 'own', raw_text: `Body of ${id}.`, reason: null })),
    stall_checks: [],
    ownership_checks: [],
    new_processes: [],
    batch_notes: '',
    quote_stats: { exact: 0, repaired: 0, rejected: 0 },
  };
  const taxonomy = canonicalTaxonomy([{ key: 'rounds', name: 'Rounds', definition: 'Work that comes round ten times.', include: [], exclude: [], example_subjects: ['x'] }], 'd'.repeat(64), 'a'.repeat(64));
  const rollup = buildRollup({ validated: [validated], merge: { ...MERGE, slugs: [], promoted: [] }, threads, messages, people: [], rates, taxonomy, flagged: new Set(), shas: SHAS });
  assert.equal((rollup.processes[0] as ProcessRollup).occurrences, 10);
  const [g] = buildSynthesisInputs(rollup, [validated], messages, [], threads);
  const cited = (g as { sidecar: SynthSidecar }).sidecar.processes[0]?.cited ?? [];
  assert.deepEqual([...new Set(cited.map((c) => c.sender))].sort(), ['a@enron.com', 'b@enron.com', 'c@enron.com']);
  assert.equal(cited.length, 10 + 2, 'one per round, and the first quote of b@ and of c@');
  assert.deepEqual(cited.filter((c) => c.sender !== 'a@enron.com').map((c) => c.message_id).sort(), ['corpus/d/inbox/01', 'corpus/d/inbox/11'], 'the first quote of each, in id order');
  assert.deepEqual(cited.map((c) => c.occurrence_id), [...cited.map((c) => c.occurrence_id)].sort(), 'listed by round');
  assert.match((g as { markdown: string }).markdown, /\n### Evidence \(12 of 20 accepted quotes: one per occurrence at even steps through the occurrences in ID order, and 2 more from senders those do not show\)\n/);
  assert.ok(SAMPLE_MIN_SENDERS >= SELF_REPORTED_MIN_SENDERS && SAMPLE_MIN_SENDERS >= loadScoring(join(repo, 'config', 'scoring.json')).estimates.min_senders, 'enough senders for every estimate rule');
});

// ---- The command ----

function project(): string {
  const root = join(tmp, `p${readdirSync(tmp).length}`);
  for (const dir of ['out/batches', 'out/validated', 'config', '.claude/agents']) mkdirSync(join(root, dir), { recursive: true });
  for (const f of ['effort-rates.json', 'scoring.json']) writeFileSync(join(root, 'config', f), readFileSync(join(repo, 'config', f)));
  writeFileSync(join(root, '.claude', 'agents', 'merger.md'), 'a stand-in merger\n');
  writeFileSync(join(root, '.claude', 'agents', 'extractor.md'), 'a stand-in extractor\n');
  writeFileSync(join(root, 'out', 'taxonomy.json'), `${JSON.stringify(TAXONOMY, null, 2)}\n`);
  writeFileSync(join(root, 'out', 'messages.jsonl'), [...MESSAGES.values()].map((m) => `${JSON.stringify(m)}\n`).join(''));
  writeFileSync(join(root, 'out', 'threads.json'), JSON.stringify(THREADS));
  writeFileSync(join(root, 'out', 'people.json'), JSON.stringify(PEOPLE));
  writeFileSync(join(root, 'out', 'prepare-stats.json'), JSON.stringify({ corpus_hash: 'c'.repeat(64), suspected_injection: [] }));
  const entries: BatchEntry[] = VALIDATED.map((v) => {
    const text = `# ${v.batch_id}\n`;
    writeFileSync(join(root, 'out', 'batches', `${v.batch_id}.md`), text);
    return { batch_id: v.batch_id, file: `out/batches/${v.batch_id}.md`, message_ids: v.messages.map((m) => m.id), thread_ids: [], bytes: text.length, lines: 1, est_tokens: 1, content_sha: sha256(text) };
  });
  writeFileSync(join(root, 'out', 'batches', 'index.json'), JSON.stringify(entries));
  for (const [i, e] of entries.entries()) {
    markDispatched(root, batchJob(e));
    recordValidation(root, batchJob(e), { ok: true, setup: null, problems: [], validated: { ...(VALIDATED[i] as ValidatedExtraction), content_sha: e.content_sha } });
  }
  writeFileSync(join(root, 'out', 'merge.json'), JSON.stringify({ ...MERGE, ...currentMergeShas(root) }));
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

test('rollup command: writes the rollup, coverage, validation report and group inputs; current until an input changes; byte-identical on rerun', () => {
  const root = project();
  assert.equal(rollupFreshness(root), 'missing');
  const r = capture(() => rollupCommand(root, []));
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.deepEqual(r.out, ['rollup: 4 processes (1 promoted), 13 counted messages in 14 occurrences; 1 tagged message unassigned; 2 synthesis groups.']);
  assert.equal(rollupFreshness(root), 'current');
  const files = ['rollup.json', 'coverage.json', 'validation-report.json', 'synthesis/index.json', 'synthesis/input/synth-000.md', 'synthesis/input/synth-000.json', 'synthesis/input/synth-001.md', 'synthesis/input/synth-001.json'];
  const before = files.map((f) => readFileSync(join(root, 'out', f)));
  const report = JSON.parse(readFileSync(join(root, 'out', 'validation-report.json'), 'utf8'));
  assert.deepEqual(report.quotes.evidence, { exact: 17, repaired: 0, rejected: 1 });
  assert.deepEqual(report.quotes.stall, { exact: 1, repaired: 0, rejected: 1 });
  assert.deepEqual(report.rejections.map((x: { kind: string; message_id: string; quote: string }) => [x.kind, x.message_id, x.quote]), [
    ['evidence', idOf(1), 'A quote the model made up.'],
    ['stall', idOf(4), bodyOf(MAILS[3] as Mail)],
  ]);
  const coverage = JSON.parse(readFileSync(join(root, 'out', 'coverage.json'), 'utf8'));
  assert.equal(coverage.unique, 15);
  const index = JSON.parse(readFileSync(join(root, 'out', 'synthesis', 'index.json'), 'utf8'));
  assert.deepEqual(index.map((g: { group_id: string; content_sha: string }) => [g.group_id, g.content_sha]), ['synth-000', 'synth-001'].map((id) => [id, sha256(readFileSync(join(root, 'out', 'synthesis', 'input', `${id}.md`), 'utf8'))]));

  // Rerun: the same bytes; a stale group file from a bigger earlier rollup is removed.
  writeFileSync(join(root, 'out', 'synthesis', 'input', 'synth-007.md'), 'left over');
  assert.equal(capture(() => rollupCommand(root, [])).code, 0);
  files.forEach((f, i) => assert.ok(readFileSync(join(root, 'out', f)).equals(before[i] as Buffer), f));
  assert.ok(!existsSync(join(root, 'out', 'synthesis', 'input', 'synth-007.md')));

  // Stale when a group input goes (a fresh clone ignores the Markdown), the rates or the merge change.
  rmSync(join(root, 'out', 'synthesis', 'input', 'synth-001.md'));
  assert.equal(rollupFreshness(root), 'stale');
  capture(() => rollupCommand(root, []));
  assert.equal(rollupFreshness(root), 'current');
  writeFileSync(join(root, 'config', 'effort-rates.json'), readFileSync(join(repo, 'config', 'effort-rates.json'), 'utf8').replace('"read": 1', '"read": 2'));
  assert.equal(rollupFreshness(root), 'stale');
});

test('rollup command: refuses without a fresh merge, and arguments', () => {
  const root = project();
  writeFileSync(join(root, '.claude', 'agents', 'merger.md'), 'a changed merger\n');
  assert.deepEqual(capture(() => rollupCommand(root, [])).err, ['rollup: out/merge.json is not fresh (stale): run node obs.mjs merge first.']);
  rmSync(join(root, 'out', 'merge.json'));
  assert.deepEqual(capture(() => rollupCommand(root, [])).err, ['rollup: out/merge.json is missing: run node obs.mjs merge first.']);
  assert.match(capture(() => rollupCommand(root, ['--all'])).err[0] ?? '', /^rollup: unexpected argument "--all"/);
});

test('an unreadable prepare-stats.json is one readable line, never a stack trace', () => {
  const root = project();
  writeFileSync(join(root, 'out', 'prepare-stats.json'), '{ not json');
  assert.throws(() => currentRollupInputs(root), (e: unknown) => e instanceof RollupError && e.message === 'out/prepare-stats.json is not valid JSON: run node obs.mjs prepare again.');
  assert.equal(rollupFreshness(root), 'missing');
  const r = capture(() => rollupCommand(root, []));
  assert.deepEqual([r.code, r.err.length, r.out], [1, 1, []]);
  assert.match(r.err[0] ?? '', /^rollup: out\/prepare-stats\.json is not valid JSON: run node obs\.mjs prepare/);
});
