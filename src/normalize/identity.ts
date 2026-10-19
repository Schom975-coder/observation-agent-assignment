// Who each address in the people directory is (ARCHITECTURE.md 4.1, "Participant identity", 6.24).
// The archive writes one person under several addresses (daren.farmer, daren.j.farmer, dfarmer and
// j..farmer are one trader), so prepare adds three fields to every record of out/people.json:
// `kind` (a person, a distribution list or a system sender), `canonical` (the address this one
// folds into, itself when none) and `fold` (the rule that folded it). Every later stage reads the
// same `canonical` from that file through identityOf.
//
// Folds are by display name and by the shape of the address's local part, and only onto a unique
// candidate among the priced people of the directory. A fold by shape never joins two identities
// whose addresses appear together in one message's From, To or Cc (two people, presumed), so two
// addresses of one identity share a message only when one display name joined them. No fold uses a
// nickname or a sound-alike, or touches a list or a system address. `name`, `email` and the record order
// stay exactly as buildPeople wrote them: the taxonomy digest reads them.
//
// Same records in, same records out, on every OS: sorted iteration, no dates, no model output.
import type { EffortRates } from '../config.ts';
import { isPricedEmail } from '../metrics/actions.ts';
import { nameTokens } from '../metrics/rollup.ts';
import type { FoldRule, ParsedMessage, Person, PersonCounts, PersonKind } from '../types.ts';

// The shapes of a local part, letters a-z only: a digit, an apostrophe, a hyphen, an underscore or
// a quote matches none of them.
export const SHAPE = {
  FL: /^([a-z]+)\.([a-z]+)$/, // first.last
  FML: /^([a-z]+)\.([a-z])\.([a-z]+)$/, // first.m.last
  ML: /^([a-z])\.\.([a-z]+)$/, // m..last (the export dropped the first name)
  IL: /^([a-z])([a-z]{3,})$/, // flast (initial and last name, no dot)
} as const;
// A distribution list: "dl" as a whole label between separators anywhere, or "everyone" or "all"
// as the first label.
export const LIST_LOCAL = /(?:^|[._-])dl(?:[._-]|$)|^(?:everyone|all)[._-]/;
// A chain of folds is at most 4 links by construction; past this many it is a cycle, which is a bug.
const MAX_CHAIN = 8;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const localOf = (email: string): string => email.slice(0, Math.max(0, email.lastIndexOf('@')));

type IdentityRates = Pick<EffortRates, 'priced_domains' | 'system_senders'>;

// An address named in system_senders: the whole address, its "local@" or its "@domain".
export function isSystemAddress(email: string, entries: readonly string[]): boolean {
  const e = email.toLowerCase();
  const at = e.lastIndexOf('@');
  if (at === -1) return false;
  return entries.some((s) => s === e || s === e.slice(0, at + 1) || s === e.slice(at));
}

export function kindOf(email: string, rates: Pick<EffortRates, 'system_senders'>): PersonKind {
  if (isSystemAddress(email, rates.system_senders)) return 'system';
  return LIST_LOCAL.test(localOf(email.toLowerCase())) ? 'list' : 'person';
}

// An address's shape: its last name, its first initial when the shape gives one (FL, FML, IL), and
// the parts the rules compare. Null when the local part has no shape.
type Shape = { shape: keyof typeof SHAPE; first: string | null; middle: string | null; initial: string | null; last: string };
export function shapeOf(email: string): Shape | null {
  const local = localOf(email);
  let m = SHAPE.FL.exec(local);
  if (m !== null) return { shape: 'FL', first: m[1] as string, middle: null, initial: (m[1] as string)[0] as string, last: m[2] as string };
  m = SHAPE.FML.exec(local);
  if (m !== null) return { shape: 'FML', first: m[1] as string, middle: m[2] as string, initial: (m[1] as string)[0] as string, last: m[3] as string };
  m = SHAPE.ML.exec(local);
  if (m !== null) return { shape: 'ML', first: null, middle: m[1] as string, initial: null, last: m[2] as string };
  m = SHAPE.IL.exec(local);
  if (m !== null) return { shape: 'IL', first: null, middle: null, initial: m[1] as string, last: m[2] as string };
  return null;
}

// The middle initial a display name carries: "Herod, Brenda F." (Last, First M) or "Brenda F Herod"
// (First M Last), lowercased; null when the name has neither form.
export function middleInitial(name: string | null): string | null {
  if (name === null) return null;
  const m = /^[^,]+,\s*\S+\s+([a-z])\.?$/i.exec(name) ?? /^\S+\s+([a-z])\.?\s+\S+$/i.exec(name);
  return m === null ? null : (m[1] as string).toLowerCase();
}

// R1's key: the name's words (nameTokens), sorted, when there are at least two.
const nameKey = (name: string | null): string | null => {
  const words = nameTokens(name ?? '').sort(byText);
  return words.length >= 2 ? words.join(' ') : null;
};

// Which addresses appear together in the From, To or Cc of one message: presumed two people, so
// never folded together. Built once from the parsed messages.
export function togetherIn(messages: readonly ParsedMessage[]): (a: string, b: string) => boolean {
  const seen = new Map<string, Set<number>>();
  messages.forEach((m, i) => {
    for (const email of new Set([m.from?.email ?? '', ...m.to.map((r) => r.email), ...m.cc.map((r) => r.email)])) {
      if (email === '') continue;
      let at = seen.get(email);
      if (at === undefined) seen.set(email, (at = new Set()));
      at.add(i);
    }
  });
  return (a, b) => {
    const x = seen.get(a);
    const y = seen.get(b);
    if (x === undefined || y === undefined || a === b) return false;
    const [small, large] = x.size <= y.size ? [x, y] : [y, x];
    for (const i of small) if (large.has(i)) return true;
    return false;
  };
}

// The priced people of the directory (E), each with its shape, indexed by last name.
type Member = { email: string; name: string | null; shape: Shape | null };
type Index = { members: Member[]; byLast: Map<string, Member[]> };
function indexOf(records: ReadonlyArray<{ email: string; name: string | null; priced: boolean }>, kinds: ReadonlyMap<string, PersonKind>): Index {
  const members = records
    .filter((p) => p.priced && kinds.get(p.email) === 'person')
    .map((p) => ({ email: p.email, name: p.name, shape: shapeOf(p.email) }))
    .sort((a, b) => byText(a.email, b.email));
  const byLast = new Map<string, Member[]>();
  for (const m of members) if (m.shape !== null) byLast.set(m.shape.last, [...(byLast.get(m.shape.last) ?? []), m]);
  return { members, byLast };
}

// R1: members of E with the same display-name key are one person, unless their names show two
// different middle initials ("Alan A Lee" and "Alan B Lee" are two people; the key leaves initials
// out). The canonical is the lowest first.last member when there is one, else the lowest member.
function displayNameLinks(index: Index): Map<string, string> {
  const groups = new Map<string, string[]>();
  const initials = new Map<string, Set<string>>();
  for (const m of index.members) {
    const key = nameKey(m.name);
    if (key === null) continue;
    groups.set(key, [...(groups.get(key) ?? []), m.email]);
    const initial = middleInitial(m.name);
    if (initial !== null) initials.set(key, (initials.get(key) ?? new Set()).add(initial));
  }
  const links = new Map<string, string>();
  for (const [key, emails] of groups) {
    if (emails.length < 2 || (initials.get(key)?.size ?? 0) > 1) continue;
    const sorted = [...emails].sort(byText);
    const canonical = sorted.find((e) => shapeOf(e)?.shape === 'FL') ?? (sorted[0] as string);
    for (const e of sorted) if (e !== canonical) links.set(e, canonical);
  }
  return links;
}

// What the shape rules make of one address of E (R2 to R5), before the co-occurrence refusal and
// R3's middle-initial check: a unique candidate and its rule, `ambiguous` for an m..last address
// whose candidates are not unique, or nothing. Uniqueness counts every shape. For R3 (the first
// initial unknown), no other priced person may carry the same last name with another first initial
// where the shape gives one (FL, FML, IL): a kpresto beside darin.presto is two Prestos, so
// m..presto folds nowhere. For R5 (the address gives its first initial), the rival that matters
// has the same initial: another known first name (first.last or first.m.last) starting with it
// beside the candidate's; a gustavo.giron cannot be dgiron, and darron.c.giron is Darron himself.
type Decision = { rule: FoldRule; to: string } | 'ambiguous' | null;
function decide(e: Member, index: Index): Decision {
  const s = e.shape;
  if (s === null) return null;
  const sameLast = (index.byLast.get(s.last) ?? []).filter((m) => m.email !== e.email);
  const fl = sameLast.filter((m) => m.shape?.shape === 'FL');
  const otherInitial = (initial: string) => sameLast.some((m) => (m.shape?.initial ?? initial) !== initial);
  // Another first name starting with `initial` than `first` (an initial-only address names no first name).
  const sameInitialRival = (initial: string, first: string) =>
    sameLast.some((m) => {
      const other = m.shape?.first ?? null;
      return other !== null && other.startsWith(initial) && other !== first;
    });
  if (s.shape === 'ML') {
    const fml = sameLast.filter((m) => m.shape?.shape === 'FML' && m.shape.middle === s.middle);
    if (fml.length === 1) return { rule: 'middle_initial', to: (fml[0] as Member).email };
    if (fml.length > 1) return 'ambiguous';
    if (fl.length === 0) return null;
    const only = fl[0] as Member;
    return fl.length === 1 && !otherInitial(only.shape?.initial as string) ? { rule: 'last_name', to: only.email } : 'ambiguous';
  }
  if (s.shape === 'FML') {
    const same = fl.filter((m) => m.shape?.first === s.first);
    return same.length === 1 ? { rule: 'first_last', to: (same[0] as Member).email } : null;
  }
  if (s.shape === 'IL') {
    const same = fl.filter((m) => (m.shape?.first as string).startsWith(s.initial as string));
    const only = same[0];
    return same.length === 1 && only !== undefined && !sameInitialRival(s.initial as string, only.shape?.first as string) ? { rule: 'initial_last', to: only.email } : null;
  }
  return null;
}

// Follow the links from `email` to the address with none. A chain past MAX_CHAIN links is a cycle,
// which the rules never make: it throws rather than loop.
export function followFolds(email: string, links: ReadonlyMap<string, { to: string }>): string {
  let at = email;
  for (let steps = 0; links.has(at); steps++) {
    if (steps >= MAX_CHAIN) throw new Error(`identity: the folds from ${email} form a cycle`);
    at = (links.get(at) as { to: string }).to;
  }
  return at;
}

// The directory with every record's kind, canonical and fold added (ARCHITECTURE.md 4.1). R1 by
// display name first; then, for each priced person not folded by R1, in address order, the rule
// its shape gives: R2 m..last onto the one first.m.last; R3 m..last onto the one first.last, only
// when a display name of that person (their own, or one already folding into them) carries the
// middle initial m; R4 first.m.last onto first.last; R5 flast onto the one f*.last. R3 is decided
// after R2, R4 and R5, so "already folding into them" means every other fold. `together` says which
// addresses share a message's From, To or Cc. A shape fold (R2 to R5) is refused when any address
// of the folding person (the address and everything already folded into it) shares a message with
// any address of the candidate's identity as it stands. So two addresses of one identity share a
// message only when one display name joined them (R1).
export function foldPeople(people: readonly PersonCounts[], rates: IdentityRates, together: (a: string, b: string) => boolean = () => false): Person[] {
  const kinds = new Map(people.map((p) => [p.email, kindOf(p.email, rates)]));
  const index = indexOf(people, kinds);
  const links = new Map<string, { to: string; rule: FoldRule }>();
  // A link onto an address already folding into `from` would close a cycle: they are one already.
  const link = (from: string, to: string, rule: FoldRule): void => {
    if (followFolds(to, links) !== from) links.set(from, { to, rule });
  };
  // Every address of E whose folds end at `root`, itself included.
  const membersOf = (root: string): string[] => index.members.filter((m) => followFolds(m.email, links) === root).map((m) => m.email);
  // Whether folding `from` onto `to` would put two addresses that share a message into one person.
  const shareMessage = (from: string, to: string): boolean => {
    const theirs = membersOf(followFolds(to, links));
    return membersOf(followFolds(from, links)).some((a) => theirs.some((b) => together(a, b)));
  };
  for (const [from, to] of displayNameLinks(index)) links.set(from, { to, rule: 'display_name' });

  const lastName: Array<{ e: Member; to: string }> = [];
  for (const e of index.members) {
    if (links.has(e.email)) continue;
    const d = decide(e, index);
    if (d === null || d === 'ambiguous') continue;
    if (d.rule === 'last_name') lastName.push({ e, to: d.to });
    else if (!shareMessage(e.email, d.to)) link(e.email, d.to, d.rule);
  }
  // R3, after the other rules: no shared message with the candidate's identity as it now stands, and
  // the middle initial shown in a display name of that identity.
  const names = new Map(people.map((p) => [p.email, p.name]));
  for (const { e, to } of lastName) {
    if (shareMessage(e.email, to)) continue;
    const shown = membersOf(followFolds(to, links)).map((m) => names.get(m) ?? null);
    if (shown.some((n) => middleInitial(n) === e.shape?.middle)) link(e.email, to, 'last_name');
  }

  return people.map((p) => ({
    email: p.email,
    name: p.name,
    sent: p.sent,
    received: p.received,
    priced: p.priced,
    kind: kinds.get(p.email) as PersonKind,
    canonical: followFolds(p.email, links),
    fold: links.get(p.email)?.rule ?? null,
  }));
}

// ---- Reading the folds back (every consumer after prepare) ----

export type Identity = {
  canonical(email: string): string; // itself for an address not in the directory
  kind(email: string): PersonKind; // kindOf for an address not in the directory
  displayName(canonical: string): string | null;
  addresses(canonical: string): string[]; // every address folding into it, sorted, itself first
  pricedParty(email: string): boolean; // a priced domain (isPricedEmail) and not a system sender
  staff(canonical: string): boolean; // a priced party and a person
  stats: { folds: Record<FoldRule, number>; ambiguous: number; lists: number; system: number };
};

const FOLD_RULES: readonly FoldRule[] = ['display_name', 'middle_initial', 'last_name', 'first_last', 'initial_last'];

// A people directory without the identity fields: written before identity folding existed.
export class IdentityError extends Error {
  override name = 'IdentityError';
}
export const STALE_PEOPLE = 'out/people.json predates identity folding: run node obs.mjs prepare.';
const KINDS: readonly unknown[] = ['person', 'list', 'system'];

// The identity of every address, from out/people.json as prepare wrote it. A record without
// `canonical` or `kind` is an IdentityError (STALE_PEOPLE): no consumer re-derives the folds.
// `stats.ambiguous`: the m..last addresses of E not folded by display name whose candidates were
// not unique.
export function identityOf(people: readonly Person[], rates: IdentityRates): Identity {
  for (const p of people) if (typeof p.canonical !== 'string' || !KINDS.includes(p.kind)) throw new IdentityError(STALE_PEOPLE);
  const byEmail = new Map(people.map((p) => [p.email, p]));
  const canonical = (email: string): string => byEmail.get(email)?.canonical ?? email;
  const kind = (email: string): PersonKind => byEmail.get(email)?.kind ?? kindOf(email, rates);
  const members = new Map<string, string[]>();
  for (const p of [...people].sort((a, b) => byText(a.email, b.email))) {
    const c = canonical(p.email);
    if (c !== p.email) members.set(c, [...(members.get(c) ?? []), p.email]);
  }
  const addresses = (c: string): string[] => [c, ...(members.get(c) ?? [])];
  const displayName = (c: string): string | null => {
    const own = byEmail.get(c)?.name ?? null;
    if (own !== null) return own;
    for (const e of members.get(c) ?? []) {
      const name = byEmail.get(e)?.name ?? null;
      if (name !== null) return name;
    }
    return null;
  };
  const pricedParty = (email: string): boolean => isPricedEmail(email, rates.priced_domains) && kind(email) !== 'system';

  const folds = Object.fromEntries(FOLD_RULES.map((r) => [r, 0])) as Record<FoldRule, number>;
  for (const p of people) if (p.fold !== null && p.fold !== undefined) folds[p.fold]++;
  const kinds = new Map(people.map((p) => [p.email, kind(p.email)]));
  const index = indexOf(people, kinds);
  const ambiguous = index.members.filter((m) => m.shape?.shape === 'ML' && byEmail.get(m.email)?.fold !== 'display_name' && decide(m, index) === 'ambiguous').length;
  return {
    canonical,
    kind,
    displayName,
    addresses,
    pricedParty,
    staff: (c) => pricedParty(c) && kind(c) === 'person',
    stats: { folds, ambiguous, lists: people.filter((p) => kind(p.email) === 'list').length, system: people.filter((p) => kind(p.email) === 'system').length },
  };
}
