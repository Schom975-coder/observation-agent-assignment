import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadEffortRates } from '../src/config.ts';
import { openCorpus } from '../src/corpus/reader.ts';
import { classifyOccurrence, countActions, isPricedEmail } from '../src/metrics/actions.ts';
import { parseMessage } from '../src/parse/message.ts';
import type { Address, ParsedMessage, SegmentKind } from '../src/types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const rates = loadEffortRates(fileURLToPath(new URL('../config/effort-rates.json', import.meta.url)));

const addr = (email: string): Address => ({ email, name: null });
const segs = (...kinds: SegmentKind[]) => kinds.map((kind, i) => ({ kind, start: i * 10, end: i * 10 + 10 }));

let nextId = 100;

// A parsed message with ordinary defaults: a fresh send from an enron.com address with no recipients.
function msg(from: string | null, over: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    id: `corpus/test-a/inbox/${nextId++}.`,
    blob_sha: '0'.repeat(40),
    mailbox: 'test-a',
    folder: 'inbox',
    message_id: null,
    date_raw: null,
    date_utc: null,
    date_status: 'missing',
    from: from === null ? null : addr(from),
    to: [],
    cc: [],
    subject: 'Gas volumes',
    subject_norm: 'gas volumes',
    reply_or_forward_subject: false,
    body_start: 0,
    body_chars: 0,
    segments: segs('own'),
    own_chars: 50,
    fresh_send: true,
    flags: { oversize: false, suspected_injection: false, injection_markers: [] },
    ...over,
  };
}

const reply = (from: string | null, over: Partial<ParsedMessage> = {}) =>
  msg(from, { subject: 'RE: Gas volumes', reply_or_forward_subject: true, fresh_send: false, segments: segs('own', 'quoted'), ...over });
const forward = (from: string | null, over: Partial<ParsedMessage> = {}) =>
  msg(from, { subject: 'FW: Gas volumes', reply_or_forward_subject: true, fresh_send: false, segments: segs('own', 'forwarded'), ...over });

// Every message tagged unless a narrower list is given.
const classify = (messages: ParsedMessage[], tagged: ParsedMessage[] = messages) =>
  classifyOccurrence(messages, new Set(tagged.map((m) => m.id)), rates);
const authored = (messages: ParsedMessage[], tagged?: ParsedMessage[]) => classify(messages, tagged).map((a) => a.authored);

test('the committed buckets are 300 and 1,500 characters, which the edge tests below rely on', () => {
  assert.deepEqual(rates.own_chars_buckets, { short_max: 300, medium_max: 1500 });
  assert.equal(rates.read_cap_per_message, 5);
});

test('isPricedEmail: listed domain and its subdomains, any case', () => {
  assert.equal(isPricedEmail('a@enron.com', ['enron.com']), true);
  assert.equal(isPricedEmail('a@ect.enron.com', ['enron.com']), true);
  assert.equal(isPricedEmail('a@na.ect.enron.com', ['enron.com']), true);
  assert.equal(isPricedEmail('Pete.Davis@ENRON.COM', ['enron.com']), true);
  assert.equal(isPricedEmail('a@enron.com', ['ENRON.COM']), true);
  assert.equal(isPricedEmail('b@example.org', ['enron.com', 'example.org']), true);
});

test('isPricedEmail: lookalike domains are not priced', () => {
  for (const email of ['a@notenron.com', 'a@enron.com.example.org', 'a@enron.co', 'a@enron.comm', 'a@calpine.com']) {
    assert.equal(isPricedEmail(email, ['enron.com']), false, email);
  }
});

test('isPricedEmail: malformed addresses are not priced', () => {
  const malformed = [
    '',
    'enron.com',
    '@enron.com',
    'a@',
    'a@@enron.com',
    'a@b@enron.com',
    'a@enron..com',
    'a@.enron.com',
    'a@enron.com.',
    'a b@enron.com',
    ' a@enron.com',
    'Davis, Pete',
    '/o=enron/ou=na/cn=recipients/cn=pdavis',
  ];
  for (const email of malformed) assert.equal(isPricedEmail(email, ['enron.com']), false, JSON.stringify(email));
});

test('daily same-subject fresh sends from one external sender are never chasers', () => {
  // Replica of the 18 "Calpine Daily Gas Nomination" emails: same sender, same subject, all fresh
  // sends. Classified side by side (the worst case for adjacency) and one per occurrence.
  const daily = Array.from({ length: 18 }, (_, i) =>
    msg('scheduler@calpine.com', {
      id: `corpus/test-b/logistics/${1000 + i}.`,
      subject: 'Calpine Daily Gas Nomination',
      subject_norm: 'calpine daily gas nomination',
      own_chars: 420,
      to: [addr('logistics.lead@enron.com')],
      cc: [addr('desk.a@enron.com'), addr('desk.b@enron.com')],
    }),
  );
  const together = classify(daily);
  assert.equal(together.length, 18);
  for (const a of together) {
    assert.equal(a.authored, 'authored_medium', a.id);
    assert.equal(a.sender_priced, false, a.id);
    assert.deepEqual(a.reads, [
      { email: 'logistics.lead@enron.com', priced: true },
      { email: 'desk.a@enron.com', priced: true },
      { email: 'desk.b@enron.com', priced: true },
    ]);
  }
  assert.deepEqual(daily.flatMap((m) => classify([m])), together);
  const counts = countActions(together);
  assert.equal(counts.unpriced.authored_medium, 18);
  assert.equal(counts.priced.read, 18 * 3);
  assert.equal(counts.unpriced.chaser + counts.priced.chaser, 0);
});

// Who the trader keeps asking in the chaser tests.
const asked = { to: [addr('scheduler@calpine.com')] };

test('a RE: follow-up to the same people after the sender\'s unanswered message is a chaser', () => {
  const ask = msg('trader@enron.com', asked);
  const nudge = reply('trader@enron.com', asked);
  const again = reply('trader@enron.com', asked);
  assert.deepEqual(authored([ask, nudge, again]), ['authored_short', 'chaser', 'chaser']);
});

test('the same item sent on to different people in turn is not a chaser', () => {
  // Replica of one person forwarding an item to one colleague, then another, minutes apart.
  const first = forward('trader@enron.com', { to: [addr('desk.a@enron.com')] });
  const second = forward('trader@enron.com', { to: [addr('desk.b@enron.com')] });
  assert.deepEqual(authored([first, second]), ['forward', 'forward']);
  // Back to someone already asked: a chaser.
  const third = forward('trader@enron.com', { to: [addr('desk.b@enron.com'), addr('desk.c@enron.com')] });
  assert.deepEqual(authored([first, second, third]), ['forward', 'forward', 'chaser']);
});

test('a reply by someone else in between breaks the chaser', () => {
  const ask = msg('trader@enron.com', asked);
  const answer = reply('scheduler@calpine.com', { to: [addr('trader@enron.com')] });
  const followUp = reply('trader@enron.com', asked);
  const nudge = reply('trader@enron.com', asked);
  assert.deepEqual(authored([ask, answer, followUp, nudge]), ['authored_short', 'authored_short', 'authored_short', 'chaser']);
});

test('untagged messages produce nothing but still count for chaser adjacency', () => {
  const ask = msg('trader@enron.com', asked);
  const answer = reply('scheduler@calpine.com', { to: [addr('trader@enron.com')] });
  const followUp = reply('trader@enron.com', asked);
  // Untagged reply by someone else between two tagged messages from one sender: no chaser.
  assert.deepEqual(
    classify([ask, answer, followUp], [ask, followUp]).map((a) => [a.id, a.authored]),
    [
      [ask.id, 'authored_short'],
      [followUp.id, 'authored_short'],
    ],
  );
  // Untagged message by the same sender just before a tagged follow-up: a chaser.
  const nudge = reply('trader@enron.com', asked);
  assert.deepEqual(
    classify([ask, nudge], [nudge]).map((a) => [a.id, a.authored]),
    [[nudge.id, 'chaser']],
  );
});

test('a message with no sender, or after one, is never a chaser', () => {
  // Shared recipients throughout, so only the missing sender can stop a chaser.
  const first = reply(null, asked);
  const second = reply(null, asked);
  const third = reply('trader@enron.com', asked);
  const fourth = reply('trader@enron.com', { ...asked, from: addr('') });
  const actions = classify([first, second, third, fourth]);
  assert.deepEqual(
    actions.map((a) => a.authored),
    ['authored_short', 'authored_short', 'authored_short', 'authored_short'],
  );
  assert.equal(actions[0]?.sender_priced, false);
});

test('chaser takes precedence over forward', () => {
  const ask = msg('trader@enron.com', asked);
  const resend = forward('trader@enron.com', asked);
  assert.deepEqual(authored([ask, resend]), ['authored_short', 'chaser']);
});

test('a "Forwarded by" deep in quoted history does not make a reply a forward', () => {
  const cases: Array<[ParsedMessage, string]> = [
    // Reply whose quoted original itself contained a forward: still a short reply.
    [reply('trader@enron.com', { subject: 'Re: Meters', segments: segs('own', 'quoted', 'forwarded') }), 'authored_short'],
    // The message's own first earlier block is the forward banner: a forward, whatever the subject.
    [reply('trader@enron.com', { subject: 'Re: Meters', segments: segs('own', 'forwarded', 'quoted') }), 'forward'],
  ];
  for (const [m, expected] of cases) assert.deepEqual(authored([m]), [expected], m.segments.map((s) => s.kind).join(','));
});

// Seam check: what the real parser emits for real emails, run through the classifier.
// Each expectation was read off the raw message by hand.
test('real corpus emails, parsed then classified', () => {
  const corpus = openCorpus(root);
  const expected: Array<[string, string]> = [
    ['corpus/farmer-d/logistics/1046.', 'authored_short'], // "Re: Meters": 1-line question; quoted Lotus reply holds an old forward
    ['corpus/farmer-d/logistics/1001.', 'forward'], // 49-char note above a "Forwarded by" banner
    ['corpus/farmer-d/logistics/1096.', 'forward'], // "FW:" subject, short note, original quoted with ">"
    ['corpus/farmer-d/logistics/10.', 'authored_short'], // "RE:" reply above "-----Original Message-----"
    ['corpus/farmer-d/logistics/1027.', 'authored_short'], // Calpine daily nomination: fresh send, short note
  ];
  for (const [id, want] of expected) {
    const entry = corpus.entries.find((e) => e.id === id);
    assert.ok(entry !== undefined, id);
    const m = parseMessage(id, entry.blob_sha, corpus.read(id));
    assert.deepEqual(authored([m]), [want], id);
  }
});

test('a forward needs a forwarded block or FW:/FWD: subject and a short note', () => {
  const lead = msg('desk.a@enron.com');
  // Each case follows a message from someone else so it cannot be a chaser.
  const cases: Array<[ParsedMessage, string]> = [
    [forward('trader@enron.com', { own_chars: 40 }), 'forward'],
    [forward('trader@enron.com', { own_chars: 300 }), 'forward'],
    [forward('trader@enron.com', { own_chars: 301 }), 'authored_medium'],
    [forward('trader@enron.com', { own_chars: 1800 }), 'authored_long'],
    // Forwarded block under a subject that does not say so.
    [forward('trader@enron.com', { subject: 'Gas volumes', reply_or_forward_subject: false }), 'forward'],
    // FW:/Fwd: subject where the parser found no forwarded block (e.g. forwarded as an attachment).
    [forward('trader@enron.com', { subject: 'Fwd: Gas volumes', segments: segs('own'), own_chars: 0 }), 'forward'],
    [forward('trader@enron.com', { subject: 'fw: Gas volumes', segments: segs('own') }), 'forward'],
    // Same prefix grammar as the parser: bracketed and spaced forms are forwards too.
    [forward('trader@enron.com', { subject: '[Fwd: Gas volumes]', segments: segs('own') }), 'forward'],
    [forward('trader@enron.com', { subject: 'Fw : Gas volumes', segments: segs('own') }), 'forward'],
    // A short reply that only quotes the original is a short written email, not a forward.
    [reply('trader@enron.com', { own_chars: 60 }), 'authored_short'],
    // A reply to a forward quotes it; the subject starts with RE:, so it is a reply.
    [reply('trader@enron.com', { subject: 'RE: FW: Gas volumes' }), 'authored_short'],
  ];
  for (const [m, expected] of cases) {
    assert.deepEqual(authored([lead, m], [m]), [expected], `${m.subject} / ${m.segments.map((s) => s.kind)} / ${m.own_chars}`);
  }
});

test('own-text buckets: <= 300 short, <= 1,500 medium, longer is long', () => {
  const edges: Array<[number, string]> = [
    [0, 'authored_short'],
    [300, 'authored_short'],
    [301, 'authored_medium'],
    [1500, 'authored_medium'],
    [1501, 'authored_long'],
  ];
  for (const [ownChars, expected] of edges) {
    assert.deepEqual(authored([msg('trader@enron.com', { own_chars: ownChars })]), [expected], String(ownChars));
  }
});

test('reads: To then Cc, each address once, sender excluded, capped at 5', () => {
  const m = msg('trader@enron.com', {
    to: [addr('r1@enron.com'), addr('trader@enron.com'), addr('R2@Enron.com')],
    cc: [addr('r2@enron.com'), addr('r3@calpine.com'), addr('r4@ect.enron.com'), addr('r5@enron.com'), addr('r6@enron.com')],
  });
  assert.deepEqual(classify([m])[0]?.reads, [
    { email: 'r1@enron.com', priced: true },
    { email: 'r2@enron.com', priced: true },
    { email: 'r3@calpine.com', priced: false },
    { email: 'r4@ect.enron.com', priced: true },
    { email: 'r5@enron.com', priced: true },
  ]);
});

test('reads: a sender writing only to themselves, or to nobody, makes no reads', () => {
  const self = msg('trader@enron.com', { to: [addr('trader@enron.com')], cc: [addr('TRADER@enron.com')] });
  const none = msg('trader@enron.com');
  assert.deepEqual(classify([self, none]).map((a) => a.reads), [[], []]);
});

test('sender_priced follows the sender\'s domain', () => {
  const actions = classify([msg('a@enron.com'), msg('b@ect.enron.com'), msg('c@calpine.com'), msg(null)]);
  assert.deepEqual(actions.map((a) => a.sender_priced), [true, true, false, false]);
});

test('countActions on a hand-counted occurrence', () => {
  // m1 external fresh send, 900 own chars  -> authored_medium, unpriced; reads a, b priced; x unpriced
  // m2 a replies, 120 own chars            -> authored_short, priced;   reads ops unpriced; b priced
  // m3 a again, right after m2             -> chaser, priced;           reads ops unpriced
  // m4 b forwards with a 40-char note      -> forward, priced;          reads c, d (subdomain), a priced
  // m5 d replies, untagged                 -> nothing
  // m6 c replies after d, 2,000 own chars  -> authored_long, priced;    reads b priced
  const m1 = msg('ops@calpine.com', { own_chars: 900, to: [addr('a@enron.com')], cc: [addr('b@enron.com'), addr('x@calpine.com')] });
  const m2 = reply('a@enron.com', { own_chars: 120, to: [addr('ops@calpine.com')], cc: [addr('b@enron.com')] });
  const m3 = reply('a@enron.com', { own_chars: 80, to: [addr('ops@calpine.com')] });
  const m4 = forward('b@enron.com', { own_chars: 40, to: [addr('c@enron.com'), addr('d@ect.enron.com'), addr('a@enron.com')] });
  const m5 = reply('d@ect.enron.com', { own_chars: 30, to: [addr('b@enron.com')] });
  const m6 = reply('c@enron.com', { own_chars: 2000, to: [addr('b@enron.com')] });
  const actions = classify([m1, m2, m3, m4, m5, m6], [m1, m2, m3, m4, m6]);
  assert.deepEqual(
    actions.map((a) => a.authored),
    ['authored_medium', 'authored_short', 'chaser', 'forward', 'authored_long'],
  );
  assert.deepEqual(countActions(actions), {
    priced: { authored_short: 1, authored_medium: 0, authored_long: 1, forward: 1, chaser: 1, read: 2 + 1 + 0 + 3 + 1 },
    unpriced: { authored_short: 0, authored_medium: 1, authored_long: 0, forward: 0, chaser: 0, read: 1 + 1 + 1 },
  });
});

test('countActions with no actions has every type at zero', () => {
  const zero = { authored_short: 0, authored_medium: 0, authored_long: 0, forward: 0, chaser: 0, read: 0 };
  assert.deepEqual(countActions([]), { priced: zero, unpriced: zero });
});
