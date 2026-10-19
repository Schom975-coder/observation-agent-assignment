import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicates } from '../src/normalize/dedup.ts';
import { IdentityError, STALE_PEOPLE, followFolds, foldPeople, identityOf, isSystemAddress, kindOf, middleInitial, shapeOf, togetherIn } from '../src/normalize/identity.ts';
import { buildPeople } from '../src/normalize/people.ts';
import { buildThreads } from '../src/normalize/threads.ts';
import { isForwardSubject, isReplyOrForward, normalizeSubject, parseAddressList, splitHeaders } from '../src/parse/headers.ts';
import type { Address, ParsedMessage, Person, PersonCounts } from '../src/types.ts';

const addr = (email: string, name: string | null = null): Address => ({ email, name });

let nextId = 100;

// A fresh send from an enron.com address, dated, with no recipients unless given.
function msg(over: Partial<ParsedMessage> = {}): ParsedMessage {
  const n = nextId++;
  return {
    id: `corpus/test-a/inbox/${n}.`,
    blob_sha: String(n).padStart(40, '0'),
    mailbox: 'test-a',
    folder: 'inbox',
    message_id: `<${n}.JavaMail@test>`,
    date_raw: null,
    date_utc: '2001-05-14T12:00:00Z',
    date_status: 'usable',
    from: addr('trader@enron.com'),
    to: [],
    cc: [],
    subject: 'Gas volumes',
    subject_norm: 'gas volumes',
    reply_or_forward_subject: false,
    body_start: 0,
    body_chars: 10,
    segments: [{ kind: 'own', start: 0, end: 10 }],
    own_chars: 10,
    fresh_send: true,
    flags: { oversize: false, suspected_injection: false, injection_markers: [] },
    ...over,
  };
}
const undated = { date_utc: null, date_status: 'missing' as const };
const reply = (over: Partial<ParsedMessage> = {}) =>
  msg({ subject: 'RE: Gas volumes', reply_or_forward_subject: true, fresh_send: false, ...over });

// Every message gets the same body unless `bodies` says otherwise.
function dedup(messages: ParsedMessage[], bodies: Record<string, string> = {}) {
  return findDuplicates(messages, new Map(messages.map((m) => [m.id, bodies[m.id] ?? 'same body'])));
}
// How one copy appears in its group.
const copy = (m: ParsedMessage, rule: 'content' | 'message_id' = 'content', recipients_differ = false) => ({ id: m.id, rule, recipients_differ });

test('dedup: same sender, subject and body 10 hours apart is one email stored twice', () => {
  const a = msg({ date_utc: '2001-05-14T08:00:00Z' });
  const b = msg({ date_utc: '2001-05-14T18:00:00Z' });
  const { groups, duplicateOf } = dedup([b, a]);
  assert.deepEqual(groups, [{ canonical: a.id, duplicates: [copy(b)] }]);
  assert.equal(duplicateOf.get(b.id), a.id);
});

test('dedup: under 24 hours apart is a copy; exactly 24 or 25 hours apart is a recurring send', () => {
  const pair = (later: string) => dedup([msg({ date_utc: '2001-05-14T08:00:00Z' }), msg({ date_utc: later })]).groups.length;
  assert.equal(pair('2001-05-15T07:00:00Z'), 1, '23 h');
  assert.equal(pair('2001-05-15T07:59:59Z'), 1, 'one second under 24 h');
  assert.equal(pair('2001-05-15T08:00:00Z'), 0, 'exactly 24 h');
  assert.equal(pair('2001-05-15T09:00:00Z'), 0, '25 h');
});

test('dedup: a cluster is anchored on its first copy, so sends 20 hours apart do not chain into one', () => {
  const [h0, h20, h40, h60] = ['2001-05-14T00:00:00Z', '2001-05-14T20:00:00Z', '2001-05-15T16:00:00Z', '2001-05-16T12:00:00Z'].map((d) =>
    msg({ date_utc: d }),
  ) as [ParsedMessage, ParsedMessage, ParsedMessage, ParsedMessage];
  assert.deepEqual(dedup([h60, h40, h20, h0]).groups, [
    { canonical: h0.id, duplicates: [copy(h20)] },
    { canonical: h40.id, duplicates: [copy(h60)] },
  ]);
});

test('dedup: daily identical nominations stay separate; only the stray re-export merges', () => {
  // Replica of Calpine's daily nomination: same sender, subject and body every day.
  const days = ['2000-04-10', '2000-04-11', '2000-04-12'].map((d) => msg({ date_utc: `${d}T08:05:00Z`, from: addr('scheduler@calpine.com') }));
  const reExport = msg({ date_utc: '2000-04-11T18:30:00Z', from: addr('scheduler@calpine.com') });
  const { groups } = dedup([...days, reExport]);
  assert.deepEqual(groups, [{ canonical: (days[1] as ParsedMessage).id, duplicates: [copy(reExport)] }]);
});

test('dedup: a different sender, subject or body is a different email', () => {
  const base = msg();
  const others = [msg({ from: addr('desk@enron.com') }), msg({ subject_norm: 'gas volumes june' }), msg()];
  const last = others[2] as ParsedMessage;
  assert.deepEqual(dedup([base, ...others], { [last.id]: 'another body' }).groups, []);
});

test('dedup: an undated copy joins only when the dated copies form one cluster', () => {
  const a = msg({ date_utc: '2001-05-14T08:00:00Z' });
  const u = msg(undated);
  assert.deepEqual(dedup([a, u]).groups, [{ canonical: a.id, duplicates: [copy(u)] }]);
  // Two dated sends days apart: which day the undated one belongs to is a guess, so it stays.
  const b = msg({ date_utc: '2001-05-20T08:00:00Z' });
  const c = msg({ date_utc: '2001-05-25T08:00:00Z' });
  assert.deepEqual(dedup([b, c, msg(undated)]).groups, []);
});

test('dedup: with no dated copy there is no time evidence, so undated copies merge only by Message-ID', () => {
  assert.deepEqual(dedup([msg(undated), msg(undated)]).groups, []);
  const u1 = msg({ ...undated, message_id: '<same@x>' });
  const u2 = msg({ ...undated, message_id: '<same@x>' });
  assert.deepEqual(dedup([u2, u1]).groups, [{ canonical: u1.id, duplicates: [copy(u2, 'message_id')] }]);
});

test('dedup: the canonical is a dated copy even when an undated copy has the lower ID', () => {
  const u = msg(undated); // created first: the lower ID
  const a = msg({ date_utc: '2001-05-14T08:00:00Z' });
  assert.ok(u.id < a.id);
  const { groups, duplicateOf } = dedup([u, a]);
  assert.deepEqual(groups, [{ canonical: a.id, duplicates: [copy(u)] }]);
  assert.equal(duplicateOf.get(u.id), a.id);
});

test('dedup: the canonical is the lowest dated ID even when it is not the earliest copy', () => {
  const low = msg({ date_utc: '2001-05-14T18:00:00Z' });
  const high = msg({ date_utc: '2001-05-14T08:00:00Z' });
  assert.deepEqual(dedup([high, low]).groups, [{ canonical: low.id, duplicates: [copy(high)] }]);
});

test('dedup: the same Message-ID header is the same email even if the bodies differ', () => {
  const a = msg({ message_id: '<dup@x>' });
  const b = msg({ message_id: '<dup@x>', from: addr('desk@enron.com') });
  assert.deepEqual(dedup([a, b], { [b.id]: 'reformatted body' }).groups, [{ canonical: a.id, duplicates: [copy(b, 'message_id')] }]);
});

test('dedup: a copy that matches by content and by Message-ID is recorded as content', () => {
  const a = msg({ message_id: '<dup@x>', date_utc: '2001-05-14T08:00:00Z' });
  const b = msg({ message_id: '<dup@x>', date_utc: '2001-05-14T09:00:00Z' });
  assert.deepEqual(dedup([a, b]).groups, [{ canonical: a.id, duplicates: [copy(b)] }]);
});

test('dedup: each copy records how it joined and whether its recipients differ from the canonical', () => {
  // A content copy two hours later, and a Message-ID-only copy months later sent to someone else.
  const a = msg({ message_id: '<m1@x>', date_utc: '2001-05-14T08:00:00Z' });
  const b = msg({ date_utc: '2001-05-14T10:00:00Z' });
  const c = msg({ message_id: '<m1@x>', date_utc: '2001-09-03T08:00:00Z', to: [addr('desk@enron.com')] });
  assert.deepEqual(dedup([c, b, a], { [c.id]: 'reformatted body' }).groups, [
    { canonical: a.id, duplicates: [copy(b), copy(c, 'message_id', true)] },
  ]);
});

test('dedup: a group of four within a day; recipient order does not matter, a different set does', () => {
  const to = [addr('x@enron.com'), addr('y@enron.com')];
  const a = msg({ date_utc: '2001-05-14T00:00:00Z', to });
  const b = msg({ date_utc: '2001-05-14T05:00:00Z', to: [...to].reverse() });
  const c = msg({ date_utc: '2001-05-14T10:00:00Z', to: [addr('x@enron.com')], cc: [addr('y@enron.com')] });
  const d = msg({ date_utc: '2001-05-14T23:00:00Z', to, cc: [addr('z@enron.com')] });
  const { groups, duplicateOf } = dedup([d, c, b, a]);
  assert.deepEqual(groups, [{ canonical: a.id, duplicates: [copy(b), copy(c), copy(d, 'content', true)] }]);
  assert.deepEqual([...duplicateOf].sort(), [b, c, d].map((m) => [m.id, a.id]));
});

test('dedup: a Message-ID shared across two content clusters joins them; the far cluster is "message_id"', () => {
  const a1 = msg({ date_utc: '2001-05-14T08:00:00Z' });
  const a2 = msg({ date_utc: '2001-05-14T18:00:00Z', message_id: '<bridge@x>' });
  const b1 = msg({ date_utc: '2001-05-20T08:00:00Z', message_id: '<bridge@x>' });
  const b2 = msg({ date_utc: '2001-05-20T12:00:00Z' });
  assert.deepEqual(dedup([b2, b1, a2, a1]).groups, [
    { canonical: a1.id, duplicates: [copy(a2), copy(b1, 'message_id'), copy(b2, 'message_id')] },
  ]);
});

test('threads: same subject within 45 days is one thread; a longer silence starts another', () => {
  const a = msg({ date_utc: '2001-01-01T00:00:00Z' });
  const b = msg({ date_utc: '2001-02-15T00:00:00Z' }); // 45 days later: same thread
  const c = msg({ date_utc: '2001-04-02T00:00:00Z' }); // 46 days after b: new thread
  const threads = buildThreads([c, a, b]);
  assert.deepEqual(threads.map((t) => t.message_ids), [[a.id, b.id], [c.id]]);
  assert.equal(threads[0]?.first_utc, '2001-01-01T00:00:00Z');
  assert.equal(threads[0]?.last_utc, '2001-02-15T00:00:00Z');
});

test('threads: messages with no subject each stand alone', () => {
  const threads = buildThreads([msg({ subject: '', subject_norm: '' }), msg({ subject: '', subject_norm: '' })]);
  assert.equal(threads.length, 2);
  assert.ok(threads.every((t) => t.message_ids.length === 1 && t.subject_norm === ''));
});

test('threads: an undated message joins the latest thread with its subject, after the dated ones', () => {
  const early = msg({ date_utc: '2001-01-01T00:00:00Z' });
  const late = msg({ date_utc: '2001-06-01T00:00:00Z' });
  const u = reply(undated);
  const lonely = msg({ ...undated, subject: 'Lunch', subject_norm: 'lunch' });
  const threads = buildThreads([u, early, late, lonely]);
  assert.deepEqual(threads.map((t) => t.message_ids), [[early.id], [late.id, u.id], [lonely.id]]);
});

test('threads: undated messages with no dated thread to join are singletons, even with the same subject', () => {
  const u1 = msg({ ...undated, subject: 'Lunch', subject_norm: 'lunch' });
  const u2 = reply({ ...undated, subject: 'RE: Lunch', subject_norm: 'lunch' });
  const threads = buildThreads([u2, u1]);
  assert.deepEqual(threads.map((t) => t.message_ids), [[u1.id], [u2.id]]);
  assert.ok(threads.every((t) => t.subject_norm === 'lunch' && t.first_utc === null && t.occurrences.length === 1));
});

test('threads: equal timestamps are ordered by ID, within a thread and between threads', () => {
  const at = '2001-05-14T12:00:00Z';
  const a1 = msg({ date_utc: at, subject_norm: 'alpha' });
  const a2 = reply({ date_utc: at, subject_norm: 'alpha' });
  const b1 = msg({ date_utc: at, subject_norm: 'beta' });
  const threads = buildThreads([b1, a2, a1]);
  assert.deepEqual(threads.map((t) => t.message_ids), [[a1.id, a2.id], [b1.id]]);
});

test('threads: two threads with the same ID are an error, not a silent merge', () => {
  // Only possible with the same message passed twice; the guard is what stops it downstream.
  const m = msg({ subject: '', subject_norm: '' });
  assert.throws(() => buildThreads([m, m]), /Two threads got the ID t-/);
});

test('occurrences: each fresh send starts one; replies and forwards join the latest', () => {
  const day1 = msg({ date_utc: '2000-04-10T08:00:00Z' });
  const re1 = reply({ date_utc: '2000-04-10T09:00:00Z' });
  const day2 = msg({ date_utc: '2000-04-11T08:00:00Z' });
  const day3 = msg({ date_utc: '2000-04-12T08:00:00Z' });
  const re3 = reply({ date_utc: '2000-04-12T10:00:00Z' });
  const [t] = buildThreads([day3, re1, day1, re3, day2]);
  assert.ok(t !== undefined);
  assert.deepEqual(t.occurrences.map((o) => o.message_ids), [[day1.id, re1.id], [day2.id], [day3.id, re3.id]]);
  assert.deepEqual(t.occurrences.map((o) => o.occurrence_id), [1, 2, 3].map((n) => `${t.thread_id}-o${n}`));
});

test('occurrences: a thread that opens with a reply still starts an occurrence', () => {
  const [t] = buildThreads([reply()]);
  assert.equal(t?.occurrences.length, 1);
});

test('threads: a thread ID depends only on its first message, not on other threads', () => {
  const a = msg({ subject_norm: 'meters', date_utc: '2001-01-01T00:00:00Z' });
  const alone = buildThreads([a])[0]?.thread_id;
  const withOthers = buildThreads([msg({ date_utc: '2000-12-01T00:00:00Z' }), a]).find((t) => t.message_ids[0] === a.id)?.thread_id;
  assert.match(alone ?? '', /^t-[0-9a-f]{12}$/);
  assert.equal(withOthers, alone);
});

test('threads: participants are every sender and recipient, sorted, once each', () => {
  const a = msg({ from: addr('b@enron.com'), to: [addr('a@enron.com')], cc: [addr('c@calpine.com')] });
  const b = reply({ from: addr('a@enron.com'), to: [addr('b@enron.com')] });
  assert.deepEqual(buildThreads([a, b])[0]?.participants, ['a@enron.com', 'b@enron.com', 'c@calpine.com']);
});

test('people: unique sent and received counts, most frequent name, staff flag', () => {
  const people = buildPeople(
    [
      msg({ from: addr('a@enron.com', 'Aye, A'), to: [addr('b@calpine.com')], cc: [addr('b@calpine.com')] }),
      msg({ from: addr('a@enron.com', 'Aye, A'), to: [addr('c@ect.enron.com')] }),
      msg({ from: addr('a@enron.com', 'A Aye'), to: [] }),
    ],
    ['enron.com'],
  );
  assert.deepEqual(people, [
    { email: 'a@enron.com', name: 'Aye, A', sent: 3, received: 0, priced: true },
    { email: 'b@calpine.com', name: null, sent: 0, received: 1, priced: false },
    { email: 'c@ect.enron.com', name: null, sent: 0, received: 1, priced: true },
  ]);
});

// The threading key and the header split it depends on (src/parse/headers.ts), on hostile input.
const fast = (label: string, run: () => unknown) => {
  const start = performance.now();
  const result = run();
  assert.ok(performance.now() - start < 200, `${label}: ${Math.round(performance.now() - start)} ms`);
  return result;
};

test('subject normalization is linear on long runs of punctuation or whitespace', () => {
  assert.equal(fast('dots then a letter', () => normalizeSubject(`a${'.'.repeat(40_000)}b`)), `a${'.'.repeat(40_000)}b`);
  assert.equal(fast('trailing dots', () => normalizeSubject(`Gas volumes${'.'.repeat(40_000)}`)), 'gas volumes');
  assert.equal(fast('a prefix then spaces', () => normalizeSubject(`Re:${' '.repeat(40_000)}x`)), 'x');
  assert.equal(fast('a prefix then tabs', () => normalizeSubject(`fw:${'\t'.repeat(40_000)}`)), '');
  assert.equal(fast('reply test', () => isReplyOrForward(`${' '.repeat(40_000)}x`)), false);
  assert.equal(fast('forward test', () => isForwardSubject(`${' '.repeat(40_000)}x`)), false);
  // Same results as before on ordinary subjects.
  assert.equal(normalizeSubject('RE: [Fwd: Fw : Gas volumes...]'), 'gas volumes');
  assert.equal(isForwardSubject('[Fwd: x]'), true);
  assert.equal(isReplyOrForward('RE:x'), true);
});

test('header lines may end in CRLF, LF or a lone CR; offsets index the raw text', () => {
  const cr = 'From: a@enron.com\rSubject: Gas\r volumes\r\rbody\rmore';
  const { fields, bodyStart } = splitHeaders(cr);
  assert.equal(fields.get('from'), ' a@enron.com');
  assert.equal(fields.get('subject'), ' Gas volumes');
  assert.equal(cr.slice(bodyStart), 'body\rmore');
  const mixed = 'A: 1\r\nB: 2\nC: 3\r\r\nbody';
  const split = splitHeaders(mixed);
  assert.deepEqual([...split.fields], [['a', ' 1'], ['b', ' 2'], ['c', ' 3']]);
  assert.equal(mixed.slice(split.bodyStart), 'body');
});

test('address parsing is linear on an unclosed comment', () => {
  const at = (label: string, run: () => unknown) => {
    const start = performance.now();
    const result = run();
    assert.ok(performance.now() - start < 1_000, `${label}: ${Math.round(performance.now() - start)} ms`);
    return result;
  };
  assert.deepEqual(at('a run of (', () => parseAddressList('('.repeat(40_000))), []);
  assert.deepEqual(at('address then an open comment', () => parseAddressList(`a@b.com (${'x'.repeat(40_000)}`)), [{ email: 'a@b.com', name: null }]);
  // Comments still name the sender and are left out of the address.
  assert.deepEqual(parseAddressList('jdoe@enron.com (John Doe)'), [{ email: 'jdoe@enron.com', name: 'John Doe' }]);
  assert.deepEqual(parseAddressList('(first) a@b.com (second'), [{ email: 'a@b.com', name: 'first' }]);
});

// ---- Identity: who each address of the directory is (src/normalize/identity.ts) ----

const IDENTITY_RATES = { priced_domains: ['enron.com'], system_senders: ['no.address@', 'enron_update@', '@caiso.com'] };
// A directory record as buildPeople writes it; priced when the domain is enron.com or under it.
const rec = (email: string, name: string | null = null): PersonCounts => ({ email, name, sent: 1, received: 1, priced: /@(?:.+\.)?enron\.com$/.test(email) });
const fold = (records: PersonCounts[], together?: (a: string, b: string) => boolean) => {
  const people = foldPeople(records, IDENTITY_RATES, together);
  return { people, of: (email: string) => people.find((p) => p.email === email) as Person };
};
const at = (local: string) => `${local}@enron.com`;
// [canonical, fold] of one address.
const folded = (records: PersonCounts[], local: string, together?: (a: string, b: string) => boolean) => {
  const p = fold(records, together).of(at(local));
  return [p.canonical, p.fold];
};

test('identity R1: one display name is one person; the canonical is the lowest first.last address, else the lowest', () => {
  assert.deepEqual(folded([rec(at('m.hall'), 'Bob Hall'), rec(at('bob.hall'), 'Hall, Bob')], 'm.hall'), [at('bob.hall'), 'display_name']);
  const three = fold([rec(at('robert.hall'), 'Bob Hall'), rec(at('bob.hall'), 'Bob Hall'), rec(at('bhall'), 'Bob Hall')]);
  assert.deepEqual(three.people.map((p) => [p.email, p.canonical, p.fold]), [
    [at('robert.hall'), at('bob.hall'), 'display_name'],
    [at('bob.hall'), at('bob.hall'), null],
    [at('bhall'), at('bob.hall'), 'display_name'],
  ]);
  assert.deepEqual(folded([rec(at("o'neal.winfree"), "Winfree, O'Neal"), rec(at('d..winfree'), "O'Neal Winfree")], "o'neal.winfree"), [at('d..winfree'), 'display_name'], 'no first.last: the lowest');
  assert.deepEqual(folded([rec(at('a.b'), 'Bob'), rec(at('c.d'), 'Bob')], 'a.b'), [at('a.b'), null], 'one word is no key');
  // The key leaves initials out, so two middle initials in one group are two people; a name with
  // no initial does not stop the fold.
  const lees = (other: string) => fold([rec(at('alan.lee'), 'Alan A Lee'), rec('alan.lee@ect.enron.com', other)]).of(at('alan.lee'));
  assert.deepEqual([lees('Alan B Lee').canonical, lees('Alan B Lee').fold], [at('alan.lee'), null], 'Alan A Lee and Alan B Lee');
  assert.deepEqual([lees('Lee, Alan B.').canonical, lees('Lee, Alan B.').fold], [at('alan.lee'), null]);
  assert.deepEqual([lees('Alan A Lee').canonical, lees('Alan A Lee').fold], ['alan.lee@ect.enron.com', 'display_name']);
  assert.deepEqual([lees('Alan Lee').canonical, lees('Alan Lee').fold], ['alan.lee@ect.enron.com', 'display_name']);
});

test('identity R2 and R3: m..last onto the one first.m.last; onto the one first.last only when a display name shows the middle initial', () => {
  const farmers = [rec(at('j..farmer')), rec(at('daren.j.farmer')), rec(at('daren.farmer'), 'Daren J Farmer')];
  const f = fold(farmers);
  assert.deepEqual([f.of(at('j..farmer')).canonical, f.of(at('j..farmer')).fold], [at('daren.farmer'), 'middle_initial'], 'R2 beats R3, and the chain is followed');
  assert.deepEqual([f.of(at('daren.j.farmer')).canonical, f.of(at('daren.j.farmer')).fold], [at('daren.farmer'), 'first_last']);
  assert.deepEqual(folded([rec(at('j..farmer')), rec(at('daren.j.farmer')), rec(at('dan.j.farmer')), rec(at('daren.farmer'), 'Daren J Farmer')], 'j..farmer'), [at('j..farmer'), null], 'two first.m.last: ambiguous, and no R3');
  // R3: the middle initial must be shown, in the candidate's own name or a name folding into it.
  const herod = (name: string | null, ...more: PersonCounts[]) => folded([rec(at('f..herod')), rec(at('brenda.herod'), name), ...more], 'f..herod');
  assert.deepEqual(herod('Brenda F Herod'), [at('brenda.herod'), 'last_name']);
  assert.deepEqual(herod('Herod, Brenda F.'), [at('brenda.herod'), 'last_name']);
  for (const name of ['Brenda G Herod', 'Herod, Brenda G.', 'Brenda Herod', null]) assert.deepEqual(herod(name), [at('f..herod'), null], String(name));
  assert.deepEqual(herod(null, rec(at('bherod'), 'Brenda F Herod')), [at('brenda.herod'), 'last_name'], 'the initial shown by an address folding into her');
  assert.deepEqual(herod('Brenda F Herod', rec(at('anne.herod'))), [at('f..herod'), null], 'two first.last: ambiguous');
  // Uniqueness counts every shape: another Herod with another first initial makes the last name ambiguous.
  assert.deepEqual(herod('Brenda F Herod', rec(at('kherod'))), [at('f..herod'), null], 'kherod is a K. Herod');
  assert.deepEqual(herod('Brenda F Herod', rec(at('karl.x.herod'))), [at('f..herod'), null]);
  assert.deepEqual(herod('Brenda F Herod', rec(at('bherod')), rec(at('b..herod'))), [at('brenda.herod'), 'last_name'], 'the same initial, or none known, is no other person');
  assert.deepEqual(middleInitial('Love, Phillip M.'), 'm');
  assert.deepEqual([middleInitial('Phillip M Love'), middleInitial('Phillip Love'), middleInitial(null)], ['m', null, null]);
});

test('identity R4 and R5: first.m.last onto first.last; flast onto the one f*.last, at any priced domain', () => {
  assert.deepEqual(folded([rec(at('carey.m.metz')), rec(at('carey.metz'))], 'carey.m.metz'), [at('carey.metz'), 'first_last']);
  assert.deepEqual(folded([rec(at('dfarmer')), rec(at('daren.farmer'))], 'dfarmer'), [at('daren.farmer'), 'initial_last']);
  const giron = fold([rec('dgiron@ect.enron.com'), rec(at('darron.giron'))]).of('dgiron@ect.enron.com');
  assert.deepEqual([giron.canonical, giron.fold], [at('darron.giron'), 'initial_last'], 'across priced domains');
  assert.deepEqual(folded([rec(at('mary')), rec(at('m.ary')), rec(at('mike.ary'))], 'mary'), [at('mary'), null], 'two candidates: no fold');
  assert.deepEqual(folded([rec(at('mary')), rec(at('paul.ary'))], 'mary'), [at('mary'), null], 'mary is m + ary, and no m*.ary exists');
  // Uniqueness for R5: the address gives its initial, so only a rival with the same initial counts.
  // A G. Giron cannot be dgiron; Darron's own first.m.last and his other dgiron are no rival.
  const girons = [rec(at('dgiron')), rec('dgiron@ect.enron.com'), rec(at('darron.giron')), rec(at('darron.c.giron')), rec(at('c..giron')), rec(at('gustavo.giron')), rec(at('g..giron'))];
  assert.deepEqual(folded(girons, 'dgiron'), [at('darron.giron'), 'initial_last']);
  // Any shape that names another D. first name is a rival: a second first.last is a second
  // candidate, and a first.m.last names one too.
  assert.deepEqual(folded([...girons, rec(at('david.giron'))], 'dgiron'), [at('dgiron'), null], 'david.giron');
  assert.deepEqual(folded([...girons, rec(at('dale.r.giron'))], 'dgiron'), [at('dgiron'), null], 'dale.r.giron');
  assert.deepEqual(folded([rec(at('jyoung')), rec(at('jackie.young')), rec(at('becky.young')), rec(at('w..young'))], 'jyoung'), [at('jackie.young'), 'initial_last'], 'other initials, or none, are no rival');
  const outside = fold([rec('dgiron@calpine.com'), rec(at('darron.giron'))]).of('dgiron@calpine.com');
  assert.deepEqual([outside.canonical, outside.fold], ['dgiron@calpine.com', null], 'an outside address never folds');
  assert.deepEqual(folded([rec(at('dgiron')), rec('darron.giron@calpine.com')], 'dgiron'), [at('dgiron'), null], 'nor is it a candidate');
});

test('identity: two addresses in one message are two people, and never fold together, whatever the rule', () => {
  const together = (a: string, b: string) => [a, b].sort().join(' ') === [at('edward.d.gottlob'), at('edward.gottlob')].sort().join(' ');
  const records = [rec(at('edward.d.gottlob')), rec(at('edward.gottlob'), 'Edward D Gottlob')];
  assert.deepEqual(folded(records, 'edward.d.gottlob'), [at('edward.gottlob'), 'first_last']);
  assert.deepEqual(folded(records, 'edward.d.gottlob', together), [at('edward.d.gottlob'), null]);
  // Built from the headers: From, To and Cc of any one message.
  const m = (from: string, to: string[], cc: string[] = []): ParsedMessage => msg({ from: addr(from), to: to.map((e) => addr(e)), cc: cc.map((e) => addr(e)) });
  const pairs = togetherIn([m(at('e..estrada'), [at('pat.ray')], [at('israel.estrada')]), m(at('pat.ray'), [at('kim.lee')])]);
  assert.deepEqual([pairs(at('e..estrada'), at('israel.estrada')), pairs(at('israel.estrada'), at('pat.ray')), pairs(at('e..estrada'), at('kim.lee')), pairs(at('pat.ray'), at('pat.ray'))], [true, true, false, false]);
  assert.deepEqual(folded([rec(at('e..estrada')), rec(at('israel.estrada'), 'Israel E Estrada')], 'e..estrada', pairs), [at('e..estrada'), null]);
  assert.deepEqual(folded([rec(at('e..estrada')), rec(at('israel.estrada'), 'Israel E Estrada')], 'e..estrada'), [at('israel.estrada'), 'last_name']);
});

test('identity: the refusal covers the whole identity on both sides, not just the two addresses linked', () => {
  const pair = (x: string, y: string) => (a: string, b: string) => [a, b].sort().join(' ') === [at(x), at(y)].sort().join(' ');
  // j..farmer shares a message with dfarmer, already folded under daren.farmer: two people.
  const farmers = [rec(at('daren.farmer'), 'Daren J Farmer'), rec(at('dfarmer')), rec(at('j..farmer'))];
  const f = fold(farmers, pair('dfarmer', 'j..farmer'));
  assert.deepEqual([f.of(at('dfarmer')).canonical, f.of(at('dfarmer')).fold], [at('daren.farmer'), 'initial_last']);
  assert.deepEqual([f.of(at('j..farmer')).canonical, f.of(at('j..farmer')).fold], [at('j..farmer'), null]);
  assert.deepEqual(folded(farmers, 'j..farmer'), [at('daren.farmer'), 'last_name'], 'without the shared message it folds');
  // The other side: cmetz is one with carey.m.metz by display name and shares a message with
  // carey.metz, so carey.m.metz (and cmetz with it) stays apart from carey.metz.
  const metz = [rec(at('carey.m.metz'), 'Carey Metz'), rec(at('cmetz'), 'Carey Metz'), rec(at('carey.metz'))];
  const g = fold(metz, pair('cmetz', 'carey.metz'));
  assert.deepEqual(g.people.map((p) => [p.email, p.canonical, p.fold]), [
    [at('carey.m.metz'), at('carey.m.metz'), null],
    [at('cmetz'), at('carey.m.metz'), 'display_name'],
    [at('carey.metz'), at('carey.metz'), null],
  ]);
  assert.deepEqual(folded(metz, 'carey.m.metz'), [at('carey.metz'), 'first_last']);
});

test('identity: a directory written before the folds is refused, never read as one person per address', () => {
  const stale = [rec(at('daren.farmer'), 'Daren J Farmer'), rec(at('dfarmer'))] as unknown as Person[];
  assert.throws(() => identityOf(stale, IDENTITY_RATES), (e: unknown) => e instanceof IdentityError && e.message === STALE_PEOPLE);
  assert.equal(STALE_PEOPLE, 'out/people.json predates identity folding: run node obs.mjs prepare.');
  assert.doesNotThrow(() => identityOf(foldPeople(stale, IDENTITY_RATES), IDENTITY_RATES));
});

test('identity: a digit, apostrophe, hyphen, underscore or quote in the local part matches no shape', () => {
  for (const local of ['j2..farmer', "j'..farmer", 'daren-j.farmer', 'd_farmer', '"dfarmer"', "'dfarmer", 'daren.farmer2']) assert.equal(shapeOf(at(local)), null, local);
  assert.deepEqual(['daren.farmer', 'daren.j.farmer', 'j..farmer', 'dfarmer', 'dfa'].map((l) => shapeOf(at(l))?.shape ?? null), ['FL', 'FML', 'ML', 'IL', null]);
  assert.deepEqual(folded([rec(at("'dfarmer")), rec(at('daren.farmer'))], "'dfarmer"), [at("'dfarmer"), null]);
});

test('identity: lists and system senders by their addresses; neither ever folds nor receives a fold', () => {
  for (const local of ['shift.dl-portland', 'dl-ga-all_enron_worldwide1', 'everyone_in_ect_houston', 'all.worldwide']) assert.equal(kindOf(at(local), IDENTITY_RATES), 'list', local);
  for (const local of ['adler.smith', 'allen.jones', 'randl.smith', 'mandl.x', 'dlsmith']) assert.equal(kindOf(at(local), IDENTITY_RATES), 'person', local);
  assert.equal(kindOf('no.address@enron.com', IDENTITY_RATES), 'system');
  assert.equal(kindOf('enron_update@concureworkplace.com', IDENTITY_RATES), 'system', 'local@ at any domain');
  assert.equal(kindOf('crcommunications@caiso.com', IDENTITY_RATES), 'system', '@domain: every address there');
  assert.equal(kindOf('ops@ops.caiso.com', IDENTITY_RATES), 'person', 'the domain itself, not its subdomains');
  assert.equal(isSystemAddress('NO.ADDRESS@ENRON.COM', IDENTITY_RATES.system_senders), true);
  // A system sender would be the only candidate for n..address, and a list carries a person's
  // display name: neither folds or takes a fold. As a person, the system address would.
  const records = [rec(at('no.address'), 'Nina N Address'), rec(at('n..address')), rec(at('dl.smith'), 'Dee Smith'), rec(at('dee.smith'), 'Dee Smith')];
  assert.deepEqual(fold(records).people.map((p) => [p.email, p.kind, p.canonical, p.fold]), [
    [at('no.address'), 'system', at('no.address'), null],
    [at('n..address'), 'person', at('n..address'), null],
    [at('dl.smith'), 'list', at('dl.smith'), null],
    [at('dee.smith'), 'person', at('dee.smith'), null],
  ]);
  assert.deepEqual(foldPeople(records, { ...IDENTITY_RATES, system_senders: [] }).map((p) => [p.canonical, p.fold]), [
    [at('no.address'), null],
    [at('no.address'), 'last_name'],
    [at('dl.smith'), null],
    [at('dee.smith'), null],
  ]);
});

test('identity: chains are followed, the display name falls back through the addresses, a cycle throws', () => {
  const f = fold([rec(at('a..allen')), rec(at('lauri.a.allen'), 'Allen, Lauri A.'), rec(at('lauri.allen'))]);
  assert.deepEqual(f.people.map((p) => [p.email, p.canonical, p.fold]), [
    [at('a..allen'), at('lauri.allen'), 'middle_initial'],
    [at('lauri.a.allen'), at('lauri.allen'), 'first_last'],
    [at('lauri.allen'), at('lauri.allen'), null],
  ]);
  const id = identityOf(f.people, IDENTITY_RATES);
  assert.equal(id.displayName(at('lauri.allen')), 'Allen, Lauri A.', 'the first name an address of hers carries');
  assert.deepEqual(id.addresses(at('lauri.allen')), [at('lauri.allen'), at('a..allen'), at('lauri.a.allen')]);
  assert.deepEqual([id.canonical(at('a..allen')), id.canonical('stranger@calpine.com')], [at('lauri.allen'), 'stranger@calpine.com']);
  assert.deepEqual([id.kind('stranger@calpine.com'), id.kind(at('no.address')), id.addresses('stranger@calpine.com')], ['person', 'system', ['stranger@calpine.com']]);
  assert.deepEqual([id.pricedParty(at('lauri.allen')), id.pricedParty(at('no.address')), id.pricedParty('ops@pipeco.com'), id.pricedParty(at('shift.dl-portland'))], [true, false, false, true]);
  assert.deepEqual([id.staff(at('lauri.allen')), id.staff(at('shift.dl-portland')), id.staff(at('no.address'))], [true, false, false]);
  assert.throws(() => followFolds(at('x'), new Map([[at('x'), { to: at('y') }], [at('y'), { to: at('x') }]])), /form a cycle/);
  // A display-name group with no first.last address, whose canonical would fold onto its own member:
  // they are one already, and nothing loops.
  const loop = fold([rec(at('a..allen'), 'Lauri Allen'), rec(at('lauri.a.allen'), 'Lauri Allen')]);
  assert.deepEqual(loop.people.map((p) => [p.email, p.canonical, p.fold]), [
    [at('a..allen'), at('a..allen'), null],
    [at('lauri.a.allen'), at('a..allen'), 'display_name'],
  ]);
});

test('identity: the records keep every counted field byte for byte; the stats count folds, ambiguous m..last addresses, lists and systems', () => {
  const records = [rec(at('j..farmer')), rec(at('daren.farmer'), 'Daren J Farmer'), rec(at('dfarmer')), rec(at('d..smith')), rec(at('dan.smith')), rec(at('dave.smith')), rec(at('shift.dl-portland')), rec(at('no.address')), rec('x@calpine.com')];
  const people = foldPeople(records, IDENTITY_RATES);
  assert.deepEqual(people.map(({ kind: _k, canonical: _c, fold: _f, ...counts }) => counts), records);
  assert.deepEqual(Object.keys(people[0] as Person), ['email', 'name', 'sent', 'received', 'priced', 'kind', 'canonical', 'fold']);
  assert.deepEqual(identityOf(people, IDENTITY_RATES).stats, { folds: { display_name: 0, middle_initial: 0, last_name: 1, first_last: 0, initial_last: 1 }, ambiguous: 1, lists: 1, system: 1 });
});
