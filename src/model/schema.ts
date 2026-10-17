// Strict structural check of an extractor's output file against the Extraction contract in
// src/types.ts: every key present, nothing else, types and enums exact. Unknown keys anywhere are
// errors rather than ignored: the contract has no numeric field of any kind (headline numbers come
// only from counted actions), so a model that adds hours, counts or scores is told to remove them.
// Errors come in document order, each naming where it is and what to do.
import { MESSAGE_ROLES, STALL_KINDS, type Extraction } from '../types.ts';

type Obj = Record<string, unknown>;

const TOP_KEYS = ['batch_id', 'messages', 'evidence', 'new_processes', 'batch_notes'] as const;
const MESSAGE_KEYS = ['id', 'processes', 'role', 'stall', 'ownership_claim'] as const;
const STALL_KEYS = ['kind', 'quote'] as const;
const OWNERSHIP_KEYS = ['person', 'quote'] as const;
const EVIDENCE_KEYS = ['process', 'message_id', 'field', 'quote', 'note'] as const;
const NEW_PROCESS_KEYS = ['key', 'name', 'definition', 'example_ids'] as const;
const FIELDS = ['body', 'subject'] as const;
const NULLABLE = new Set(['stall', 'ownership_claim']);

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function kindOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'object') return 'an object';
  if (typeof v === 'string') return 'a string';
  return `a ${typeof v}`;
}

const list = (options: readonly string[]) => options.map((o) => `"${o}"`).join(', ');

// Model-written text as a problem shows it: cut to `max` characters, then JSON-escaped, so it is one
// short line with no control characters whatever the model wrote. JSON leaves NEL, LS and PS raw,
// and some readers take them as line breaks, so they are escaped too.
export const MODEL_TEXT_MAX_CHARS = 80;
const UNICODE_BREAKS = new RegExp(`[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, 'g');
const BACKSLASH = String.fromCharCode(92);
export function modelText(text: string, max: number = MODEL_TEXT_MAX_CHARS): string {
  const points = Array.from(text);
  const cut = points.length > max ? `${points.slice(0, max).join('')}...` : text;
  return JSON.stringify(cut).replace(UNICODE_BREAKS, (c) => `${BACKSLASH}u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

class Checker {
  readonly errors: string[] = [];

  #add(where: string, what: string): void {
    this.errors.push(`schema: ${where} ${what}`);
  }

  // `v` is an object with exactly `keys`; reports unknown and missing keys. False if not an object.
  object(where: string, v: unknown, keys: readonly string[]): v is Obj {
    if (!isObject(v)) {
      this.#add(where, `must be an object, got ${kindOf(v)}`);
      return false;
    }
    for (const k of Object.keys(v)) {
      if (keys.includes(k)) continue;
      const numeric = typeof v[k] === 'number' ? '; the schema has no numeric fields' : '';
      this.#add(where, `has unknown key ${modelText(k, 60)}: remove it${numeric} (allowed keys: ${keys.join(', ')})`);
    }
    for (const k of keys) {
      if (Object.hasOwn(v, k)) continue;
      this.#add(where, `is missing key "${k}"${NULLABLE.has(k) ? ' (use null when there is none)' : ''}`);
    }
    return true;
  }

  string(where: string, v: unknown): void {
    if (v !== undefined && typeof v !== 'string') this.#add(where, `must be a string, got ${kindOf(v)}`);
  }

  strings(where: string, v: unknown): void {
    if (v === undefined) return;
    if (!Array.isArray(v)) {
      this.#add(where, `must be an array of strings, got ${kindOf(v)}`);
      return;
    }
    v.forEach((s, i) => this.string(`${where}[${i}]`, s));
  }

  oneOf(where: string, v: unknown, options: readonly string[]): void {
    if (v === undefined) return;
    if (typeof v === 'string' && options.includes(v)) return;
    const got = typeof v === 'string' ? modelText(v, 60) : kindOf(v);
    this.#add(where, `must be one of ${list(options)}, got ${got}`);
  }

  // An array whose items are checked by `item`. Absent keys were reported by object().
  array(where: string, v: unknown, item: (where: string, value: unknown) => void): void {
    if (v === undefined) return;
    if (!Array.isArray(v)) {
      this.#add(where, `must be an array, got ${kindOf(v)}`);
      return;
    }
    v.forEach((value, i) => item(`${where}[${i}]`, value));
  }
}

// The message ID in a label when it is readable, so the model can find the entry. It is model
// text, so it is shown escaped and cut.
const labelled = (where: string, v: unknown): string =>
  isObject(v) && typeof v.id === 'string' ? `${where} (${modelText(v.id)})` : where;

// The extraction typed, or null with every reason it does not fit the contract.
export function checkExtractionSchema(value: unknown): { extraction: Extraction | null; errors: string[] } {
  const c = new Checker();
  if (c.object('the top level', value, TOP_KEYS)) {
    c.string('batch_id', value.batch_id);
    c.array('messages', value.messages, (where, m) => {
      const at = labelled(where, m);
      if (!c.object(at, m, MESSAGE_KEYS)) return;
      c.string(`${at}.id`, m.id);
      c.strings(`${at}.processes`, m.processes);
      c.oneOf(`${at}.role`, m.role, MESSAGE_ROLES);
      if (m.stall !== null && m.stall !== undefined && c.object(`${at}.stall`, m.stall, STALL_KEYS)) {
        c.oneOf(`${at}.stall.kind`, m.stall.kind, STALL_KINDS);
        c.string(`${at}.stall.quote`, m.stall.quote);
      }
      if (m.ownership_claim !== null && m.ownership_claim !== undefined && c.object(`${at}.ownership_claim`, m.ownership_claim, OWNERSHIP_KEYS)) {
        c.string(`${at}.ownership_claim.person`, m.ownership_claim.person);
        c.string(`${at}.ownership_claim.quote`, m.ownership_claim.quote);
      }
    });
    c.array('evidence', value.evidence, (where, e) => {
      if (!c.object(where, e, EVIDENCE_KEYS)) return;
      c.string(`${where}.process`, e.process);
      c.string(`${where}.message_id`, e.message_id);
      c.oneOf(`${where}.field`, e.field, FIELDS);
      c.string(`${where}.quote`, e.quote);
      c.string(`${where}.note`, e.note);
    });
    c.array('new_processes', value.new_processes, (where, p) => {
      if (!c.object(where, p, NEW_PROCESS_KEYS)) return;
      c.string(`${where}.key`, p.key);
      c.string(`${where}.name`, p.name);
      c.string(`${where}.definition`, p.definition);
      c.strings(`${where}.example_ids`, p.example_ids);
    });
    c.string('batch_notes', value.batch_notes);
  }
  return { extraction: c.errors.length === 0 ? (value as Extraction) : null, errors: c.errors };
}
