// The merge contract (ARCHITECTURE.md 5.6, 6.19): the input code builds for the merger from the
// extractors' proposed "new:" keys, the checks the merger's proposal must pass, the canonical
// out/merge.json code writes from an accepted one, and effectiveKeys(), the one function every
// later stage uses to turn a message's tags into the keys it is counted under.
//
// The merger decides one thing: where each proposed key's messages count (a taxonomy key, a
// promoted process of its own, or nowhere). Everything numeric is code's: the counts in the input,
// the size check that demotes a promotion too small to be recurring work, and every count after.
// Like the taxonomy gate, the proposal is strict (unknown keys rejected, no numeric field) and its
// free text is scanned for instructions and effort numbers, since a promoted process's definition
// is shown to every later reader.
import { cutChars, flatten, jsonText } from '../batch/digest.ts';
import { estTokens, lineCount } from '../batch/build.ts';
import { catchAllWord, checkKey, checkProcessText, type Taxonomy } from './taxonomy.ts';
import { modelText } from './schema.ts';
import type { MergeProposal, MergeTable, ParsedMessage, Thread, ValidatedExtraction } from '../types.ts';

export const MERGE_INPUT_MAX_TOKENS = 48_000;
export const MERGE_INPUT_MAX_LINES = 1_200;
export const MERGE_PROPOSAL_MAX_BYTES = 200_000;
export const DEFINITION_SHOWN_CHARS = 160;
export const DEFINITION_CUT_CHARS = 100; // the first step down when the input is over its cap
export const NAME_SHOWN_CHARS = 60;
export const SUBJECTS_SHOWN = 2;
export const SUBJECT_SHOWN_CHARS = 60;

export class MergeInputError extends Error {
  override name = 'MergeInputError';
}

// What code counts for one proposed key over the done batches' validated extractions.
export type SlugFacts = {
  slug: string; // "new:annual-budget-preparation"
  name: string; // the first declaration's (batch order, then declaration order)
  definition: string;
  message_ids: string[]; // the messages tagged with it, ID order
  occurrence_ids: string[];
  thread_ids: string[];
  batches: string[];
  months: string[]; // YYYY-MM of its usable-date messages, sorted, distinct
  subjects: string[]; // distinct subject_norm of its unflagged messages, in message ID order
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort(byText);
const isNewKey = (k: string): boolean => k.startsWith('new:');

// Message -> its occurrence and thread, from threads.json.
function occurrenceIndex(threads: readonly Thread[]): Map<string, { occurrence_id: string; thread_id: string }> {
  const index = new Map<string, { occurrence_id: string; thread_id: string }>();
  for (const t of threads) for (const o of t.occurrences) for (const id of o.message_ids) index.set(id, { occurrence_id: o.occurrence_id, thread_id: t.thread_id });
  return index;
}

// One record per distinct new: key tagged in `validated` (the done batches), sorted by slug.
// `messages`: every parsed message by ID (dates, subjects, flags).
export function slugFacts(validated: readonly ValidatedExtraction[], threads: readonly Thread[], messages: ReadonlyMap<string, ParsedMessage>): SlugFacts[] {
  const where = occurrenceIndex(threads);
  const declared = new Map<string, { name: string; definition: string }>();
  const tagged = new Map<string, { ids: Set<string>; batches: Set<string> }>();
  for (const v of [...validated].sort((a, b) => byText(a.batch_id, b.batch_id))) {
    for (const p of v.new_processes) if (!declared.has(p.key)) declared.set(p.key, { name: p.name, definition: p.definition });
    for (const m of v.messages) {
      for (const key of new Set(m.processes.filter(isNewKey))) {
        const t = tagged.get(key) ?? { ids: new Set<string>(), batches: new Set<string>() };
        t.ids.add(m.id);
        t.batches.add(v.batch_id);
        tagged.set(key, t);
      }
    }
  }
  return [...tagged.keys()].sort(byText).map((slug) => {
    const t = tagged.get(slug) as { ids: Set<string>; batches: Set<string> };
    const ids = sortedUnique(t.ids);
    const ms = ids.map((id) => messages.get(id)).filter((m): m is ParsedMessage => m !== undefined);
    const subjects: string[] = [];
    for (const m of ms) if (!m.flags.suspected_injection && m.subject_norm !== '' && !subjects.includes(m.subject_norm)) subjects.push(m.subject_norm);
    const decl = declared.get(slug) ?? { name: '', definition: '' };
    return {
      slug,
      name: decl.name,
      definition: decl.definition,
      message_ids: ids,
      occurrence_ids: sortedUnique(ids.flatMap((id) => where.get(id)?.occurrence_id ?? [])),
      thread_ids: sortedUnique(ids.flatMap((id) => where.get(id)?.thread_id ?? [])),
      batches: sortedUnique(t.batches),
      months: sortedUnique(ms.flatMap((m) => (m.date_status === 'usable' && m.date_utc !== null ? [m.date_utc.slice(0, 7)] : []))),
      subjects,
    };
  });
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const monthRange = (months: readonly string[]): string =>
  months.length === 0 ? 'undated' : months.length === 1 ? (months[0] as string) : `${months[0]}..${months.at(-1)}`;
// Email-derived and extractor-written text: one line, cut, JSON-quoted (as in the digest).
const quoted = (s: string, max: number): string => jsonText(cutChars(flatten(s), max));

// A proposed key whose slug the promoted-key rules refuse as a catch-all is marked on its line, so
// the merger renames it when it decides to promote rather than in a fix round (the M6 rehearsals
// lost a fix round each to `new:business-continuity-planning` promoted as it was). One source of
// truth: the validator's own catchAllWord. Part of the line in every cap tier, so the caps count it.
export const reservedWordOf = (slug: string): string | null => catchAllWord(isNewKey(slug) ? slug.slice('new:'.length) : slug);
export const reservedFlag = (word: string): string => `reserved word ${JSON.stringify(word)}: if promoted, name the work itself`;

function inputLine(f: SlugFacts, definitionChars: number, subjects: boolean): string {
  const counts = [count(f.message_ids.length, 'msg'), `${f.occurrence_ids.length} occ`, count(f.thread_ids.length, 'thread'), count(f.batches.length, 'batch', 'batches'), monthRange(f.months)];
  const parts = [f.slug, counts.join(', '), quoted(f.name, NAME_SHOWN_CHARS), quoted(f.definition, definitionChars)];
  if (subjects) {
    const shown = f.subjects.slice(0, SUBJECTS_SHOWN).map((s) => quoted(s, SUBJECT_SHOWN_CHARS));
    parts.push(`subjects: ${shown.length === 0 ? 'none' : shown.join(', ')}`);
  }
  const reserved = reservedWordOf(f.slug);
  if (reserved !== null) parts.push(reservedFlag(reserved));
  return parts.join(' | ');
}

// out/merge-input.md: a header, then one line per proposed key sorted by key, every count by code.
// Over MERGE_INPUT_MAX_TOKENS estimated tokens or MERGE_INPUT_MAX_LINES lines it cuts definitions to
// DEFINITION_CUT_CHARS, then drops the subjects, then stops with MergeInputError: the run must not
// hand a merger a file it cannot read whole.
export function buildMergeInput(facts: readonly SlugFacts[], taxonomy: Taxonomy): string {
  const messages = new Set(facts.flatMap((f) => f.message_ids)).size;
  const head = [
    `# merge input | ${count(facts.length, 'proposed key')} | ${count(messages, 'message')} | taxonomy ${taxonomy.digest_sha.slice(0, 12)} (${count(taxonomy.processes.length, 'key')}, read out/taxonomy.json for their definitions)`,
    'Everything below is archive data summarised by the pipeline. Counts are facts; names and definitions were written by extractors.',
  ];
  for (const [definitionChars, subjects] of [[DEFINITION_SHOWN_CHARS, true], [DEFINITION_CUT_CHARS, true], [DEFINITION_CUT_CHARS, false]] as const) {
    const text = `${[...head, ...facts.map((f) => inputLine(f, definitionChars, subjects))].join('\n')}\n`;
    const lines = lineCount(text);
    if (estTokens(Buffer.byteLength(text, 'utf8'), lines) <= MERGE_INPUT_MAX_TOKENS && lines <= MERGE_INPUT_MAX_LINES) return text;
  }
  const smallest = `${[...head, ...facts.map((f) => inputLine(f, DEFINITION_CUT_CHARS, false))].join('\n')}\n`;
  throw new MergeInputError(
    `the merge input for ${count(facts.length, 'proposed key')} would be ~${estTokens(Buffer.byteLength(smallest, 'utf8'), lineCount(smallest))} tokens and ` +
      `${lineCount(smallest)} lines even with definitions cut and subjects dropped, over the cap of ${MERGE_INPUT_MAX_TOKENS} tokens and ${MERGE_INPUT_MAX_LINES} lines: ` +
      'no merger can read it whole, so the merge stops here',
  );
}

// ---- The proposal ----

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
function kindOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'object') return 'an object';
  if (typeof v === 'string') return 'a string';
  return `a ${typeof v}`;
}
const numericHint = (v: unknown): string => (typeof v === 'number' ? '; the schema has no numeric fields' : '');

// The proposal's fields, as the merger's schema lists them (a seam test reads them).
export const PROPOSAL_KEYS = ['mapped', 'unassigned', 'promoted'] as const;
export const PROMOTED_KEYS = ['key', 'name', 'definition', 'aliases'] as const;
export const LIST_MAX_ITEMS = 15; // keys listed in one problem before "and K more"

const listed = (items: readonly string[]): string =>
  items.length <= LIST_MAX_ITEMS ? items.join(', ') : `${items.slice(0, LIST_MAX_ITEMS).join(', ')}, and ${items.length - LIST_MAX_ITEMS} more`;

// The proposal typed, or null with every problem found, each naming where it is and what to do.
// `slugs`: the proposed keys of the input; `taxonomyKeys`: out/taxonomy.json's. Every proposed key
// must appear exactly once across the lists in `mapped`, `unassigned` and the promoted aliases, and
// nothing else may; every key of `mapped` must be a taxonomy key. A taxonomy key with an empty list
// changes nothing and is accepted.
export function checkMergeProposal(value: unknown, slugs: ReadonlySet<string>, taxonomyKeys: ReadonlySet<string>): { proposal: MergeProposal | null; problems: string[] } {
  const problems: string[] = [];
  const add = (p: string) => void problems.push(p);
  if (!isObject(value)) {
    add(`schema: the top level must be an object {"mapped": {...}, "unassigned": [...], "promoted": [...]}, got ${kindOf(value)}`);
    return { proposal: null, problems };
  }
  for (const k of Object.keys(value)) {
    if (!(PROPOSAL_KEYS as readonly string[]).includes(k)) add(`schema: the top level has unknown key ${modelText(k, 60)}: remove it${numericHint(value[k])} (allowed keys: ${PROPOSAL_KEYS.join(', ')})`);
  }
  if (!isObject(value.mapped)) {
    add(`schema: the top level ${value.mapped === undefined ? 'is missing key "mapped"' : `key "mapped" must be an object {"<taxonomy key>": ["new:...", ...]}, got ${kindOf(value.mapped)}`}`);
  }
  for (const k of ['unassigned', 'promoted'] as const) {
    if (!Array.isArray(value[k])) add(`schema: the top level ${value[k] === undefined ? `is missing key "${k}"` : `key "${k}" must be an array, got ${kindOf(value[k])}`}`);
  }
  if (problems.length > 0) return { proposal: null, problems };
  const promotedList = value.promoted as unknown[];

  // Where each proposed key was placed, to report a second placement.
  const placed = new Map<string, string>();
  const place = (at: string, slug: unknown): void => {
    if (typeof slug !== 'string') {
      add(`schema: ${at} must be a string, got ${kindOf(slug)}${numericHint(slug)}`);
      return;
    }
    if (!slugs.has(slug)) {
      add(`${at}: ${modelText(slug)} is not a proposed key in the merge input: use the keys exactly as the input lists them (each starts with "new:")`);
      return;
    }
    const first = placed.get(slug);
    if (first !== undefined) add(`${at}: ${slug} is already placed at ${first}: place each proposed key exactly once`);
    else placed.set(slug, at);
  };

  const promotedHere = new Set(promotedList.flatMap((p) => (isObject(p) && typeof p.key === 'string' ? [p.key] : [])));
  for (const [key, list] of Object.entries(value.mapped as Obj)) {
    const at = `mapped[${modelText(key, 60)}]`;
    if (!taxonomyKeys.has(key)) {
      add(
        `mapped: ${modelText(key, 60)} is not a taxonomy key: ` +
          (promotedHere.has(key)
            ? 'it is a process this file promotes, so list these proposed keys in its aliases instead'
            : 'list these proposed keys under a key of out/taxonomy.json exactly as written there, in the aliases of a promoted process, or in unassigned'),
      );
    }
    if (!Array.isArray(list)) add(`schema: ${at} must be an array of proposed keys, got ${kindOf(list)}${numericHint(list)}`);
    else list.forEach((slug, j) => place(`${at}[${j}]`, slug));
  }
  (value.unassigned as unknown[]).forEach((slug, j) => place(`unassigned[${j}]`, slug));

  const promotedKeys = new Map<string, number>();
  const names = new Map<string, number>();
  promotedList.forEach((p, i) => {
    const at = isObject(p) && typeof p.key === 'string' ? `promoted[${i}] (${modelText(p.key)})` : `promoted[${i}]`;
    if (!isObject(p)) {
      add(`schema: ${at} must be an object, got ${kindOf(p)}`);
      return;
    }
    for (const k of Object.keys(p)) {
      if (!(PROMOTED_KEYS as readonly string[]).includes(k)) add(`schema: ${at} has unknown key ${modelText(k, 60)}: remove it${numericHint(p[k])} (allowed keys: ${PROMOTED_KEYS.join(', ')})`);
    }
    for (const k of PROMOTED_KEYS) if (!Object.hasOwn(p, k)) add(`schema: ${at} is missing key "${k}"`);
    const key = checkKey(at, p.key, add);
    if (key !== null) {
      if (taxonomyKeys.has(key)) add(`${at}.key ${modelText(key)} is already a taxonomy key: list the proposed keys under it in mapped instead of promoting`);
      const first = promotedKeys.get(key);
      if (first !== undefined) add(`${at}.key ${modelText(key)} repeats promoted[${first}]: promote each process once, with every key that means the same work as an alias`);
      else promotedKeys.set(key, i);
    }
    // The name and the definition only: a promoted process carries no include or exclude notes.
    checkProcessText(at, { name: p.name, definition: p.definition }, add, (name) => {
      const folded = name.trim().toLowerCase();
      const first = names.get(folded);
      if (first !== undefined) add(`${at}.name ${modelText(name, 60)} repeats promoted[${first}]: names must be unique`);
      else names.set(folded, i);
    });
    if (p.aliases !== undefined) {
      if (!Array.isArray(p.aliases)) add(`schema: ${at}.aliases must be an array of strings, got ${kindOf(p.aliases)}`);
      else if (p.aliases.length === 0) add(`${at}.aliases is empty: list every proposed key this process absorbs (at least one)`);
      else p.aliases.forEach((a, j) => place(`${at}.aliases[${j}]`, a));
    }
  });

  const missing = [...slugs].filter((s) => !placed.has(s)).sort(byText);
  if (missing.length > 0) {
    add(
      `${count(missing.length, 'proposed key is', 'proposed keys are')} in none of mapped, unassigned and the promoted aliases: ${listed(missing)} ` +
        '(place every key of the input exactly once: under the taxonomy key that covers its work in mapped, in unassigned, or in the aliases of a promoted process)',
    );
  }
  return { proposal: problems.length === 0 ? (value as MergeProposal) : null, problems };
}

const DUPLICATE_PATH_MAX = 120;
const DUPLICATE_PROBLEMS_MAX = 20;

// A key written twice in one object of a JSON text: JSON.parse keeps the last copy without a word,
// so a taxonomy key written twice in `mapped` would silently drop its first list. One problem per
// repeat, at most DUPLICATE_PROBLEMS_MAX, naming the object as the other problems do ("the top
// level", "mapped", "promoted[2]"), cut to DUPLICATE_PATH_MAX characters. `text` must already parse
// as JSON; one linear pass.
export function duplicateKeyProblems(text: string): string[] {
  type Frame = { object: boolean; path: string; keys: Set<string>; expectKey: boolean; key: string; index: number };
  const name = (key: string): string => (/^[\w:-]{1,60}$/.test(key) ? key : modelText(key, 60));
  // Deep nesting would otherwise grow a path, and the problem line quoting it, without limit.
  const bounded = (path: string): string => (path.length > DUPLICATE_PATH_MAX ? `${path.slice(0, DUPLICATE_PATH_MAX - 3)}...` : path);
  const stack: Frame[] = [];
  const problems: string[] = [];
  for (let i = 0; i < text.length && problems.length < DUPLICATE_PROBLEMS_MAX; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack.at(-1);
      if (top !== undefined && top.object && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) {
          problems.push(
            `schema: ${top.path} has key ${modelText(key, 60)} twice, and JSON keeps only the last copy: write each key once` +
              (top.path === 'mapped' ? ', with one list per taxonomy key holding all of its proposed keys' : ''),
          );
        } else top.keys.add(key);
        top.key = key;
        top.expectKey = false;
      }
      i = j;
    } else if (c === '{' || c === '[') {
      const top = stack.at(-1);
      const path = top === undefined ? 'the top level' : !top.object ? `${top.path}[${top.index}]` : top.path === 'the top level' ? name(top.key) : `${top.path}.${name(top.key)}`;
      stack.push({ object: c === '{', path: bounded(path), keys: new Set(), expectKey: c === '{', key: '', index: 0 });
    } else if (c === '}' || c === ']') stack.pop();
    else if (c === ',') {
      const top = stack.at(-1);
      if (top?.object) top.expectKey = true;
      else if (top !== undefined) top.index++;
    }
  }
  return problems;
}

// ---- The canonical table ----

type PromoteMin = { messages: number; occurrences: number; threads: number; active_months: number };

// out/merge.json from an accepted proposal. Every promotion is sized on its merged membership (the
// union of its aliases' messages, their occurrences, threads and active months) and demoted, with
// the reason, when any count is under `promoteMin`, or when every message behind it was flagged as a
// suspected injection (`flagged`). A demotion changes the table, never the proposal's acceptance.
export function canonicalMergeTable(
  proposal: MergeProposal,
  facts: readonly SlugFacts[],
  promoteMin: PromoteMin,
  flagged: ReadonlySet<string>,
  shas: { extractions_sha: string; taxonomy_sha: string; agent_sha: string },
): MergeTable {
  const fact = new Map(facts.map((f) => [f.slug, f]));
  const fate = new Map<string, { status: MergeTable['slugs'][number]['status']; to: string | null; reason: string | null }>();
  for (const [to, list] of Object.entries(proposal.mapped)) for (const slug of list) fate.set(slug, { status: 'mapped', to, reason: null });
  for (const slug of proposal.unassigned) fate.set(slug, { status: 'unassigned', to: null, reason: null });
  const promoted: MergeTable['promoted'] = [];
  for (const p of [...proposal.promoted].sort((a, b) => byText(a.key, b.key))) {
    const members = p.aliases.map((a) => fact.get(a)).filter((f): f is SlugFacts => f !== undefined);
    const ids = new Set(members.flatMap((f) => f.message_ids));
    const size = {
      messages: ids.size,
      occurrences: new Set(members.flatMap((f) => f.occurrence_ids)).size,
      threads: new Set(members.flatMap((f) => f.thread_ids)).size,
      active_months: new Set(members.flatMap((f) => f.months)).size,
    };
    const short = (Object.keys(promoteMin) as Array<keyof PromoteMin>).filter((k) => size[k] < promoteMin[k]);
    const injectionOnly = ids.size > 0 && [...ids].every((id) => flagged.has(id));
    let reason: string | null = null;
    if (short.length > 0) {
      reason =
        `promoted as ${p.key}, but the pipeline counted ${count(size.messages, 'message')}, ${count(size.occurrences, 'occurrence')}, ` +
        `${count(size.threads, 'thread')} and ${count(size.active_months, 'active month')}; a promoted process needs at least ` +
        `${count(promoteMin.messages, 'message')}, ${count(promoteMin.occurrences, 'occurrence')}, ${count(promoteMin.threads, 'thread')} and ${count(promoteMin.active_months, 'active month')}`;
    } else if (injectionOnly) {
      reason = `promoted as ${p.key}, but every message behind it is flagged as a suspected injection`;
    }
    if (reason !== null) {
      for (const a of p.aliases) fate.set(a, { status: 'demoted', to: null, reason });
      continue;
    }
    const aliases = [...p.aliases].sort(byText);
    for (const a of aliases) fate.set(a, { status: a === `new:${p.key}` ? 'promoted' : 'alias', to: p.key, reason: null });
    // The proposal has no notes; the table keeps the fields, empty, so its shape does not change.
    promoted.push({ key: p.key, name: p.name, definition: p.definition, include: [], exclude: [], aliases, ...size });
  }
  const slugs: MergeTable['slugs'] = [...facts]
    .sort((a, b) => byText(a.slug, b.slug))
    .map((f) => {
      const x = fate.get(f.slug) ?? { status: 'unassigned' as const, to: null, reason: null };
      return { slug: f.slug, messages: f.message_ids.length, batches: f.batches.length, status: x.status, to: x.to, reason: x.reason };
    });
  const with_ = (statuses: readonly string[]) => slugs.filter((s) => statuses.includes(s.status));
  const messagesOf = (rows: readonly MergeTable['slugs'][number][]) => new Set(rows.flatMap((r) => fact.get(r.slug)?.message_ids ?? []));
  const counted = messagesOf(with_(['mapped', 'promoted', 'alias']));
  return {
    version: 1,
    extractions_sha: shas.extractions_sha,
    taxonomy_sha: shas.taxonomy_sha,
    agent_sha: shas.agent_sha,
    promote_min: { messages: promoteMin.messages, occurrences: promoteMin.occurrences, threads: promoteMin.threads, active_months: promoteMin.active_months },
    slugs,
    promoted,
    counts: {
      slugs: slugs.length,
      mapped: with_(['mapped']).length,
      promoted: promoted.length,
      aliases: with_(['promoted', 'alias']).length,
      unassigned: with_(['unassigned']).length,
      demoted: with_(['demoted']).length,
      messages_mapped: messagesOf(with_(['mapped'])).size,
      messages_promoted: messagesOf(with_(['promoted', 'alias'])).size,
      messages_unassigned: [...messagesOf(with_(['unassigned', 'demoted']))].filter((id) => !counted.has(id)).length,
    },
  };
}

// ---- Merged keys ----

const lookups = new WeakMap<MergeTable, Map<string, string | null>>();

// A proposed key -> the key it counts under, or null (unassigned, demoted, or not in the table).
function lookup(table: MergeTable): Map<string, string | null> {
  let map = lookups.get(table);
  if (map === undefined) {
    map = new Map(table.slugs.map((s) => [s.slug, s.status === 'mapped' || s.status === 'promoted' || s.status === 'alias' ? s.to : null]));
    lookups.set(table, map);
  }
  return map;
}

// The keys a message's tags count under after the merge: a taxonomy key is itself; a new: key is
// the taxonomy key it was mapped to or the promoted process it belongs to, or nothing. Sorted, each
// once; [] when every tag ended unassigned.
export function effectiveKeys(tags: readonly string[], table: MergeTable): string[] {
  const map = lookup(table);
  const keys = new Set<string>();
  for (const tag of tags) {
    if (!isNewKey(tag)) keys.add(tag);
    else {
      const to = map.get(tag);
      if (to !== undefined && to !== null) keys.add(to);
    }
  }
  return [...keys].sort(byText);
}

// The key a proposed key counts under, or null: for re-keying evidence.
export const mergeTarget = (slug: string, table: MergeTable): string | null => lookup(table).get(slug) ?? null;
