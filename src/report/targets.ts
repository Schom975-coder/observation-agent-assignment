// The rule behind "every number drills to messages" (ARCHITECTURE.md 5.12, spec section 4.3), as a
// walk over the built files: every Num has a target of a known kind whose parameters resolve, a
// count equals the length of the list its target opens, and the money ties (the parts add up to
// their totals, the rows to the headline, the running total ends at it). The tests run it on the
// fixture build and on the real one; it returns one line per problem.
import { ACTION_TYPES } from '../config.ts';
import { STALL_KINDS } from '../types.ts';
import { DAY_MS, utcMs } from '../util/time.ts';
import { TARGET_KINDS, type DashboardData, type LoopItem, type MessageIndexRow, type MethodData, type Num, type ProcessData, type Target } from './types.ts';

export type Bundle = {
  data: DashboardData | Omit<DashboardData, 'inputs' | 'outputs'>;
  method: MethodData;
  loops: readonly LoopItem[];
  processes: readonly ProcessData[];
  index: readonly MessageIndexRow[];
};

export const isNum = (x: unknown): x is Num =>
  typeof x === 'object' && x !== null && !Array.isArray(x) && typeof (x as Num).v === 'number' && typeof (x as Num).t === 'string';

// Every Num under `value`, with its path, the name of the field it sits in (for an array item, the
// array's field) and the object that holds it.
export function numsIn(value: unknown, path = '', field = ''): Array<{ num: Num; path: string; field: string; parent: unknown }> {
  const out: Array<{ num: Num; path: string; field: string; parent: unknown }> = [];
  const walk = (v: unknown, p: string, f: string, parent: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`, f, parent));
      return;
    }
    if (typeof v !== 'object' || v === null) return;
    if (isNum(v)) {
      out.push({ num: v, path: p, field: f, parent });
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, p === '' ? k : `${p}.${k}`, k, v);
  };
  walk(value, path, field, null);
  return out;
}

// "$1,511" -> 1511; null when the text is not a whole-dollar figure.
export function dollarsOf(text: string): number | null {
  const m = /^(-?)\$(\d{1,3}(?:,\d{3})*)$/.exec(text);
  return m === null ? null : (m[1] === '-' ? -1 : 1) * Number((m[2] as string).replace(/,/g, ''));
}

// "24.1" -> 241; null when the text is not hours to one decimal.
export function tenthsOf(text: string): number | null {
  const m = /^(\d{1,3}(?:,\d{3})*)\.(\d)$/.exec(text);
  return m === null ? null : Number((m[1] as string).replace(/,/g, '')) * 10 + Number(m[2]);
}

const PARTICIPANT_FILTERS = ['staff', 'writers', 'copied', 'all'];
const ROW_FILTERS = ['all', 'in_total', 'below', 'one_mailbox', 'drafted', 'drafted_one_mailbox'];
const METHOD_SECTIONS = ['rates', 'tiers', 'threshold', 'estimates', 'rounding', 'identity', 'flagged', 'merge', 'quotes', 'gold', 'run', 'dates', 'coverage', 'explainer'];

// The figures without a kind that are not counts of a list, by the field they sit in, and why. Every
// other figure without a kind is a count, and its target must open a list of that many items.
export const NOT_A_LIST: Readonly<Record<string, string>> = {
  minutes: 'the run’s wall time from its log (seconds, shown in minutes): a duration, not a count; it opens the run facts',
  share: 'the running total’s share of the headline: a percentage, not a count; it opens the total',
};

// What a count's target opens: the length of its list, or why it opens none (a problem unless the
// field is in NOT_A_LIST).
type Opened = { n: number } | { none: string };

// The walk. `extra`: more roots to walk with the same rules (the report model).
// `counts: false` on an extra root checks its targets only (the report places the data's own Nums,
// whose counts the data walk checked in their fields).
export function checkTargets(b: Bundle, extra: Array<{ name: string; value: unknown; counts?: boolean }> = []): string[] {
  const problems: string[] = [];
  const rows = b.data.rows;
  const keys = new Set(rows.map((r) => r.key));
  const files = new Map(b.processes.map((p) => [p.key, p]));
  const ids = new Set(b.index.map((m) => m.id));
  const threads = new Set(b.index.map((m) => m.thread_id).filter((t): t is string => t !== null));
  const buckets = new Map(b.method.coverage.map((c) => [c.bucket, c.ids]));
  const mailboxes = new Map(b.data.scope.mailboxes.map((m) => [m.key, m]));
  const drafted = rows.filter((r) => r.document?.status === 'done');
  const draftedKeys = new Set(drafted.map((r) => r.key));
  const allIds = [...buckets.values()].reduce((n, l) => n + l.length, 0);
  const sumOf = <T>(xs: readonly T[], f: (x: T) => number): number => xs.reduce((n, x) => n + f(x), 0);

  // The list a count's target opens, for a Num in `field` held by `parent`.
  const opened = (d: Target, field: string, file: ProcessData | undefined, parent: unknown): Opened => {
    const need = (f: ProcessData | undefined, n: (p: ProcessData) => number): Opened => (f === undefined ? { none: 'no process file' } : { n: n(f) });
    switch (d.kind) {
      case 'actions': {
        const types = d.type === 'authored' ? ['authored_short', 'authored_medium', 'authored_long'] : [d.type];
        return need(file, (f) => f.action_sources.filter((s) => s.priced && types.includes(s.type) && (d.person === undefined || s.person === d.person)).length);
      }
      case 'occurrences':
        return need(file, (f) => {
          if (field === 'messages') return sumOf(f.occurrences, (o) => o.message_ids.length);
          if (field === 'last_three_months_share') {
            const end = mailboxes.get(f.row.top_mailbox)?.last_utc ?? '';
            return end === '' ? 0 : f.occurrences.filter((o) => o.date_utc !== null && Math.floor((utcMs(end) - utcMs(o.date_utc)) / DAY_MS) <= 90).length;
          }
          if (d.month !== undefined) return f.monthly.find((m) => m.month === d.month)?.ids.length ?? 0;
          return f.occurrences.length;
        });
      case 'participants':
        return need(file, (f) => {
          const p = f.participants;
          return d.filter === 'all' ? p.length : d.filter === 'staff' ? p.filter((x) => x.staff).length : d.filter === 'writers' ? p.filter((x) => x.staff && x.wrote).length : p.filter((x) => x.staff && !x.wrote).length;
        });
      case 'stalls':
        return need(file, (f) => f.stall_quotes.filter((q) => d.stall_kind === undefined || q.stall_kind === d.stall_kind).length);
      case 'claims':
        return need(file, (f) => (field === 'conflicts' ? f.conflicts.length : f.claims.length));
      case 'gaps':
        return need(file, (f) => f.reply_gaps.length);
      case 'months':
        return need(file, (f) => f.monthly.length);
      case 'loops': {
        const list = d.key === undefined ? b.loops : (file?.loops ?? []);
        return { n: list.filter((l) => (d.recent !== true || l.recent) && (d.drafted !== true || l.processes.some((k) => draftedKeys.has(k)))).length };
      }
      case 'document':
        return field === 'blanks' ? need(file, (f) => f.document?.blank_items.length ?? 0) : { none: 'a document opens its text, not a list' };
      case 'documents':
        // The documents layer lists every drafted document with its blanks: a count of it is the blanks.
        return { n: sumOf(b.processes.filter((p) => draftedKeys.has(p.key)), (p) => p.document?.blank_items.length ?? 0) };
      case 'evidence':
        return need(file, (f) => (d.set === 'estimate' ? f.estimate_quotes.length : f.evidence.length));
      case 'coverage':
        return buckets.has(d.bucket) ? { n: buckets.get(d.bucket)?.length ?? 0 } : { none: 'no such bucket' };
      case 'mailbox':
        if (d.key === undefined) return { none: 'the mailbox table is not a list of items' };
        if (field === 'rows_mostly') return { n: rows.filter((r) => r.in_total && r.one_mailbox && r.top_mailbox === d.key).length };
        if (field === 'messages') return { n: b.index.filter((m) => m.mailbox === d.key).length };
        return { none: `a mailbox's ${field} is not one of its lists` };
      case 'rows': {
        const f = d.filter;
        const list =
          f === 'all'
            ? rows
            : f === 'in_total'
              ? rows.filter((r) => r.in_total)
              : f === 'below'
                ? rows.filter((r) => !r.in_total)
                : f === 'one_mailbox'
                  ? rows.filter((r) => r.in_total && r.one_mailbox)
                  : f === 'drafted'
                    ? drafted
                    : drafted.filter((r) => r.one_mailbox);
        return { n: list.length };
      }
      case 'method':
        if (d.section === 'coverage' && field === 'files') return { n: allIds };
        if (d.section === 'coverage' && field === 'unique') return { n: allIds - (buckets.get('duplicates')?.length ?? 0) };
        if (d.section === 'run' && field === 'agents') return { n: sumOf(b.method.run.agents, (a) => a.count) };
        if (d.section === 'run' && field === 'fix_rounds') return { n: sumOf(b.method.run.fix_rounds, (x) => x.rounds) };
        if (d.section === 'identity' && typeof parent === 'object' && parent !== null && Array.isArray((parent as { items?: unknown }).items)) return { n: ((parent as { items: unknown[] }).items).length };
        return { none: `the ${d.section} section is not a list for ${field}` };
      default:
        return { none: `a ${d.kind} target opens no list` };
    }
  };

  const check = (root: string, value: unknown, counts = true): void => {
    for (const { num, path, field, parent } of numsIn(value, root)) {
      const at = `${path}`;
      const d = (num as { d?: Target }).d;
      if (d === undefined || typeof d !== 'object' || !TARGET_KINDS.includes(d.kind)) {
        problems.push(`${at}: "${num.t}" has no drill target of a known kind`);
        continue;
      }
      // A process key, for every kind that names one (a mailbox target names a mailbox).
      const key = 'key' in d && d.kind !== 'mailbox' ? d.key : undefined;
      if (key !== undefined && !keys.has(key)) problems.push(`${at}: target ${d.kind} names ${key}, which is not a process`);
      if (d.kind === 'actions' && !(ACTION_TYPES as readonly string[]).includes(d.type) && d.type !== 'authored') problems.push(`${at}: action type ${String(d.type)} is not an action type`);
      if (d.kind === 'message' && !ids.has(d.id)) problems.push(`${at}: message ${d.id} is not in the index`);
      if (d.kind === 'thread' && !threads.has(d.id)) problems.push(`${at}: thread ${d.id} is not in the index`);
      if (d.kind === 'coverage' && !buckets.has(d.bucket)) problems.push(`${at}: coverage bucket ${d.bucket} is not in method.json`);
      if (d.kind === 'mailbox' && d.key !== undefined && !mailboxes.has(d.key)) problems.push(`${at}: mailbox ${d.key} is not in the scope`);
      if (d.kind === 'participants' && !PARTICIPANT_FILTERS.includes(d.filter)) problems.push(`${at}: participant filter ${d.filter} is not one`);
      if (d.kind === 'rows' && !ROW_FILTERS.includes(d.filter)) problems.push(`${at}: row filter ${d.filter} is not one`);
      if (d.kind === 'method' && !METHOD_SECTIONS.includes(d.section)) problems.push(`${at}: method section ${d.section} is not one`);
      if (d.kind === 'stalls' && d.stall_kind !== undefined && !(STALL_KINDS as readonly string[]).includes(d.stall_kind)) problems.push(`${at}: stall kind ${d.stall_kind} is not one`);
      if (d.kind === 'occurrences' && d.month !== undefined && key !== undefined && !(files.get(key)?.monthly.some((m) => m.month === d.month) ?? false)) {
        problems.push(`${at}: month ${d.month} is not a month of ${key}`);
      }
      if (key !== undefined && keys.has(key) && !files.has(key)) problems.push(`${at}: there is no process file for ${key}`);
      // A count (a figure without a kind) equals the list its target opens; the few that are not
      // counts are named in NOT_A_LIST.
      if (counts && num.k === undefined && !Object.hasOwn(NOT_A_LIST, field)) {
        const o = opened(d, field, key === undefined ? undefined : files.get(key), parent);
        if ('none' in o) problems.push(`${at}: "${num.t}" is a count, but its ${d.kind} target opens no list to check it against (${o.none})`);
        else if (o.n !== num.v) problems.push(`${at}: "${num.t}" counts ${num.v} but its ${d.kind} list holds ${o.n}`);
      }
    }
  };

  check('data', b.data);
  check('method', b.method);
  check('loops', b.loops);
  for (const p of b.processes) check(`process/${p.key}`, p);
  for (const x of extra) check(x.name, x.value, x.counts !== false);

  // The money ties (A6), in cents and as shown.
  const h = b.data.headline;
  const inTotal = rows.filter((r) => r.in_total);
  const below = rows.filter((r) => !r.in_total);
  const sum = sumOf(inTotal, (r) => r.total.v);
  if (sum !== h.total.v) problems.push(`headline: the rows in the total add up to ${sum}, not ${h.total.v}`);
  const last = b.data.cumulative.at(-1);
  if (last !== undefined && last.cents.v !== h.total.v) problems.push(`cumulative: ends at ${last.cents.v}, not the headline ${h.total.v}`);
  if (b.data.cumulative.length !== inTotal.length) problems.push(`cumulative: ${b.data.cumulative.length} steps for ${inTotal.length} rows in the total`);
  const tie = (where: string, parts: Num[], total: Num): void => {
    if (sumOf(parts, (p) => p.v) !== total.v) problems.push(`${where}: the parts' cents do not add up to ${total.v}`);
    const shown = parts.map((p) => dollarsOf(p.t));
    const whole = dollarsOf(total.t);
    if (shown.some((x) => x === null) || whole === null || sumOf(shown as number[], (x) => x) !== whole) {
      problems.push(`${where}: ${parts.map((p) => p.t).join(' + ')} does not add up to ${total.t}`);
    }
  };
  tie('headline', [h.counted, h.estimated], h.total);
  for (const r of rows) tie(`row ${r.key}`, [r.counted, r.estimated], r.total);
  // What the page shows adds up: the rows to the headline and to the total below the bar, the running
  // total to the rows above it, the rows' hours to the headline's.
  const shownSum = (rs: typeof rows): number | null => {
    const xs = rs.map((r) => dollarsOf(r.total.t));
    return xs.some((x) => x === null) ? null : sumOf(xs as number[], (x) => x);
  };
  if (shownSum(inTotal) !== dollarsOf(h.total.t)) problems.push(`shown: the rows in the total show ${shownSum(inTotal)}, the headline ${h.total.t}`);
  if (below.length > 0 && shownSum(below) !== dollarsOf(h.below_cents.t)) problems.push(`shown: the rows below the bar show ${shownSum(below)}, their total ${h.below_cents.t}`);
  let prefix = 0;
  b.data.cumulative.forEach((c, i) => {
    prefix += dollarsOf(inTotal[i]?.total.t ?? '') ?? 0;
    if (dollarsOf(c.cents.t) !== prefix) problems.push(`shown: the running total at ${c.key} shows ${c.cents.t}, the rows above it add up to ${prefix}`);
  });
  const hours = inTotal.map((r) => tenthsOf(r.hours.t));
  if (hours.some((x) => x === null) || sumOf(hours as number[], (x) => x) !== tenthsOf(h.hours.t)) problems.push(`shown: the rows' hours do not add up to the headline's ${h.hours.t}`);

  // Every message in exactly one coverage bucket (A13).
  const seen = new Set<string>();
  let n = 0;
  for (const c of b.method.coverage) {
    n += c.ids.length;
    for (const id of c.ids) {
      if (seen.has(id)) problems.push(`coverage: ${id} is in two buckets`);
      seen.add(id);
    }
  }
  if (n !== b.data.scope.files.v) problems.push(`coverage: the buckets hold ${n} messages, not ${b.data.scope.files.v}`);
  return problems;
}
