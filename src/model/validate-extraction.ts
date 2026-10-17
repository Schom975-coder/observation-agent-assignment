// Checks one extractor output file (out/extract/<batch>.json) against the batch it was made from:
// the strict schema, coverage of every message, process keys, and every quote located in the raw
// message (ARCHITECTURE.md 5.2, 6.11). Deterministic and model-free: a fix round hands `problems`
// back to the extractor (through out/fix/<batch>.txt), and the ledger records `validated`.
//
// Problems are written for the model that has to fix them: each names the message ID or quote,
// says what is wrong and what to do, and they come most important first (the schema, coverage,
// process keys, evidence, tags left without evidence, stall and ownership claims, lengths). All
// are returned; callers truncate. Text the model wrote (IDs not in the batch, process keys, quotes,
// names) appears only escaped and cut (`modelText`), and lists stop after LIST_MAX_ITEMS with
// "and K more", so every problem is one bounded line whose instruction survives. A failure the
// model cannot fix (out/ missing or stale, the corpus unreadable) is returned as `setup` with no
// problems, so no text the model wrote can pose as one. None carries an absolute local path.
//
// Injection-flagged messages get no special treatment here: their evidence is checked like any
// other, and quarantining a process backed only by flagged messages belongs to the rollup.
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { openCorpus } from '../corpus/reader.ts';
import { gitBlobSha } from '../util/hash.ts';
import { QUOTE_MAX_CHARS, QUOTE_MIN_CHARS, checkQuote, mentions, quoteLength, rejectedQuote, type QuoteField } from '../validate/quotes.ts';
import { checkExtractionSchema, modelText } from './schema.ts';
import type { BatchEntry, Extraction, ExtractionCheck, ParsedMessage, QuoteCheck, ValidatedEvidence, ValidatedExtraction } from '../types.ts';

export const NOTE_MAX_CHARS = 200;
export const BATCH_NOTES_MAX_WORDS = 100;
// A proposed process key: "new:" and a lowercase slug of hyphen-joined words.
export const NEW_KEY = /^new:[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Roles a message may have with no process at all.
export const ROLES_WITHOUT_PROCESS: readonly string[] = ['personal', 'noise', 'automated', 'injection_attempt'];

export type CheckOptions = { outDir?: string; taxonomyKeys?: readonly string[] };

type Message = Extraction['messages'][number];
type Batch = { entry: BatchEntry; ids: readonly string[]; inBatch: ReadonlySet<string> };
type Source = { message: ParsedMessage; raw: string };

// Problems reach the model and the run log, so they never carry an absolute local path.
// `file` relative to `dir` with "/" separators ('' for `dir` itself), or null when it is outside.
const within = (dir: string, file: string): string | null => {
  const rel = relative(dir, file).replaceAll('\\', '/');
  return isAbsolute(rel) || rel === '..' || rel.startsWith('../') ? null : rel;
};

// A path as problems show it: relative to the repo root with "/" separators. A file outside the
// repo but inside the out folder (a test's temp out/) is shown as "out/...", anything else by name.
export function repoPath(root: string, file: string, outDir: string = join(root, 'out')): string {
  const inRoot = within(root, file);
  if (inRoot !== null) return inRoot === '' ? '.' : inRoot;
  const inOut = within(outDir, file);
  if (inOut !== null) return inOut === '' ? 'out' : `out/${inOut}`;
  return basename(file);
}

// Absolute paths a message from Git or the OS may still carry: a drive-letter path, or a POSIX path
// of two or more segments not glued to a word (so "MMBtu/d" and "out/x" are left alone).
const ABSOLUTE_PATH = /[A-Za-z]:[\\/][^\s'"`]*|(?<![\w.~-])\/(?:[^\s/'"`]+\/)+[^\s'"`]*/g;

// An error as problems show it: the code of a file-system error (whose message names the absolute
// path), otherwise its message on one line with any absolute path replaced by <path>.
export function errorText(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return code;
  return (err instanceof Error ? err.message : String(err)).replace(/\s*\n\s*/g, ' ').replace(ABSOLUTE_PATH, '<path>');
}

const chars = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};
const words = (s: string): number => s.split(/\s+/).filter((w) => w !== '').length;

// The start of a quote as shown in a problem: its first 60 characters, escaped.
const preview = (quote: string): string => modelText(quote.trim(), 60);

// The longest a problem gets, and the most items it lists before "and K more". The coverage problem
// has its own larger budget, so 15 of the corpus's IDs (up to 34 characters) fit before its
// instruction. Model text is cut at the source, so no other problem comes near these.
export const PROBLEM_MAX_CHARS = 500;
export const COVERAGE_MAX_CHARS = 800;
export const LIST_MAX_ITEMS = 15;

// Items joined with ", ": at most LIST_MAX_ITEMS, and only as many as fit in `budget` characters,
// then ", and K more", so a long list never pushes the instruction after it out of the problem.
export function listed(items: readonly string[], budget: number): string {
  const shown: string[] = [];
  let used = 0;
  for (const item of items) {
    const add = (shown.length === 0 ? 0 : 2) + item.length;
    if (shown.length === LIST_MAX_ITEMS || (shown.length > 0 && used + add + ', and 9999 more'.length > budget)) break;
    shown.push(item);
    used += add;
  }
  const more = items.length - shown.length;
  return more === 0 ? shown.join(', ') : `${shown.join(', ')}, and ${more} more`;
}

// A problem that lists `items` between `head` and `tail`, kept within `budget`.
const listProblem = (head: string, items: readonly string[], tail: string, budget = PROBLEM_MAX_CHARS): string =>
  `${head}${listed(items, budget - head.length - tail.length)}${tail}`;

const failed = (problems: string[]): ExtractionCheck => ({ ok: false, setup: null, problems, validated: null });
const setupFailed = (setup: string): ExtractionCheck => ({ ok: false, setup, problems: [], validated: null });

// The process keys an extraction may use besides new:<slug>: given, else out/taxonomy.json's, else none.
function loadTaxonomy(
  outDir: string,
  given: readonly string[] | undefined,
  shown: (file: string) => string,
): { keys: ReadonlySet<string> } | { problem: string } {
  if (given !== undefined) return { keys: new Set(given) };
  const file = join(outDir, 'taxonomy.json');
  if (!existsSync(file)) return { keys: new Set() };
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const processes = (value as { processes?: unknown } | null)?.processes;
    if (!Array.isArray(processes)) throw new Error('it has no "processes" array');
    const keys = processes.map((p: unknown) => (p as { key?: unknown } | null)?.key);
    if (!keys.every((k): k is string => typeof k === 'string' && k !== '')) throw new Error('a process has no "key" string');
    return { keys: new Set(keys) };
  } catch (err) {
    return { problem: `cannot read the taxonomy in ${shown(file)} (${errorText(err)})` };
  }
}

// The batch's ParsedMessages and raw text, checked against the bytes they were parsed from.
function loadSources(
  root: string,
  outDir: string,
  ids: readonly string[],
  shown: (file: string) => string,
): { sources: Map<string, Source> } | { problem: string } {
  const wanted = new Set(ids);
  const parsed = new Map<string, ParsedMessage>();
  try {
    for (const line of readFileSync(join(outDir, 'messages.jsonl'), 'utf8').split('\n')) {
      if (line === '') continue;
      const m = JSON.parse(line) as ParsedMessage;
      if (wanted.has(m.id)) parsed.set(m.id, m);
    }
  } catch (err) {
    return { problem: `cannot read ${shown(join(outDir, 'messages.jsonl'))} (${errorText(err)}); run "node obs.mjs prepare"` };
  }
  const absent = ids.filter((id) => !parsed.has(id));
  if (absent.length > 0) {
    return {
      problem: `${absent.length} of the batch's messages are not in ${shown(join(outDir, 'messages.jsonl'))} (first: ${absent[0]}); run "node obs.mjs prepare"`,
    };
  }
  let bytes: Map<string, Buffer>;
  try {
    bytes = openCorpus(root).readMany(ids);
  } catch (err) {
    return { problem: `cannot read the batch's messages from the corpus (${errorText(err)})` };
  }
  const sources = new Map<string, Source>();
  const changed: string[] = [];
  for (const id of ids) {
    const data = bytes.get(id) as Buffer;
    const message = parsed.get(id) as ParsedMessage;
    if (gitBlobSha(data) !== message.blob_sha) changed.push(id);
    sources.set(id, { message, raw: data.toString('utf8') });
  }
  if (changed.length > 0) {
    return {
      problem: `${changed.length} of the batch's messages changed since prepare ran (first: ${changed[0]}); run "node obs.mjs prepare" again`,
    };
  }
  return { sources };
}

// An ID the model wrote that is not in the batch (model text, so escaped and cut), with the likely
// intended one when it only lost its trailing dot.
function unknownId(id: string, batch: Batch): string {
  return batch.inBatch.has(`${id}.`) ? `${modelText(id)} (did you mean ${id}.? IDs keep their trailing dot)` : modelText(id);
}

// A message ID as a problem shows it: as written when it is one of the batch's own IDs (then it is
// the index's text, not the model's), otherwise as model text.
const idText = (id: string, batch: Batch): string => (batch.inBatch.has(id) ? id : modelText(id));

export function checkExtraction(root: string, batchId: string, options: CheckOptions = {}): ExtractionCheck {
  const outDir = options.outDir ?? join(root, 'out');
  const shown = (file: string) => repoPath(root, file, outDir);

  let index: unknown;
  try {
    index = JSON.parse(readFileSync(join(outDir, 'batches', 'index.json'), 'utf8'));
  } catch (err) {
    return setupFailed(`cannot read ${shown(join(outDir, 'batches', 'index.json'))} (${errorText(err)}); run "node obs.mjs prepare"`);
  }
  const entry = Array.isArray(index) ? (index as BatchEntry[]).find((b) => b?.batch_id === batchId) : undefined;
  if (entry === undefined) return setupFailed(`${batchId} is not a batch in ${shown(join(outDir, 'batches', 'index.json'))}`);
  const batch: Batch = { entry, ids: entry.message_ids, inBatch: new Set(entry.message_ids) };

  const file = join(outDir, 'extract', `${batchId}.json`);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return failed([`${shown(file)} does not exist or cannot be read: write the extraction for ${batchId} there`]);
  }
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    return failed([
      `${shown(file)} is not valid JSON (${errorText(err)}): write exactly one JSON object, with no comments, trailing commas or text around it; ` +
        'raw tabs or line breaks inside JSON strings must be written as \\t or \\n',
    ]);
  }
  const schema = checkExtractionSchema(value);
  if (schema.extraction === null) return failed(schema.errors);
  const x = schema.extraction;

  const taxonomy = loadTaxonomy(outDir, options.taxonomyKeys, shown);
  if ('problem' in taxonomy) return setupFailed(taxonomy.problem);
  const loaded = loadSources(root, outDir, batch.ids, shown);
  if ('problem' in loaded) return setupFailed(loaded.problem);
  return check(x, batchId, batch, taxonomy.keys, loaded.sources);
}

function check(x: Extraction, batchId: string, batch: Batch, taxonomy: ReadonlySet<string>, sources: Map<string, Source>): ExtractionCheck {
  const problems: string[] = [];
  const add = (p: string) => void problems.push(p);
  const lengths: string[] = []; // note and batch_notes lengths, reported last

  if (x.batch_id !== batchId) add(`batch_id is ${modelText(x.batch_id)} but this file is for ${batchId}: set "batch_id": "${batchId}"`);

  // Coverage: exactly the batch's messages, each once. Later checks use the first entry per ID.
  const first = new Map<string, Message>();
  const doubled = new Set<string>();
  const extra: string[] = [];
  for (const m of x.messages) {
    if (!batch.inBatch.has(m.id)) {
      if (!extra.includes(m.id)) extra.push(m.id);
    } else if (first.has(m.id)) doubled.add(m.id);
    else first.set(m.id, m);
  }
  const missing = batch.ids.filter((id) => !first.has(id));
  if (missing.length > 0) {
    add(
      listProblem(
        `messages[] is missing ${missing.length} of the ${batch.ids.length} messages in ${batchId}: `,
        missing,
        ' (add one entry for each, with the ID copied exactly from its MESSAGE line)',
        COVERAGE_MAX_CHARS,
      ),
    );
  }
  if (extra.length > 0) {
    add(listProblem(`messages[] has ${extra.length} ID(s) that are not in ${batchId}: `, extra.map((id) => unknownId(id, batch)), ' (remove them or correct the ID)'));
  }
  if (doubled.size > 0) add(listProblem('messages[] lists ', [...doubled], ' more than once (keep one entry per message)'));
  const entries = [...first.values()];

  // Process keys.
  const usedNew = new Map<string, string[]>();
  for (const m of entries) {
    const seen = new Set<string>();
    for (const key of m.processes) {
      if (seen.has(key)) {
        add(`${m.id}: process ${modelText(key)} is listed twice in processes (list it once)`);
        continue;
      }
      seen.add(key);
      if (key.startsWith('new:')) {
        if (!NEW_KEY.test(key)) {
          add(`${m.id}: ${modelText(key)} is not a valid new process key: use "new:" and lowercase words joined by hyphens, e.g. "new:meter-reconciliation"`);
        } else if (taxonomy.has(key.slice(4))) {
          add(`${m.id}: ${modelText(key)} proposes a key the taxonomy already has: use ${JSON.stringify(key.slice(4))}`);
        } else usedNew.set(key, [...(usedNew.get(key) ?? []), m.id]);
      } else if (!taxonomy.has(key)) {
        const valid = taxonomy.size > 0 ? 'use a key from out/taxonomy.json, or' : 'there is no taxonomy yet, so';
        add(`${m.id}: unknown process key ${modelText(key)} (${valid} propose "new:<slug>" and declare it in new_processes)`);
      }
    }
    if (m.processes.length === 0 && !ROLES_WITHOUT_PROCESS.includes(m.role)) {
      add(
        `${m.id}: processes is [] but role is "${m.role}"; an empty list is allowed only for roles ${ROLES_WITHOUT_PROCESS.join(', ')} ` +
          '(tag the process this message is part of, or correct the role)',
      );
    }
  }

  // Proposed processes: every new: key used is declared, every declaration is used.
  const declared = new Map<string, number>();
  x.new_processes.forEach((p, i) => {
    const at = `new_processes[${i}] (${modelText(p.key)})`;
    if (!NEW_KEY.test(p.key)) add(`${at}: key must be "new:" and lowercase words joined by hyphens, e.g. "new:meter-reconciliation"`);
    if (declared.has(p.key)) add(`${at}: ${modelText(p.key)} is declared more than once (declare it once)`);
    else declared.set(p.key, i);
    if (p.name.trim() === '') add(`${at}: name is empty`);
    if (p.definition.trim() === '') add(`${at}: definition is empty`);
    for (const id of p.example_ids) {
      if (!batch.inBatch.has(id)) add(`${at}: example ID ${unknownId(id, batch)} is not in ${batchId}`);
      else if (!first.get(id)?.processes.includes(p.key)) add(`${at}: example ${id} is not tagged ${modelText(p.key)} (tag it or drop it from example_ids)`);
    }
  });
  for (const [key, ids] of usedNew) {
    if (!declared.has(key)) {
      add(listProblem(`${modelText(key)} is used by `, ids, ' but not declared in new_processes (add {"key", "name", "definition", "example_ids"} for it)'));
    }
  }
  // Any new: key a message lists counts as used here, even one already reported as invalid.
  const listedNew = new Set(entries.flatMap((m) => m.processes.filter((k) => k.startsWith('new:'))));
  for (const [key, i] of declared) {
    if (NEW_KEY.test(key) && !listedNew.has(key)) {
      add(`new_processes[${i}] declares ${modelText(key)} but no message uses it (tag the messages it covers, or remove it)`);
    }
  }

  // Where else a quote not found in its message is: the other field, or another batch message.
  const elsewhere = (id: string, quote: string, field: QuoteField): { field: QuoteField } | { message: string } | null => {
    const own = sources.get(id);
    const other: QuoteField = field === 'body' ? 'subject' : 'body';
    if (own !== undefined && checkQuote(own.raw, own.message, quote, other).match !== 'rejected') return { field: other };
    for (const otherId of batch.ids) {
      if (otherId === id) continue;
      const s = sources.get(otherId) as Source;
      if (checkQuote(s.raw, s.message, quote, 'body').match !== 'rejected' || checkQuote(s.raw, s.message, quote, 'subject').match !== 'rejected') {
        return { message: otherId };
      }
    }
    return null;
  };

  // What to tell the model about a rejected quote. `where` names the message and the entry.
  const quoteProblem = (where: string, quote: string, c: QuoteCheck, field: QuoteField | 'claim', found: string | null): string => {
    const n = quoteLength(quote);
    switch (c.reason) {
      case 'empty':
        return `${where}: quote is empty (copy ${QUOTE_MIN_CHARS}-${QUOTE_MAX_CHARS} characters of the message text)`;
      case 'too_short':
        return `${where}: quote is ${n} characters, under the ${QUOTE_MIN_CHARS} minimum: ${preview(quote)} (quote a longer stretch; only a whole subject may be shorter)`;
      case 'too_long':
        return `${where}: quote is ${n} characters, over the ${QUOTE_MAX_CHARS} maximum: ${preview(quote)} (quote the most telling sentence or two)`;
      case 'wrong_message':
        return `${where}: quote is not in this message but is in ${found}: ${preview(quote)} (cite ${found} for it, or quote this message's own text)`;
      default: {
        const from = field === 'subject' ? "the message's Subject line" : field === 'body' ? 'the message body' : 'the message';
        const hint = found === null ? '' : `; it is in the ${found}: set "field": "${found}"`;
        return `${where}: quote not found verbatim: ${preview(quote)} (copy it character for character from ${from} in the batch file${hint})`;
      }
    }
  };

  // Evidence: in the batch, tagged with the process, quote located. A rejected quote blocks only
  // when its (message, process) tag ends up with no accepted quote: an extra quote that fails
  // beside an accepted one stays in `validated` as rejected (it never ships) and costs no loop.
  // Citing a message outside the batch, or a process the message is not tagged with, always blocks.
  const checks: QuoteCheck[] = [];
  const supported = new Set<string>(); // "<id>\0<process>" with an accepted quote
  const rejectedFor = new Map<string, number>();
  const evidenceProblems: Array<{ text: string; tag: string | null }> = []; // tag: blocks only if unsupported
  x.evidence.forEach((e, i) => {
    const where = `${idText(e.message_id, batch)}: evidence[${i}] (${modelText(e.process)})`;
    const source = sources.get(e.message_id);
    if (source === undefined) {
      checks.push(rejectedQuote('wrong_message'));
      const found = elsewhere(e.message_id, e.quote, e.field);
      const there = found !== null && 'message' in found ? `; the quote is in ${found.message}` : '';
      evidenceProblems.push({ text: `${where}: message_id ${unknownId(e.message_id, batch)} is not in ${batchId} (cite a message from this batch${there})`, tag: null });
      return;
    }
    const tags = first.get(e.message_id)?.processes ?? [];
    const tagged = tags.includes(e.process);
    if (!tagged) {
      evidenceProblems.push({
        text: listProblem(
          `${where}: ${modelText(e.process)} is not one of this message's processes [`,
          tags.map((t) => modelText(t)),
          '] (tag the message with it, or cite the right process)',
        ),
        tag: null,
      });
    }
    let c = checkQuote(source.raw, source.message, e.quote, e.field);
    let found: string | null = null;
    if (c.reason === 'not_found') {
      const other = elsewhere(e.message_id, e.quote, e.field);
      if (other !== null && 'message' in other) {
        c = rejectedQuote('wrong_message');
        found = other.message;
      } else if (other !== null) found = other.field;
    }
    checks.push(c);
    const key = `${e.message_id}\0${e.process}`;
    if (c.match === 'rejected') {
      evidenceProblems.push({ text: quoteProblem(where, e.quote, c, e.field, found), tag: key });
      rejectedFor.set(key, (rejectedFor.get(key) ?? 0) + 1);
    } else if (tagged) supported.add(key);
    const noteChars = chars(e.note);
    if (noteChars > NOTE_MAX_CHARS) lengths.push(`${where}: note is ${noteChars} characters; keep it to ${NOTE_MAX_CHARS}`);
  });
  for (const p of evidenceProblems) if (p.tag === null || !supported.has(p.tag)) add(p.text);

  // Every (message, process) tag names its evidence.
  for (const m of entries) {
    for (const key of new Set(m.processes)) {
      if (supported.has(`${m.id}\0${key}`)) continue;
      const rejected = rejectedFor.get(`${m.id}\0${key}`) ?? 0;
      const why = rejected > 0 ? ` (its ${rejected} quote${rejected > 1 ? 's were' : ' was'} rejected)` : '';
      add(`${m.id}: process ${modelText(key)} has no accepted evidence quote${why}: add an evidence entry quoting this message verbatim for it, or remove the tag`);
    }
  }

  // Stall and ownership quotes, body first, then subject. Entries for IDs outside the batch are
  // already reported; their quotes cannot be located.
  const claim = (id: string, quote: string): QuoteCheck => {
    const s = sources.get(id);
    if (s === undefined) return rejectedQuote('wrong_message');
    const body = checkQuote(s.raw, s.message, quote, 'body');
    if (body.match !== 'rejected') return body;
    const subject = checkQuote(s.raw, s.message, quote, 'subject');
    return subject.match !== 'rejected' ? subject : body;
  };
  const stall_checks: ValidatedExtraction['stall_checks'] = [];
  const ownership_checks: ValidatedExtraction['ownership_checks'] = [];
  for (const m of x.messages) {
    const inBatch = first.get(m.id) === m;
    if (m.stall !== null) {
      const c = claim(m.id, m.stall.quote);
      stall_checks.push({ message_id: m.id, ...c });
      if (inBatch && c.match === 'rejected') add(quoteProblem(`${m.id}: stall`, m.stall.quote, c, 'claim', null));
    }
    if (m.ownership_claim !== null) {
      const c = claim(m.id, m.ownership_claim.quote);
      ownership_checks.push({ message_id: m.id, person: m.ownership_claim.person, ...c });
      const source = sources.get(m.id);
      const person = m.ownership_claim.person;
      if (inBatch && person.trim() === '') add(`${m.id}: ownership_claim.person is empty (name the person the message says owns the work)`);
      else if (inBatch && source !== undefined && !mentions(source.raw, source.message, person)) {
        add(`${m.id}: ownership_claim.person ${preview(person)} does not appear in this message (name the person as the message writes them)`);
      }
      if (inBatch && c.match === 'rejected') add(quoteProblem(`${m.id}: ownership_claim`, m.ownership_claim.quote, c, 'claim', null));
    }
  }

  const noteWords = words(x.batch_notes);
  if (noteWords > BATCH_NOTES_MAX_WORDS) lengths.push(`batch_notes is ${noteWords} words; keep it to ${BATCH_NOTES_MAX_WORDS}`);
  problems.push(...lengths);

  // The validated record, keys in contract order whatever order the model wrote them in.
  const evidence: ValidatedEvidence[] = x.evidence.map((e, i) => ({
    evidence_id: `${batchId}:e${i}`,
    process: e.process,
    message_id: e.message_id,
    field: e.field,
    quote: e.quote,
    note: e.note,
    ...(checks[i] as QuoteCheck),
  }));
  const all = [...evidence, ...stall_checks, ...ownership_checks];
  const count = (match: QuoteCheck['match']) => all.filter((c) => c.match === match).length;
  const validated: ValidatedExtraction = {
    batch_id: batchId,
    content_sha: batch.entry.content_sha,
    messages: x.messages.map((m) => ({
      id: m.id,
      processes: [...m.processes],
      role: m.role,
      stall: m.stall === null ? null : { kind: m.stall.kind, quote: m.stall.quote },
      ownership_claim: m.ownership_claim === null ? null : { person: m.ownership_claim.person, quote: m.ownership_claim.quote },
    })),
    evidence,
    stall_checks,
    ownership_checks,
    new_processes: x.new_processes.map((p) => ({ key: p.key, name: p.name, definition: p.definition, example_ids: [...p.example_ids] })),
    batch_notes: x.batch_notes,
    // Over every quote checked: evidence, stall and ownership.
    quote_stats: { exact: count('exact'), repaired: count('repaired'), rejected: count('rejected') },
  };
  return { ok: problems.length === 0, setup: null, problems, validated };
}
