// Everyone who sent or received a unique message, with the display name they appear under
// most often and whether their domain is priced. Who each address is (a person, a list or a system,
// and which addresses are one person) is added by src/normalize/identity.ts.
import { isPricedEmail } from '../metrics/actions.ts';
import type { ParsedMessage, PersonCounts } from '../types.ts';

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildPeople(unique: readonly ParsedMessage[], pricedDomains: readonly string[]): PersonCounts[] {
  const people = new Map<string, { sent: number; received: number; names: Map<string, number> }>();
  const entry = (email: string) => {
    let p = people.get(email);
    if (p === undefined) {
      p = { sent: 0, received: 0, names: new Map() };
      people.set(email, p);
    }
    return p;
  };
  for (const m of unique) {
    if (m.from !== null && m.from.email !== '') {
      const p = entry(m.from.email);
      p.sent += 1;
      if (m.from.name !== null) p.names.set(m.from.name, (p.names.get(m.from.name) ?? 0) + 1);
    }
    for (const email of new Set([...m.to, ...m.cc].map((r) => r.email).filter((e) => e !== ''))) entry(email).received += 1;
  }
  return [...people]
    .sort(([a], [b]) => byId(a, b))
    .map(([email, p]) => ({
      email,
      // Most frequent name; ties go to the alphabetically first so the choice is stable.
      name: [...p.names].sort((x, y) => y[1] - x[1] || byId(x[0], y[0]))[0]?.[0] ?? null,
      sent: p.sent,
      received: p.received,
      priced: isPricedEmail(email, pricedDomains),
    }));
}
