// Plain words for the pipeline's codes (ARCHITECTURE.md 5.10): stall kinds, email actions, document
// types, tiers, estimate bases, claim statuses and participant kinds, so no page or report shows a
// code. And the refused-word check of the wording rules (requirements section G), which the tests
// run on code-written text.
import type { ActionType } from '../config.ts';
import type { ClaimStatus, DraftType, FoldRule, PersonKind, StallKind, Tier } from '../types.ts';
import { NOT_A_CONFIDENCE_INTERVAL, NO_REPLY, ONE_PERSON_CAUTION } from './format.ts';

export const stallKindWords: Record<StallKind, { one: string; many: string }> = {
  waiting_on_reply: { one: 'waiting on a reply', many: 'waiting on a reply' },
  rework: { one: 'rework', many: 'rework' },
  handoff_confusion: { one: 'handoff confusion', many: 'handoff confusion' },
  system_failure: { one: 'a system failure', many: 'system failures' },
  ownership_conflict: { one: 'an ownership conflict', many: 'ownership conflicts' },
  avoidance: { one: 'avoidance', many: 'avoidance' },
  other: { one: 'other', many: 'other' },
};

// "6 waiting on a reply", "1 system failure", "3 system failures".
export function stallCountWords(kind: StallKind, n: number): string {
  const w = stallKindWords[kind];
  const one = w.one.replace(/^an? /, '');
  return `${n} ${n === 1 ? one : w.many}`;
}

export const actionWords: Record<ActionType, string> = {
  authored_short: 'short emails written',
  authored_medium: 'medium emails written',
  authored_long: 'long emails written',
  forward: 'forwards',
  chaser: 'chasers',
  read: 'reads, one per addressee',
};

// What a message is counted as, for the viewer's "Counted here as:" line.
export const actionOneWords: Record<ActionType, string> = {
  authored_short: 'a short email written',
  authored_medium: 'a medium email written',
  authored_long: 'a long email written',
  forward: 'a forward',
  chaser: 'a chaser',
  read: 'a read',
};

export const docWords: Record<DraftType, string> = { sop: 'SOP', checklist: 'checklist', email_template: 'email template', template: 'template' };
// At the start of a sentence or as a link: "Checklist", "SOP".
export const docTitle = (t: DraftType): string => {
  const w = docWords[t];
  return w === w.toUpperCase() ? w : `${(w[0] as string).toUpperCase()}${w.slice(1)}`;
};

export const tierWords: Record<Tier, string> = {
  A: 'seen steadily: 40 or more times over 6 or more months by 3 or more staff',
  B: 'in the total: 10 or more times over 3 or more months by 2 or more staff',
  C: 'seen too rarely to count, not in the total',
};

// The tier rule in words from the scoring config, so a changed config changes the words.
export function tierRuleWords(tier: Tier, rules: { A: { min_occurrences: number; min_active_months: number; min_staff: number }; B: { min_occurrences: number; min_active_months: number; min_staff: number } }): string {
  if (tier === 'C') return tierWords.C;
  const r = rules[tier];
  const rule = `${r.min_occurrences} or more times over ${r.min_active_months} or more months by ${r.min_staff} or more staff`;
  return tier === 'A' ? `seen steadily: ${rule}` : `in the total: ${rule}`;
}

// As src/model/artifacts.ts says it in the drafted documents.
export const basisWords: Record<string, string> = {
  observed: 'seen in the emails',
  inferred: 'worked out from the steps the emails show',
  self_reported: 'as people described it in the emails',
  override: 'set by the project team',
};

export const claimStatusWords: Record<ClaimStatus, string> = {
  matched: 'matched to someone on the threads',
  several: 'could be any of several people on the threads',
  unmatched: 'not matched to anyone on the threads',
  group: 'a group or role, not one person',
};

export const kindWords: Record<PersonKind, string> = { person: 'person', list: 'distribution list', system: 'system sender' };

export const foldRuleWords: Record<FoldRule, string> = {
  display_name: 'the same display name',
  middle_initial: 'm..last onto the one first.m.last with that middle initial',
  last_name: 'm..last onto the one first.last, the middle initial shown in a display name',
  first_last: 'first.m.last onto first.last',
  initial_last: 'flast onto the one f*.last',
};

export const dateStatusWords: Record<string, string> = {
  usable: 'usable',
  missing: 'no Date header',
  unparseable: 'a Date header that is not a valid date',
  out_of_range: 'a date outside the archive’s years',
};

// "Giron, Darron C" read as "Darron C Giron" (the archive's directory form, as src/model/artifacts.ts
// reads it); a name without one comma as written; no name: the address.
export function personName(name: string | null, email: string): string {
  if (name === null || name.trim() === '') return email === '' ? 'unknown sender' : email;
  const m = /^([^,]+),[ \t]*([^,]+)$/.exec(name.trim());
  const s = m === null ? name.trim() : `${(m[2] as string).trim()} ${(m[1] as string).trim()}`;
  return s.replace(/[ \t]+[\u2013\u2014][ \t]+/g, ', ').replace(/[\u2013\u2014]/g, '-');
}

const SUFFIX = /^(?:jr|sr|ii|iii|iv|v)\.?$/i;
// The surname a person goes by in short labels: "Williams III, Bill" and "Bill Williams III" give
// "Williams", "Darron C Giron" gives "Giron".
export function surname(name: string | null): string | null {
  if (name === null || name.trim() === '') return null;
  const n = name.trim();
  const words = (n.includes(',') ? (n.split(',')[0] as string) : n).trim().split(/\s+/);
  while (words.length > 1 && SUFFIX.test(words.at(-1) as string)) words.pop();
  return (n.includes(',') ? words.join(' ') : words.at(-1)) ?? null;
}

// ---- The refused-word check (requirements section G) ----

export const REFUSED = [
  'at least',
  'floor',
  'conservative',
  'savings',
  'annual',
  'annually',
  'unanswered',
  'company-wide',
  'ending',
  'wind-down',
  'unlock',
  'transform',
  'game-changer',
  'seamless',
  'revolutionize',
  'leverage',
  'empower',
  'delve',
  'significant savings',
  'low-hanging',
] as const;

// The cautionary sentences, exact: removed from a text before the check, so they may use a word the
// check refuses elsewhere.
export const CAUTIONS: readonly string[] = [NO_REPLY, ONE_PERSON_CAUTION, NOT_A_CONFIDENCE_INTERVAL];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const REFUSED_PATTERN = new RegExp(`(?<![A-Za-z0-9-])(?:${[...REFUSED].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})(?![A-Za-z0-9-])`, 'gi');

// Every refused word in `text`, case-insensitive, on word boundaries, as found.
export function refusedWords(text: string): string[] {
  let t = text;
  for (const c of CAUTIONS) t = t.split(c).join(' ');
  return [...t.matchAll(REFUSED_PATTERN)].map((m) => m[0]);
}
