// Splits a message body into the sender's own text and the earlier messages it carries, so
// actions are priced on what the sender wrote, not on the thread pasted below it (ARCHITECTURE 4.1).
// The markers come from reading the corpus: Outlook and cc:Mail reply separators, Lotus Notes
// "Forwarded by" banners, other forward banners, the header block of an included message (Outlook
// From/Sent/To/Subject, or Lotus "Name on 05/14/2001 10:00 AM" followed by To/cc/Subject),
// "... wrote:" attributions, and ">"-prefixed lines. Text before the first marker is own; each
// marker starts a segment of its kind; the segments tile the body exactly.
import type { Segment, SegmentKind } from '../types.ts';

export const MARKER_TYPES = [
  'original_message', // -----Original Message----- (also Original Appointment, cc:Mail Reply Separator)
  'forwarded_by', // ---------------------- Forwarded by Name/HOU/ECT on 05/14/2001 10:00 AM -----
  'forwarded_message', // -- Forwarded message --, Begin forwarded message:, Inline attachment follows
  'reply_header', // header block of an included message with no separator line above it
  'wrote_line', // On Jan 16, 2002, Name wrote:
  'gt_quote', // > quoted line, when it comes before any other marker
] as const;
export type MarkerType = (typeof MARKER_TYPES)[number];
export type BodyMarker = { type: MarkerType; kind: Exclude<SegmentKind, 'own'>; start: number };

const KIND: Record<MarkerType, BodyMarker['kind']> = {
  original_message: 'quoted',
  forwarded_by: 'forwarded',
  forwarded_message: 'forwarded',
  reply_header: 'quoted',
  wrote_line: 'quoted',
  gt_quote: 'quoted',
};

const ORIGINAL =
  /^[ \t]*(?:-{2,}[ \t]*Original[ \t]+(?:Message|Appointment)[ \t]*-{2,}|_{3,}[ \t]*Reply[ \t]+Separator[ \t]*_{3,})/i;
const FORWARDED_BY = /^[ \t]*-{3,}[ \t]*Forwarded[ \t]+by\b/i;
const FORWARDED_MESSAGE =
  /^[ \t]*(?:-{2,}[ \t]*(?:Forwarded[ \t]+Message|Inline[ \t]+attachment[ \t]+follows|Received[ \t]+from)\b|Begin[ \t]+forwarded[ \t]+message\b)/i;
const WROTE = /\bwrote:[ \t]*$/i;
const WROTE_ALONE = /^[ \t]*wrote:[ \t]*$/i;
const WROTE_LEAD = /^[ \t]*(?:-{2,}[ \t]*)?(?:On|At)\b/i;
const GT = /^[ \t]*>/;
const BLANK = /^\s*$/;
const LABEL = /^[ \t]*(From|Sent|To|Cc|Bcc|Date|Subject)[ \t]*:/i;
const FROM_LABEL = /^[ \t]*From[ \t]*:/i;
const SUBJECT = /^[ \t]*Subject[ \t]*:/i;
// Bounded so a long whitespace run can't make the lazy match backtrack quadratically.
const COLUMN_TO = /^[ \t]{10,}\S.{0,200}?[ \t]{3,}To:[ \t]/;
const COLUMN_SUBJECT = /^[ \t]{10,}\S.{0,200}?[ \t]{3,}Subject:[ \t]/;
const LOTUS_TIME = /\b\d{1,2}\/\d{1,2}\/\d{2,4}[ \t]+\d{1,2}:\d{2}(?::\d{2})?[ \t]*[AP]M\b/i;
const LOTUS_TIME_ONLY = /^[ \t]*\d{1,2}\/\d{1,2}\/\d{2,4}[ \t]+\d{1,2}:\d{2}(?::\d{2})?[ \t]*[AP]M[ \t]*$/i;
const LOTUS_DATE_WRAPPED = /\bon[ \t]+\d{1,2}\/\d{1,2}\/\d{2,4}[ \t]*$/i; // "Name on 02/20/2001" + time on the next line
const MEMO_FROM = /^[ \t]+From:[ \t]+\S.*\d{1,2}\/\d{1,2}\/\d{2,4}/i;
const LETTERHEAD = /^[ \t]+\S.{0,58}$/; // short indented line, e.g. "\tEnron North America Corp."
const NAME_LINE = /^[ \t]*\S.{0,50}[^.!?:,\s][ \t]*$/; // short, not ending like a sentence
// Lines Lotus may put between the sender line and To:.
const ATTRIBUTION_FILLER = [
  /^\s*$/,
  /^[ \t]*Sent[ \t]+by[ \t]*:/i,
  /^[ \t]*Please[ \t]+respond[ \t]+to\b/i,
  /^[ \t]*<[^>]*>[ \t]*$/, // the address of a wrapped "Please respond to"
  /^[ \t]*\d{1,2}:\d{2}(?::\d{2})?[ \t]*[AP]M[ \t]*$/i, // a wrapped time
];

// The first header block below a separator belongs to that separator's segment when at most this
// many non-blank lines come between (Lotus prints the banner, its wrapped time, sometimes a
// letterhead line, then the header).
const ABSORB_NONBLANK = 3;
// How far above a Subject line a header block may start (long wrapped To/cc lists), and how far
// above the block a Lotus "Name / time" attribution may sit.
const MAX_BLOCK_LINES = 40;
const MAX_ATTRIBUTION_LINES = 8;

// `text` is the line without its ending, with quoted-printable residue that some exports left in
// the body (=09 tab, =20 space, = soft break) undone so markers read as written. Offsets are untouched.
type Line = { start: number; text: string };

function bodyLines(text: string, bodyStart: number): Line[] {
  const lines: Line[] = [];
  let pos = bodyStart;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const raw = text.slice(pos, end).replace(/\r$/, '');
    lines.push({ start: pos, text: raw.replace(/=(?:09|20)/gi, ' ').replace(/=$/, '') });
    pos = end + 1;
  }
  return lines;
}

const lineText = (lines: Line[], i: number): string => lines[i]?.text ?? '';
const quotedOrBlank = (t: string) => BLANK.test(t) || GT.test(t);

function separatorType(lines: Line[], i: number): MarkerType | null {
  const t = lineText(lines, i);
  if (ORIGINAL.test(t)) return 'original_message';
  if (FORWARDED_BY.test(t)) return 'forwarded_by';
  if (FORWARDED_MESSAGE.test(t)) return 'forwarded_message';
  if (t.length <= 200 && WROTE.test(t)) {
    let next = i + 1;
    while (next < lines.length && BLANK.test(lineText(lines, next))) next++;
    if (WROTE_LEAD.test(t) || WROTE_ALONE.test(t) || GT.test(lineText(lines, next))) return 'wrote_line';
  }
  return null;
}

// First line of the header block that ends with the Subject line lines[s], or null if the lines
// above it are not one. Accepted: a From field with Sent/To/Date/Cc (Outlook, RFC 822), or a To
// field with a Lotus timestamp or a cc field (Lotus Notes).
function headerBlockStart(lines: Line[], separators: Array<MarkerType | null>, s: number): number | null {
  const labels = new Set<string>();
  let top = s;
  for (let j = s; j >= 0 && s - j <= MAX_BLOCK_LINES; j--) {
    const t = lineText(lines, j);
    // Lotus sometimes leaves one blank line between cc: and Subject:.
    if (j === s - 1 && BLANK.test(t) && !quotedOrBlank(lineText(lines, j - 1))) continue;
    if (quotedOrBlank(t) || separators[j] != null) break;
    const label = LABEL.exec(t)?.[1];
    if (label !== undefined) {
      labels.add(label.toLowerCase());
      top = j;
    }
  }
  let start = top;
  let attribution = LOTUS_TIME.test(lineText(lines, top));
  if (!attribution) {
    // Lotus puts the sender a few lines above To: "Name on 05/14/2001 10:00 AM", "From: Name  <time>",
    // or a name line then a time line, possibly followed by filler lines.
    const filler = (t: string) => ATTRIBUTION_FILLER.some((re) => re.test(t));
    let k = top - 1;
    while (k >= 0 && top - k <= MAX_ATTRIBUTION_LINES && filler(lineText(lines, k))) k--;
    const t = lineText(lines, k);
    const sender = LOTUS_TIME.test(t) || LOTUS_DATE_WRAPPED.test(t) || FROM_LABEL.test(t);
    if (k >= 0 && top - k <= MAX_ATTRIBUTION_LINES && !GT.test(t) && sender) {
      attribution = true;
      start = k;
      if (LOTUS_TIME_ONLY.test(t)) {
        // The name is on the line above the time, or one blank line further up.
        let n = k - 1;
        if (BLANK.test(lineText(lines, n)) && NAME_LINE.test(lineText(lines, n - 1))) n--;
        if (n >= 0 && !quotedOrBlank(lineText(lines, n)) && separators[n] == null) start = n;
      }
    }
  }
  // The Lotus memo form ("\tFrom:  Name   05/14/2001 10:00 AM") has a letterhead line above it.
  if (MEMO_FROM.test(lineText(lines, start))) {
    let h = start - 1;
    while (h >= 0 && start - h <= 2 && BLANK.test(lineText(lines, h))) h--;
    if (h >= 0 && start - h <= 2 && LETTERHEAD.test(lineText(lines, h)) && BLANK.test(lineText(lines, h - 1))) start = h;
  }
  const outlook = labels.has('from') && ['sent', 'to', 'date', 'cc'].some((l) => labels.has(l));
  const notes = labels.has('to') && (attribution || labels.has('cc'));
  return outlook || notes ? start : null;
}

// Lotus two-column reply header: sender, address and time in an indented left column, To/cc/Subject
// in the right one. Starts at the first line of that block when lines[s] is its Subject line.
function columnBlockStart(lines: Line[], separators: Array<MarkerType | null>, s: number): number | null {
  let top = s;
  let to = false;
  for (let j = s - 1; j >= 0 && s - j <= 8; j--) {
    const t = lineText(lines, j);
    if (quotedOrBlank(t) || separators[j] != null) break;
    if (COLUMN_TO.test(t)) to = true;
    top = j;
  }
  return to ? top : null;
}

// Markers in body order, at most one per line, each at the start of its line.
export function findMarkers(text: string, bodyStart: number): BodyMarker[] {
  const lines = bodyLines(text, bodyStart);
  // Nested quoting (">" lines) never opens a segment by its separators or headers.
  const separators = lines.map((l, i) => (GT.test(l.text) ? null : separatorType(lines, i)));
  const found: Array<{ line: number; type: MarkerType }> = [];
  let openSeparator: number | null = null; // separator line whose own header block has not been seen yet
  let lastBlockEnd = -1; // Subject line of the last header block, so a second Subject line cannot re-find it
  for (let i = 0; i < lines.length; i++) {
    const t = lineText(lines, i);
    const separator = separators[i];
    if (separator != null) {
      let line = i;
      // A bare "wrote:" continues the attribution on the line above it.
      if (separator === 'wrote_line' && WROTE_ALONE.test(t) && i > 0 && !quotedOrBlank(lineText(lines, i - 1))) line = i - 1;
      found.push({ line, type: separator });
      openSeparator = i;
      continue;
    }
    if (GT.test(t)) continue;
    const start = SUBJECT.test(t)
      ? headerBlockStart(lines, separators, i)
      : COLUMN_SUBJECT.test(t)
        ? columnBlockStart(lines, separators, i)
        : null;
    if (start === null || start <= lastBlockEnd) continue;
    lastBlockEnd = i;
    const absorbed =
      openSeparator !== null &&
      start >= openSeparator &&
      lines.slice(openSeparator + 1, start).filter((l) => !BLANK.test(l.text)).length <= ABSORB_NONBLANK;
    if (!absorbed) found.push({ line: start, type: 'reply_header' });
    openSeparator = null;
  }
  found.sort((a, b) => a.line - b.line);
  // A ">" line opens a quoted segment only while still in own text.
  const firstQuoted = lines.findIndex((l) => GT.test(l.text));
  const firstOther = found[0]?.line ?? Infinity;
  if (firstQuoted !== -1 && firstQuoted < firstOther) found.unshift({ line: firstQuoted, type: 'gt_quote' });

  const markers: BodyMarker[] = [];
  let previous = -1;
  for (const { line, type } of found) {
    if (line <= previous) continue;
    previous = line;
    markers.push({ type, kind: KIND[type], start: lines[line]?.start ?? text.length });
  }
  return markers;
}

// Segments covering [bodyStart, text.length) in order with no gaps; none for an empty body.
export function segmentBody(text: string, bodyStart: number): { segments: Segment[]; markers: BodyMarker[] } {
  if (bodyStart >= text.length) return { segments: [], markers: [] };
  const markers = findMarkers(text, bodyStart);
  const segments: Segment[] = [];
  let start = bodyStart;
  let kind: SegmentKind = 'own';
  for (const marker of markers) {
    if (marker.start > start) segments.push({ kind, start, end: marker.start });
    start = marker.start;
    kind = marker.kind;
  }
  segments.push({ kind, start, end: text.length });
  return { segments, markers };
}

// Length of the own text with whitespace runs collapsed to one space and the ends trimmed.
export function ownChars(text: string, segments: Segment[]): number {
  const own = segments.filter((s) => s.kind === 'own').map((s) => text.slice(s.start, s.end));
  return own.join(' ').replace(/\s+/g, ' ').trim().length;
}
