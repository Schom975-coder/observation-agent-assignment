// The header block of a raw message: where it ends, its fields, the address lists and the subject.
// Hand-rolled because the corpus has one header style (plain text, 7bit), and total: a malformed
// field gives an empty value or a skipped address, never an exception.
import type { Address } from '../types.ts';

export type HeaderBlock = {
  // Lowercased field name -> value after the colon, unfolded. A repeated field keeps its first value.
  fields: Map<string, string>;
  // Offset of the first body character: just after the first empty line, or the end of the text.
  bodyStart: number;
};

const FIELD = /^([^\s:]+)[ \t]*:/;

export function splitHeaders(text: string): HeaderBlock {
  const fields = new Map<string, string>();
  let current: string | null = null; // field that continuation lines extend; null after a repeat or junk line
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const next = nl === -1 ? text.length : nl + 1;
    // A byte-order mark before the first field would otherwise become part of its name.
    const line = text.slice(pos, nl === -1 ? text.length : nl).replace(/\r$/, '').replace(/^﻿/, '');
    pos = next;
    if (line === '') return { fields, bodyStart: next };
    if (line.startsWith(' ') || line.startsWith('\t')) {
      // Unfolding removes only the line break; the leading whitespace stays (RFC 5322 2.2.3).
      if (current !== null) fields.set(current, (fields.get(current) ?? '') + line);
      continue;
    }
    const m = FIELD.exec(line);
    const name = m?.[1]?.toLowerCase();
    if (m === null || name === undefined || fields.has(name)) {
      current = null;
      continue;
    }
    fields.set(name, line.slice(m[0].length));
    current = name;
  }
  return { fields, bodyStart: text.length };
}

// Trimmed value of a field, or null when it is absent or blank.
export function headerValue(fields: Map<string, string>, name: string): string | null {
  const value = fields.get(name)?.trim();
  return value === undefined || value === '' ? null : value;
}

// A display name as people read it, or null when there is none. A "name" that is only an
// address (X-From is often "tnray@aep.com@ENRON <IMCEANOTES-...>") is not a display name.
function cleanName(raw: string): string | null {
  let name = raw.replace(/\s+/g, ' ').trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/\\(.)/g, '$1').trim();
  }
  if (name.length >= 2 && name.startsWith("'") && name.endsWith("'")) name = name.slice(1, -1).trim();
  if (name === '' || (name.includes('@') && !name.includes(' '))) return null;
  return name;
}

// Split an address list on commas (and semicolons) that are outside quotes and angle brackets.
function splitList(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let angle = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (angle) {
      if (c === '>') angle = false;
    } else if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '<') angle = true;
    else if (c === ',' || c === ';') {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function parseAddress(part: string): Address | null {
  let email: string;
  let name: string | null = null;
  const lt = part.indexOf('<');
  if (lt !== -1) {
    const gt = part.indexOf('>', lt);
    email = part.slice(lt + 1, gt === -1 ? part.length : gt);
    name = cleanName(part.slice(0, lt));
  } else {
    // Bare address, possibly with an old-style "(Name)" comment or a group label "Team:".
    const comment = /\(([^)]*)\)/.exec(part);
    if (comment !== null) name = cleanName(comment[1] ?? '');
    const bare = part.replace(/\([^)]*\)/g, ' ');
    const token = bare.slice(bare.lastIndexOf(':') + 1).split(/\s+/).find((t) => t.includes('@')) ?? '';
    email = token.replace(/^(['"])(.*)\1$/, '$2');
  }
  email = email.trim().toLowerCase();
  return email.includes('@') ? { email, name } : null;
}

// Addresses in a From/To/Cc value: lowercased, trimmed, first occurrence of each email kept,
// entries without an "@" skipped.
export function parseAddressList(value: string | null): Address[] {
  if (value === null) return [];
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const part of splitList(value)) {
    const address = parseAddress(part);
    if (address === null || seen.has(address.email)) continue;
    seen.add(address.email);
    out.push(address);
  }
  return out;
}

// The sender's name from X-From: the text before any "<...>" part, e.g.
// "Cernosek, Clem </O=ENRON/OU=NA/CN=RECIPIENTS/CN=Ccernos>" -> "Cernosek, Clem".
// Taking the text before the first "<" also handles '"Name" <a@b>@ENRON <IMCEANOTES-...>'.
export function xFromName(value: string | null): string | null {
  if (value === null) return null;
  const lt = value.indexOf('<');
  return cleanName(lt === -1 ? value : value.slice(0, lt));
}

// One leading reply/forward prefix: "re:", "fw:" or "fwd:", any case, with optional whitespace,
// optionally opening a bracket as in "[Fwd: Fw: subject]".
const SUBJECT_PREFIX = /^\s*(\[?)\s*(?:re|fwd?)\s*:/i;
const TRAILING_PUNCT = /[\s.,;:!?'"`*~_\-–—…]+$/u;

// The first prefix is a forward ("FW:", "Fw :", "[Fwd: ...]"). Same grammar as SUBJECT_PREFIX,
// so parsing and action counting agree on every subject; "RE: FW:" is a reply.
const FORWARD_PREFIX = /^\s*\[?\s*fwd?\s*:/i;

export function isReplyOrForward(subject: string): boolean {
  return SUBJECT_PREFIX.test(subject);
}

export function isForwardSubject(subject: string): boolean {
  return FORWARD_PREFIX.test(subject);
}

// Threading key: lowercase, every leading prefix stripped (with the brackets they opened),
// whitespace collapsed, trailing punctuation stripped.
export function normalizeSubject(subject: string): string {
  let s = subject.toLowerCase();
  let brackets = 0;
  for (let m = SUBJECT_PREFIX.exec(s); m !== null; m = SUBJECT_PREFIX.exec(s)) {
    if (m[1] === '[') brackets++;
    s = s.slice(m[0].length);
  }
  s = s.replace(/\s+/g, ' ').trim();
  for (; brackets > 0 && s.endsWith(']'); brackets--) s = s.slice(0, -1).trimEnd();
  return s.replace(TRAILING_PUNCT, '');
}
