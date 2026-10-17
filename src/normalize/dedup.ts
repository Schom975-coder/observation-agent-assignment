// Finds the same email stored more than once. Two rules (ARCHITECTURE.md 4.1):
//  - content: same sender, same normalized subject, same whitespace-collapsed body, sent less than
//    24 hours apart. Dated copies are taken in time order and each joins the current cluster only
//    if it is strictly less than 24 h after that cluster's first (earliest) copy, so a chain of
//    sends 20 h apart cannot grow into one cluster spanning days, and exactly 24 h apart is not a
//    copy. The same body a day or more apart is a recurring send (Calpine's daily nomination).
//  - message_id: the same Message-ID header.
// Undated copies, conservatively: one joins its content group only when the group's dated copies
// form exactly one cluster; otherwise which day it belongs to is a guess and it stays unique. A
// group with no dated copy merges nothing by content (no time evidence); Message-ID still applies.
// The canonical is the lowest ID among a group's dated members (the lowest ID if none is dated),
// so a dated copy is never dropped in favour of an undated one.
import { sha256 } from '../util/hash.ts';
import { DAY_MS, utcMs } from '../util/time.ts';
import type { DuplicateGroup, ParsedMessage } from '../types.ts';

export type DedupResult = {
  groups: DuplicateGroup[];
  duplicateOf: Map<string, string>; // duplicate ID -> canonical ID
};

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function bodyKey(text: string, bodyStart: number): string {
  return sha256(text.slice(bodyStart).replace(/\s+/g, ' ').trim());
}

// Union-find over message IDs.
class Sets {
  readonly #parent = new Map<string, string>();
  find(id: string): string {
    let root = id;
    while (this.#parent.has(root) && this.#parent.get(root) !== root) root = this.#parent.get(root) as string;
    this.#parent.set(id, root);
    return root;
  }
  union(a: string, b: string): void {
    const [ra, rb] = [this.find(a), this.find(b)];
    if (ra !== rb) this.#parent.set(rb, ra);
  }
}

const addressSet = (m: ParsedMessage): string =>
  [...new Set([...m.to, ...m.cc].map((r) => r.email).filter((e) => e !== ''))].sort(byId).join('\n');

// `bodies`: message ID -> bodyKey of its text.
export function findDuplicates(messages: readonly ParsedMessage[], bodies: ReadonlyMap<string, string>): DedupResult {
  const sets = new Sets();
  const clusterOf = new Map<string, number>(); // message ID -> content cluster it was merged in

  const byContent = new Map<string, ParsedMessage[]>();
  for (const m of messages) {
    if (m.from === null) continue;
    const key = `${m.from.email}\0${m.subject_norm}\0${bodies.get(m.id) ?? ''}`;
    const list = byContent.get(key);
    if (list === undefined) byContent.set(key, [m]);
    else list.push(m);
  }
  let clusterCount = 0;
  for (const group of byContent.values()) {
    if (group.length < 2) continue;
    const dated = group.filter((m) => m.date_utc !== null).sort((a, b) => utcMs(a.date_utc as string) - utcMs(b.date_utc as string) || byId(a.id, b.id));
    const clusters: ParsedMessage[][] = [];
    for (const m of dated) {
      const current = clusters.at(-1);
      const anchor = current?.[0];
      if (current !== undefined && anchor !== undefined && utcMs(m.date_utc as string) - utcMs(anchor.date_utc as string) < DAY_MS) current.push(m);
      else clusters.push([m]);
    }
    if (clusters.length === 1) (clusters[0] as ParsedMessage[]).push(...group.filter((m) => m.date_utc === null));
    for (const cluster of clusters) {
      if (cluster.length < 2) continue;
      const n = clusterCount++;
      for (const m of cluster) {
        clusterOf.set(m.id, n);
        sets.union((cluster[0] as ParsedMessage).id, m.id);
      }
    }
  }

  const byMessageId = new Map<string, string>();
  for (const m of messages) {
    if (m.message_id === null) continue;
    const first = byMessageId.get(m.message_id);
    if (first === undefined) byMessageId.set(m.message_id, m.id);
    else sets.union(first, m.id);
  }

  const members = new Map<string, ParsedMessage[]>();
  for (const m of messages) {
    const root = sets.find(m.id);
    const list = members.get(root);
    if (list === undefined) members.set(root, [m]);
    else list.push(m);
  }
  const groups: DuplicateGroup[] = [];
  const duplicateOf = new Map<string, string>();
  for (const list of members.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => byId(a.id, b.id));
    const canonical = (sorted.find((m) => m.date_utc !== null) ?? sorted[0]) as ParsedMessage;
    const home = clusterOf.get(canonical.id);
    const recipients = addressSet(canonical);
    // A copy in the canonical's own content cluster is "content" (even if it also shares the
    // Message-ID); any other copy is reached through a Message-ID match, directly or via a copy.
    const duplicates = sorted
      .filter((m) => m !== canonical)
      .map((m) => ({
        id: m.id,
        rule: home !== undefined && clusterOf.get(m.id) === home ? ('content' as const) : ('message_id' as const),
        recipients_differ: addressSet(m) !== recipients,
      }));
    groups.push({ canonical: canonical.id, duplicates });
    for (const d of duplicates) duplicateOf.set(d.id, canonical.id);
  }
  groups.sort((a, b) => byId(a.canonical, b.canonical));
  return { groups, duplicateOf };
}
