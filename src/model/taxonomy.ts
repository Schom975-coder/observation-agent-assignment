// The taxonomy contract (ARCHITECTURE.md 5.5): what the taxonomist proposes in
// out/taxonomy-proposed.json, the checks a proposal must pass, and the canonical out/taxonomy.json
// that code writes from an accepted one. Whatever this gate admits becomes part of every
// extraction's cache key and every extractor's instructions, so it must hold against a degenerate
// or steered proposal, not only a sloppy one:
// - strict like the extraction schema: unknown keys are errors, no numeric field anywhere;
// - no catch-all keys: a key may not be, start with or end with a catch-all word;
// - free text describes work and addresses nobody: every name, definition and note is run through
//   the corpus injection scanner and a few patterns for text aimed at extractors, reviewers or the
//   analysis, and may carry no number of hours, minutes, dollars or percent;
// - every process is recurring: its example subjects, which must be real thread subjects (the one
//   claim code can check), together cover at least MIN_OCCURRENCES occurrences, and none of them
//   comes only from messages the pipeline flagged;
// - the canonical file fits TAXONOMY_MAX_BYTES, since every extractor reads it whole.
//
// The limits below are the ones the taxonomist's prompt states (.claude/agents/taxonomist.md); a
// seam test reads them from here and fails if the prompt drifts.
import { injectionMarkers } from '../parse/flags.ts';
import type { Thread } from '../types.ts';

export const PROCESSES_MIN = 8;
export const PROCESSES_MAX = 30;
// What the prompt asks for; the validator accepts anything from PROCESSES_MIN to PROCESSES_MAX.
export const PROCESSES_TARGET_MIN = 12;
export const PROCESSES_TARGET_MAX = 25;
export const KEY_MIN_CHARS = 3;
export const KEY_MAX_CHARS = 40;
export const NAME_MIN_CHARS = 3;
export const NAME_MAX_CHARS = 60;
export const DEFINITION_MIN_CHARS = 20;
export const DEFINITION_MAX_CHARS = 400;
export const NOTES_MAX = 8; // include and exclude each
export const NOTE_MAX_CHARS = 120;
export const EXAMPLE_SUBJECTS_MIN = 1;
export const EXAMPLE_SUBJECTS_MAX = 5;
// A process's example subjects together cover at least this many occurrences in threads.json.
export const MIN_OCCURRENCES = 2;
// out/taxonomy.json as written (2-space JSON and a newline): every extractor reads it whole.
export const TAXONOMY_MAX_BYTES = 24_000;
// A lowercase slug: letters, digits and single hyphens, starting with a letter.
export const KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
// Catch-all words: a key that is one of these, or starts or ends with one ("general-correspondence",
// "requests-other", "everything-else"), names a bin, not a piece of work. Matched by whole hyphen
// words, so "interest-statement" is not "rest". Messages that fit no process get a role or a
// new:<slug> proposal from the extractor instead.
export const CATCHALL_WORDS: readonly string[] = [
  'general',
  'other',
  'others',
  'misc',
  'miscellaneous',
  'uncategorised',
  'uncategorized',
  'unsorted',
  'unclassified',
  'unknown',
  'rest',
  'etc',
  'everything',
  'various',
  'none',
  'non-process',
  'routine',
  'correspondence',
  'communication',
  'communications',
  'email',
  'emails',
  'mail',
  'messages',
  'business',
  'catch-all',
  'catchall',
  'leftover',
  'leftovers',
  'assorted',
  'sundry',
];
// The extractor's roles and its new: prefix: never a key of their own.
export const RESERVED_KEYS: readonly string[] = ['personal', 'noise', 'automated', 'new'];

// Text a taxonomy must not carry, beyond what the corpus injection scanner already looks for. Each
// is about what the text does (address a reader of the pipeline, steer what is cited, tagged or
// reported), never about where it came from. The same linear-pattern rule as src/parse/flags.ts.
export const STEERING_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // "Extractors: ...", "SYSTEM: ...", "Note to the reviewer: ..." at the start of a sentence. Not
  // "pipeline": in this company "Pipeline: El Paso" is an ordinary label.
  {
    name: 'addressed_label',
    // After a line break only spaces and tabs may follow, so a run of line breaks is tried once per
    // break, not rescanned from each one (linear on hostile text).
    pattern: /(?:^|[.;!?]\s+|\n[^\S\n]*)(?:note\s+to\s+)?(?:the\s+)?(?:extractors?|reviewers?|reviewing\s+process|system|assistant|ai|llm|model|analysis)\s*:/i,
  },
  { name: 'reviewing_process', pattern: /\breviewing\s+(?:process|system|agent|model)\b/i },
  { name: 'addressed_modal', pattern: /\b(?:extractors?|reviewers?|the\s+analysis|ai|assistants?|llms?)\s+(?:shall|must|should|will|are\s+to|is\s+to|need\s+to)\b/i },
  { name: 'ignore_instructions', pattern: /\b(?:ignore|disregard|override|bypass)\s+(?:the|this|these|those|all|any|every|your|previous|prior|above|earlier)\b/i },
  { name: 'tag_nothing', pattern: /\btag\s+(?:nothing|no\s+messages?|none)\b/i },
  { name: 'sets_role', pattern: /\b(?:as|with)\s+(?:the\s+)?role\b|\brole\s*[:=]/i },
  { name: 'suppress_citation', pattern: /\b(?:do\s+not|don't|never|shall\s+not|must\s+not|should\s+not)\s+(?:cite|quote|count|report|mention|record)\b/i },
  { name: 'effort_claim', pattern: /\bzero\s+(?:staff\s+)?(?:hours?|minutes?|time|cost|effort|dollars?)\b|\bfully\s+automated\b/i },
];
// A number tied to time, money or a share: the pipeline counts and prices the work itself. The
// number part is tried only where a run of digits, commas and points starts (its first digit after
// any leading separators), so a long run of digits or "1,1,1,..." is scanned once, not once per
// digit: linear on hostile text.
export const EFFORT_NUMBER = /\$\s*\d|\d\s*%|(?<![\d,.])[,.]*\d[\d,.]*\s*(?:-\s*)?(?:percent|per\s*cent|pct|dollars?|usd|cents?|hours?|hrs?|hr|h|minutes?|mins?|min|fte)\b/i;
// Free text is checked for steering and effort numbers on at most this many characters: every field
// it applies to is far shorter, and a longer one is already reported as too long.
export const PROSE_SCAN_MAX_CHARS = 4_000;

// Names of the patterns `text` matches: the corpus injection scanner's, then the steering ones.
export function steeringMarkers(text: string): string[] {
  return [...injectionMarkers(text), ...STEERING_PATTERNS.filter((p) => p.pattern.test(text)).map((p) => p.name)];
}

// The catch-all word a key is, starts with or ends with, or null.
export function catchAllWord(key: string): string | null {
  if (RESERVED_KEYS.includes(key)) return key;
  const words = key.split('-');
  for (const w of CATCHALL_WORDS) {
    const n = w.split('-').length;
    if (words.length >= n && (words.slice(0, n).join('-') === w || words.slice(-n).join('-') === w)) return w;
  }
  return null;
}

// What threads.json says about a subject: the occurrences it covers that hold at least one message
// the pipeline did not flag, and how many of its messages are unflagged.
export type SubjectStats = { occurrences: number; unflagged_messages: number };

// `flagged`: IDs flagged suspected_injection or oversize (prepare-stats.json), which the digest
// never shows. Empty subjects are not subjects.
export function subjectStats(threads: readonly Thread[], flagged: ReadonlySet<string>): Map<string, SubjectStats> {
  const stats = new Map<string, SubjectStats>();
  for (const t of threads) {
    if (t.subject_norm === '') continue;
    const s = stats.get(t.subject_norm) ?? { occurrences: 0, unflagged_messages: 0 };
    s.unflagged_messages += t.message_ids.filter((id) => !flagged.has(id)).length;
    s.occurrences += t.occurrences.filter((o) => o.message_ids.some((id) => !flagged.has(id))).length;
    stats.set(t.subject_norm, s);
  }
  return stats;
}

export type TaxonomyProcess = {
  key: string;
  name: string;
  definition: string; // the recurring work, not a topic, a counterparty or a mailbox
  include: string[]; // notes for the extractors: what belongs
  exclude: string[]; // and what does not
  example_subjects: string[]; // subject_norm strings copied from the digest; each exists in threads.json
};
export type TaxonomyProposal = { processes: TaxonomyProcess[] };
// out/taxonomy.json. digest_sha and agent_sha say which digest and which taxonomist definition it
// came from (both hashed with newlines normalised); a change to either makes it stale.
export type Taxonomy = { version: 1; digest_sha: string; agent_sha: string; processes: TaxonomyProcess[] };

const PROCESS_KEYS = ['key', 'name', 'definition', 'include', 'exclude', 'example_subjects'] as const;

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const chars = (s: string): number => [...s].length;
const shown = (s: string): string => JSON.stringify(chars(s) > 60 ? `${[...s].slice(0, 60).join('')}...` : s);

function kindOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'object') return 'an object';
  if (typeof v === 'string') return 'a string';
  return `a ${typeof v}`;
}

const numericHint = (v: unknown): string => (typeof v === 'number' ? '; the schema has no numeric fields' : '');

// The serialised size of the canonical file these processes make (both hashes are 64 characters).
export const taxonomyBytes = (processes: TaxonomyProcess[]): number =>
  Buffer.byteLength(`${JSON.stringify(canonicalTaxonomy(processes, '0'.repeat(64), '0'.repeat(64)), null, 2)}\n`, 'utf8');

// ---- Text checks shared by every process record: the taxonomist's, and a process the merger
// promotes (src/model/merge.ts). `at` names the record in each problem; problems go to `add`. ----

// Free text describes the work and addresses nobody: no instruction to the pipeline or its readers
// and, unless `numbers` allows it, no number of hours, minutes, dollars or percent.
export function checkProse(at: string, where: string, text: string, add: (p: string) => void, numbers = false): void {
  const s = text.length > PROSE_SCAN_MAX_CHARS ? text.slice(0, PROSE_SCAN_MAX_CHARS) : text;
  const markers = steeringMarkers(s);
  if (markers.length > 0) {
    add(
      `${at}.${where} reads as an instruction to the pipeline or its readers (${markers.join(', ')}): ` +
        'describe the work and how to recognise its messages; address no reader and say nothing about what is cited, tagged or reported',
    );
  }
  const number = numbers ? null : EFFORT_NUMBER.exec(s);
  if (number !== null) {
    add(`${at}.${where} has a number of hours, minutes, dollars or percent (${shown(number[0].trim())}): the pipeline counts and prices the work itself; leave such numbers out`);
  }
}

// A string field of min-max characters (trimmed for the minimum); null when absent or not a string.
export function textField(at: string, field: string, v: unknown, min: number, max: number, add: (p: string) => void): string | null {
  if (v === undefined) return null;
  if (typeof v !== 'string') {
    add(`schema: ${at}.${field} must be a string, got ${kindOf(v)}${numericHint(v)}`);
    return null;
  }
  const n = chars(v.trim());
  if (n < min || chars(v) > max) add(`${at}.${field} must be ${min}-${max} characters, got ${chars(v)}`);
  return v;
}

// An array of non-empty strings, minItems-maxItems long, each at most maxChars; the strings found.
export function textList(at: string, field: string, v: unknown, minItems: number, maxItems: number, maxChars: number | null, add: (p: string) => void): string[] | null {
  if (v === undefined) return null;
  if (!Array.isArray(v)) {
    add(`schema: ${at}.${field} must be an array of strings, got ${kindOf(v)}`);
    return null;
  }
  if (v.length < minItems || v.length > maxItems) add(`${at}.${field} must have ${minItems === 0 ? `at most ${maxItems}` : `${minItems}-${maxItems}`} entries, got ${v.length}`);
  const out: string[] = [];
  v.forEach((s, j) => {
    if (typeof s !== 'string') {
      add(`schema: ${at}.${field}[${j}] must be a string, got ${kindOf(s)}${numericHint(s)}`);
      return;
    }
    if (s.trim() === '') add(`${at}.${field}[${j}] is empty`);
    else if (maxChars !== null && chars(s) > maxChars) add(`${at}.${field}[${j}] must be at most ${maxChars} characters, got ${chars(s)}`);
    out.push(s);
  });
  return out;
}

// A process key: a slug of KEY_MIN_CHARS-KEY_MAX_CHARS, no catch-all or reserved word, its words no
// instruction. The key, or null when absent or not a string. Uniqueness is the caller's.
export function checkKey(at: string, v: unknown, add: (p: string) => void): string | null {
  const key = textField(at, 'key', v, KEY_MIN_CHARS, KEY_MAX_CHARS, add);
  if (key === null) return null;
  if (!KEY_PATTERN.test(key)) {
    add(`${at}.key must be a lowercase slug: letters, digits and single hyphens, starting with a letter (e.g. "meter-volume-correction"), got ${shown(key)}`);
  }
  const word = catchAllWord(key);
  if (word !== null) {
    add(`${at}.key ${shown(key)} is a catch-all ("${word}"), not a process: name the recurring work itself (messages that fit no process get a role or a new: key from the extractor)`);
  }
  checkProse(at, 'key', key.replaceAll('-', ' '), add);
  return key;
}

// The name, definition and include/exclude notes of a process record: lengths, and no instruction
// or effort number in any of them. `onName` runs right after the name's own checks (the caller's
// uniqueness check, so problems keep their order). Returns the fields that are strings.
export function checkProcessText(
  at: string,
  fields: { name?: unknown; definition?: unknown; include?: unknown; exclude?: unknown },
  add: (p: string) => void,
  onName?: (name: string) => void,
): { name: string | null; definition: string | null; include: string[] | null; exclude: string[] | null } {
  const name = textField(at, 'name', fields.name, NAME_MIN_CHARS, NAME_MAX_CHARS, add);
  if (name !== null) {
    checkProse(at, 'name', name, add);
    onName?.(name);
  }
  const definition = textField(at, 'definition', fields.definition, DEFINITION_MIN_CHARS, DEFINITION_MAX_CHARS, add);
  if (definition !== null) checkProse(at, 'definition', definition, add);
  const notes = { include: null as string[] | null, exclude: null as string[] | null };
  for (const field of ['include', 'exclude'] as const) {
    notes[field] = textList(at, field, fields[field], 0, NOTES_MAX, NOTE_MAX_CHARS, add);
    for (const [j, note] of (notes[field] ?? []).entries()) checkProse(at, `${field}[${j}]`, note, add);
  }
  return { name, definition, ...notes };
}

// The proposal typed, or null with every problem found, each naming where it is and what to do.
// `subjects`: subjectStats() of threads.json.
export function checkTaxonomyProposal(value: unknown, subjects: ReadonlyMap<string, SubjectStats>): { processes: TaxonomyProcess[] | null; problems: string[] } {
  const problems: string[] = [];
  const add = (p: string) => problems.push(p);

  if (!isObject(value)) {
    add(`schema: the top level must be an object {"processes": [...]}, got ${kindOf(value)}`);
    return { processes: null, problems };
  }
  for (const k of Object.keys(value)) {
    if (k !== 'processes') add(`schema: the top level has unknown key ${shown(k)}: remove it${numericHint(value[k])} (allowed keys: processes)`);
  }
  const list = value.processes;
  if (!Array.isArray(list)) {
    add(`schema: the top level ${list === undefined ? 'is missing key "processes"' : `key "processes" must be an array, got ${kindOf(list)}`}`);
    return { processes: null, problems };
  }
  if (list.length < PROCESSES_MIN || list.length > PROCESSES_MAX) {
    add(`processes: ${list.length} processes; propose ${PROCESSES_TARGET_MIN}-${PROCESSES_TARGET_MAX} (the file is accepted with ${PROCESSES_MIN}-${PROCESSES_MAX})`);
  }

  const keys = new Map<string, number>();
  const names = new Map<string, number>();
  const subjectOwner = new Map<string, number>();
  list.forEach((p, i) => {
    const at = isObject(p) && typeof p.key === 'string' ? `processes[${i}] (${shown(p.key)})` : `processes[${i}]`;
    if (!isObject(p)) {
      add(`schema: ${at} must be an object, got ${kindOf(p)}`);
      return;
    }
    for (const k of Object.keys(p)) {
      if (!(PROCESS_KEYS as readonly string[]).includes(k)) {
        add(`schema: ${at} has unknown key ${shown(k)}: remove it${numericHint(p[k])} (allowed keys: ${PROCESS_KEYS.join(', ')})`);
      }
    }
    for (const k of PROCESS_KEYS) if (!Object.hasOwn(p, k)) add(`schema: ${at} is missing key "${k}"`);

    const key = checkKey(at, p.key, add);
    if (key !== null) {
      const first = keys.get(key);
      if (first !== undefined) add(`${at}.key ${shown(key)} repeats processes[${first}]: keys must be unique`);
      else keys.set(key, i);
    }
    checkProcessText(at, p, add, (name) => {
      const folded = name.trim().toLowerCase();
      const first = names.get(folded);
      if (first !== undefined) add(`${at}.name ${shown(name)} repeats processes[${first}]: names must be unique`);
      else names.set(folded, i);
    });

    const examples = textList(at, 'example_subjects', p.example_subjects, EXAMPLE_SUBJECTS_MIN, EXAMPLE_SUBJECTS_MAX, null, add);
    let occurrences = 0;
    for (const [j, s] of (examples ?? []).entries()) {
      if (s.trim() === '') continue; // reported above
      const stats = subjects.get(s);
      if (stats === undefined) {
        const cut = s.endsWith('...') ? ' (the digest cut that subject short; choose one shown whole)' : '';
        add(`${at}.example_subjects[${j}] ${shown(s)} is not a subject in the corpus${cut}: copy a subject exactly as the digest shows it`);
        continue;
      }
      if (stats.unflagged_messages === 0) {
        add(`${at}.example_subjects[${j}] ${shown(s)} comes only from messages the pipeline flagged (suspected injection or oversize): choose a subject the digest shows`);
        continue;
      }
      const owner = subjectOwner.get(s);
      if (owner === undefined) {
        subjectOwner.set(s, i);
        occurrences += stats.occurrences;
      } else if (owner === i) add(`${at}.example_subjects[${j}] ${shown(s)} is listed twice: list each subject once`);
      else add(`${at}.example_subjects[${j}] ${shown(s)} is already an example of processes[${owner}]: each subject may be an example under one process only`);
    }
    if (examples !== null && occurrences < MIN_OCCURRENCES) {
      add(
        `${at}.example_subjects cover ${occurrences} occurrence${occurrences === 1 ? '' : 's'} in the corpus; a process is work that comes round again: ` +
          `give subjects that together cover at least ${MIN_OCCURRENCES} (section B of the digest counts the occurrences of recurring subjects), or drop the process`,
      );
    }
  });

  if (problems.length > 0) return { processes: null, problems };
  const processes = list as TaxonomyProcess[];
  const bytes = taxonomyBytes(processes);
  if (bytes > TAXONOMY_MAX_BYTES) {
    add(`processes: the taxonomy would be ${bytes} bytes, over the cap of ${TAXONOMY_MAX_BYTES}: shorten definitions and notes, or merge processes`);
    return { processes: null, problems };
  }
  return { processes, problems };
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// The canonical file: processes sorted by key, every object's keys in contract order, so the same
// accepted proposal always gives the same bytes.
export function canonicalTaxonomy(processes: TaxonomyProcess[], digestSha: string, agentSha: string): Taxonomy {
  return {
    version: 1,
    digest_sha: digestSha,
    agent_sha: agentSha,
    processes: [...processes]
      .sort((a, b) => byText(a.key, b.key))
      .map((p) => ({
        key: p.key,
        name: p.name,
        definition: p.definition,
        include: [...p.include],
        exclude: [...p.exclude],
        example_subjects: [...p.example_subjects],
      })),
  };
}
