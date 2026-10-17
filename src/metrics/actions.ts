// What each message in an occurrence counts as in the email-trail model (ARCHITECTURE.md 4.1).
// Headline hours are these counts times the published per-action minutes, so the rules stay
// plain enough to check by hand: no I/O, no dates, no model output, same input -> same counts.
import { ACTION_TYPES, type ActionType, type EffortRates } from '../config.ts';
import { isForwardSubject } from '../parse/headers.ts';
import type { AuthoredAction, MessageActions, ParsedMessage } from '../types.ts';

export type ActionCounts = Record<ActionType, number>;

type ClassifyRates = Pick<EffortRates, 'read_cap_per_message' | 'own_chars_buckets' | 'priced_domains'>;

// local@domain: no whitespace, one @, a dotted domain with no empty labels.
const ADDRESS = /^[^\s@]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;

// Company staff: the domain is a listed one or a subdomain of it (ect.enron.com yes, notenron.com no).
export function isPricedEmail(email: string, domains: readonly string[]): boolean {
  const domain = ADDRESS.exec(email.toLowerCase())?.[1];
  if (domain === undefined) return false;
  return domains.some((d) => {
    const listed = d.toLowerCase();
    return domain === listed || domain.endsWith(`.${listed}`);
  });
}

// An empty address is no sender: it must not make two broken messages look like a chaser.
function senderOf(m: ParsedMessage): string | null {
  const email = m.from?.email.toLowerCase() ?? '';
  return email === '' ? null : email;
}

// A chaser goes back to someone already asked: forwarding one item to different people in turn
// is not chasing anyone.
function sharesRecipient(earlier: ParsedMessage, later: ParsedMessage): boolean {
  const asked = new Set([...earlier.to, ...earlier.cc].map((r) => r.email.toLowerCase()));
  return [...later.to, ...later.cc].some((r) => asked.has(r.email.toLowerCase()));
}

function authoredAction(m: ParsedMessage, previous: ParsedMessage | undefined, rates: ClassifyRates): AuthoredAction {
  const sender = senderOf(m);
  // A fresh send is never a chaser, so a daily report with the same subject is not nagging.
  if (
    !m.fresh_send &&
    sender !== null &&
    previous !== undefined &&
    senderOf(previous) === sender &&
    sharesRecipient(previous, m)
  ) {
    return 'chaser';
  }
  const { short_max, medium_max } = rates.own_chars_buckets;
  // It has to pass something on: its first earlier block is a forward banner, or the subject says FW.
  // A "Forwarded by" deep inside quoted history belongs to an earlier message, not to this reply.
  const firstEarlier = m.segments.find((s) => s.kind !== 'own');
  const forwards = firstEarlier?.kind === 'forwarded' || isForwardSubject(m.subject);
  if (forwards && m.own_chars <= short_max) return 'forward';
  if (m.own_chars <= short_max) return 'authored_short';
  if (m.own_chars <= medium_max) return 'authored_medium';
  return 'authored_long';
}

// To then Cc in header order, each address once, never the sender, first `read_cap_per_message` kept.
function readsOf(m: ParsedMessage, sender: string | null, rates: ClassifyRates): MessageActions['reads'] {
  const reads: MessageActions['reads'] = [];
  const seen = new Set<string>();
  for (const recipient of [...m.to, ...m.cc]) {
    if (reads.length >= rates.read_cap_per_message) break;
    const email = recipient.email.toLowerCase();
    if (email === sender || seen.has(email)) continue;
    seen.add(email);
    reads.push({ email, priced: isPricedEmail(email, rates.priced_domains) });
  }
  return reads;
}

// `messages`: the unique messages of one occurrence in chronological order (grouping and order are
// the caller's job). Untagged messages yield nothing but still count as the chaser's predecessor.
export function classifyOccurrence(
  messages: readonly ParsedMessage[],
  tagged: ReadonlySet<string>,
  rates: ClassifyRates,
): MessageActions[] {
  const actions: MessageActions[] = [];
  messages.forEach((m, i) => {
    if (!tagged.has(m.id)) return;
    const sender = senderOf(m);
    actions.push({
      id: m.id,
      authored: authoredAction(m, messages[i - 1], rates),
      sender_priced: sender !== null && isPricedEmail(sender, rates.priced_domains),
      reads: readsOf(m, sender, rates),
    });
  });
  return actions;
}

const zeroCounts = (): ActionCounts => Object.fromEntries(ACTION_TYPES.map((t) => [t, 0])) as ActionCounts;

// Authored actions are priced by the sender, reads by each recipient. Every type is present.
export function countActions(actions: readonly MessageActions[]): { priced: ActionCounts; unpriced: ActionCounts } {
  const priced = zeroCounts();
  const unpriced = zeroCounts();
  for (const a of actions) {
    (a.sender_priced ? priced : unpriced)[a.authored] += 1;
    for (const r of a.reads) (r.priced ? priced : unpriced).read += 1;
  }
  return { priced, unpriced };
}
