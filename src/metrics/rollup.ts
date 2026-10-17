// The rollup (ARCHITECTURE.md 4.1, 5.7): per merged process, what the email trail shows, counted
// by code from the merged membership. Occurrences and their shares, the window and active months,
// email actions by type with the messages they were counted from and the minutes they cost at the
// published rates, participants, reply gaps, chasers, validated stall quotes, ownership claims and
// conflicts, and the accepted evidence. No model output sets any number here: the extractors and
// the merger decided which messages belong where, and that is all that is read of them.
//
// Same inputs, same record, on every OS: integer arithmetic, ID order, UTC dates compared as
// strings, every list sorted.
import type { EffortRates } from '../config.ts';
import { classifyOccurrence, countActions, isPricedEmail } from './actions.ts';
import { effectiveKeys, mergeTarget } from '../model/merge.ts';
import type { Taxonomy } from '../model/taxonomy.ts';
import { roundHalfUp } from '../util/round.ts';
import { DAY_MS, utcMs } from '../util/time.ts';
import {
  STALL_KINDS,
  type ActionSource,
  type MergeTable,
  type MessageActions,
  type OwnershipConflict,
  type ParsedMessage,
  type Participant,
  type Person,
  type ProcessRollup,
  type Rollup,
  type StallKind,
  type Thread,
  type ValidatedExtraction,
} from '../types.ts';

// A month is 30.4375 days = 487/16 (the mean Gregorian month), so months_x100 = days * 1600 / 487.
export const MONTH_X16_DAYS = 487;
// Two ownership claims naming different people this close together contradict each other.
export const OWNERSHIP_CONFLICT_DAYS = 60;
export const ALL_SHARE_X100 = 100;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Days from the first to the last usable date, both counted: the same day is 1.
export function spanDays(firstUtc: string, lastUtc: string): number {
  return Math.floor((utcMs(lastUtc) - utcMs(firstUtc)) / DAY_MS) + 1;
}

// The window in hundredths of a month, at least one month: max(100, roundHalfUp(days * 1600 / 487)).
export function windowMonthsX100(days: number): number {
  return Math.max(100, roundHalfUp(days * 1600, MONTH_X16_DAYS));
}

// A message tagged with k merged keys gives each 1/k of itself, in hundredths: the floor of 100/k
// each, and the hundredths left over one each to its keys in sort order, so the shares add up to
// exactly 100 (k = 3: 34/33/33).
export function messageShares(keys: readonly string[]): Map<string, number> {
  const sorted = [...new Set(keys)].sort(byText);
  const shares = new Map<string, number>();
  if (sorted.length === 0) return shares;
  const base = Math.floor(ALL_SHARE_X100 / sorted.length);
  const left = ALL_SHARE_X100 - base * sorted.length;
  sorted.forEach((k, i) => shares.set(k, base + (i < left ? 1 : 0)));
  return shares;
}

// "batch-010:e5" -> sortable by batch, then by index as a number.
const evidenceOrder = (a: string, b: string): number => {
  const [ab, ai] = a.split(':e');
  const [bb, bi] = b.split(':e');
  return byText(ab as string, bb as string) || Number(ai) - Number(bi);
};

const usable = (m: ParsedMessage | undefined): string | null => (m !== undefined && m.date_status === 'usable' && m.date_utc !== null ? m.date_utc : null);
const senderOf = (m: ParsedMessage): string => (m.from?.email ?? '').toLowerCase();
const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};
// A person as a claim names them, compared without case or spacing.
const personKey = (p: string): string => p.toLowerCase().replace(/\s+/g, ' ').trim();

export type RollupInputs = {
  validated: ValidatedExtraction[]; // the done batches'
  merge: MergeTable;
  threads: Thread[];
  messages: Map<string, ParsedMessage>; // every parsed message, duplicates included
  people: Person[];
  rates: EffortRates;
  taxonomy: Taxonomy;
  flagged: ReadonlySet<string>; // suspected injections
  shas: Rollup['inputs'];
};

// What the rollup leaves out, for the validation report: processes with no counted message, and
// processes every message of which is a flagged injection (quarantined, never counted).
export type RollupNotes = { empty: string[]; quarantined: Array<{ key: string; messages: string[] }> };

type Entry = ValidatedExtraction['messages'][number] & { batch_id: string };

export function buildRollup(inputs: RollupInputs): Rollup {
  return rollupWithNotes(inputs).rollup;
}

export function rollupWithNotes(inputs: RollupInputs): { rollup: Rollup; notes: RollupNotes } {
  const { validated, merge, threads, messages, people, rates, taxonomy, flagged } = inputs;
  const names = new Map(people.map((p) => [p.email, p.name]));

  // Where each message sits.
  const occurrenceOf = new Map<string, string>();
  const threadOf = new Map<string, Thread>();
  const occurrenceMessages = new Map<string, string[]>();
  for (const t of threads) {
    for (const id of t.message_ids) threadOf.set(id, t);
    for (const o of t.occurrences) {
      occurrenceMessages.set(o.occurrence_id, o.message_ids);
      for (const id of o.message_ids) occurrenceOf.set(id, o.occurrence_id);
    }
  }

  // The processes there can be: the taxonomy's and the promotions the merge kept.
  const known = new Map<string, { name: string; definition: string; origin: 'taxonomy' | 'promoted' }>();
  for (const p of taxonomy.processes) known.set(p.key, { name: p.name, definition: p.definition, origin: 'taxonomy' });
  for (const p of merge.promoted) known.set(p.key, { name: p.name, definition: p.definition, origin: 'promoted' });

  // Every classified message, its merged keys, and the members of each process.
  const entries = new Map<string, Entry>();
  for (const v of validated) for (const m of v.messages) if (!entries.has(m.id)) entries.set(m.id, { ...m, batch_id: v.batch_id });
  const keysOf = new Map<string, string[]>();
  const members = new Map<string, string[]>();
  for (const [id, e] of entries) {
    const keys = effectiveKeys(e.processes, merge).filter((k) => known.has(k));
    keysOf.set(id, keys);
    for (const k of keys) members.set(k, [...(members.get(k) ?? []), id]);
  }
  const notes: RollupNotes = { empty: [...known.keys()].filter((k) => !members.has(k)).sort(byText), quarantined: [] };
  for (const [k, ids] of [...members]) {
    if (ids.every((id) => flagged.has(id))) {
      notes.quarantined.push({ key: k, messages: [...ids].sort(byText) });
      members.delete(k);
    }
  }
  notes.quarantined.sort((a, b) => byText(a.key, b.key));
  // The keys each message is counted under, quarantined processes left out; its share of each.
  const counted = new Map<string, string[]>();
  for (const [id, keys] of keysOf) counted.set(id, keys.filter((k) => members.has(k)));
  const shareOf = (id: string, key: string): number => messageShares(counted.get(id) ?? []).get(key) ?? 0;

  // Validated stall and ownership quotes, by message.
  const stallCheck = new Map<string, ValidatedExtraction['stall_checks'][number]>();
  const ownershipCheck = new Map<string, ValidatedExtraction['ownership_checks'][number]>();
  for (const v of validated) {
    for (const c of v.stall_checks) if (!stallCheck.has(c.message_id)) stallCheck.set(c.message_id, c);
    for (const c of v.ownership_checks) if (!ownershipCheck.has(c.message_id)) ownershipCheck.set(c.message_id, c);
  }
  // Accepted evidence, re-keyed through the merge, by process.
  const evidence = new Map<string, string[]>();
  for (const v of validated) {
    for (const e of v.evidence) {
      if (e.match === 'rejected') continue;
      const key = e.process.startsWith('new:') ? mergeTarget(e.process, merge) : e.process;
      if (key === null || !members.has(key) || !(counted.get(e.message_id) ?? []).includes(key)) continue;
      evidence.set(key, [...(evidence.get(key) ?? []), e.evidence_id]);
    }
  }

  // Each message's actions, classified once in its occurrence (the type does not depend on the process).
  const actionsOf = new Map<string, MessageActions>();
  const countedIds = new Set([...counted].filter(([, keys]) => keys.length > 0).map(([id]) => id));
  for (const [, ids] of occurrenceMessages) {
    if (!ids.some((id) => countedIds.has(id))) continue;
    const ms = ids.map((id) => messages.get(id)).filter((m): m is ParsedMessage => m !== undefined);
    for (const a of classifyOccurrence(ms, countedIds, rates)) actionsOf.set(a.id, a);
  }

  const processes: ProcessRollup[] = [...members.keys()].sort(byText).map((key) => {
    const info = known.get(key) as { name: string; definition: string; origin: 'taxonomy' | 'promoted' };
    const ids = [...(members.get(key) as string[])].sort(byText);
    const ms = ids.map((id) => messages.get(id)).filter((m): m is ParsedMessage => m !== undefined);

    // Occurrences and their shares: an occurrence counts as the largest share among its messages.
    const occShare = new Map<string, number>();
    for (const id of ids) {
      const o = occurrenceOf.get(id);
      if (o !== undefined) occShare.set(o, Math.max(occShare.get(o) ?? 0, shareOf(id, key)));
    }
    const occurrence_ids = [...occShare.keys()].sort(byText);
    const thread_ids = [...new Set(ids.flatMap((id) => threadOf.get(id)?.thread_id ?? []))].sort(byText);
    const shared = occurrence_ids.filter((o) => (occShare.get(o) as number) < ALL_SHARE_X100).length;

    // The window, from usable dates only.
    const dates = ms.map(usable).filter((d): d is string => d !== null).sort(byText);
    const first = dates[0] ?? null;
    const last = dates.at(-1) ?? null;
    const span = first !== null && last !== null ? spanDays(first, last) : 0;
    const datedOccurrence = new Map<string, string>(); // occurrence -> its earliest usable date
    for (const m of ms) {
      const d = usable(m);
      const o = occurrenceOf.get(m.id);
      if (d !== null && o !== undefined && (!datedOccurrence.has(o) || d < (datedOccurrence.get(o) as string))) datedOccurrence.set(o, d);
    }
    const undated = occurrence_ids.filter((o) => !datedOccurrence.has(o)).length;
    const months = new Map<string, { occurrences: number; messages: number }>();
    for (const d of dates) {
      const month = months.get(d.slice(0, 7)) ?? { occurrences: 0, messages: 0 };
      month.messages++;
      months.set(d.slice(0, 7), month);
    }
    for (const d of datedOccurrence.values()) (months.get(d.slice(0, 7)) as { occurrences: number }).occurrences++;

    // Actions, with the messages they were counted from, priced at the published rates.
    const own = ids.map((id) => actionsOf.get(id)).filter((a): a is MessageActions => a !== undefined);
    const action_sources: ActionSource[] = [];
    for (const a of own) {
      const share = shareOf(a.id, key);
      const sender = senderOf(messages.get(a.id) as ParsedMessage);
      action_sources.push({ message_id: a.id, type: a.authored, person: sender, priced: a.sender_priced, share_x100: share });
      for (const r of a.reads) action_sources.push({ message_id: a.id, type: 'read', person: r.email, priced: r.priced, share_x100: share });
    }
    let today = 0;
    let automatable = 0; // in hundredths of a minute times 100 until the one rounding
    for (const s of action_sources) {
      if (!s.priced) continue;
      today += rates.minutes[s.type] * s.share_x100;
      automatable += rates.minutes[s.type] * rates.automatable_pct[s.type] * s.share_x100;
    }

    // Participants, from the actions.
    const people = new Map<string, Participant>();
    for (const s of action_sources) {
      if (s.person === '') continue;
      const p = people.get(s.person) ?? { email: s.person, name: names.get(s.person) ?? null, staff: isPricedEmail(s.person, rates.priced_domains), authored: 0, forwards: 0, chasers: 0, reads: 0 };
      if (s.type === 'read') p.reads++;
      else if (s.type === 'forward') p.forwards++;
      else if (s.type === 'chaser') p.chasers++;
      else p.authored++;
      people.set(s.person, p);
    }
    const total = (p: Participant) => p.authored + p.forwards + p.chasers + p.reads;
    const participants = [...people.values()].sort((a, b) => total(b) - total(a) || byText(a.email, b.email));

    // Reply gaps: from a tagged message to the next later message in its thread by someone else.
    const gaps: number[] = [];
    for (const m of ms) {
      const d = usable(m);
      const thread = threadOf.get(m.id);
      if (d === null || thread === undefined) continue;
      const after = thread.message_ids.slice(thread.message_ids.indexOf(m.id) + 1).map((id) => messages.get(id));
      const reply = after.find((r) => r !== undefined && usable(r) !== null && senderOf(r) !== senderOf(m));
      if (reply !== undefined) gaps.push(utcMs(usable(reply) as string) - utcMs(d));
    }
    const gap = median(gaps);

    // Validated stall quotes and ownership claims.
    const stalls: ProcessRollup['stalls'] = [];
    const ownership_claims: ProcessRollup['ownership_claims'] = [];
    for (const id of ids) {
      const e = entries.get(id) as Entry;
      const sc = stallCheck.get(id);
      if (e.stall !== null && sc !== undefined && sc.match !== 'rejected' && sc.start !== null && sc.end !== null) {
        stalls.push({ message_id: id, kind: e.stall.kind, quote: sc.raw_text ?? e.stall.quote, start: sc.start, end: sc.end });
      }
      const oc = ownershipCheck.get(id);
      if (e.ownership_claim !== null && oc !== undefined && oc.match !== 'rejected') {
        ownership_claims.push({ message_id: id, person: e.ownership_claim.person, date_utc: usable(messages.get(id)), quote: oc.raw_text ?? e.ownership_claim.quote });
      }
    }
    const conflict = ownershipConflict(ownership_claims);

    const actions = countActions(own);
    const senders = new Set(ms.map(senderOf).filter((s) => s !== ''));
    const flags: string[] = [];
    if (dates.length === 0) flags.push('undated_only');
    if (undated > 0) flags.push(`undated_occurrences:${undated}`);
    if (shared > 0) flags.push(`shared_occurrences:${shared}`);
    if (senders.size === 1) flags.push('single_source');
    if (ids.some((id) => flagged.has(id))) flags.push('injection_adjacent');

    return {
      key,
      name: info.name,
      origin: info.origin,
      definition: info.definition,
      message_ids: ids,
      thread_ids,
      occurrence_ids,
      occurrences: occurrence_ids.length,
      occurrence_share_x100: occurrence_ids.reduce((n, o) => n + (occShare.get(o) as number), 0),
      shared_occurrences: shared,
      window: {
        first_utc: first,
        last_utc: last,
        span_days: span,
        months_x100: first === null ? ALL_SHARE_X100 : windowMonthsX100(span),
        active_months: months.size,
        undated_occurrences: undated,
      },
      monthly: [...months].sort(([a], [b]) => byText(a, b)).map(([month, x]) => ({ month, occurrences: x.occurrences, messages: x.messages })),
      actions,
      action_sources,
      email_x100: { today, automatable: roundHalfUp(automatable, 100) },
      participants,
      staff_participants: participants.filter((p) => p.staff).length,
      median_reply_gap_h: gap === null ? null : Math.round(gap / 360_000) / 10,
      chasers: actions.priced.chaser + actions.unpriced.chaser,
      stalls,
      ownership_claims,
      ownership_conflict: conflict,
      evidence_ids: [...(evidence.get(key) ?? [])].sort(evidenceOrder),
      flags,
    };
  });

  // What was tagged but counted nowhere, and how every classified message ended.
  const unassignedIds = [...entries.values()].filter((e) => e.processes.length > 0 && (counted.get(e.id) ?? []).length === 0).map((e) => e.id).sort(byText);
  const role_only: Record<string, number> = {};
  for (const e of entries.values()) if (e.processes.length === 0) role_only[e.role] = (role_only[e.role] ?? 0) + 1;
  const tagged = [...entries.values()].filter((e) => e.processes.length > 0).length;
  return {
    rollup: {
      version: 1,
      inputs: inputs.shas,
      processes,
      unassigned: {
        messages: unassignedIds.length,
        message_ids: unassignedIds,
        slugs: merge.slugs
          .filter((s): s is typeof s & { status: 'unassigned' | 'demoted' } => s.status === 'unassigned' || s.status === 'demoted')
          .map((s) => ({ slug: s.slug, messages: s.messages, status: s.status, reason: s.reason })),
      },
      coverage: {
        files: messages.size,
        unique: threads.reduce((n, t) => n + t.message_ids.length, 0),
        classified: entries.size,
        tagged,
        counted: tagged - unassignedIds.length,
        unassigned: unassignedIds.length,
        role_only: Object.fromEntries(Object.entries(role_only).sort(([a], [b]) => byText(a, b))),
      },
    },
    notes,
  };
}

// Two or more different people claimed to own the work within OWNERSHIP_CONFLICT_DAYS of each
// other (usable dates only): every claim that is part of such a pair, by date.
export function ownershipConflict(claims: ProcessRollup['ownership_claims']): OwnershipConflict | null {
  const dated = claims.filter((c) => c.date_utc !== null);
  const inConflict = new Set<number>();
  for (let i = 0; i < dated.length; i++) {
    for (let j = i + 1; j < dated.length; j++) {
      const a = dated[i] as (typeof dated)[number];
      const b = dated[j] as (typeof dated)[number];
      if (personKey(a.person) === personKey(b.person)) continue;
      if (Math.abs(utcMs(a.date_utc as string) - utcMs(b.date_utc as string)) <= OWNERSHIP_CONFLICT_DAYS * DAY_MS) {
        inConflict.add(i);
        inConflict.add(j);
      }
    }
  }
  if (inConflict.size === 0) return null;
  const list = [...inConflict].map((i) => dated[i] as (typeof dated)[number]).sort((a, b) => byText(a.date_utc as string, b.date_utc as string) || byText(a.message_id, b.message_id));
  return { claims: list.map((c) => ({ person: c.person, message_id: c.message_id, date_utc: c.date_utc })) };
}

// Stall counts by kind, every kind present.
export function stallsByKind(stalls: ReadonlyArray<{ kind: StallKind }>): Record<StallKind, number> {
  const counts = Object.fromEntries(STALL_KINDS.map((k) => [k, 0])) as Record<StallKind, number>;
  for (const s of stalls) counts[s.kind]++;
  return counts;
}
