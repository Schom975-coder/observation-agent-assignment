// The extraction validator on recorded extractor outputs: a tiny Git-only fixture corpus is
// prepared into a temp out/, then each test writes out/extract/batch-000.json and checks it.
// The fixture's messages exist only as Git objects with trailing-dot IDs, as the real corpus does
// on Windows, so every OS reads them through `git cat-file` exactly as the hook will. Two of them
// have the corpus's main shape (CRLF headers, LF body) and one has a folded Subject field.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyTag } from '../src/batch/build.ts';
import { CorpusError, openCorpus } from '../src/corpus/reader.ts';
import { checkExtraction, errorText, repoPath } from '../src/model/validate-extraction.ts';
import { prepare } from '../src/pipeline/prepare.ts';
import type { BatchEntry, Extraction, ExtractionCheck, ParsedMessage } from '../src/types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'obs-validate-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// A Git repo whose corpus is only in Git objects (nothing checked out), plus the config prepare reads.
function gitFixture(name: string, files: Record<string, string>): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, 'config'), { recursive: true });
  copyFileSync(join(root, 'config', 'effort-rates.json'), join(dir, 'config', 'effort-rates.json'));
  const git = (args: string[], input?: string): string => {
    const config = ['-c', 'core.protectNTFS=false', '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
    const r = spawnSync('git', [...config, ...args], { cwd: dir, input, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(['init', '-q']);
  for (const [id, text] of Object.entries(files)) {
    const sha = git(['hash-object', '-w', '--no-filters', '--stdin'], text);
    git(['update-index', '--add', '--cacheinfo', `100644,${sha},${id}`]);
  }
  git(['commit', '-q', '--no-verify', '-m', 'fixture']);
  return dir;
}

const BOM = String.fromCharCode(0xfeff);
const crlf = (...lines: string[]) => lines.join('\r\n');
// The corpus's main shape: CRLF header lines, the blank line, then an LF-only body.
const mixed = (headers: string[], body: string[]) => `${headers.join('\r\n')}\r\n\r\n${body.join('\n')}`;
const ID1 = 'corpus/alpha/inbox/1.';
const ID2 = 'corpus/alpha/inbox/2.';
const ID3 = 'corpus/alpha/inbox/3.';
const ID4 = 'corpus/beta/sent/1.';
const fixture = gitFixture('fixture', {
  [ID1]: crlf(
    'Message-ID: <1001.test@example.invalid>',
    'Date: Mon, 14 May 2001 10:00:00 -0700',
    'From: jane.doe@enron.com',
    'To: bob.smith@enron.com',
    'Subject: Meter 1234 nomination for',
    ' June',
    '',
    'Bob,',
    '',
    'Please confirm the June nomination for meter 1234 by noon. The volumes are',
    '5,000 MMBtu/d at Katy.',
    '',
    'Jane',
    '',
  ),
  [ID2]: mixed(
    [
      'Message-ID: <1002.test@example.invalid>',
      'Date: Mon, 14 May 2001 11:30:00 -0700',
      'From: bob.smith@enron.com',
      'To: jane.doe@enron.com',
      'Subject: RE: Meter 1234 nomination for June',
    ],
    [
      'Confirmed: meter 1234 is nominated at 5,000 MMBtu/d for June.',
      '',
      'Bob',
      '',
      '-----Original Message-----',
      'From: Doe, Jane',
      'Sent: Monday, May 14, 2001 10:00 AM',
      'To: Smith, Bob',
      'Subject: Meter 1234 nomination for June',
      '',
      'Please confirm the June nomination for meter 1234 by noon.',
      '',
    ],
  ),
  [ID3]: crlf(
    'Message-ID: <1003.test@example.invalid>',
    'Date: Tue, 15 May 2001 09:00:00 -0700',
    'From: carol.lee@enron.com',
    'To: jane.doe@enron.com',
    'Subject: Lunch on Friday?',
    '',
    'Want to grab lunch on Friday at the usual place?',
    '',
  ),
  [ID4]: mixed(
    [
      'Message-ID: <1004.test@example.invalid>',
      'Date: Wed, 16 May 2001 08:15:00 -0700',
      'From: dan.ray@enron.com',
      'To: ops.team@enron.com',
      'Subject: Tejas outage still open',
    ],
    [
      'The Tejas pipeline outage is still not resolved. I have asked Gas Control twice',
      'and nobody owns the fix. Only Mike can restart the Tejas compressor, and he is',
      'out until Monday.',
      '',
    ],
  ),
});
const out = join(fixture, 'out');
prepare(fixture, out);
mkdirSync(join(out, 'extract'), { recursive: true });
const index: BatchEntry[] = JSON.parse(readFileSync(join(out, 'batches', 'index.json'), 'utf8'));
const TAXONOMY = ['gas-nomination', 'pipeline-operations'];
const rawOf = new Map([...openCorpus(fixture).readMany([ID1, ID2, ID3, ID4])].map(([id, b]) => [id, b.toString('utf8')]));

function valid(): Extraction {
  return {
    batch_id: 'batch-000',
    messages: [
      { id: ID1, processes: ['gas-nomination'], role: 'request', stall: null, ownership_claim: null },
      { id: ID2, processes: ['gas-nomination'], role: 'response', stall: null, ownership_claim: null },
      { id: ID3, processes: [], role: 'personal', stall: null, ownership_claim: null },
      {
        id: ID4,
        processes: ['pipeline-operations', 'new:outage-escalation'],
        role: 'fyi',
        stall: { kind: 'waiting_on_reply', quote: 'I have asked Gas Control twice and nobody owns the fix.' },
        ownership_claim: { person: 'Mike', quote: 'Only Mike can restart the Tejas compressor' },
      },
    ],
    evidence: [
      {
        process: 'gas-nomination',
        message_id: ID1,
        field: 'body',
        quote: 'Please confirm the June nomination for meter 1234 by noon. The volumes are 5,000 MMBtu/d at Katy.',
        note: 'Asks for the monthly nomination to be confirmed.',
      },
      { process: 'gas-nomination', message_id: ID2, field: 'subject', quote: 'RE: Meter 1234 nomination for June', note: 'Reply in the nomination thread.' },
      { process: 'gas-nomination', message_id: ID2, field: 'body', quote: 'Confirmed: meter 1234 is nominated at 5,000 MMBtu/d for June.', note: 'The confirmation.' },
      { process: 'pipeline-operations', message_id: ID4, field: 'body', quote: 'The Tejas pipeline outage is still not resolved.', note: 'An open outage.' },
      { process: 'new:outage-escalation', message_id: ID4, field: 'body', quote: 'I have asked Gas Control twice\nand nobody owns the fix.', note: 'Chasing an owner.' },
      { process: 'gas-nomination', message_id: ID1, field: 'subject', quote: 'Meter 1234 nomination for June', note: 'The subject, folded in the raw header.' },
    ],
    new_processes: [
      { key: 'new:outage-escalation', name: 'Outage escalation', definition: 'Chasing someone to own and fix a pipeline outage.', example_ids: [ID4] },
    ],
    batch_notes: 'Two nomination messages, one personal note, one outage escalation.',
  };
}

function checkIn(outDir: string, extraction: unknown, options: { taxonomyKeys?: readonly string[] } = { taxonomyKeys: TAXONOMY }): ExtractionCheck {
  mkdirSync(join(outDir, 'extract'), { recursive: true });
  writeFileSync(join(outDir, 'extract', 'batch-000.json'), typeof extraction === 'string' ? extraction : JSON.stringify(extraction, null, 2));
  return checkExtraction(fixture, 'batch-000', { outDir, ...options });
}
const check = (extraction: unknown, options?: { taxonomyKeys?: readonly string[] }) => checkIn(out, extraction, options);

const edit = (change: (x: Extraction) => void): Extraction => {
  const x = valid();
  change(x);
  return x;
};
type Evidence = Extraction['evidence'][number];
const message = (x: Extraction, id: string) => x.messages.find((m) => m.id === id) as Extraction['messages'][number];
const evidence = (x: Extraction, i: number) => x.evidence[i] as Evidence;

// A copy of the prepared out/ outside the fixture repo, to break on purpose.
let copies = 0;
function copyOut(): string {
  const dir = join(tmp, `out-copy-${copies++}`);
  cpSync(out, dir, { recursive: true });
  return dir;
}

// No problem may carry a local path: not the temp folder, not any drive-letter or home path.
function assertNoLocalPath(problems: readonly string[]): void {
  for (const p of problems) {
    assert.ok(!p.includes(tmp) && !p.includes(tmp.replaceAll('\\', '/')), p);
    assert.doesNotMatch(p, /[A-Za-z]:[\\/]|(?:^|[\s'"(])\/(?:Users|home|tmp|var|private)\//, p);
  }
}

test('the fixture is one batch of the four messages, read from Git objects, in the corpus line-ending shapes', () => {
  assert.equal(index.length, 1);
  assert.deepEqual([...(index[0] as BatchEntry).message_ids].sort(), [ID1, ID2, ID3, ID4]);
  assert.equal(openCorpus(fixture).readFrom, 'git');
  const raw4 = rawOf.get(ID4) as string;
  const split = raw4.indexOf('\r\n\r\n') + 4;
  assert.ok(raw4.slice(0, split).includes('\r\n') && !raw4.slice(split).includes('\r'), 'ID4: CRLF headers, LF body');
  assert.match(rawOf.get(ID1) as string, /\r\nSubject: Meter 1234 nomination for\r\n June\r\n/);
});

test('readMany: the requested messages in the order asked, the same bytes as read(); an unknown ID is an error', () => {
  const corpus = openCorpus(fixture);
  const many = corpus.readMany([ID4, ID1, ID4]);
  assert.deepEqual([...many.keys()], [ID4, ID1]);
  assert.ok((many.get(ID4) as Buffer).equals(corpus.read(ID4)));
  assert.ok((many.get(ID1) as Buffer).equals(corpus.read(ID1)));
  assert.ok((many.get(ID1) as Buffer).includes('\r\n'), 'bytes come back raw');
  assert.equal(corpus.readMany([]).size, 0);
  assert.throws(() => corpus.readMany([ID1, 'corpus/alpha/inbox/9.']), CorpusError);
});

test('a valid extraction passes, and validated locates every quote in the raw message', () => {
  const result = check(valid());
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  const v = result.validated;
  assert.ok(v !== null);
  assert.equal(v.batch_id, 'batch-000');
  assert.equal(v.content_sha, (index[0] as BatchEntry).content_sha);
  assert.deepEqual(v.messages, valid().messages);
  assert.deepEqual(v.new_processes, valid().new_processes);
  assert.deepEqual(
    v.evidence.map((e) => [e.evidence_id, e.match, e.segment]),
    [
      ['batch-000:e0', 'repaired', 'own'],
      ['batch-000:e1', 'exact', 'subject'],
      ['batch-000:e2', 'exact', 'own'],
      ['batch-000:e3', 'exact', 'own'],
      ['batch-000:e4', 'exact', 'own'],
      ['batch-000:e5', 'repaired', 'subject'],
    ],
  );
  // Every accepted quote, body or subject, has a raw span and raw_text is the raw text there.
  for (const e of [...v.evidence, ...v.stall_checks, ...v.ownership_checks]) {
    assert.ok(e.start !== null && e.end !== null, JSON.stringify(e));
    assert.equal(rawOf.get(e.message_id)?.slice(e.start, e.end), e.raw_text);
  }
  assert.equal(v.evidence[0]?.raw_text, 'Please confirm the June nomination for meter 1234 by noon. The volumes are\r\n5,000 MMBtu/d at Katy.');
  assert.equal(v.evidence[4]?.raw_text, 'I have asked Gas Control twice\nand nobody owns the fix.');
  assert.equal(v.evidence[5]?.raw_text, 'Meter 1234 nomination for\r\n June');
  assert.deepEqual(
    v.stall_checks.map((c) => [c.message_id, c.match, c.raw_text]),
    [[ID4, 'repaired', 'I have asked Gas Control twice\nand nobody owns the fix.']],
  );
  assert.deepEqual(v.ownership_checks.map((c) => [c.message_id, c.person, c.match]), [[ID4, 'Mike', 'exact']]);
  assert.deepEqual(v.quote_stats, { exact: 5, repaired: 3, rejected: 0 });
  // The validated evidence keeps the model's entry and adds the check, keys in a fixed order.
  assert.deepEqual(Object.keys(v.evidence[0] as object), [
    'evidence_id', 'process', 'message_id', 'field', 'quote', 'note', 'match', 'start', 'end', 'segment', 'raw_text', 'reason',
  ]);
});

test('deterministic: the same file gives the same JSON, whatever key order the model wrote', () => {
  const first = JSON.stringify(check(valid()));
  assert.equal(JSON.stringify(check(valid())), first);
  // The same content with every object's keys reversed.
  const reversed = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(reversed)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]))
        : value;
  assert.equal(JSON.stringify(check(reversed(valid()))), first);
});

test('taxonomy keys come from the options, else out/taxonomy.json, else only new: keys are valid', () => {
  const none = check(valid(), {});
  assert.equal(none.ok, false);
  assert.deepEqual(none.problems.slice(0, 3), [
    `${ID1}: unknown process key "gas-nomination" (there is no taxonomy yet, so propose "new:<slug>" and declare it in new_processes)`,
    `${ID2}: unknown process key "gas-nomination" (there is no taxonomy yet, so propose "new:<slug>" and declare it in new_processes)`,
    `${ID4}: unknown process key "pipeline-operations" (there is no taxonomy yet, so propose "new:<slug>" and declare it in new_processes)`,
  ]);
  const file = join(out, 'taxonomy.json');
  writeFileSync(file, JSON.stringify({ processes: TAXONOMY.map((key) => ({ key, name: key, definition: '', include: [], exclude: [], example_subjects: [] })) }));
  try {
    assert.deepEqual(check(valid(), {}).problems, []);
    writeFileSync(file, '{"processes": [{"name": "no key"}]}');
    const broken = check(valid(), {});
    assert.equal(broken.validated, null);
    assert.deepEqual(broken.problems, ['setup: cannot read the taxonomy in out/taxonomy.json (a process has no "key" string)']);
  } finally {
    rmSync(file);
  }
  // A file-system error shows its code, never the absolute path in its message.
  mkdirSync(file);
  try {
    assert.deepEqual(check(valid(), {}).problems, ['setup: cannot read the taxonomy in out/taxonomy.json (EISDIR)']);
  } finally {
    rmSync(file, { recursive: true });
  }
});

test('malformed JSON and a missing file: one problem, nothing validated; the JSON problem says how to escape tabs and line breaks', () => {
  const bad = check('{"batch_id": "batch-000", "note": "a\tb"}');
  assert.equal(bad.ok, false);
  assert.equal(bad.validated, null);
  assert.equal(bad.problems.length, 1);
  assert.match(
    bad.problems[0] ?? '',
    /^out\/extract\/batch-000\.json is not valid JSON \(.+\): write exactly one JSON object, with no comments, trailing commas or text around it; raw tabs or line breaks inside JSON strings must be written as \\t or \\n$/,
  );
  rmSync(join(out, 'extract', 'batch-000.json'));
  const missing = checkExtraction(fixture, 'batch-000', { outDir: out, taxonomyKeys: TAXONOMY });
  assert.deepEqual(missing, {
    ok: false,
    problems: ['out/extract/batch-000.json does not exist or cannot be read: write the extraction for batch-000 there'],
    validated: null,
  });
  // A byte-order mark in front of otherwise valid JSON is tolerated.
  assert.equal(check(`${BOM}${JSON.stringify(valid())}`).ok, true);
});

test('schema: unknown keys (hours_per_month), wrong types and enums, missing keys; nothing validated', () => {
  const x = valid() as unknown as Record<string, unknown> & { messages: Array<Record<string, unknown>>; evidence: Array<Record<string, unknown>> };
  (x.messages[0] as Record<string, unknown>).hours_per_month = 12;
  x.total_minutes = 300;
  (x.messages[1] as Record<string, unknown>).role = 'boss';
  (x.messages[2] as Record<string, unknown>).processes = 'gas-nomination';
  delete (x.messages[3] as Record<string, unknown>).stall;
  (x.evidence[0] as Record<string, unknown>).field = 'header';
  (x.evidence[1] as Record<string, unknown>).quote = 42;
  const result = check(x);
  assert.equal(result.ok, false);
  assert.equal(result.validated, null);
  assert.deepEqual(result.problems, [
    'schema: the top level has unknown key "total_minutes": remove it; the schema has no numeric fields (allowed keys: batch_id, messages, evidence, new_processes, batch_notes)',
    `schema: messages[0] (${ID1}) has unknown key "hours_per_month": remove it; the schema has no numeric fields (allowed keys: id, processes, role, stall, ownership_claim)`,
    `schema: messages[1] (${ID2}).role must be one of "request", "response", "forward", "fyi", "automated", "personal", "noise", "injection_attempt", got "boss"`,
    `schema: messages[2] (${ID3}).processes must be an array of strings, got a string`,
    `schema: messages[3] (${ID4}) is missing key "stall" (use null when there is none)`,
    'schema: evidence[0].field must be one of "body", "subject", got "header"',
    'schema: evidence[1].quote must be a string, got a number',
  ]);
  assert.deepEqual(check([]).problems, ['schema: the top level must be an object, got an array']);
});

test('coverage: missing, extra and repeated message IDs are named; a dropped trailing dot is pointed out', () => {
  const result = check(
    edit((x) => {
      x.messages = x.messages.filter((m) => m.id !== ID3);
      x.messages.push({ id: 'corpus/alpha/inbox/9.', processes: [], role: 'noise', stall: null, ownership_claim: null });
      x.messages.push({ id: 'corpus/alpha/inbox/3', processes: [], role: 'personal', stall: null, ownership_claim: null });
      x.messages.push({ ...message(x, ID1) });
    }),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    `messages[] is missing 1 of the 4 messages in batch-000: ${ID3} (add one entry for each, with the ID copied exactly from its MESSAGE line)`,
    'messages[] has 2 ID(s) that are not in batch-000: corpus/alpha/inbox/9., corpus/alpha/inbox/3 (did you mean corpus/alpha/inbox/3.? IDs keep their trailing dot) (remove them or correct the ID)',
    `messages[] lists ${ID1} more than once (keep one entry per message)`,
  ]);
  assert.ok(result.validated !== null, 'the schema passed, so the record is still built');
});

test('process keys: unknown taxonomy key, undeclared and unused new: keys, a bad slug, and [] with role request', () => {
  const result = check(
    edit((x) => {
      message(x, ID1).processes = ['gas-nominations'];
      message(x, ID2).processes = ['gas-nomination', 'new:nomination-chasing'];
      message(x, ID3).role = 'request';
      message(x, ID4).processes = ['pipeline-operations', 'new:Outage_Escalation'];
      x.new_processes.push({ key: 'new:meter-audit', name: 'Meter audit', definition: 'Auditing meters.', example_ids: [ID1] });
    }),
  );
  assert.equal(result.ok, false);
  const want = [
    `${ID1}: unknown process key "gas-nominations" (use a key from out/taxonomy.json, or propose "new:<slug>" and declare it in new_processes)`,
    `${ID3}: processes is [] but role is "request"; an empty list is allowed only for roles personal, noise, automated, injection_attempt (tag the process this message is part of, or correct the role)`,
    `${ID4}: "new:Outage_Escalation" is not a valid new process key: use "new:" and lowercase words joined by hyphens, e.g. "new:meter-reconciliation"`,
    `new_processes[1] ("new:meter-audit"): example ${ID1} is not tagged "new:meter-audit" (tag it or drop it from example_ids)`,
    `"new:nomination-chasing" is used by ${ID2} but not declared in new_processes (add {"key", "name", "definition", "example_ids"} for it)`,
    'new_processes[0] declares "new:outage-escalation" but no message uses it (tag the messages it covers, or remove it)',
    'new_processes[1] declares "new:meter-audit" but no message uses it (tag the messages it covers, or remove it)',
  ];
  for (const p of want) assert.ok(result.problems.includes(p), `missing problem: ${p}\ngot:\n${result.problems.join('\n')}`);
  assert.ok(result.problems.indexOf(want[0] as string) < result.problems.indexOf(want[4] as string), 'key problems before declarations');
});

test('process keys: a process listed twice, a new: key the taxonomy already has, a key declared twice, empty name and definition', () => {
  const result = check(
    edit((x) => {
      message(x, ID2).processes = ['gas-nomination', 'gas-nomination'];
      message(x, ID1).processes = ['gas-nomination', 'new:gas-nomination'];
      x.evidence.push({ process: 'new:gas-nomination', message_id: ID1, field: 'body', quote: 'Please confirm the June nomination for meter 1234', note: '' });
      x.new_processes.push(
        { key: 'new:outage-escalation', name: 'Again', definition: 'The same key a second time.', example_ids: [] },
        { key: 'new:gas-nomination', name: ' ', definition: '', example_ids: [] },
      );
    }),
  );
  assert.deepEqual(result.problems, [
    `${ID1}: "new:gas-nomination" proposes a key the taxonomy already has: use "gas-nomination"`,
    `${ID2}: process "gas-nomination" is listed twice in processes (list it once)`,
    'new_processes[1] ("new:outage-escalation"): "new:outage-escalation" is declared more than once (declare it once)',
    'new_processes[2] ("new:gas-nomination"): name is empty',
    'new_processes[2] ("new:gas-nomination"): definition is empty',
  ]);
});

test('evidence citing a message outside the batch is rejected as wrong_message, and always blocks', () => {
  const result = check(
    edit((x) => {
      x.evidence.push({ process: 'gas-nomination', message_id: 'corpus/alpha/inbox/7.', field: 'body', quote: 'Please confirm the June nomination for meter 1234', note: '' });
    }),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    `corpus/alpha/inbox/7.: evidence[6] ("gas-nomination"): message_id corpus/alpha/inbox/7. is not in batch-000 (cite a message from this batch; the quote is in ${ID1})`,
  ]);
  const e = result.validated?.evidence[6];
  assert.deepEqual([e?.evidence_id, e?.match, e?.reason, e?.start], ['batch-000:e6', 'rejected', 'wrong_message', null]);
});

test('a rejected quote blocks only when its tag has no accepted quote; an extra one is kept as rejected and costs no loop', () => {
  const july = 'Please confirm the July nomination for meter 1234 by noon. The volumes are 5,000 MMBtu/d at Katy.';
  // ID1's tag still has its accepted subject quote (e5): the failed body quote never ships.
  const extra = check(edit((x) => (evidence(x, 0).quote = july)));
  assert.deepEqual(extra.problems, []);
  assert.equal(extra.ok, true);
  assert.deepEqual([extra.validated?.evidence[0]?.match, extra.validated?.evidence[0]?.reason], ['rejected', 'not_found']);
  assert.deepEqual(extra.validated?.quote_stats, { exact: 5, repaired: 2, rejected: 1 });

  // Without e5, the tag has nothing accepted: the quote problem and the tag problem both block.
  const only = check(
    edit((x) => {
      evidence(x, 0).quote = july;
      x.evidence.pop();
    }),
  );
  assert.equal(only.ok, false);
  assert.deepEqual(only.problems, [
    `${ID1}: evidence[0] ("gas-nomination"): quote not found verbatim: "Please confirm the July nomination for meter 1234 by noon. T..." ` +
      '(copy it character for character from the message body in the batch file)',
    `${ID1}: process "gas-nomination" has no accepted evidence quote (its 1 quote was rejected): add an evidence entry quoting this message verbatim for it, or remove the tag`,
  ]);
  const v = only.validated;
  assert.ok(v !== null, 'rejected quotes still give a validated record');
  assert.deepEqual([v.evidence[0]?.match, v.evidence[0]?.reason, v.evidence[0]?.raw_text], ['rejected', 'not_found', null]);
  assert.deepEqual(v.quote_stats, { exact: 5, repaired: 1, rejected: 1 });
});

test('empty, too short and too long quotes through checkExtraction, each the only quote for its tag', () => {
  const cases: Array<[string, string]> = [
    ['   ', `${ID2}: evidence[2] ("gas-nomination"): quote is empty (copy 20-400 characters of the message text)`],
    ['Confirmed: meter', `${ID2}: evidence[2] ("gas-nomination"): quote is 16 characters, under the 20 minimum: "Confirmed: meter" (quote a longer stretch; only a whole subject may be shorter)`],
    [
      'x'.repeat(401),
      `${ID2}: evidence[2] ("gas-nomination"): quote is 401 characters, over the 400 maximum: "${'x'.repeat(60)}..." (quote the most telling sentence or two)`,
    ],
  ];
  for (const [quote, problem] of cases) {
    const result = check(
      edit((x) => {
        evidence(x, 2).quote = quote;
        x.evidence.splice(1, 1); // drop ID2's subject quote, so the body quote is the tag's only one
      }),
    );
    assert.deepEqual(result.problems, [
      problem.replace('evidence[2]', 'evidence[1]'),
      `${ID2}: process "gas-nomination" has no accepted evidence quote (its 1 quote was rejected): add an evidence entry quoting this message verbatim for it, or remove the tag`,
    ]);
  }
});

test('a tag without any evidence entry is a problem', () => {
  const result = check(edit((x) => (x.evidence = x.evidence.filter((e) => e.message_id !== ID2))));
  assert.deepEqual(result.problems, [
    `${ID2}: process "gas-nomination" has no accepted evidence quote: add an evidence entry quoting this message verbatim for it, or remove the tag`,
  ]);
});

test('quotes in the wrong field or the wrong message, and evidence for a process the message lacks, say where to look', () => {
  const result = check(
    edit((x) => {
      evidence(x, 0).quote = 'Only Mike can restart the Tejas compressor';
      evidence(x, 3).quote = 'Tejas outage still open';
      x.evidence.pop(); // ID1's subject quote: its body quote is now its only one
      x.evidence.push({ process: 'pipeline-operations', message_id: ID1, field: 'body', quote: 'Please confirm the June nomination for meter 1234', note: '' });
    }),
  );
  assert.deepEqual(result.problems, [
    `${ID1}: evidence[0] ("gas-nomination"): quote is not in this message but is in ${ID4}: "Only Mike can restart the Tejas compressor" (cite ${ID4} for it, or quote this message's own text)`,
    `${ID4}: evidence[3] ("pipeline-operations"): quote not found verbatim: "Tejas outage still open" (copy it character for character from the message body in the batch file; it is in the subject: set "field": "subject")`,
    `${ID1}: evidence[5] ("pipeline-operations"): "pipeline-operations" is not one of this message's processes ["gas-nomination"] (tag the message with it, or cite the right process)`,
    `${ID1}: process "gas-nomination" has no accepted evidence quote (its 1 quote was rejected): add an evidence entry quoting this message verbatim for it, or remove the tag`,
    `${ID4}: process "pipeline-operations" has no accepted evidence quote (its 1 quote was rejected): add an evidence entry quoting this message verbatim for it, or remove the tag`,
  ]);
  assert.deepEqual(
    result.validated?.evidence.map((e) => [e.match, e.reason]),
    [['rejected', 'wrong_message'], ['exact', null], ['exact', null], ['rejected', 'not_found'], ['exact', null], ['exact', null]],
  );
});

test('stall and ownership quotes are checked against their message, body first, then subject, and always block when rejected', () => {
  const result = check(
    edit((x) => {
      message(x, ID1).stall = { kind: 'waiting_on_reply', quote: 'Meter 1234 nomination for June' };
      message(x, ID2).stall = { kind: 'rework', quote: 'We had to redo the whole nomination twice.' };
      message(x, ID4).ownership_claim = { person: ' ', quote: 'Mike owns the compressor restart' };
    }),
  );
  assert.deepEqual(result.problems, [
    `${ID2}: stall: quote not found verbatim: "We had to redo the whole nomination twice." (copy it character for character from the message in the batch file)`,
    `${ID4}: ownership_claim.person is empty (name the person the message says owns the work)`,
    `${ID4}: ownership_claim: quote not found verbatim: "Mike owns the compressor restart" (copy it character for character from the message in the batch file)`,
  ]);
  const v = result.validated;
  assert.deepEqual(
    v?.stall_checks.map((c) => [c.message_id, c.match, c.segment, c.raw_text]),
    [
      [ID1, 'repaired', 'subject', 'Meter 1234 nomination for\r\n June'],
      [ID2, 'rejected', null, null],
      [ID4, 'repaired', 'own', 'I have asked Gas Control twice\nand nobody owns the fix.'],
    ],
  );
});

test('ownership_claim.person must appear in its message, headers or body, ignoring case and whitespace', () => {
  for (const person of ['MIKE', ' mike ', 'Gas  Control', 'dan.ray@enron.com', 'Ops.Team']) {
    const ok = check(edit((x) => (message(x, ID4).ownership_claim = { person, quote: 'Only Mike can restart the Tejas compressor' })));
    assert.deepEqual(ok.problems, [], person);
  }
  const result = check(edit((x) => (message(x, ID4).ownership_claim = { person: 'Michael Jones', quote: 'Only Mike can restart the Tejas compressor' })));
  assert.deepEqual(result.problems, [`${ID4}: ownership_claim.person "Michael Jones" does not appear in this message (name the person as the message writes them)`]);
  assert.deepEqual(result.validated?.ownership_checks.map((c) => [c.person, c.match]), [['Michael Jones', 'exact']]);
});

test('lengths: notes over 200 characters and batch_notes over 100 words come last', () => {
  const result = check(
    edit((x) => {
      evidence(x, 2).note = 'n'.repeat(201);
      x.batch_notes = Array.from({ length: 101 }, () => 'word').join(' ');
      message(x, ID1).processes = ['nope'];
    }),
  );
  assert.deepEqual(result.problems.slice(-2), [
    `${ID2}: evidence[2] ("gas-nomination"): note is 201 characters; keep it to 200`,
    'batch_notes is 101 words; keep it to 100',
  ]);
  assert.match(result.problems[0] ?? '', /unknown process key "nope"/);
  assert.equal(check(edit((x) => (evidence(x, 2).note = 'n'.repeat(200)))).ok, true);
});

test('batch_id must name this batch; an unknown batch or a missing out/ is a setup problem', () => {
  const wrong = check(edit((x) => (x.batch_id = 'batch-001')));
  assert.deepEqual(wrong.problems, ['batch_id is "batch-001" but this file is for batch-000: set "batch_id": "batch-000"']);
  assert.equal(wrong.validated?.batch_id, 'batch-000');
  assert.deepEqual(checkExtraction(fixture, 'batch-999', { outDir: out }), {
    ok: false,
    problems: ['setup: batch-999 is not a batch in out/batches/index.json'],
    validated: null,
  });
  const nowhere = checkExtraction(fixture, 'batch-000', { outDir: join(fixture, 'no-out') });
  assert.deepEqual(nowhere.problems, ['setup: cannot read no-out/batches/index.json (ENOENT); run "node obs.mjs prepare"']);
});

test('setup: out/ copied outside the repo, stale or incomplete; problems name repo-relative paths only', () => {
  const problems: string[] = [];
  const run = (outDir: string, x: unknown = valid()) => {
    const result = checkIn(outDir, x);
    problems.push(...result.problems);
    return result;
  };
  // Outside the repo, out/ is still shown as out/.
  const away = copyOut();
  assert.equal(run(away).ok, true);
  rmSync(join(away, 'extract', 'batch-000.json'));
  assert.deepEqual(checkExtraction(fixture, 'batch-000', { outDir: away, taxonomyKeys: TAXONOMY }).problems, [
    'out/extract/batch-000.json does not exist or cannot be read: write the extraction for batch-000 there',
  ]);
  rmSync(join(away, 'batches', 'index.json'));
  const noIndex = run(away);
  assert.deepEqual(noIndex.problems, ['setup: cannot read out/batches/index.json (ENOENT); run "node obs.mjs prepare"']);

  // A message whose bytes changed after prepare: its offsets can no longer be trusted.
  const stale = copyOut();
  const jsonl = join(stale, 'messages.jsonl');
  writeFileSync(jsonl, readFileSync(jsonl, 'utf8').replace(/"blob_sha":"[0-9a-f]+"/, `"blob_sha":"${'0'.repeat(40)}"`));
  const changed = run(stale);
  assert.equal(changed.validated, null);
  assert.deepEqual(changed.problems, [`setup: 1 of the batch's messages changed since prepare ran (first: ${ID1}); run "node obs.mjs prepare" again`]);

  // A batch message missing from messages.jsonl.
  const partial = copyOut();
  const lines = readFileSync(join(partial, 'messages.jsonl'), 'utf8').split('\n');
  writeFileSync(join(partial, 'messages.jsonl'), lines.filter((l) => !l.includes(`"id":"${ID3}"`)).join('\n'));
  assert.deepEqual(run(partial).problems, [`setup: 1 of the batch's messages are not in out/messages.jsonl (first: ${ID3}); run "node obs.mjs prepare"`]);
  rmSync(join(partial, 'messages.jsonl'));
  assert.deepEqual(run(partial).problems, ['setup: cannot read out/messages.jsonl (ENOENT); run "node obs.mjs prepare"']);

  // No corpus at the root at all.
  const empty = join(tmp, 'empty-root');
  mkdirSync(empty);
  const noCorpus = checkExtraction(empty, 'batch-000', { outDir: copyOut(), taxonomyKeys: TAXONOMY });
  assert.match(noCorpus.problems[0] ?? '', /^setup: cannot read the batch's messages from the corpus \(No corpus found: /);
  problems.push(...noCorpus.problems);
  assertNoLocalPath(problems);
});

test('repoPath and errorText never show an absolute local path', () => {
  assert.equal(repoPath(fixture, join(fixture, 'out', 'batches', 'index.json')), 'out/batches/index.json');
  assert.equal(repoPath(fixture, fixture), '.');
  assert.equal(repoPath(fixture, join(tmp, 'elsewhere', 'x.json'), join(tmp, 'elsewhere')), 'out/x.json');
  assert.equal(repoPath(fixture, join(tmp, 'unrelated', 'y.json')), 'y.json');
  const fsError = Object.assign(new Error(`ENOENT: no such file or directory, open '${join(tmp, 'x')}'`), { code: 'ENOENT' });
  assert.equal(errorText(fsError), 'ENOENT');
  assert.equal(errorText(new Error('fatal: not a git repository: D:\\data\\repo/.git')), 'fatal: not a git repository: <path>');
  assert.equal(errorText(new Error("cannot open '/srv/data/out/index.json'\nbecause")), "cannot open '<path>' because");
  assert.equal(errorText(new Error('5,000 MMBtu/d in out/batches is fine')), '5,000 MMBtu/d in out/batches is fine');
});

// The real corpus end to end: extract the batch holding the oversize table the way a model reads it
// (from the batch file), and every quote copied from what the file shows validates.
test('real corpus: quotes copied from a prepared batch file validate against the raw messages', (t) => {
  const realOut = join(tmp, 'real-out');
  const { batches } = prepare(root, realOut);
  const batch = batches.find((b) => b.message_ids.includes('corpus/farmer-d/logistics/3221.')) as BatchEntry;
  const content = readFileSync(join(realOut, 'batches', `${batch.batch_id}.md`), 'utf8');
  const parsed = new Map(
    readFileSync(join(realOut, 'messages.jsonl'), 'utf8')
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as ParsedMessage)
      .map((m) => [m.id, m]),
  );
  const x: Extraction = { batch_id: batch.batch_id, messages: [], evidence: [], new_processes: [], batch_notes: 'Test extraction.' };
  for (const id of batch.message_ids) {
    const tag = bodyTag(parsed.get(id) as ParsedMessage);
    const open = `[BODY ${tag}]\n`;
    const start = content.indexOf(open) + open.length;
    const lines = content.slice(start, content.indexOf(`\n[/BODY ${tag}]`, start)).split('\n');
    const i = lines.findIndex((l) => l.trim().length >= 20 && l.trim().length <= 200 && !l.startsWith('[... '));
    if (i === -1) {
      x.messages.push({ id, processes: [], role: 'noise', stall: null, ownership_claim: null });
      continue;
    }
    x.messages.push({ id, processes: ['new:test-process'], role: 'fyi', stall: null, ownership_claim: null });
    x.evidence.push({ process: 'new:test-process', message_id: id, field: 'body', quote: lines[i] as string, note: '' });
    // Two lines joined with a space, as a model that drops a wrap would quote them.
    const next = lines[i + 1]?.trim() ?? '';
    if (next !== '' && !next.startsWith('[... ') && (lines[i] as string).trim().length + next.length < 380) {
      x.evidence.push({ process: 'new:test-process', message_id: id, field: 'body', quote: `${(lines[i] as string).trim()} ${next}`, note: '' });
    }
  }
  x.new_processes.push({ key: 'new:test-process', name: 'Test', definition: 'Every message with a quotable line.', example_ids: [] });
  mkdirSync(join(realOut, 'extract'), { recursive: true });
  writeFileSync(join(realOut, 'extract', `${batch.batch_id}.json`), JSON.stringify(x));
  const result = checkExtraction(root, batch.batch_id, { outDir: realOut, taxonomyKeys: [] });
  assert.deepEqual(result.problems, []);
  const stats = result.validated?.quote_stats;
  t.diagnostic(`${batch.batch_id}: ${batch.message_ids.length} messages, quotes ${JSON.stringify(stats)}`);
  assert.ok(stats !== undefined && stats.rejected === 0 && stats.exact >= batch.message_ids.length / 2 && stats.repaired > 0, JSON.stringify(stats));
});
