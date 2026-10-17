// Threads and occurrences (ARCHITECTURE.md 4.1). The corpus has no In-Reply-To or References
// headers, so a thread is messages sharing a normalized subject, split where the conversation
// went quiet for more than 45 days. Within a thread each fresh send starts a new occurrence;
// replies and forwards belong to the latest one. Only unique (de-duplicated) messages come in.
// An undated message joins the most recent thread with its subject; with no dated thread to join,
// it is a singleton, since nothing says two undated messages belong to one conversation.
import { sha256 } from '../util/hash.ts';
import { DAY_MS, utcMs } from '../util/time.ts';
import type { Occurrence, ParsedMessage, Thread } from '../types.ts';

export const THREAD_GAP_DAYS = 45;

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Dated messages in time order (ID breaks ties), then undated ones by ID.
function chronological(a: ParsedMessage, b: ParsedMessage): number {
  if (a.date_utc !== null && b.date_utc !== null) return utcMs(a.date_utc) - utcMs(b.date_utc) || byId(a.id, b.id);
  if (a.date_utc !== null) return -1;
  if (b.date_utc !== null) return 1;
  return byId(a.id, b.id);
}

function makeThread(subjectNorm: string, members: ParsedMessage[]): Thread {
  const ordered = [...members].sort(chronological);
  const first = ordered[0] as ParsedMessage;
  const thread_id = `t-${sha256(first.id).slice(0, 12)}`;
  const occurrences: Occurrence[] = [];
  for (const m of ordered) {
    const current = occurrences.at(-1);
    if (current === undefined || m.fresh_send) {
      occurrences.push({ occurrence_id: `${thread_id}-o${occurrences.length + 1}`, message_ids: [m.id] });
    } else {
      current.message_ids.push(m.id);
    }
  }
  const dated = ordered.filter((m) => m.date_utc !== null);
  const participants = new Set<string>();
  for (const m of ordered) {
    if (m.from !== null && m.from.email !== '') participants.add(m.from.email);
    for (const r of [...m.to, ...m.cc]) if (r.email !== '') participants.add(r.email);
  }
  return {
    thread_id,
    subject_norm: subjectNorm,
    message_ids: ordered.map((m) => m.id),
    first_utc: dated[0]?.date_utc ?? null,
    last_utc: dated.at(-1)?.date_utc ?? null,
    participants: [...participants].sort(byId),
    occurrences,
  };
}

export function buildThreads(unique: readonly ParsedMessage[]): Thread[] {
  const bySubject = new Map<string, ParsedMessage[]>();
  const singles: ParsedMessage[] = [];
  for (const m of unique) {
    if (m.subject_norm === '') {
      singles.push(m);
      continue;
    }
    const list = bySubject.get(m.subject_norm);
    if (list === undefined) bySubject.set(m.subject_norm, [m]);
    else list.push(m);
  }

  const threads: Thread[] = [];
  for (const [subject, members] of bySubject) {
    const dated = members.filter((m) => m.date_utc !== null).sort(chronological);
    const groups: ParsedMessage[][] = [];
    for (const m of dated) {
      const last = groups.at(-1);
      const prev = last?.at(-1);
      if (last !== undefined && prev !== undefined && utcMs(m.date_utc as string) - utcMs(prev.date_utc as string) <= THREAD_GAP_DAYS * DAY_MS) {
        last.push(m);
      } else {
        groups.push([m]);
      }
    }
    const undated = members.filter((m) => m.date_utc === null).sort(chronological);
    const latest = groups.at(-1);
    if (latest !== undefined) latest.push(...undated);
    else for (const m of undated) groups.push([m]);
    for (const g of groups) threads.push(makeThread(subject, g));
  }
  for (const m of singles) threads.push(makeThread('', [m]));
  // Batches, extractor output and the dashboard all key on the thread ID, so a collision would
  // silently merge two conversations downstream: stop instead.
  const seen = new Set<string>();
  for (const t of threads) {
    if (seen.has(t.thread_id)) throw new Error(`Two threads got the ID ${t.thread_id} (first message ${t.message_ids[0]})`);
    seen.add(t.thread_id);
  }

  // Time order of each thread's first message, so batches follow the calendar.
  const firstMessage = new Map(unique.map((m) => [m.id, m]));
  return threads.sort((a, b) =>
    chronological(firstMessage.get(a.message_ids[0] as string) as ParsedMessage, firstMessage.get(b.message_ids[0] as string) as ParsedMessage),
  );
}
