// Finds a quote a model copied from a batch file in the raw message it says the quote comes from
// (ARCHITECTURE.md 6.11). Two levels and no others:
//   exact     the quote is a substring of the text once both sides go through normalizeNewlines,
//             the same function the batch renderer shows bodies through;
//   repaired  it matches once every whitespace run on both sides is collapsed to one space (a
//             quote that lost or gained a line wrap), and is mapped back to the raw span it covers.
// Anything else is rejected: no fuzzy matching, so nothing that is not in the file ever ships.
//
// Offsets index into the whole raw message text (bytes.toString('utf8'), headers included,
// original line endings kept), like Segment offsets, and raw_text is always raw.slice(start, end):
// what the dashboard highlights is the file's own text, CRLFs, wraps and header folds included.
// Every accepted quote, body or subject, has offsets.
//
// Every step is linear in the message: one pass to build each view, indexOf to search (V8's
// string search does not backtrack quadratically), no regular expression applied to the quote.
import type { ParsedMessage, QuoteCheck, Segment, SegmentKind } from '../types.ts';
import { normalizeNewlines } from '../util/text.ts';

export const QUOTE_MIN_CHARS = 20;
export const QUOTE_MAX_CHARS = 400;

export type QuoteField = 'body' | 'subject';
export type QuoteRejection = 'empty' | 'too_short' | 'too_long' | 'not_found' | 'wrong_message';

// Length in characters (code points, so an emoji counts once), after trimming.
export function quoteLength(quote: string): number {
  let n = 0;
  for (const _ of quote.trim()) n++;
  return n;
}

// A string derived from a stretch of the raw text, with the raw offset of each of its UTF-16 units.
// toRaw has one extra entry at the end: the raw offset just past the stretch.
type View = { text: string; toRaw: Int32Array };

// `src` (which starts at raw offset `base`) after normalizeNewlines. The map is built by walking
// both strings in step and checking that they agree, so if the shared function ever changes, this
// fails loudly instead of mapping quotes to the wrong place.
function newlineView(src: string, base: number): View {
  const text = normalizeNewlines(src);
  const toRaw = new Int32Array(text.length + 1);
  let i = 0;
  for (let j = 0; j < text.length; j++) {
    const c = src.charCodeAt(i);
    toRaw[j] = base + i;
    if (c === 0x0d && text.charCodeAt(j) === 0x0a) i += src.charCodeAt(i + 1) === 0x0a ? 2 : 1;
    else if (c === text.charCodeAt(j)) i++;
    else throw new Error(`normalizeNewlines changed more than line endings at offset ${base + i}`);
  }
  if (i !== src.length) throw new Error('normalizeNewlines dropped text');
  toRaw[text.length] = base + i;
  return { text, toRaw };
}

const WHITESPACE = /\s+/g;
const collapse = (s: string): string => s.replace(WHITESPACE, ' ');

// The view with every whitespace run replaced by one space; a run maps to the raw offset of its
// first unit. Non-whitespace units keep their own offsets, so a match that starts and ends on
// non-whitespace (every trimmed quote does) maps back to an exact raw span.
function collapsedView(v: View): View {
  const parts: string[] = [];
  const toRaw = new Int32Array(v.text.length + 1);
  let k = 0;
  let last = 0;
  const copy = (from: number, to: number) => {
    for (let i = from; i < to; i++) toRaw[k++] = v.toRaw[i] as number;
    parts.push(v.text.slice(from, to));
  };
  const ws = new RegExp(WHITESPACE.source, 'g');
  for (let m = ws.exec(v.text); m !== null; m = ws.exec(v.text)) {
    copy(last, m.index);
    toRaw[k++] = v.toRaw[m.index] as number;
    parts.push(' ');
    last = m.index + m[0].length;
  }
  copy(last, v.text.length);
  toRaw[k] = v.toRaw[v.text.length] as number;
  return { text: parts.join(''), toRaw: toRaw.subarray(0, k + 1) };
}

// First index in the view whose raw offset is >= `raw` (the view's length if none).
function lowerBound(toRaw: Int32Array, raw: number): number {
  let lo = 0;
  let hi = toRaw.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((toRaw[mid] as number) < raw) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Where `needle` occurs in the view: the first occurrence starting inside one of `prefer` (raw
// ranges, in order), else the earliest. -1 if none. At most one indexOf per range plus one.
function find(v: View, needle: string, prefer: readonly Segment[]): number {
  for (const r of prefer) {
    const j = v.text.indexOf(needle, lowerBound(v.toRaw, r.start));
    if (j !== -1 && (v.toRaw[j] as number) < r.end) return j;
  }
  return v.text.indexOf(needle);
}

// The raw span of a match of `length` units at view index j. The match starts and ends on
// non-whitespace, which maps one to one.
function span(v: View, j: number, length: number): { start: number; end: number } {
  return { start: v.toRaw[j] as number, end: (v.toRaw[j + length - 1] as number) + 1 };
}

// Views are built once per message and reused for every quote checked against it.
type Target = { raw: string; body?: View; collapsedBody?: View; subject?: View; folded?: string };
const targets = new WeakMap<ParsedMessage, Target>();

function target(raw: string, m: ParsedMessage): Target {
  let t = targets.get(m);
  if (t === undefined || t.raw !== raw) {
    t = { raw };
    targets.set(m, t);
  }
  return t;
}

function bodyView(raw: string, m: ParsedMessage): View {
  const t = target(raw, m);
  if (t.body === undefined) {
    const start = Math.min(m.body_start, raw.length);
    t.body = newlineView(raw.slice(start), start);
  }
  return t.body;
}

function collapsedBodyView(raw: string, m: ParsedMessage): View {
  const t = target(raw, m);
  t.collapsedBody ??= collapsedView(bodyView(raw, m));
  return t.collapsedBody;
}

export const rejectedQuote = (reason: QuoteRejection): QuoteCheck => ({
  match: 'rejected',
  start: null,
  end: null,
  segment: null,
  raw_text: null,
  reason,
});

const segmentAt = (m: ParsedMessage, pos: number): SegmentKind | null =>
  m.segments.find((s) => s.start <= pos && pos < s.end)?.kind ?? null;

function checkBody(raw: string, m: ParsedMessage, q: string): QuoteCheck {
  const own = m.segments.filter((s) => s.kind === 'own');
  const v = bodyView(raw, m);
  let j = find(v, q, own);
  let match: 'exact' | 'repaired' = 'exact';
  let at: { start: number; end: number } | null = j === -1 ? null : span(v, j, q.length);
  if (at === null) {
    const c = collapsedBodyView(raw, m);
    const cq = collapse(q);
    j = find(c, cq, own);
    if (j === -1) return rejectedQuote('not_found');
    match = 'repaired';
    at = span(c, j, cq.length);
  }
  return { match, start: at.start, end: at.end, segment: segmentAt(m, at.start), raw_text: raw.slice(at.start, at.end), reason: null };
}

// The subject built from the raw header block the way the parser builds it (splitHeaders, then
// trimmed): the value of the first Subject field with its folded continuation lines appended
// without their line breaks, a leading byte-order mark on any line ignored. Each unit keeps its raw
// offset, so its text is the subject the batch file shows, and a match maps back to raw text.
function subjectView(raw: string, bodyStart: number): View {
  const ranges: Array<[number, number]> = [];
  let inField = false;
  let pos = 0;
  while (pos < bodyStart) {
    let end = pos;
    while (end < bodyStart && raw.charCodeAt(end) !== 0x0a && raw.charCodeAt(end) !== 0x0d) end++;
    const next = raw.charCodeAt(end) === 0x0d && raw.charCodeAt(end + 1) === 0x0a ? end + 2 : end + 1;
    const start = raw.charCodeAt(pos) === 0xfeff ? pos + 1 : pos;
    const first = raw.charCodeAt(start);
    if (inField) {
      if (start === end || (first !== 0x20 && first !== 0x09)) break;
      ranges.push([start, end]);
    } else {
      const name = /^subject[ \t]*:/i.exec(raw.slice(start, Math.min(end, start + 64)));
      if (name !== null) {
        inField = true;
        ranges.push([start + name[0].length, end]);
      }
    }
    pos = next;
  }
  const text = ranges.map(([a, b]) => raw.slice(a, b)).join('');
  const lead = text.length - text.trimStart().length;
  const kept = text.trim();
  const toRaw = new Int32Array(kept.length + 1);
  let i = 0;
  let k = 0;
  for (const [a, b] of ranges) {
    for (let r = a; r < b; r++, i++) if (i >= lead && i < lead + kept.length) toRaw[k++] = r;
  }
  toRaw[kept.length] = kept.length === 0 ? 0 : (toRaw[kept.length - 1] as number) + 1;
  return { text: kept, toRaw };
}

function subjectViewOf(raw: string, m: ParsedMessage): View {
  const t = target(raw, m);
  t.subject ??= subjectView(raw, Math.min(m.body_start, raw.length));
  return t.subject;
}

// Subject quotes are matched against the subject as the batch file shows it (unfolded and
// trimmed) and mapped back to the raw Subject field. A match that is verbatim in the raw text is
// exact; one that spans a folded line break is repaired, and its offsets and raw_text cover the
// raw span with the fold in it (CRLF and the continuation's leading whitespace included). Either
// way every accepted subject quote has offsets and raw_text = raw.slice(start, end).
function checkSubject(raw: string, m: ParsedMessage, q: string, length: number): QuoteCheck {
  const v = subjectViewOf(raw, m);
  const whole = q === v.text || collapse(q) === collapse(v.text);
  if (length < QUOTE_MIN_CHARS && !whole) return rejectedQuote('too_short');
  let j = v.text.indexOf(q);
  let at: { start: number; end: number };
  let match: 'exact' | 'repaired';
  if (j !== -1) {
    at = span(v, j, q.length);
    match = at.end - at.start === q.length ? 'exact' : 'repaired';
  } else {
    const c = collapsedView(v);
    const cq = collapse(q);
    j = c.text.indexOf(cq);
    if (j === -1) return rejectedQuote('not_found');
    match = 'repaired';
    at = span(c, j, cq.length);
  }
  return { match, start: at.start, end: at.end, segment: 'subject', raw_text: raw.slice(at.start, at.end), reason: null };
}

// Whether `name` appears anywhere in the raw message, headers or body, ignoring case and
// differences in whitespace (line breaks included). An ownership claim must name someone the
// message itself names.
export function mentions(raw: string, message: ParsedMessage, name: string): boolean {
  const needle = collapse(name.trim()).toLowerCase();
  if (needle === '') return false;
  const t = target(raw, message);
  t.folded ??= collapse(raw).toLowerCase();
  return t.folded.includes(needle);
}

// Check one quote against one message. `raw` is the whole raw message text; `field` says where the
// quote claims to be. The quote is trimmed, then must be 20-400 characters (a subject quote may be
// shorter when it is the whole subject). When it occurs more than once in the body, the first
// occurrence in the sender's own text wins, else the earliest; `segment` is the kind of segment
// the match starts in.
export function checkQuote(raw: string, message: ParsedMessage, quote: string, field: QuoteField): QuoteCheck {
  const q = normalizeNewlines(quote).trim();
  if (q === '') return rejectedQuote('empty');
  const length = quoteLength(q);
  if (length > QUOTE_MAX_CHARS) return rejectedQuote('too_long');
  if (field === 'subject') return checkSubject(raw, message, q, length);
  if (length < QUOTE_MIN_CHARS) return rejectedQuote('too_short');
  return checkBody(raw, message, q);
}
