import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicates } from '../src/normalize/dedup.ts';
import { buildPeople } from '../src/normalize/people.ts';
import { buildThreads } from '../src/normalize/threads.ts';
import { isForwardSubject, isReplyOrForward, normalizeSubject, parseAddressList, splitHeaders } from '../src/parse/headers.ts';
import type { Address, ParsedMessage } from '../src/types.ts';

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
