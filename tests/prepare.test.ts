// The whole deterministic front half on the real corpus, checked against what must hold
// whatever the exact counts: nothing lost, nothing doubled, every batch readable in one call.
// A few counts are pinned as well; see the note on those.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BATCH_MAX_BYTES, BATCH_MAX_LINES, BATCH_MAX_TOKENS, bodyTag, lineCount } from '../src/batch/build.ts';
import { DIGEST_MAX_BYTES, DIGEST_MAX_LINES } from '../src/batch/digest.ts';
import { ConfigError } from '../src/config.ts';
import { openCorpus } from '../src/corpus/reader.ts';
import { bodyKey } from '../src/normalize/dedup.ts';
import { codeSha, prepare, prepareCommand, prepareIsCurrent } from '../src/pipeline/prepare.ts';
import { sha256 } from '../src/util/hash.ts';
import { normalizeNewlines } from '../src/util/text.ts';
import { DAY_MS, utcMs } from '../src/util/time.ts';
import type { BatchEntry, DuplicateGroup, ParsedMessage, Person, Thread } from '../src/types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'obs-prepare-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const outA = join(tmp, 'a');
const { stats } = prepare(root, outA);
const read = (file: string) => JSON.parse(readFileSync(join(outA, file), 'utf8'));
const messages: ParsedMessage[] = readFileSync(join(outA, 'messages.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
const byId = new Map(messages.map((m) => [m.id, m]));
const dedup: { duplicates: number; groups: DuplicateGroup[] } = read('dedup.json');
const threads: Thread[] = read('threads.json');
const index: BatchEntry[] = read('batches/index.json');
const duplicateIds = new Set(dedup.groups.flatMap((g) => g.duplicates.map((d) => d.id)));
const uniqueIds = messages.map((m) => m.id).filter((id) => !duplicateIds.has(id));
const get = (id: string) => byId.get(id) as ParsedMessage;
const raw = openCorpus(root).readAll();
const rawText = (id: string) => (raw.get(id) as Buffer).toString('utf8');

test('every message is parsed once, in ID order', () => {
  assert.equal(messages.length, 3240);
  assert.equal(stats.messages, 3240);
  const ids = messages.map((m) => m.id);
  assert.deepEqual(ids, [...ids].sort());
});

// Pinned counts. 39 duplicates / 3,201 unique were measured two independent ways before they were
// pinned. Threads, occurrences and batches are regression pins taken from this code's own run: if
// one moves, explain why in the change (and in DECISIONS.md if the rule changed), don't just update it.
test('pinned counts: 39 duplicates, 3,201 unique; threads, occurrences and batches unchanged', () => {
  assert.equal(stats.duplicates, 39);
  assert.equal(stats.unique, 3201);
  assert.equal(stats.threads, 2601);
  assert.equal(stats.occurrences, 2701);
  assert.equal(stats.batches, 99);
});

test('duplicates: each copy points at a canonical that is itself unique: the lowest dated ID in its group', () => {
  assert.equal(dedup.duplicates, duplicateIds.size);
  assert.equal(stats.unique + stats.duplicates, 3240);
  for (const g of dedup.groups) {
    assert.ok(!duplicateIds.has(g.canonical), g.canonical);
    const ids = [g.canonical, ...g.duplicates.map((d) => d.id)].sort();
    const dated = ids.filter((id) => get(id).date_utc !== null);
    assert.equal(g.canonical, dated[0] ?? ids[0], `${g.canonical} is the lowest dated ID`);
  }
});

test('every content duplicate matches its canonical and sits under 24 h from its cluster anchor', () => {
  const key = (m: ParsedMessage) => `${m.from?.email}\0${m.subject_norm}\0${bodyKey(rawText(m.id), m.body_start)}`;
  for (const g of dedup.groups) {
    const canonical = get(g.canonical);
    const copies = g.duplicates.filter((d) => d.rule === 'content').map((d) => get(d.id));
    const cluster = [canonical, ...copies];
    const dated = cluster.filter((m) => m.date_utc !== null).sort((a, b) => utcMs(a.date_utc as string) - utcMs(b.date_utc as string));
    const anchor = dated[0] as ParsedMessage;
    for (const m of copies) {
      assert.ok(canonical.from !== null && m.from?.email === canonical.from.email, `${m.id}: same sender`);
      assert.equal(m.subject_norm, canonical.subject_norm, `${m.id}: same subject`);
      assert.equal(key(m), key(canonical), `${m.id}: same body`);
    }
    for (const m of cluster) {
      if (m.date_utc !== null) {
        assert.ok(utcMs(m.date_utc) - utcMs(anchor.date_utc as string) < DAY_MS, `${m.id}: under 24 h after ${anchor.id}`);
        continue;
      }
      // The allowed undated case: every dated copy of this content in the corpus is one cluster.
      const all = messages.filter((x) => x.date_utc !== null && key(x) === key(canonical)).map((x) => utcMs(x.date_utc as string));
      assert.ok(Math.max(...all) - Math.min(...all) < DAY_MS, `${m.id}: undated, and its content has one dated cluster`);
    }
  }
});

test('the one Message-ID shared by two files merges them, with the lower ID as canonical', () => {
  const holders = new Map<string, string[]>();
  for (const m of messages) if (m.message_id !== null) holders.set(m.message_id, [...(holders.get(m.message_id) ?? []), m.id]);
  assert.deepEqual([...holders.values()].filter((ids) => ids.length > 1), [['corpus/farmer-d/logistics/880.', 'corpus/williams-w3/inbox/143.']]);
  const g = dedup.groups.find((x) => x.canonical === 'corpus/farmer-d/logistics/880.');
  assert.ok(g !== undefined);
  assert.deepEqual(g.duplicates.map((d) => d.id), ['corpus/williams-w3/inbox/143.']);
  assert.equal(get('corpus/farmer-d/logistics/880.').message_id, get('corpus/williams-w3/inbox/143.').message_id);
});

test('every unique message is in exactly one thread and one occurrence; no duplicate is in any', () => {
  const inThreads = threads.flatMap((t) => t.message_ids);
  const inOccurrences = threads.flatMap((t) => t.occurrences.flatMap((o) => o.message_ids));
  assert.deepEqual([...inThreads].sort(), [...uniqueIds].sort());
  assert.deepEqual([...inOccurrences].sort(), [...uniqueIds].sort());
  assert.equal(new Set(threads.map((t) => t.thread_id)).size, threads.length, 'thread IDs are unique');
});

test('every unique message is in exactly one batch, and every batch fits one Read call', () => {
  const inBatches = index.flatMap((b) => b.message_ids);
  assert.deepEqual([...inBatches].sort(), [...uniqueIds].sort());
  for (const b of index) {
    const content = readFileSync(join(outA, 'batches', `${b.batch_id}.md`), 'utf8');
    assert.equal(b.bytes, Buffer.byteLength(content), b.batch_id);
    assert.equal(b.lines, lineCount(content), b.batch_id);
    assert.ok(b.bytes <= BATCH_MAX_BYTES, `${b.batch_id}: ${b.bytes} bytes`);
    assert.ok(b.est_tokens <= BATCH_MAX_TOKENS, `${b.batch_id}: ~${b.est_tokens} tokens`);
    assert.ok(b.lines <= BATCH_MAX_LINES, `${b.batch_id}: ${b.lines} lines`);
    assert.ok(!content.includes('\r'), `${b.batch_id} holds a CR`);
    assert.match(b.file, /^out\/batches\/batch-\d{3}\.md$/);
  }
  assert.deepEqual(readdirSync(join(outA, 'batches')).sort(), [...index.map((b) => `${b.batch_id}.md`), 'index.json'].sort());
});

test('the batch files show the injection flag and cut the oversize table', () => {
  assert.deepEqual(stats.suspected_injection, ['corpus/farmer-d/logistics/3220.']);
  assert.deepEqual(stats.oversize, ['corpus/farmer-d/logistics/3221.']);
  const contentOf = (id: string) => {
    const b = index.find((x) => x.message_ids.includes(id));
    assert.ok(b !== undefined, id);
    return readFileSync(join(outA, 'batches', `${b.batch_id}.md`), 'utf8');
  };
  assert.match(contentOf('corpus/farmer-d/logistics/3220.'), /Flags: suspected_injection\n\[NOTE: this body contains text addressed to automated readers/);
  assert.match(contentOf('corpus/farmer-d/logistics/3221.'), /lines omitted: oversize body/);
});

test('every shown body is the message text verbatim (LF line endings), or a head and tail of it around one marker', () => {
  const marker = /\n\[\.\.\. \d+ (?:lines|bytes) omitted[^\n]*\.\.\.\]\n/;
  const cut: string[] = [];
  for (const b of index) {
    const content = readFileSync(join(outA, 'batches', `${b.batch_id}.md`), 'utf8');
    for (const id of b.message_ids) {
      const open = `[BODY ${bodyTag(get(id))}]\n`;
      const start = content.indexOf(open);
      const end = content.indexOf(`\n[/BODY ${bodyTag(get(id))}]\n`, start + open.length);
      assert.ok(start >= 0 && end >= start + open.length, `${id}: body markers`);
      const parts = content.slice(start + open.length, end).split(marker);
      assert.ok(parts.length <= 2, `${id}: one marker at most`);
      // The body as written: from body_start, LF line endings, trailing newlines dropped.
      const body = normalizeNewlines(rawText(id).slice(get(id).body_start)).replace(/\n+$/, '');
      if (parts.length === 1) {
        assert.equal(parts[0], body, `${id}: shown whole, exactly`);
      } else {
        cut.push(id);
        assert.ok(body.startsWith(parts[0] as string), `${id}: the head is the start of the body`);
        assert.ok(body.endsWith(parts[1] as string), `${id}: the tail is the end of the body`);
      }
    }
  }
  assert.deepEqual(cut, ['corpus/farmer-d/logistics/3221.'], 'only the oversize table is cut');
});

test('the stats name the corpus they were built from', () => {
  assert.match(stats.corpus_hash, /^[0-9a-f]+$/);
  assert.equal(stats.corpus_hash, read('manifest.json').corpus_hash);
  assert.equal(read('prepare-stats.json').corpus_hash, stats.corpus_hash);
});

// Pinned: who each address is lives in people.json's added fields, and nothing the batch files or the
// taxonomy digest read changes, so the taxonomy and all 99 extractions keep their cache keys.
test('pinned: the taxonomy digest and the batch index are the bytes the extractions were keyed on', () => {
  assert.equal(stats.digest_sha, 'a3746b869f7761db1c8f3bf6b1f7b0b44735be04f1bf5265b2d5b62b80714172');
  assert.equal(stats.outputs['batches/index.json'], 'ee58eb4c18e92b68cb3cf77be6f7b45bf073075fdce70686826a3d43c20b05fb');
});

// Pinned identity counts (src/normalize/identity.ts), taken from this code's own run and reviewed:
// R3 folds only with the middle initial shown in a display name (6 of 33 candidates), and not when
// the last name has another known first initial (kpresto beside darin.presto); R5 folds unless a
// rival with the same first initial exists (none on the corpus; gustavo.giron is no rival to
// dgiron); two addresses in one message's headers never fold together (edward.d.gottlob and
// edward.gottlob). If a count moves, say why in the change.
test('pinned identity: folds by rule, the m..last addresses left alone, lists and system senders', () => {
  assert.deepEqual(stats.identity, { folds: { display_name: 4, middle_initial: 4, last_name: 6, first_last: 10, initial_last: 33 }, ambiguous: 30, lists: 26, system: 9 });
  const people: Person[] = read('people.json');
  assert.equal(people.length, stats.people);
  const of = (email: string) => people.find((p) => p.email === email) as Person;
  const canonical = (...locals: string[]) => locals.map((l) => of(l.includes('@') ? l : `${l}@enron.com`).canonical);
  // Daren Farmer's four addresses are one person, and so are Darron Giron's five.
  assert.deepEqual(canonical('daren.farmer', 'daren.j.farmer', 'dfarmer', 'j..farmer'), Array(4).fill('daren.farmer@enron.com'));
  assert.deepEqual(canonical('darron.giron', 'darron.c.giron', 'c..giron', 'dgiron', 'dgiron@ect.enron.com'), Array(5).fill('darron.giron@enron.com'));
  assert.deepEqual(canonical('gustavo.giron', 'whicks'), ['gustavo.giron@enron.com', 'w.hicks@enron.com']);
  assert.deepEqual(canonical('edward.d.gottlob', 'e..estrada', 'm..presto'), ['edward.d.gottlob@enron.com', 'e..estrada@enron.com', 'm..presto@enron.com']);
  const ambiguous = 'a..brown a..campos a..price a..roberts c..hall d..anderson d..baughman d..hogan d..smith d..thomas f..smith g..moore h..cook h..lewis k..allen l..davis l..day l..garcia l..kelly m..moore m..presto m..scott m..smith n..gilbert p..adams s..bryan s..lim w..bennett w..white w..young'.split(' ');
  assert.equal(ambiguous.length, 30);
  for (const local of ambiguous) assert.deepEqual([of(`${local}@enron.com`).fold, of(`${local}@enron.com`).canonical], [null, `${local}@enron.com`], local);
  // Only persons fold or are folded into; every canonical is a priced person of the directory.
  for (const p of people.filter((x) => x.canonical !== x.email)) {
    assert.ok(p.kind === 'person' && p.priced && p.fold !== null, p.email);
    assert.ok(of(p.canonical).kind === 'person' && of(p.canonical).priced && of(p.canonical).fold === null, p.canonical);
  }
});

test('the taxonomy digest: written, one Read call, its hash in the stats, no message IDs', () => {
  const digest = readFileSync(join(outA, 'taxonomy-digest.md'), 'utf8');
  const bytes = Buffer.byteLength(digest);
  const lines = lineCount(digest);
  assert.ok(bytes <= DIGEST_MAX_BYTES, `${bytes} bytes`);
  assert.ok(lines <= DIGEST_MAX_LINES, `${lines} lines`);
  assert.equal(stats.digest_sha, sha256(digest));
  assert.equal(read('prepare-stats.json').digest_sha, stats.digest_sha);
  assert.deepEqual(
    digest.split('\n').filter((l) => l.startsWith('#')),
    ['# Taxonomy digest', '## A. Subject words', '## B. Recurring subjects', '## C. Sample messages', '## D. Frequent senders'],
  );
  // View B: subjects that recur, ranked by occurrences and then distinct months; every one a real
  // thread subject.
  const text = digest.split('\n');
  const rows = text
    .slice(text.indexOf('## B. Recurring subjects'), text.indexOf('## C. Sample messages'))
    .filter((l) => l.startsWith('- '))
    .map((l) => /^- ("(?:[^"\\]|\\.)*") \| (\d+) occurrences \| (\d+) months? \(/.exec(l));
  assert.equal(rows.length, 60);
  const rank = rows.map((m) => {
    assert.ok(m !== null);
    assert.ok(new Set(threads.map((t) => t.subject_norm)).has(JSON.parse(m[1] as string)), m[1]);
    return [Number(m[2]), Number(m[3])] as const;
  });
  for (const [i, [occurrences, months]] of rank.entries()) {
    assert.ok(occurrences >= 2, `row ${i}: ${occurrences} occurrences`);
    const prev = rank[i - 1];
    if (prev !== undefined) assert.ok(prev[0] > occurrences || (prev[0] === occurrences && prev[1] >= months), `row ${i} is ranked`);
  }
  assert.ok(!digest.includes('corpus/') && !digest.includes('\r'));
  // Every sampled subject that is shown whole is a real thread subject, ready to be an example.
  const subjects = new Set(threads.map((t) => t.subject_norm));
  const sampled = [...digest.matchAll(/^- [a-z0-9-]+ \| (?:\d{4}-\d\d|undated) \| "(?:[^"\\]|\\.)*" \| ("(?:[^"\\]|\\.)*") \|/gm)].map((m) => JSON.parse(m[1] as string) as string);
  assert.equal(sampled.length, 100, 'a sample of 100 messages');
  for (const s of sampled) if (!s.endsWith('...') && s !== '(no subject)') assert.ok(subjects.has(s), s);
});

test('the taxonomy digest leaves out the flagged messages: no line of the injection, nothing of the oversize table', () => {
  const digest = readFileSync(join(outA, 'taxonomy-digest.md'), 'utf8').toLowerCase();
  for (const id of [...stats.suspected_injection, ...stats.oversize]) {
    assert.ok(!digest.includes(get(id).subject_norm), `${id}: its subject`);
    // Lines of the raw message, as written and as the digest would escape them: every line of the
    // injection; the oversize table's first rows (a short line of it, such as a sign-off, could
    // match any sampled message).
    const injection = stats.suspected_injection.includes(id);
    const lines = rawText(id).split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim().toLowerCase());
    for (const line of injection ? lines : lines.slice(0, 80)) {
      if (line.length < (injection ? 6 : 30)) continue;
      assert.ok(!digest.includes(line), `${id}: ${JSON.stringify(line.slice(0, 60))}`);
      assert.ok(!digest.includes(JSON.stringify(line).slice(1, -1)), `${id}: escaped ${JSON.stringify(line.slice(0, 60))}`);
    }
  }
  assert.ok(!digest.includes('farmer-d/logistics/3220.'));
  assert.ok(!digest.includes('reviewing process') && !digest.includes('processing directive'));
});

test('the daily Calpine nominations are separate occurrences, not one long thread', () => {
  const daily = messages.filter((m) => m.subject === 'Calpine Daily Gas Nomination' && !duplicateIds.has(m.id));
  assert.ok(daily.length >= 15, `${daily.length} daily sends`);
  const occurrenceOf = new Map(threads.flatMap((t) => t.occurrences.flatMap((o) => o.message_ids.map((id) => [id, o.occurrence_id] as const))));
  assert.equal(new Set(daily.map((m) => occurrenceOf.get(m.id))).size, daily.length);
});

test('the message with no date is kept, in exactly one thread and exactly one batch', () => {
  const id = 'corpus/giron-d/sent/795.';
  assert.equal(get(id).date_utc, null);
  assert.ok(uniqueIds.includes(id));
  assert.equal(threads.filter((t) => t.message_ids.includes(id)).length, 1);
  assert.equal(index.filter((b) => b.message_ids.includes(id)).length, 1);
});

test('a second run writes byte-identical files', () => {
  const outB = join(tmp, 'b');
  prepare(root, outB);
  const files = (dir: string) => [
    ...['manifest.json', 'messages.jsonl', 'dedup.json', 'threads.json', 'people.json', 'prepare-stats.json', 'taxonomy-digest.md'],
    ...readdirSync(join(dir, 'batches')).map((f) => join('batches', f)),
  ];
  assert.deepEqual(files(outB), files(outA));
  for (const f of files(outA)) assert.ok(readFileSync(join(outA, f)).equals(readFileSync(join(outB, f))), f);
});

// A tiny corpus on disk, outside any Git checkout (file names without the trailing dot, which
// Windows cannot create; the reader takes whatever names it finds).
function miniRoot(name: string, files: Record<string, string>): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, 'config'), { recursive: true });
  copyFileSync(join(root, 'config', 'effort-rates.json'), join(dir, 'config', 'effort-rates.json'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, 'corpus', rel, '..'), { recursive: true });
    writeFileSync(join(dir, 'corpus', rel), text);
  }
  return dir;
}

function errorsOf(run: () => number): { code: number; lines: string[] } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.join(' '));
  try {
    return { code: run(), lines };
  } finally {
    console.error = original;
  }
}

const goodMessage = 'From: a@enron.com\r\nSubject: Volumes\r\nDate: Mon, 14 May 2001 10:00:00 -0700\r\n\r\nbody\r\n';

test('a run that fails before writing leaves the previous manifest, batches and stats as they were', () => {
  const mini = miniRoot('mini-fail', { 'x/inbox/1': goodMessage });
  writeFileSync(join(mini, 'config', 'effort-rates.json'), '{"version": 0}'); // fails after ingest
  const out = join(mini, 'out');
  mkdirSync(join(out, 'batches'), { recursive: true });
  writeFileSync(join(out, 'batches', 'batch-000.md'), 'previous run');
  writeFileSync(join(out, 'prepare-stats.json'), 'previous stats');
  writeFileSync(join(out, 'manifest.json'), 'previous manifest');
  assert.throws(() => prepare(mini, out), ConfigError);
  assert.equal(readFileSync(join(out, 'manifest.json'), 'utf8'), 'previous manifest');
  assert.equal(readFileSync(join(out, 'batches', 'batch-000.md'), 'utf8'), 'previous run');
  assert.equal(readFileSync(join(out, 'prepare-stats.json'), 'utf8'), 'previous stats');
  assert.ok(!existsSync(join(out, 'messages.jsonl')) && !existsSync(join(out, 'threads.json')));
});

test('a 70,000-character subject is cut for display and still packs into one batch; the parse keeps it whole', () => {
  const subject = 's'.repeat(70_000);
  const mini = miniRoot('mini-long', {
    'x/inbox/1': `From: a@enron.com\r\nSubject: ${subject}\r\nDate: Mon, 14 May 2001 10:00:00 -0700\r\n\r\nbody\r\n`,
  });
  const out = join(mini, 'out');
  const result = prepare(mini, out);
  assert.equal(result.stats.batches, 1);
  const content = readFileSync(join(out, 'batches', 'batch-000.md'), 'utf8');
  assert.ok(content.includes(`\nSubject: ${'s'.repeat(500)} [... 69500 more characters]\n`));
  assert.ok(content.includes(` | ${'s'.repeat(500)} [... 69500 more characters] | 1 messages ===\n`), 'thread header too');
  const [parsed] = readFileSync(join(out, 'messages.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
  assert.equal(parsed.subject, subject);
});

test('a reply with lone-CR line endings parses like its CRLF and LF twins: same segments, own_chars and fresh_send', () => {
  // No re: prefix on the subject, so fresh_send depends only on finding the quoted block.
  const lines = [
    'From: a@enron.com',
    'To: b@enron.com',
    'Subject: Volumes for',
    ' June',
    'Date: Mon, 14 May 2001 10:00:00 -0700',
    '',
    'Numbers are below.',
    '',
    'Jane',
    '',
    '-----Original Message-----',
    'From: Smith, Bob',
    'Sent: Monday, May 14, 2001 9:00 AM',
    'To: Doe, Jane',
    'Subject: June volumes',
    '',
    'What are the June volumes?',
    '',
  ];
  const texts = ['\r\n', '\n', '\r'].map((eol) => lines.join(eol));
  const mini = miniRoot('mini-cr', { 'x/inbox/1': texts[0] as string, 'x/inbox/2': texts[1] as string, 'x/inbox/3': texts[2] as string });
  const out = join(mini, 'out');
  prepare(mini, out);
  const parsed = readFileSync(join(out, 'messages.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as ParsedMessage);
  assert.deepEqual(parsed.map((m) => m.id), ['corpus/x/inbox/1', 'corpus/x/inbox/2', 'corpus/x/inbox/3']);
  // Segments compared by kind and text (offsets differ: a CRLF line break is two characters).
  const shape = (i: number) => {
    const m = parsed[i] as ParsedMessage;
    const text = texts[i] as string;
    return {
      segments: m.segments.map((s) => [s.kind, normalizeNewlines(text.slice(s.start, s.end))]),
      own_chars: m.own_chars,
      fresh_send: m.fresh_send,
      from: m.from,
      to: m.to,
      subject: m.subject,
      subject_norm: m.subject_norm,
      date_utc: m.date_utc,
    };
  };
  const crlf = shape(0);
  assert.deepEqual(crlf.segments.map(([kind]) => kind), ['own', 'quoted']);
  assert.equal(crlf.fresh_send, false);
  assert.equal(crlf.own_chars, 'Numbers are below. Jane'.length);
  assert.equal(crlf.subject, 'Volumes for June');
  assert.deepEqual(shape(1), crlf, 'LF twin');
  assert.deepEqual(shape(2), crlf, 'lone-CR twin');
  assert.equal((parsed[2] as ParsedMessage).body_start, lines.slice(0, 6).join('\r').length + 1);
});

test('writing starts by removing the old stats, so a run that dies mid-write leaves no prepare-stats.json', () => {
  const mini = miniRoot('mini-write', { 'x/inbox/1': goodMessage });
  const out = join(mini, 'out');
  mkdirSync(join(out, 'people.json'), { recursive: true }); // a folder where a file must go: that write fails
  writeFileSync(join(out, 'prepare-stats.json'), 'previous stats');
  assert.throws(() => prepare(mini, out), (err: NodeJS.ErrnoException) => err.code === 'EISDIR' && /people\.json/.test(err.message));
  assert.ok(!existsSync(join(out, 'prepare-stats.json')));
  rmSync(join(out, 'people.json'), { recursive: true });
  prepare(mini, out);
  assert.equal(JSON.parse(readFileSync(join(out, 'prepare-stats.json'), 'utf8')).messages, 1);
});

test('a bad config file prints one clean line and exits 1', () => {
  const mini = miniRoot('mini-config', { 'x/inbox/1': goodMessage });
  writeFileSync(join(mini, 'config', 'effort-rates.json'), '{"version": 0}');
  const { code, lines } = errorsOf(() => prepareCommand(mini));
  assert.equal(code, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /^prepare: .*effort-rates\.json is invalid: - version must be a positive integer/);
});

// console.log and console.error captured while `run` runs.
function outputOf(run: () => number): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...args: unknown[]) => void out.push(args.join(' '));
  console.error = (...args: unknown[]) => void err.push(args.join(' '));
  try {
    return { code: run(), out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

// Every file under `dir` with its modification time: what a run that writes nothing leaves alone.
const mtimes = (dir: string): Record<string, number> =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => statSync(join(dir, f)).isFile())
      .sort()
      .map((f) => [f, statSync(join(dir, f)).mtimeMs]),
  );

test('prepare skips itself when the corpus listing, the code and every output are unchanged; anything else, or --force, runs it', () => {
  const mini = miniRoot('mini-skip', { 'x/inbox/1': goodMessage, 'x/inbox/2': goodMessage.replace('Volumes', 'Nominations') });
  mkdirSync(join(mini, 'src'), { recursive: true });
  writeFileSync(join(mini, 'src', 'a.ts'), 'export const a = 1;\n');
  const out = join(mini, 'out');
  const full = (args: string[] = []) => {
    const r = outputOf(() => prepareCommand(mini, args));
    assert.equal(r.code, 0, r.err.join('\n'));
    return r.out;
  };
  assert.match(full()[0] ?? '', /^prepare: 2 messages parsed/);
  const stats = JSON.parse(readFileSync(join(out, 'prepare-stats.json'), 'utf8'));
  assert.equal(stats.code_sha, codeSha(mini));
  assert.deepEqual(Object.keys(stats.outputs), ['manifest.json', 'messages.jsonl', 'dedup.json', 'threads.json', 'people.json', 'batches/index.json']);
  for (const [rel, sha] of Object.entries(stats.outputs)) assert.equal(sha256(readFileSync(join(out, rel))), sha, rel);

  // Unchanged: one line, nothing written.
  const before = mtimes(out);
  const sleepUntil = Date.now() + 30;
  while (Date.now() < sleepUntil) {
    // let the clock move, so a rewrite would show in the modification times
  }
  assert.deepEqual(full(), ['prepare: unchanged']);
  assert.deepEqual(mtimes(out), before);
  assert.ok(prepareIsCurrent(mini));

  // Each of these makes it run in full, after which it is current again.
  const changes: Array<[string, () => void]> = [
    ['a batch file is missing', () => rmSync(join(out, 'batches', 'batch-000.md'))],
    ['a batch file was edited', () => writeFileSync(join(out, 'batches', 'batch-000.md'), 'edited\n')],
    ['an output was edited', () => writeFileSync(join(out, 'threads.json'), '[]\n')],
    ['the digest is missing', () => rmSync(join(out, 'taxonomy-digest.md'))],
    ['the corpus listing differs', () => writeFileSync(join(mini, 'corpus', 'x', 'inbox', '3'), goodMessage.replace('Volumes', 'Invoices'))],
    ['the code changed', () => writeFileSync(join(mini, 'src', 'a.ts'), 'export const a = 2;\n')],
    ['a source file was added', () => writeFileSync(join(mini, 'src', 'b.ts'), 'export const b = 1;\n')],
    ['the rates changed', () => writeFileSync(join(mini, 'config', 'effort-rates.json'), readFileSync(join(root, 'config', 'effort-rates.json'), 'utf8').replace('"read": 1', '"read": 2'))],
    ['the stats are from before M5 (no code_sha)', () => {
      const s = JSON.parse(readFileSync(join(out, 'prepare-stats.json'), 'utf8'));
      delete s.code_sha;
      writeFileSync(join(out, 'prepare-stats.json'), JSON.stringify(s));
    }],
  ];
  for (const [why, change] of changes) {
    change();
    assert.equal(prepareIsCurrent(mini), false, why);
    assert.match(full()[0] ?? '', /^prepare: \d+ messages parsed/, why);
    assert.deepEqual(full(), ['prepare: unchanged'], `${why}: current again`);
  }
  assert.match(full(['--force'])[0] ?? '', /^prepare: 3 messages parsed/, '--force always runs');
  const bad = outputOf(() => prepareCommand(mini, ['--fast']));
  assert.deepEqual([bad.code, bad.err], [1, ['prepare: unexpected argument "--fast". Usage: node obs.mjs prepare [--force]']]);
  assert.ok(!existsSync(join(out, 'runs')), 'outside a run, no run log');

  // During a run, each prepare logs one event with its duration and whether it skipped itself.
  mkdirSync(join(out, 'ledger'), { recursive: true });
  writeFileSync(join(out, 'ledger', 'run.json'), JSON.stringify({ active: true, run_id: 'r-prepare', started_utc: '2026-10-18T00:00:00Z' }));
  full();
  full(['--force']);
  const events = readFileSync(join(out, 'runs', 'r-prepare.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(events.map((e) => [e.event, e.skipped, Number.isInteger(e.ms)]), [['prepare', true, true], ['prepare', false, true]]);
});

test('codeSha covers src/**/*.ts and the rates file, newline-normalised, and nothing else', () => {
  const dir = join(tmp, 'code-sha');
  mkdirSync(join(dir, 'src', 'run'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'src', 'run', 'x.ts'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'config', 'effort-rates.json'), '{}\n');
  const first = codeSha(dir);
  writeFileSync(join(dir, 'src', 'run', 'x.ts'), 'export const x = 1;\r\n');
  assert.equal(codeSha(dir), first, 'a CRLF checkout of the same file');
  writeFileSync(join(dir, 'src', 'notes.md'), 'not code');
  writeFileSync(join(dir, 'config', 'scoring.json'), '{}');
  assert.equal(codeSha(dir), first, 'other files do not count');
  writeFileSync(join(dir, 'config', 'effort-rates.json'), '{"x": 1}\n');
  assert.notEqual(codeSha(dir), first);
});

test('prepare with no corpus prints one clean line and exits 1', () => {
  const empty = join(tmp, 'empty');
  mkdirSync(empty);
  const { code, lines } = errorsOf(() => prepareCommand(empty));
  assert.equal(code, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /^prepare: No corpus found/);
});
