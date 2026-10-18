// Quote validation (ARCHITECTURE.md 6.11): exact after newline normalization, else repaired by
// whitespace collapse and mapped back to the raw span, else rejected. Offsets index into the
// whole raw message and raw_text is always the raw text at them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { shownBody } from '../src/batch/build.ts';
import { openCorpus } from '../src/corpus/reader.ts';
import { parseMessage } from '../src/parse/message.ts';
import { normalizeNewlines } from '../src/util/text.ts';
import { claimant, nameTokens } from '../src/metrics/rollup.ts';
import { QUOTE_MAX_CHARS, QUOTE_MIN_CHARS, checkQuote, mentions, quoteLength } from '../src/validate/quotes.ts';
import type { ParsedMessage, QuoteCheck } from '../src/types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const corpus = openCorpus(root);
const SHA = 'f'.repeat(40);

const HEADERS = ['Date: Mon, 14 May 2001 10:00:00 -0700 (PDT)', 'From: jane.doe@enron.com', 'To: bob.smith@enron.com', 'Subject: Meter 1234 volumes for June'];

// A raw message from header lines and body lines joined with `eol`, and its parse.
function message(body: string[], eol = '\r\n', headers = HEADERS): { raw: string; m: ParsedMessage } {
  const raw = [...headers, '', ...body].join(eol);
  return { raw, m: parseMessage('corpus/test-q/inbox/1.', SHA, Buffer.from(raw, 'utf8')) };
}

function real(id: string): { raw: string; m: ParsedMessage } {
  const entry = corpus.entries.find((e) => e.id === id);
  assert.ok(entry !== undefined, id);
  const bytes = corpus.read(id);
  return { raw: bytes.toString('utf8'), m: parseMessage(id, entry.blob_sha, bytes) };
}

// Every located quote: raw_text is the raw text at its offsets.
function assertLocated(raw: string, c: QuoteCheck, match: 'exact' | 'repaired'): asserts c is QuoteCheck & { start: number; end: number; raw_text: string } {
  assert.equal(c.match, match, JSON.stringify(c));
  assert.equal(c.reason, null);
  assert.ok(c.start !== null && c.end !== null && c.raw_text !== null);
  assert.equal(raw.slice(c.start, c.end), c.raw_text);
}

const collapse = (s: string) => s.replace(/\s+/g, ' ');

test('exact: a substring of the body, located at its raw offsets in the own segment', () => {
  const { raw, m } = message(['Bob,', '', 'Please confirm the June volumes for meter 1234 today.', '', 'Jane']);
  const quote = 'Please confirm the June volumes for meter 1234 today.';
  const c = checkQuote(raw, m, quote, 'body');
  assertLocated(raw, c, 'exact');
  assert.equal(c.raw_text, quote);
  assert.equal(c.start, raw.indexOf(quote));
  assert.equal(c.end, raw.indexOf(quote) + quote.length);
  assert.equal(c.segment, 'own');
  // Surrounding whitespace in the quote is trimmed, not matched.
  assert.deepEqual(checkQuote(raw, m, `  ${quote}\n`, 'body'), c);
});

test('CRLF vs LF: a quote spanning line breaks matches either way and keeps the raw line endings', () => {
  const body = ['Volumes for June are below.', 'Meter 1234: 5,000 MMBtu/d', 'Meter 5678: 2,500 MMBtu/d', 'Thanks'];
  const lfQuote = 'Volumes for June are below.\nMeter 1234: 5,000 MMBtu/d';
  for (const eol of ['\r\n', '\n', '\r']) {
    const { raw, m } = message(body, eol);
    for (const quote of [lfQuote, lfQuote.replace('\n', '\r\n'), lfQuote.replace('\n', '\r')]) {
      const c = checkQuote(raw, m, quote, 'body');
      assertLocated(raw, c, 'exact');
      assert.equal(c.raw_text, lfQuote.replace('\n', eol), `${JSON.stringify(eol)} ${JSON.stringify(quote)}`);
      assert.equal(c.start, raw.indexOf('Volumes for June'));
    }
  }
});

test('repaired: a quote that lost its line wrap maps back to the precise raw span, CRLF and trailing space included', () => {
  const { raw, m } = message(['Gary, production from the High Island block commenced on ', 'Saturday at 2:00 p.m. at about 6,500 gross.', 'More later.']);
  const c = checkQuote(raw, m, 'production from the High Island block commenced on Saturday at 2:00 p.m.', 'body');
  assertLocated(raw, c, 'repaired');
  assert.equal(c.raw_text, 'production from the High Island block commenced on \r\nSaturday at 2:00 p.m.');
  assert.equal(c.start, raw.indexOf('production'));
  assert.equal(c.end, raw.indexOf('2:00 p.m.') + '2:00 p.m.'.length);
  assert.equal(c.segment, 'own');
  // Extra whitespace in the quote is repaired the same way; anything but whitespace is not.
  assert.equal(checkQuote(raw, m, 'production  from the\tHigh Island block commenced on\nSaturday', 'body').match, 'repaired');
  assert.deepEqual(checkQuote(raw, m, 'production from the High Island block commenced Saturday', 'body').reason, 'not_found');
  assert.deepEqual(checkQuote(raw, m, 'production from the high island block commenced on', 'body').reason, 'not_found');
  assert.deepEqual(checkQuote(raw, m, 'productionfrom the High Island block commenced on', 'body').reason, 'not_found');
});

test('a quote spanning a blank line in a real CRLF body: exact with \\n\\n, repaired as one line', () => {
  const { raw, m } = real('corpus/farmer-d/logistics/24.');
  assert.ok(raw.slice(m.body_start).includes('\r\n'), 'this body uses CRLF');
  const exact = checkQuote(raw, m, 'until 5 AM Monday morning.\n\nTks and let me know if you have concerns', 'body');
  assertLocated(raw, exact, 'exact');
  assert.equal(exact.raw_text, 'until 5 AM Monday morning.\r\n\r\nTks and let me know if you have concerns');
  assert.equal(exact.segment, 'own');
  const repaired = checkQuote(raw, m, 'until 5 AM Monday morning. Tks and let me know if you have concerns', 'body');
  assertLocated(raw, repaired, 'repaired');
  assert.equal(repaired.raw_text, exact.raw_text);
  assert.deepEqual([repaired.start, repaired.end], [exact.start, exact.end]);
  // Its quoted part: located in the quoted segment.
  const quoted = checkQuote(raw, m, '-----Original Message-----', 'body');
  assertLocated(raw, quoted, 'exact');
  assert.equal(quoted.segment, 'quoted');
});

test('real LF body: a quote across a wrap with a trailing space is repaired to the raw text', () => {
  const { raw, m } = real('corpus/farmer-d/logistics/1048.');
  const c = checkQuote(raw, m, 'Would there be a problem if I created a desk to desk for meter 378 for March 2000', 'body');
  assertLocated(raw, c, 'repaired');
  assert.equal(c.raw_text, 'Would there be a problem if I created a desk to desk for meter 378 \nfor  March 2000');
  assert.equal(c.segment, 'own');
});

test('subject quotes: exact inside one line, repaired across a header fold to the raw span with the fold in it', () => {
  const { raw, m } = real('corpus/farmer-d/logistics/1048.');
  assert.equal(m.subject, 'ENA 202 and HPL 216 Transport Contracts Needed at Meter 378 for March 2000');
  const inLine = checkQuote(raw, m, 'HPL 216 Transport Contracts Needed', 'subject');
  assertLocated(raw, inLine, 'exact');
  assert.equal(inLine.segment, 'subject');
  assert.ok(inLine.start > raw.indexOf('\nSubject:') && inLine.end < m.body_start, 'inside the header block');
  // The raw Subject field is folded before "March": the quote as the batch file shows it (one
  // line) is repaired, and its raw text is the folded span itself.
  const folded = checkQuote(raw, m, 'Contracts Needed at Meter 378 for March 2000', 'subject');
  assertLocated(raw, folded, 'repaired');
  assert.equal(folded.raw_text, 'Contracts Needed at Meter 378 for\r\n March 2000');
  assert.equal(folded.segment, 'subject');
  assert.equal(folded.start, raw.indexOf('Contracts Needed'));
  // The whole subject spans the fold too.
  const whole = checkQuote(raw, m, m.subject, 'subject');
  assertLocated(raw, whole, 'repaired');
  assert.equal(whole.raw_text, 'ENA 202 and HPL 216 Transport Contracts Needed at Meter 378 for\r\n March 2000');
  const repaired = checkQuote(raw, m, 'Transport  Contracts\nNeeded at Meter', 'subject');
  assertLocated(raw, repaired, 'repaired');
  assert.equal(repaired.raw_text, 'Transport Contracts Needed at Meter');
  // A subject quote is looked for in the subject only, and a body quote in the body only.
  assert.equal(checkQuote(raw, m, 'Would there be a problem if I created', 'subject').reason, 'not_found');
  const plain = message(['Numbers attached.']);
  assert.equal(checkQuote(plain.raw, plain.m, 'Meter 1234 volumes for June', 'subject').match, 'exact');
  assert.equal(checkQuote(plain.raw, plain.m, 'Meter 1234 volumes for June', 'body').reason, 'not_found');
});

test('subject quotes on folded headers: CRLF, LF and lone-CR folds, several continuation lines, the first Subject field only', () => {
  for (const eol of ['\r\n', '\n', '\r']) {
    const headers = [
      'Date: Mon, 14 May 2001 10:00:00 -0700',
      'From: jane.doe@enron.com',
      'Subject: Volumes for',
      ' June deliveries at Katy',
      '\tand Carthage hubs',
      'To: bob.smith@enron.com',
      'Subject: A second subject the parser ignores',
    ];
    const { raw, m } = message(['Body text here.'], eol, headers);
    assert.equal(m.subject, 'Volumes for June deliveries at Katy\tand Carthage hubs');
    const label = JSON.stringify(eol);
    const across = checkQuote(raw, m, 'Volumes for June deliveries', 'subject');
    assertLocated(raw, across, 'repaired');
    assert.equal(across.raw_text, `Volumes for${eol} June deliveries`, label);
    const twoFolds = checkQuote(raw, m, 'June deliveries at Katy and Carthage hubs', 'subject');
    assertLocated(raw, twoFolds, 'repaired');
    assert.equal(twoFolds.raw_text, `June deliveries at Katy${eol}\tand Carthage hubs`, label);
    const continuation = checkQuote(raw, m, 'June deliveries at Katy', 'subject');
    assertLocated(raw, continuation, 'exact');
    assert.equal(continuation.start, raw.indexOf('June deliveries'), label);
    assert.equal(checkQuote(raw, m, 'A second subject the parser ignores', 'subject').reason, 'not_found', label);
  }
});

// Every subject in the corpus, quoted whole, is accepted with a raw span: exact when it sits on
// one header line, repaired when the field is folded. Pins the number of folded subjects.
test('all corpus subjects validate as whole-subject quotes with raw offsets; folded ones are repaired', () => {
  const all = corpus.readAll();
  let exact = 0;
  let repaired = 0;
  for (const entry of corpus.entries) {
    const bytes = all.get(entry.id) as Buffer;
    const raw = bytes.toString('utf8');
    const m = parseMessage(entry.id, entry.blob_sha, bytes);
    if (m.subject === '' || quoteLength(m.subject) > QUOTE_MAX_CHARS) continue;
    const c = checkQuote(raw, m, m.subject, 'subject');
    assertLocated(raw, c, c.match === 'exact' ? 'exact' : 'repaired');
    assert.equal(c.segment, 'subject');
    assert.ok(c.end <= m.body_start, entry.id);
    assert.equal(collapse(c.raw_text), collapse(m.subject), entry.id);
    if (c.match === 'exact') {
      assert.equal(c.raw_text, m.subject, entry.id);
      exact++;
    } else {
      assert.match(c.raw_text, /\r?\n[ \t]/, `${entry.id}: repaired only across a fold`);
      repaired++;
    }
  }
  assert.equal(repaired, 79, 'messages whose Subject field is folded');
  assert.ok(exact > 3000, `${exact} single-line subjects`);
});

test('mentions: every word of the name is a whole word of the raw message, headers included, in any order and case', () => {
  const { raw, m } = message(['Only Mike  Smith can restart', 'the compressor.', 'Thanks, Gas', 'Control'], '\r\n', [
    ...HEADERS,
    'X-From: Doe, Jane </O=ENRON/OU=NA/CN=RECIPIENTS/CN=JDOE>',
  ]);
  for (const name of ['Mike Smith', 'mike smith', ' MIKE\tSMITH ', 'Smith, Mike', 'Gas Control', 'Doe, Jane', 'Jane Doe', 'jane.doe@enron.com', 'Mike S.']) {
    assert.equal(mentions(raw, m, name), true, name);
  }
  // A word the message lacks, part of a word only, or no word of two or more letters at all.
  for (const name of ['Sarah', 'Mike Jones', 'Smit', 'Michael', '', '   ', 'M. S.', '-']) assert.equal(mentions(raw, m, name), false, name);
});

test('mentions: a claim naming "Darron Giron" is found in a header "Giron, Darron C" and a body "Darron"; "Darron Jones" is not', () => {
  const { raw, m } = message(['Darron handles the daily imbalance check now.'], '\r\n', [...HEADERS, 'X-From: Giron, Darron C </O=ENRON/OU=NA/CN=RECIPIENTS/CN=DGIRON>']);
  assert.equal(mentions(raw, m, 'Darron Giron'), true);
  assert.equal(mentions(raw, m, 'Darron'), true);
  assert.equal(mentions(raw, m, 'Darron Jones'), false);
  // The same words the rollup's ownership resolver compares (4.1).
  assert.deepEqual(nameTokens("Giron, Darron C. O'Neal"), ['giron', 'darron', 'oneal']);
});

test('mentions: words scattered over two people pass (the word-level rule of 15.2); the rollup then keeps both people as a tie', () => {
  const { raw, m } = message(['Kate Fraser sends the schedule; Mark Symes checks it.'], '\r\n');
  assert.equal(mentions(raw, m, 'Kate Symes'), true, 'a name assembled from two people is accepted');
  // The resolver matches it to both, one word each, so it counts as either of them: a conflict
  // needs another claim that names neither.
  const people = [
    { email: 'kate.fraser@enron.com', name: 'Kate Fraser' },
    { email: 'mark.symes@enron.com', name: 'Mark Symes' },
  ];
  assert.deepEqual(claimant('Kate Symes', people, people), { known: ['kate.fraser@enron.com', 'mark.symes@enron.com'] });
});

test('subject quotes: a short quote is allowed only when it is the whole subject', () => {
  const headers = HEADERS.map((h) => (h.startsWith('Subject:') ? 'Subject: Gas nom' : h));
  const { raw, m } = message(['Attached.'], '\r\n', headers);
  const whole = checkQuote(raw, m, 'Gas nom', 'subject');
  assertLocated(raw, whole, 'exact');
  assert.equal(whole.segment, 'subject');
  assert.equal(whole.start, raw.indexOf('Gas nom'));
  assert.equal(checkQuote(raw, m, ' Gas  nom ', 'subject').match, 'repaired');
  assert.equal(checkQuote(raw, m, 'Gas', 'subject').reason, 'too_short');
  assert.equal(checkQuote(raw, m, 'gas nom', 'subject').reason, 'too_short');
  // In the body the same short text is too short, whole subject or not.
  assert.equal(checkQuote(raw, m, 'Gas nom', 'body').reason, 'too_short');
});

test('not found, empty, and the 20-400 character limits (counted in characters after trimming)', () => {
  const long = 'x'.repeat(QUOTE_MAX_CHARS + 50);
  const { raw, m } = message([`Short line ${long}`, 'Another line that is plain text.']);
  assert.equal(QUOTE_MIN_CHARS, 20);
  assert.equal(QUOTE_MAX_CHARS, 400);
  assert.equal(checkQuote(raw, m, 'This sentence is not in the message.', 'body').reason, 'not_found');
  for (const empty of ['', '   ', '\r\n\t']) {
    assert.deepEqual(checkQuote(raw, m, empty, 'body'), { match: 'rejected', start: null, end: null, segment: null, raw_text: null, reason: 'empty' });
  }
  assert.equal(checkQuote(raw, m, 'x'.repeat(19), 'body').reason, 'too_short');
  assert.equal(checkQuote(raw, m, `   ${'x'.repeat(19)}   `, 'body').reason, 'too_short', 'trimmed before counting');
  assert.equal(checkQuote(raw, m, 'x'.repeat(20), 'body').match, 'exact');
  assert.equal(checkQuote(raw, m, 'x'.repeat(400), 'body').match, 'exact');
  assert.equal(checkQuote(raw, m, 'x'.repeat(401), 'body').reason, 'too_long');
  assert.equal(checkQuote(raw, m, 'x'.repeat(401), 'subject').reason, 'too_long');
  // Characters, not UTF-16 units: 20 emoji are 20 characters.
  assert.equal(quoteLength('\u{1F600}'.repeat(20)), 20);
  assert.equal(quoteLength(`  ${'é'.repeat(5)}  `), 5);
});

test('repeated text: the copy in the sender own text wins over an earlier quoted copy; otherwise the earliest', () => {
  const real1331 = real('corpus/farmer-d/logistics/1331.');
  const sig = 'If you have any questions please call me 36449.';
  const text = real1331.raw;
  assert.ok(text.indexOf(sig) !== text.lastIndexOf(sig), 'the signature appears twice');
  const c = checkQuote(text, real1331.m, sig, 'body');
  assertLocated(text, c, 'exact');
  assert.equal(c.segment, 'own');
  assert.equal(c.start, text.indexOf(sig));

  // Segments as the parser never makes them (own after quoted), to see the preference itself.
  const { raw, m } = message(['The meter list is attached for June.', 'ok', 'The meter list is attached for June.', 'end']);
  const second = raw.lastIndexOf('The meter list');
  const crafted: ParsedMessage = {
    ...m,
    segments: [
      { kind: 'quoted', start: m.body_start, end: second },
      { kind: 'own', start: second, end: raw.length },
    ],
  };
  const preferred = checkQuote(raw, crafted, 'The meter list is attached for June.', 'body');
  assertLocated(raw, preferred, 'exact');
  assert.deepEqual([preferred.start, preferred.segment], [second, 'own']);
  const repaired = checkQuote(raw, crafted, 'The meter  list is attached for June.', 'body');
  assert.deepEqual([repaired.match, repaired.start, repaired.segment], ['repaired', second, 'own']);
  // With no own copy, the earliest wins.
  const quotedOnly: ParsedMessage = { ...m, segments: [{ kind: 'quoted', start: m.body_start, end: raw.length }] };
  const earliest = checkQuote(raw, quotedOnly, 'The meter list is attached for June.', 'body');
  assert.deepEqual([earliest.start, earliest.segment], [raw.indexOf('The meter list'), 'quoted']);
});

test('the oversize message: quotes from its shown head and tail validate against the full raw text', () => {
  const id = 'corpus/farmer-d/logistics/3221.';
  const { raw, m } = real(id);
  assert.equal(m.flags.oversize, true);
  const shown = shownBody(m, raw);
  const [head, tail] = shown.split(/\n\[\.\.\. \d+ lines omitted[^\n]*\]\n/);
  assert.ok(head !== undefined && tail !== undefined, 'the batch view is cut');
  const headLines = head.split('\n');
  const tailLines = tail.split('\n');
  const quotes = [
    headLines.find((l) => l.startsWith('Pasting the full month position')) as string,
    headLines.slice(4, 7).join('\n'), // the table header and first row, across line breaks
    tailLines.at(-3) as string, // the last table row
    tailLines.slice(-3).join('\n'), // the last row, a blank line and the signature
  ];
  for (const quote of quotes) {
    assert.ok(quoteLength(quote) >= 20 && quoteLength(quote) <= 400, JSON.stringify(quote));
    const c = checkQuote(raw, m, quote, 'body');
    assertLocated(raw, c, 'exact');
    assert.equal(normalizeNewlines(c.raw_text), quote.trim());
    assert.ok(c.start >= m.body_start);
  }
  // The text that stands in for the omitted lines is not in the message.
  const marker = shown.match(/\[\.\.\. \d+ lines omitted[^\n]*\]/)?.[0] as string;
  assert.equal(checkQuote(raw, m, marker, 'body').reason, 'not_found');
});

// A small deterministic generator, so the offset checks below are the same on every run.
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('offset mapping: random bodies with mixed line endings and whitespace map every quote back exactly', () => {
  const rand = prng(20261017);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const tokens = ['meter', 'gas', 'a', 'b', '7', ',', '.', 'é', '\u{1F600}', ' ', ' ', '  ', '\t', '\r\n', '\n', '\r', ' \r\n', '\r\n\r\n', '\u00A0'];
  const whitespace = [' ', '  ', '\n', '\r\n', '\t', ' \n '];
  let exact = 0;
  let repaired = 0;
  for (let round = 0; round < 300; round++) {
    let body = '';
    while (body.length < 400) body += pick(tokens);
    const raw = `${HEADERS.join('\r\n')}\r\n\r\nx${body}`;
    const m = parseMessage('corpus/test-q/inbox/2.', SHA, Buffer.from(raw, 'utf8'));
    const norm = normalizeNewlines(raw.slice(m.body_start));
    const start = Math.floor(rand() * (norm.length - 80));
    const quote = norm.slice(start, start + 20 + Math.floor(rand() * 60)).trim();
    if (quoteLength(quote) < 20) continue;

    // Exact: the earliest occurrence in the normalized body, mapped to the raw span.
    const c = checkQuote(raw, m, quote, 'body');
    assertLocated(raw, c, 'exact');
    assert.equal(normalizeNewlines(c.raw_text), quote);
    assert.equal(normalizeNewlines(raw.slice(m.body_start, c.start)).length, norm.indexOf(quote), `round ${round}`);
    exact++;

    // Repaired: the same quote with its whitespace runs replaced; it maps to the earliest
    // whitespace-collapsed occurrence, and the raw span starts and ends on the quote's own text.
    const variant = quote.replace(/\s+/g, () => pick(whitespace));
    const v = checkQuote(raw, m, variant, 'body');
    if (quoteLength(normalizeNewlines(variant)) < 20) {
      assert.equal(v.reason, 'too_short');
      continue;
    }
    if (norm.includes(normalizeNewlines(variant))) {
      assert.equal(v.match, 'exact');
      continue;
    }
    assertLocated(raw, v, 'repaired');
    assert.equal(collapse(normalizeNewlines(v.raw_text)), collapse(quote));
    assert.ok(!/^\s|\s$/.test(v.raw_text), JSON.stringify(v.raw_text));
    assert.equal(collapse(normalizeNewlines(raw.slice(m.body_start, v.start))).length, collapse(norm).indexOf(collapse(quote)), `round ${round}`);
    repaired++;
  }
  assert.ok(exact > 200 && repaired > 100, `${exact} exact, ${repaired} repaired`);
});

test('fast on hostile input: a 350 KB body and 400-character quotes of repeated characters', () => {
  const cases: Array<[string, string, QuoteCheck['match']]> = [
    ['a'.repeat(350_000), `${'a'.repeat(399)}b`, 'rejected'],
    ['a'.repeat(350_000), `b${'a'.repeat(399)}`, 'rejected'],
    ['a'.repeat(350_000), 'a'.repeat(400), 'exact'],
    [`${'ab'.repeat(175_000)}`, `${'ab'.repeat(199)}aa`, 'rejected'],
    [' a'.repeat(175_000), `${'a '.repeat(199)}b`, 'rejected'],
    ['a\r\n'.repeat(116_000), `${'a\n'.repeat(199)}a`, 'exact'],
    ['a \r\n '.repeat(70_000), `${'a '.repeat(199)}a`, 'repaired'],
    [' '.repeat(350_000), `${' '.repeat(100)}${'a'.repeat(30)}`, 'rejected'],
  ];
  let ms = 0;
  for (const [body, quote, match] of cases) {
    const { raw, m } = message([body]);
    const started = performance.now();
    assert.equal(checkQuote(raw, m, quote, 'body').match, match);
    // The second check reuses the message's views.
    assert.equal(checkQuote(raw, m, quote, 'body').match, match);
    ms += performance.now() - started;
  }
  // Measured at well under a second; the bound is generous so slow CI machines do not flake.
  assert.ok(ms < 10_000, `${Math.round(ms)} ms for ${cases.length * 2} checks`);
});
