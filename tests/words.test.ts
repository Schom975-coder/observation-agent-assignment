// The wording rules (requirements G, A19) on code-written text. The build runs redacted: every
// data-text field (names, prose, quotes, subjects, documents) becomes "[data]" before any string is
// made, so what is left is what code wrote, and it must hold no refused word and, on the top layer,
// no key, batch id or internal unit. The dashboard's own files are checked the same way when they
// exist. Verbatim archive text may hold such words (an email says "unanswered"); on the real build
// those are listed as a warning only.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInputs, renderOutputs, type Rendered } from '../src/report/build.ts';
import { CAUTIONS, REFUSED, refusedWords } from '../src/report/words.ts';
import type { DashboardData } from '../src/report/types.ts';
import { builtProject } from './fixtures/pipeline.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'obs words '));
after(() => rmSync(tmp, { recursive: true, force: true }));

// Fields that hold identifiers (keys, ids, paths, addresses, codes), not words.
const ID_FIELDS = new Set([
  'key', 'id', 'message_id', 'thread_id', 'occurrence_id', 'path', 'file', 'log', 'sha', 'email', 'address', 'addresses', 'person', 'from', 'sender', 'canonical',
  'ids', 'message_ids', 'processes', 'top_mailbox', 'mailbox', 'to', 'bucket', 'type', 'kind', 'status', 'rule', 'segment', 'field', 'match', 'why', 'stall_kind',
  'section', 'filter', 'tier', 'origin', 'month', 'date_utc', 'first_utc', 'last_utc', 'mailbox_end_utc', 'stall_ids', 'folder', 'date_status', 'role',
  'markers', 'tags', 'lists', 'system', 'ambiguous', 'no_initial', 'shared_message', 'no_candidate', 'chasers', 'undated_occurrences', 'a', 'b', 'from_name', 'job',
  'model', 'effort', 'name', 'duplicate_of', 'source', 'artifact_type', 'inputs', 'outputs',
]);

// Every string value of a JSON value outside the identifier fields.
function words(value: unknown, field = ''): string[] {
  if (typeof value === 'string') return ID_FIELDS.has(field) ? [] : [value];
  if (Array.isArray(value)) return value.flatMap((v) => words(v, field));
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([k, v]) => words(v, k));
  return [];
}

let root = '';
let redacted: Rendered;
before(() => {
  root = builtProject(tmp);
  const { inputs, assets, shas } = loadInputs(root);
  redacted = renderOutputs(inputs, assets, shas, { redact: true });
});

test('refusedWords: case-insensitive, whole words, the cautions excepted', () => {
  assert.deepEqual(refusedWords('Annual SAVINGS of at least $5, a seamless game-changer.'), ['Annual', 'SAVINGS', 'at least', 'seamless', 'game-changer']);
  assert.deepEqual(refusedWords('pending, floors, the lower end, company-wide figures, end-to-end'), ['company-wide']);
  assert.deepEqual(refusedWords(`Something unanswered. ${CAUTIONS[0]}`), ['unanswered']);
  for (const c of CAUTIONS) assert.deepEqual(refusedWords(c), [], c);
  assert.ok(REFUSED.includes('floor') && REFUSED.includes('ending'));
});

test('the redacted build holds no refused word in any code-written text', () => {
  const hits: string[] = [];
  for (const [path, content] of redacted.files) {
    if (typeof content !== 'string') continue;
    if (path.endsWith('.json')) {
      for (const s of words(JSON.parse(content))) for (const w of refusedWords(s)) hits.push(`${path}: "${w}" in "${s.slice(0, 120)}"`);
    } else if (path === 'report.md' || path === 'report.html') {
      const text = content.replace(/<style>[\s\S]*?<\/style>/, '');
      for (const w of refusedWords(text)) hits.push(`${path}: "${w}"`);
    }
  }
  assert.deepEqual(hits, []);
});

test('A19: the top layer holds no key, batch id, internal unit or tier letter', () => {
  const data = JSON.parse(redacted.files.get('dashboard/data.json') as string) as DashboardData;
  const keys = data.rows.map((r) => r.key);
  const top: string[] = [
    ...data.rows.flatMap((r) => Object.values(r).flatMap((v) => (typeof v === 'object' && v !== null && 't' in v ? [(v as { t: string }).t] : []))),
    ...data.rows.flatMap((r) => [r.seen_in, r.status_line, r.tier_words, r.stall_label, ...r.flags]),
    ...Object.values(data.headline).flatMap((v) => (typeof v === 'object' && v !== null && 't' in v ? [(v as { t: string }).t] : [])),
    ...Object.values(data.sentences),
    ...data.next_steps.flatMap((s) => [s.title, s.text]),
  ];
  const bad = /batch-|synth-|draft-|x100|\bocc\b|cents|tier [ABC]\b/;
  for (const s of top) {
    assert.doesNotMatch(s, bad, s);
    for (const k of keys) assert.ok(!s.includes(k), `${s} names the key ${k}`);
  }
});

// The page's own files, once Tasks 2 and 3 add them: the whole of index.html and the string
// literals of the scripts.
test('the dashboard’s own files hold no refused word', (t) => {
  const files = ['index.html', 'app.js', 'viewer.js'].map((f) => join(repo, 'dashboard', f)).filter((f) => existsSync(f));
  if (files.length === 0) {
    t.skip('no page files yet');
    return;
  }
  const literal = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const strings = f.endsWith('.html') ? [text] : [...text.matchAll(literal)].map((m) => m[0]);
    for (const s of strings) assert.deepEqual(refusedWords(s), [], `${f}: ${s.slice(0, 120)}`);
  }
});

// Verbatim archive text and model prose are data: shown as written, listed here as a warning.
test('the real build’s data text: refused words listed as a warning only', (t) => {
  const real = process.env.OBS_BUILD_ROOT ?? repo;
  let out: Rendered;
  try {
    const { inputs, assets, shas } = loadInputs(real);
    out = renderOutputs(inputs, assets, shas);
  } catch (err) {
    t.skip(`the build inputs there are not current: ${(err as Error).message}`);
    return;
  }
  const md = out.files.get('report.md') as string;
  const found = refusedWords(md);
  t.diagnostic(`refused words in the data text of report.md (data, shown as written): ${found.length === 0 ? 'none' : [...new Set(found.map((w) => w.toLowerCase()))].join(', ')}`);
});
