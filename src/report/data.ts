// The dashboard's data, built from the run's outputs (ARCHITECTURE.md 4 stage 15, 5.10 to 5.13):
// data.json (the rows, the headline, the code-written sentences), one file per process, the message
// index, the Methodology tables, the open loops and the run summary. Pure: the inputs come in read
// and parsed (src/report/build.ts), the records go out, and nothing here reads a file, the clock or a
// model. Every figure is a Num from the one formatter with its drill target; every list is sorted by
// a stated key, so the same inputs give the same bytes on every OS.
import { ACTION_TYPES, type ActionType, type EffortRates, type Scoring } from '../config.ts';
import { CENTS_PER_HOUR, cents as centsOf, perMonthX100 } from '../metrics/score.ts';
import { foldReport, identityOf, togetherIn, type Identity } from '../normalize/identity.ts';
import { roundHalfUp } from '../util/round.ts';
import { DAY_MS, utcMs } from '../util/time.ts';
import type { GoldScore } from '../gold/score.ts';
import type { Taxonomy } from '../model/taxonomy.ts';
import type { ValidationReport } from '../run/rollup.ts';
import {
  STALL_KINDS,
  type ArtifactStatus,
  type ArtifactType,
  type Artifacts,
  type Coverage,
  type DraftType,
  type DuplicateGroup,
  type FoldRule,
  type MergeTable,
  type Opportunities,
  type Opportunity,
  type ParsedMessage,
  type Person,
  type ProcessRollup,
  type Rollup,
  type StallKind,
  type Thread,
  type ValidatedExtraction,
} from '../types.ts';
import * as F from './format.ts';
import { blankItems } from './markdown.ts';
import {
  actionWords,
  basisWords,
  claimStatusWords,
  dateStatusWords,
  docTitle,
  foldRuleWords,
  personName,
  stallCountWords,
  stallKindWords,
  surname,
  tierRuleWords,
} from './words.ts';
import type {
  CoverageBucket,
  DashboardData,
  DocumentEntry,
  Kind,
  LoopItem,
  MailboxScope,
  MessageIndexRow,
  MethodData,
  Num,
  ProcessData,
  QuoteRef,
  Row,
  RunSummary,
  Target,
} from './types.ts';

// ---- Inputs ----

// The run facts' span (src/report/build.ts runSpanOf): the latest cold run (started with --force)
// first, then each later run that changed what the figures rest on, each log cut after its last step of work and without the build's events.
export type RunSpan = { runs: Array<{ id: string; path: string; events: Array<Record<string, unknown>> }> };

export type BuildInputs = {
  opportunities: Opportunities;
  rollup: Rollup;
  artifacts: Artifacts;
  artifactText: ReadonlyMap<string, string>; // a done artifact's path -> its rendered Markdown, LF endings
  people: Person[];
  rates: EffortRates;
  scoring: Scoring;
  messages: ParsedMessage[]; // every message, duplicates included
  threads: Thread[];
  dedup: { groups: DuplicateGroup[] };
  coverage: Coverage;
  validation: ValidationReport;
  merge: MergeTable;
  taxonomy: Pick<Taxonomy, 'processes'>;
  validated: ValidatedExtraction[]; // the done batches', in ledger order
  gold: GoldScore | null;
  run: RunSpan | null;
  synthesizer: { model: string | null; effort: string | null };
  files: { rates: string; scoring: string; rates_sha: string; scoring_sha: string };
};

// redact: replace every data-text field with REDACTED (or `token`) before anything is built.
export type BuildOptions = { redact?: boolean; token?: string };

export type Built = {
  data: Omit<DashboardData, 'inputs' | 'outputs'>;
  method: MethodData;
  processes: ProcessData[];
  index: MessageIndexRow[];
  loops: LoopItem[];
  summary: RunSummary;
};

// What every data-text field becomes in a redacted build (section 2.5): the refused-word test then
// sees code-written text only.
export const REDACTED = '[data]';

// A failure of the build, said in one line (src/report/build.ts prints it as `build: <line>`). Defined
// here so the data code can throw it without importing the stage.
export class BuildError extends Error {
  override name = 'BuildError';
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const SENT_FOLDER = /^_?sent(?:_items|_mail)?$/i;
const RECENT_DAYS = 90;
const ONE_MAILBOX_PCT = 90;
const LABEL_MAX = 90;
// The proposed fix shows as its whole first sentence; the cap only guards against a runaway one.
const FIX_MAX = 400;
const REPLY_GAP_MIN = 5;

// ---- Nums ----

const num = (v: number, t: string, d: Target, extra: { x?: string; k?: Kind } = {}): Num => ({
  v,
  t,
  ...(extra.x === undefined ? {} : { x: extra.x }),
  ...(extra.k === undefined ? {} : { k: extra.k }),
  d,
});
const moneyNum = (cents: number, kind: Kind, d: Target, t: string = F.money(cents, kind)): Num => num(cents, t, d, { x: F.moneyExact(cents, kind), k: kind });
const hoursNum = (x100: number, kind: Kind, d: Target): Num => num(x100, F.hours(x100), d, { x: `${F.hundredths(x100)} hours`, k: kind });
const countNum = (n: number, d: Target, t: string = F.count(n)): Num => num(n, t, d);

// ---- Redaction ----

// Every data-text field of the inputs replaced with REDACTED: process names and definitions, synthesis
// prose, estimate rationales, quotes, subjects, display names, claims, artifact bodies, merge slugs
// and aliases, raw date headers. Ids, keys, addresses and counts stay, so the build runs the same.
export function redactInputs(inputs: BuildInputs, token: string = REDACTED): BuildInputs {
  const x = structuredClone({ ...inputs, artifactText: undefined }) as Omit<BuildInputs, 'artifactText'>;
  const R = token;
  for (const o of x.opportunities.opportunities) {
    o.name = R;
    for (const p of o.counted.participants) if (p.name !== null) p.name = R;
    if (o.estimated !== null) o.estimated.rationale = R;
    if (o.synthesis !== null) {
      o.synthesis.description = R;
      o.synthesis.steps = o.synthesis.steps.map(() => R);
      for (const s of o.synthesis.stalls) s.summary = R;
      for (const s of o.synthesis.contradictions) s.summary = R;
      o.synthesis.automation.approach = R;
      o.synthesis.automation.rationale = R;
    }
  }
  for (const p of x.rollup.processes) {
    p.name = R;
    p.definition = R;
    for (const q of p.participants) if (q.name !== null) q.name = R;
    for (const s of p.stalls) s.quote = R;
    for (const c of p.ownership_claims) {
      c.person = R;
      c.quote = R;
      if (c.match.name !== null) c.match.name = R;
    }
  }
  for (const s of x.rollup.unassigned.slugs) {
    s.slug = R;
    if (s.reason !== null) s.reason = R;
  }
  for (const p of x.people) if (p.name !== null) p.name = R;
  for (const m of x.messages) {
    m.subject = R;
    m.subject_norm = R;
    if (m.date_raw !== null) m.date_raw = R;
    if (m.from !== null && m.from.name !== null) m.from.name = R;
    for (const a of [...m.to, ...m.cc]) if (a.name !== null) a.name = R;
  }
  for (const v of x.validated) {
    for (const e of v.evidence) {
      e.quote = R;
      e.note = R;
      if (e.raw_text !== null) e.raw_text = R;
    }
    for (const c of v.stall_checks) if (c.raw_text !== null) c.raw_text = R;
    for (const c of v.ownership_checks) {
      c.person = R;
      if (c.raw_text !== null) c.raw_text = R;
    }
    for (const m of v.messages) {
      if (m.stall !== null) m.stall.quote = R;
      if (m.ownership_claim !== null) m.ownership_claim = { person: R, quote: R };
    }
  }
  for (const p of x.merge.promoted) {
    p.name = R;
    p.definition = R;
    p.aliases = p.aliases.map(() => R);
  }
  for (const s of x.merge.slugs) {
    s.slug = R;
    if (s.reason !== null) s.reason = R;
  }
  for (const p of x.taxonomy.processes) {
    p.name = R;
    p.definition = R;
  }
  for (const r of x.validation.rejections) r.quote = R;
  for (const f of x.validation.flagged) f.tags = f.tags.map(() => R);
  if (x.gold !== null) {
    for (const m of x.gold.mismatches) {
      m.label.processes = m.label.processes.map(() => R);
      m.extracted.processes = m.extracted.processes.map(() => R);
    }
  }
  return { ...x, artifactText: new Map([...inputs.artifactText.keys()].map((k) => [k, R])) };
}

// ---- Text cut by code (section 3.8) ----

// The first sentence of a text: up to the first . ! or ? followed by a space or the end.
export function firstSentence(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  const m = /[.!?](?=\s|$)/.exec(t);
  return m === null ? t : t.slice(0, m.index + 1);
}

// Cut at the last word boundary before `max` characters, with an ellipsis.
export function cutAt(text: string, max: number): string {
  if ([...text].length <= max) return text;
  const head = [...text].slice(0, max - 1).join('');
  const space = head.lastIndexOf(' ');
  return `${(space > 0 ? head.slice(0, space) : head).replace(/[\s,;:.]+$/, '')}…`;
}

// ---- The build ----

type Entry = ValidatedExtraction['messages'][number];

export function buildData(raw: BuildInputs, opts: BuildOptions = {}): Built {
  const inputs = opts.redact === true ? redactInputs(raw, opts.token) : raw;
  const { opportunities, rollup, rates, scoring } = inputs;
  const identity: Identity = identityOf(inputs.people, rates);

  // ---- Where each message sits ----
  const messages = [...inputs.messages].sort((a, b) => byText(a.id, b.id));
  const msg = new Map(messages.map((m) => [m.id, m]));
  const usable = (id: string): string | null => {
    const m = msg.get(id);
    return m !== undefined && m.date_status === 'usable' && m.date_utc !== null ? m.date_utc : null;
  };
  const senderOf = (id: string): string => identity.canonical((msg.get(id)?.from?.email ?? '').toLowerCase());
  const labelOf = (canonical: string): string => personName(identity.displayName(canonical), canonical);
  const threadOf = new Map<string, Thread>();
  const occurrenceOf = new Map<string, string>();
  for (const t of inputs.threads) {
    for (const id of t.message_ids) threadOf.set(id, t);
    for (const o of t.occurrences) for (const id of o.message_ids) occurrenceOf.set(id, o.occurrence_id);
  }
  const duplicateOf = new Map<string, string>();
  for (const g of inputs.dedup.groups) for (const d of g.duplicates) duplicateOf.set(d.id, g.canonical);
  const entries = new Map<string, Entry>();
  for (const v of inputs.validated) for (const m of v.messages) if (!entries.has(m.id)) entries.set(m.id, m);
  const flaggedIds = new Set(messages.filter((m) => m.flags.suspected_injection).map((m) => m.id));

  // ---- Ranks and membership ----
  // The shown rank: the processes in the total (tiers A and B) first, in the score's order, then those
  // seen too rarely to count, so the numbers a reader sees run 1, 2, 3 within the total.
  const opps = [...opportunities.opportunities].sort((a, b) => Number(a.tier === 'C') - Number(b.tier === 'C') || a.rank - b.rank);
  const rankOf = new Map(opps.map((o, i) => [o.key, i + 1]));
  const shownRank = (key: string): number => rankOf.get(key) as number;
  const rolled = new Map(rollup.processes.map((p) => [p.key, p]));
  const keysOfMessage = new Map<string, string[]>();
  for (const p of rollup.processes) for (const id of p.message_ids) keysOfMessage.set(id, [...(keysOfMessage.get(id) ?? []), p.key]);
  const byRank = (a: string, b: string): number => (rankOf.get(a) ?? 1e9) - (rankOf.get(b) ?? 1e9) || byText(a, b);
  for (const [id, keys] of keysOfMessage) keysOfMessage.set(id, [...keys].sort(byRank));

  // ---- Quotes, placed (QuoteRef), by the ids the synthesis input gives them ----
  const quoteBase = (messageId: string): Pick<QuoteRef, 'message_id' | 'sender' | 'sender_label' | 'date_utc'> => {
    const sender = senderOf(messageId);
    return { message_id: messageId, sender, sender_label: labelOf(sender), date_utc: usable(messageId) };
  };
  const evidenceRefs = new Map<string, QuoteRef>();
  const stallRefs = new Map<string, QuoteRef>();
  const claimRefs = new Map<string, QuoteRef>();
  const stallIdOf = new Map<string, string>();
  const claimIdOf = new Map<string, string>();
  for (const v of inputs.validated) {
    const entryOf = new Map(v.messages.map((m) => [m.id, m]));
    for (const e of v.evidence) {
      if (e.match === 'rejected' || e.start === null || e.end === null || flaggedIds.has(e.message_id)) continue;
      evidenceRefs.set(e.evidence_id, {
        id: e.evidence_id,
        kind: 'evidence',
        ...quoteBase(e.message_id),
        start: e.start,
        end: e.end,
        raw_text: e.raw_text ?? e.quote,
        match: e.match,
        segment: e.segment,
        field: e.field,
      } as QuoteRef);
    }
    v.stall_checks.forEach((c, i) => {
      const id = `${v.batch_id}:s${i}`;
      if (!stallIdOf.has(c.message_id)) stallIdOf.set(c.message_id, id);
      const kind = entryOf.get(c.message_id)?.stall?.kind;
      if (c.match === 'rejected' || c.start === null || c.end === null || flaggedIds.has(c.message_id) || kind === undefined) return;
      stallRefs.set(id, { id, kind: 'stall', ...quoteBase(c.message_id), start: c.start, end: c.end, raw_text: c.raw_text ?? '', match: c.match, segment: c.segment, field: 'body', stall_kind: kind } as QuoteRef);
    });
    v.ownership_checks.forEach((c, i) => {
      const id = `${v.batch_id}:o${i}`;
      if (!claimIdOf.has(c.message_id)) claimIdOf.set(c.message_id, id);
      if (c.match === 'rejected' || c.start === null || c.end === null || flaggedIds.has(c.message_id)) return;
      claimRefs.set(id, { id, kind: 'claim', ...quoteBase(c.message_id), start: c.start, end: c.end, raw_text: c.raw_text ?? '', match: c.match, segment: c.segment, field: 'body', person: c.person } as QuoteRef);
    });
  }
  // Rebuild each ref with the keys in the type's order, so the JSON reads the same everywhere.
  const ordered = (q: QuoteRef): QuoteRef => ({
    id: q.id,
    kind: q.kind,
    message_id: q.message_id,
    start: q.start,
    end: q.end,
    raw_text: q.raw_text,
    match: q.match,
    segment: q.segment,
    field: q.field,
    sender: q.sender,
    sender_label: q.sender_label,
    date_utc: q.date_utc,
    ...(q.stall_kind === undefined ? {} : { stall_kind: q.stall_kind }),
    ...(q.person === undefined ? {} : { person: q.person }),
  });
  for (const m of [evidenceRefs, stallRefs, claimRefs]) for (const [k, q] of m) m.set(k, ordered(q));
  const resolve = (id: string): QuoteRef | null => evidenceRefs.get(id) ?? stallRefs.get(id) ?? claimRefs.get(id) ?? null;
  // The quotes of a list of cited ids, each span once (a stall quote is often cited as evidence too).
  const resolveAll = (ids: readonly string[]): QuoteRef[] => {
    const seen = new Set<string>();
    return ids
      .map(resolve)
      .filter((q): q is QuoteRef => q !== null)
      .filter((q) => {
        const at = `${q.message_id}|${q.start}|${q.end}`;
        return !seen.has(at) && (seen.add(at), true);
      });
  };

  // ---- Mailboxes ----
  const mailboxKeys = [...new Set(messages.map((m) => m.mailbox))].sort(byText);
  const mailboxBasics = new Map<string, { owner: string; ownerShort: string; ownerId: string | null; messages: number; first: string; last: string; own: number }>();
  for (const key of mailboxKeys) {
    const ms = messages.filter((m) => m.mailbox === key);
    const dates = ms.map((m) => usable(m.id)).filter((d): d is string => d !== null).sort(byText);
    // The owner: the staff person who sent at least half of the sent folder's mail (a folder named
    // sent, sent_items, sent_mail or _sent_mail); failing that, the staff person most of the
    // mailbox's messages are addressed to (more than half of them), else nobody: the key stands for
    // the owner and nothing is said about the owner's own mail.
    const tally = (list: string[]): string | null => {
      const n = new Map<string, number>();
      for (const e of list) if (e !== '') n.set(e, (n.get(e) ?? 0) + 1);
      return [...n].sort(([a, x], [b, y]) => y - x || byText(a, b))[0]?.[0] ?? null;
    };
    const staffPerson = (c: string): boolean => identity.kind(c) === 'person' && identity.staff(c);
    const sent = ms.filter((m) => SENT_FOLDER.test(m.folder));
    const sender = tally(sent.map((m) => senderOf(m.id)).filter(staffPerson));
    let ownerId = sender !== null && sent.filter((m) => senderOf(m.id) === sender).length * 2 >= sent.length ? sender : null;
    if (ownerId === null) {
      const staffTo = (m: ParsedMessage): string[] => [...new Set([...m.to, ...m.cc].map((a) => identity.canonical(a.email.toLowerCase())))].filter(staffPerson);
      const top = tally(ms.flatMap(staffTo));
      const reach = top === null ? 0 : ms.filter((m) => staffTo(m).includes(top)).length;
      ownerId = top !== null && reach * 2 > ms.length ? top : null;
    }
    const name = ownerId === null ? null : identity.displayName(ownerId);
    mailboxBasics.set(key, {
      owner: ownerId === null ? key : personName(name, ownerId),
      ownerShort: ownerId === null ? key : (surname(name) ?? ownerId),
      ownerId,
      messages: ms.length,
      first: dates[0] ?? '',
      last: dates.at(-1) ?? '',
      own: ownerId === null ? 0 : ms.filter((m) => senderOf(m.id) === ownerId).length,
    });
  }
  const mailboxEnd = (key: string): string | null => {
    const l = mailboxBasics.get(key)?.last ?? '';
    return l === '' ? null : l;
  };
  const daysBetween = (fromUtc: string, toUtc: string): number => Math.floor((utcMs(toUtc) - utcMs(fromUtc)) / DAY_MS);

  // ---- Open loops (requirements B5): computed over the threads ----
  const chaserMessages = new Set<string>();
  const waitingStall = new Map<string, QuoteRef>();
  for (const p of rollup.processes) {
    for (const s of p.action_sources) if (s.type === 'chaser') chaserMessages.add(s.message_id);
    for (const s of p.stalls) {
      if (s.kind !== 'waiting_on_reply') continue;
      const ref = stallRefs.get(stallIdOf.get(s.message_id) ?? '');
      if (ref !== undefined) waitingStall.set(s.message_id, ref);
    }
  }
  const loops: LoopItem[] = [];
  for (const t of inputs.threads) {
    if (!t.message_ids.some((id) => keysOfMessage.has(id))) continue;
    const last = t.message_ids.at(-1) as string;
    const waiting = waitingStall.get(last) ?? null;
    if (waiting === null && !chaserMessages.has(last)) continue;
    const m = msg.get(last) as ParsedMessage;
    const date = usable(last);
    const end = mailboxEnd(m.mailbox);
    const days = date === null || end === null ? null : daysBetween(date, end);
    const from = senderOf(last);
    loops.push({
      thread_id: t.thread_id,
      message_id: last,
      why: waiting === null ? 'chase' : 'waiting',
      date_utc: date,
      mailbox: m.mailbox,
      mailbox_end_utc: end,
      days_before_end: days,
      recent: days !== null && days <= RECENT_DAYS,
      subject: m.subject,
      from,
      from_label: labelOf(from),
      thread_length: t.message_ids.length,
      processes: [...new Set(t.message_ids.flatMap((id) => keysOfMessage.get(id) ?? []))].sort(byRank),
      quote: waiting,
    });
  }
  loops.sort((a, b) => byText(b.date_utc ?? '', a.date_utc ?? '') || byText(a.thread_id, b.thread_id));
  const loopsOf = (key: string): LoopItem[] => loops.filter((l) => l.processes.includes(key));

  // ---- Artifacts ----
  const artifactOf = new Map(inputs.artifacts.artifacts.map((a) => [a.key, a]));
  const docText = (path: string | null): string | null => (path === null ? null : (inputs.artifactText.get(path) ?? null));

  // ---- What the page shows, so that what it shows adds up ----
  // Each row's whole dollars are shared out by the largest remainder: the rows in the total against
  // the headline's whole dollars, the rows below the bar against their own total. So the rows, and
  // the running total (the prefix sums of the shown rows), add up to the shown headline, and the
  // shown order stays the rank order. The rows' hours (in tenths) the same way against the headline's
  // hours. Exact cents stay one level down (x).
  const h = opportunities.headline.tiers_ab_cents;
  const bar = scoring.artifacts.min_automatable_cents;
  const shownDollars = new Map<string, number>();
  const shownTenths = new Map<string, number>();
  for (const group of [opps.filter((o) => o.tier !== 'C'), opps.filter((o) => o.tier === 'C')]) {
    const cents = group.map((o) => o.dollars_per_month_cents.automatable);
    const hoursX100 = group.map((o) => o.hours_per_month_x100.automatable);
    const total = cents.reduce((a, c) => a + c, 0);
    const hours = hoursX100.reduce((a, c) => a + c, 0);
    let dollarsShown: number[];
    let tenthsShown: number[];
    try {
      dollarsShown = F.largestRemainder(cents, 100, roundHalfUp(total, 100));
      tenthsShown = F.largestRemainder(hoursX100, 10, roundHalfUp(hours, 10));
    } catch (err) {
      throw new BuildError(`the shown dollars or hours cannot be shared out: ${(err as Error).message}`);
    }
    group.forEach((o, i) => {
      shownDollars.set(o.key, dollarsShown[i] as number);
      shownTenths.set(o.key, tenthsShown[i] as number);
    });
  }

  // ---- Rows and process files ----
  const rows: Row[] = [];
  const processes: ProcessData[] = [];
  let droppedTotal = 0;
  for (const o of opps) {
    const p = rolled.get(o.key);
    if (p === undefined) throw new BuildError(`${o.key} is in out/opportunities.json but not in out/rollup.json`);
    const built = buildProcess(o, p);
    rows.push(built.row);
    processes.push(built.file);
    droppedTotal += built.file.contradictions_dropped;
  }

  function buildProcess(o: Opportunity, p: ProcessRollup): { row: Row; file: ProcessData } {
    const key = o.key;
    const inTotal = o.tier !== 'C';
    const countedCents = centsOf(o.counted.email_per_month_x100.automatable);
    const estimatedCents = o.estimated === null ? 0 : centsOf(o.estimated.work_per_month_x100.automatable);
    const totalCents = o.dollars_per_month_cents.automatable;
    if (countedCents + estimatedCents !== totalCents) throw new BuildError(`the parts of ${key} do not add up to its total`);
    // The row's shown dollars (shared out against its group's total), its parts against them.
    const shown = shownDollars.get(key) as number;
    let ct: string;
    let et: string;
    try {
      [ct, et] = F.partsOf([countedCents, estimatedCents], shown, ['counted', 'estimated']) as [string, string];
    } catch (err) {
      throw new BuildError(`the parts of ${key} cannot add up to its shown dollars: ${(err as Error).message}`);
    }
    const formula: Target = { kind: 'formula', key };

    // Where it was seen.
    const perMailbox = new Map<string, number>();
    for (const id of p.message_ids) {
      const mb = msg.get(id)?.mailbox ?? '';
      perMailbox.set(mb, (perMailbox.get(mb) ?? 0) + 1);
    }
    const nMessages = p.message_ids.length;
    const mailboxes = [...perMailbox].sort(([a, x], [b, y]) => y - x || byText(a, b)).map(([k, n]) => ({ key: k, n, pct: F.pctValue(n, nMessages) }));
    const top = mailboxes[0] ?? { key: '', n: 0, pct: 0 };
    const oneMailbox = nMessages > 0 && top.n * 100 >= nMessages * ONE_MAILBOX_PCT;
    const seenIn = oneMailbox ? `Mostly seen in: ${mailboxBasics.get(top.key)?.ownerShort ?? top.key} (${top.pct}%)` : `Seen in: ${F.plural(mailboxes.length, 'mailbox', 'mailboxes')}`;

    // Who.
    const participants = p.participants.map((x) => ({
      email: x.email,
      name: x.name,
      label: personName(x.name, x.email),
      kind: x.kind,
      addresses: [...x.addresses],
      staff: x.staff,
      authored: x.authored,
      forwards: x.forwards,
      chasers: x.chasers,
      reads: x.reads,
      wrote: x.authored + x.forwards + x.chasers > 0,
    }));
    const staff = participants.filter((x) => x.staff);
    const writers = staff.filter((x) => x.wrote);
    const copied = staff.filter((x) => !x.wrote);

    // Occurrences, by the rollup's rule: a round's date is its earliest usable-dated tagged message.
    const tagged = new Set(p.message_ids);
    const occMessages = new Map<string, string[]>();
    for (const id of p.message_ids) {
      const occ = occurrenceOf.get(id);
      if (occ !== undefined) occMessages.set(occ, [...(occMessages.get(occ) ?? []), id]);
    }
    const timeOrder = (a: string, b: string): number => byText(usable(a) ?? '\uffff', usable(b) ?? '\uffff') || byText(a, b);
    const occurrences = p.occurrence_ids.map((id) => {
      const ids = [...(occMessages.get(id) ?? [])].filter((m) => tagged.has(m)).sort(timeOrder);
      const dates = ids.map(usable).filter((d): d is string => d !== null).sort(byText);
      return { id, message_ids: ids, date_utc: dates[0] ?? null };
    });
    const undated = occurrences.filter((x) => x.date_utc === null).map((x) => x.id);
    const monthIds = new Map<string, string[]>();
    for (const x of occurrences) if (x.date_utc !== null) monthIds.set(x.date_utc.slice(0, 7), [...(monthIds.get(x.date_utc.slice(0, 7)) ?? []), x.id]);
    const monthly = p.monthly.map((mo) => {
      const ids = monthIds.get(mo.month) ?? [];
      return { month: mo.month, occurrences: countNum(ids.length, { kind: 'occurrences', key, month: mo.month }), messages: mo.messages, ids };
    });

    // The last three months of the top mailbox's record.
    const topEnd = mailboxEnd(top.key);
    const recentRounds = topEnd === null ? 0 : occurrences.filter((x) => x.date_utc !== null && daysBetween(x.date_utc, topEnd) <= RECENT_DAYS).length;
    const datedRounds = occurrences.length - undated.length;
    const lastThree = topEnd === null || datedRounds === 0 ? null : countNum(recentRounds, { kind: 'occurrences', key }, `${F.count(recentRounds)} of ${F.count(occurrences.length)}`);

    // Actions.
    const sources = [...p.action_sources]
      .sort((a, b) => byText(a.message_id, b.message_id) || ACTION_TYPES.indexOf(a.type) - ACTION_TYPES.indexOf(b.type) || byText(a.address, b.address))
      .map((s) => ({ message_id: s.message_id, type: s.type as ActionType, person: s.person, address: s.address, priced: s.priced, share_x100: s.share_x100 }));
    const pricedChasers = [...new Set(sources.filter((s) => s.type === 'chaser' && s.priced).map((s) => s.message_id))];
    const actionTable = ACTION_TYPES.map((type) => {
      const n = p.actions.priced[type];
      const m = rates.minutes[type];
      const share = rates.automatable_pct[type];
      return {
        type,
        words: actionWords[type],
        count: countNum(n, { kind: 'actions', key, type }),
        minutes_each: m,
        minutes: F.minutes(n * m * 100),
        automatable_pct: share,
        automatable_minutes: F.minutes(n * m * share),
      };
    });

    // Stalls: the validated quotes, by kind; the synthesis stalls with their cited quotes.
    const stallQuotes = p.stalls.map((s) => stallRefs.get(stallIdOf.get(s.message_id) ?? '')).filter((q): q is QuoteRef => q !== undefined);
    const kindCount = new Map<StallKind, number>();
    for (const q of stallQuotes) kindCount.set(q.stall_kind as StallKind, (kindCount.get(q.stall_kind as StallKind) ?? 0) + 1);
    const kindsByCount = [...kindCount].sort(([a, x], [b, y]) => y - x || STALL_KINDS.indexOf(a) - STALL_KINDS.indexOf(b));
    const topKind = kindsByCount[0]?.[0] ?? null;
    const synth = o.synthesis;
    const groups = (synth?.stalls ?? []).map((s, i) => ({ s, i, quotes: resolveAll(s.evidence_ids) }));
    const chosen = [...groups].sort((a, b) => b.s.evidence_ids.length - a.s.evidence_ids.length || a.i - b.i)[0] ?? null;
    const stallSummary = chosen === null ? null : chosen.s.summary;
    const stallLabel =
      stallSummary !== null
        ? cutAt(firstSentence(stallSummary), LABEL_MAX)
        : topKind !== null
          ? `${F.plural(kindCount.get(topKind) as number, 'quote')}: ${(kindCount.get(topKind) as number) === 1 ? stallKindWords[topKind].one : stallKindWords[topKind].many}`
          : 'none quoted';
    const fix = synth === null || synth.automation.approach.trim() === '' ? null : cutAt(firstSentence(synth.automation.approach), FIX_MAX);

    // Owner claims, conflicts and the contradictions that remain (3.9).
    const claimByMessage = new Map(p.ownership_claims.map((c) => [c.message_id, c]));
    const claims = p.ownership_claims
      .map((c) => {
        const q = claimRefs.get(claimIdOf.get(c.message_id) ?? '');
        if (q === undefined) return null;
        return { message_id: c.message_id, person: c.person, date_utc: c.date_utc, status: c.match.status, status_words: claimStatusWords[c.match.status], name: c.match.name, people: [...c.match.people], quote: q };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
    let dropped = 0;
    const contradictions = (synth?.contradictions ?? []).flatMap((c) => {
      const quotes = resolveAll(c.evidence_ids);
      // The cited claim ids (":o"), each as the rollup matched it.
      const cited = c.evidence_ids
        .map((id) => claimRefs.get(id))
        .filter((q): q is QuoteRef => q !== undefined)
        .map((q) => claimByMessage.get(q.message_id))
        .filter((x): x is NonNullable<typeof x> => x !== undefined)
        .map((x) => ({ message_id: x.message_id, person: x.person, date_utc: x.date_utc, status: x.match.status, name: x.match.name, people: x.match.people }));
      const onlyClaims = c.evidence_ids.length > 0 && c.evidence_ids.every((id) => /:o\d+$/.test(id));
      const onePerson = cited.length > 0 && cited.length === c.evidence_ids.length && cited.every((x) => x.status === 'matched') && new Set(cited.map((x) => x.people[0] ?? '')).size === 1;
      if (onlyClaims && onePerson) {
        dropped++;
        return [];
      }
      return [{ summary: c.summary, quotes, claims: cited.map(({ people: _people, ...rest }) => rest) }];
    });

    // The reply gap, shown only with REPLY_GAP_MIN or more replies measured.
    const gapN = p.reply_gap_n;
    const replyGap = gapN < REPLY_GAP_MIN || p.median_reply_gap_h === null ? null : { n: countNum(gapN, { kind: 'gaps', key }), median_h: F.hours(Math.round(p.median_reply_gap_h * 100)) };

    // The document.
    const art = artifactOf.get(key) ?? null;
    const docType: DraftType | null = art === null || art.artifact_type === 'none' ? null : art.artifact_type;
    const markdown = art !== null && art.status === 'done' ? docText(art.path) : null;
    const blanks = markdown === null ? [] : blankItems(markdown);
    const blanksNum = markdown === null ? null : countNum(blanks.length, { kind: 'document', key }, F.plural(blanks.length, 'item'));
    const statusLine = statusLineOf(o, art?.status ?? null, docType, blanks.length, art?.reason ?? null);

    // Flags in plain words.
    const flags = o.flags.flatMap((f): string[] => {
      const [name, n] = f.split(':');
      const k = Number(n ?? '0');
      switch (name) {
        case 'shared_occurrences':
          return [k === 1 ? 'one round shared with another process' : `${F.count(k)} rounds shared with other processes`];
        case 'undated_occurrences':
          return [`${F.plural(k, 'round')} without a usable date`];
        case 'undated_only':
          return ['no usable date'];
        case 'single_source':
          return ['one sender only'];
        case 'estimate_missing':
          return ['no estimate accepted'];
        case 'synthesis_missing':
          return ['no summary accepted'];
        case 'estimate_override':
          return ['estimate set by the project team'];
        case 'injection_adjacent':
          return ['beside a flagged message'];
        default:
          return [];
      }
    });

    const myLoops = loopsOf(key);
    const e = o.estimated;
    const row: Row = {
      rank: shownRank(o.key),
      key,
      name: o.name,
      tier: o.tier,
      tier_words: tierRuleWords(o.tier, scoring.tiers),
      in_total: inTotal,
      origin: o.origin,
      total: moneyNum(totalCents, 'total', formula, F.dollars(shown, 'total')),
      counted: moneyNum(countedCents, 'counted', formula, ct),
      estimated: moneyNum(estimatedCents, 'estimated', formula, et),
      low: moneyNum(o.range_cents.low, 'total', formula),
      high: moneyNum(o.range_cents.high, 'total', formula),
      today: moneyNum(o.dollars_per_month_cents.today, 'total', formula),
      hours: num(o.hours_per_month_x100.automatable, F.tenthsOfHours(shownTenths.get(key) as number), formula, { x: `${F.hundredths(o.hours_per_month_x100.automatable)} hours`, k: 'total' }),
      hours_today: hoursNum(o.hours_per_month_x100.today, 'total', formula),
      occurrences: countNum(p.occurrences, { kind: 'occurrences', key }, F.times(p.occurrences)),
      shared_occurrences: p.shared_occurrences,
      active_months: countNum(p.window.active_months, { kind: 'months', key }, F.plural(p.window.active_months, 'active month')),
      span_days: p.window.span_days,
      first_utc: p.window.first_utc,
      last_utc: p.window.last_utc,
      messages: countNum(nMessages, { kind: 'occurrences', key }, F.plural(nMessages, 'email')),
      threads: p.thread_ids.length,
      mailboxes,
      top_mailbox: top.key,
      top_pct: top.pct,
      one_mailbox: oneMailbox,
      seen_in: seenIn,
      staff: countNum(staff.length, { kind: 'participants', key, filter: 'staff' }, F.plural(staff.length, 'staff member', 'staff')),
      writers: countNum(writers.length, { kind: 'participants', key, filter: 'writers' }),
      copied: countNum(copied.length, { kind: 'participants', key, filter: 'copied' }),
      estimate: e === null ? null : { low: e.minutes_per_occurrence.low, mid: e.minutes_per_occurrence.mid, high: e.minutes_per_occurrence.high, automatable_pct: e.automatable_pct, basis_words: basisWords[e.basis] ?? e.basis, source: e.source },
      stall_label: stallLabel,
      stall_summary: stallSummary,
      stall_kind: topKind,
      stall_quotes: countNum(stallQuotes.length, { kind: 'stalls', key }, F.plural(stallQuotes.length, 'stall quote')),
      fix,
      document: docType === null || art === null ? null : { type: docType, status: art.status, blanks: blanksNum, reason: art.reason },
      status_line: statusLine,
      chasers: countNum(pricedChasers.length, { kind: 'actions', key, type: 'chaser' }, F.plural(pricedChasers.length, 'chaser')),
      stall_count: topKind === null ? countNum(0, { kind: 'stalls', key }) : countNum(kindCount.get(topKind) as number, { kind: 'stalls', key, stall_kind: topKind }),
      loops: countNum(myLoops.length, { kind: 'loops', key }, F.plural(myLoops.length, 'open loop')),
      loops_recent: countNum(myLoops.filter((l) => l.recent).length, { kind: 'loops', key, recent: true }),
      claims: countNum(claims.length, { kind: 'claims', key }, F.plural(claims.length, 'claim')),
      conflicts: countNum(p.ownership_conflicts.length, { kind: 'claims', key }, F.plural(p.ownership_conflicts.length, 'conflict')),
      reply_gap: replyGap,
      last_three_months_share: lastThree,
      flags,
    };

    const file: ProcessData = {
      key,
      name: o.name,
      definition: p.definition,
      rank: shownRank(o.key),
      tier: o.tier,
      row,
      synthesis:
        synth === null
          ? null
          : { description: synth.description, steps: [...synth.steps], approach: synth.automation.approach, rationale: synth.automation.rationale, artifact_type: synth.automation.artifact_type as ArtifactType },
      formula: { counted: o.formula.counted, estimated: o.formula.estimated, total: o.formula.total },
      window: { ...p.window },
      months: p.window.months_x100,
      occurrence_share_x100: p.occurrence_share_x100,
      actions: { priced: { ...p.actions.priced }, unpriced: { ...p.actions.unpriced } },
      action_table: actionTable,
      email: { today_x100: o.counted.email_x100.today, automatable_x100: o.counted.email_x100.automatable, per_month_today_x100: o.counted.email_per_month_x100.today, per_month_automatable_x100: o.counted.email_per_month_x100.automatable },
      work: e === null ? null : { per_month_today_x100: e.work_per_month_x100.today, per_month_automatable_x100: e.work_per_month_x100.automatable, low_cents: o.range_cents.low - countedCents, high_cents: o.range_cents.high - countedCents },
      estimate_quotes: (e?.evidence_ids ?? []).map(resolve).filter((q): q is QuoteRef => q !== null),
      estimate_check: e === null || e.source !== 'model' ? null : { occurrences_cited: e.occurrences_cited, senders_cited: e.senders_cited },
      monthly,
      occurrences,
      undated_occurrences: undated,
      action_sources: sources,
      participants,
      stalls_by_kind: kindsByCount.map(([k, n]) => ({ kind: k, words: stallCountWords(k, n), count: countNum(n, { kind: 'stalls', key, stall_kind: k }) })),
      stall_groups: [...groups].sort((a, b) => b.s.evidence_ids.length - a.s.evidence_ids.length || a.i - b.i).map((g) => ({ summary: g.s.summary, quotes: g.quotes })),
      stall_quotes: stallQuotes,
      evidence: p.evidence_ids.map((id) => evidenceRefs.get(id)).filter((q): q is QuoteRef => q !== undefined),
      chasers: pricedChasers,
      reply_gaps: p.reply_gaps.map((g) => ({ ...g })),
      reply_gap_n: p.reply_gap_n,
      median_reply_gap_h: p.median_reply_gap_h,
      claims,
      conflicts: p.ownership_conflicts.map((c) => ({ ...c })),
      contradictions,
      contradictions_dropped: dropped,
      loops: myLoops,
      document: docType === null || art === null ? null : { type: docType, status: art.status, path: art.path, markdown, blanks: blanksNum, blank_items: blanks, reason: art.reason },
    };
    return { row, file };
  }

  // "Drafted: SOP, 8 items to confirm" and the other status lines (section 3.1).
  function statusLineOf(o: Opportunity, status: ArtifactStatus | null, type: DraftType | null, blanks: number, reason: string | null): string {
    if (status === 'done' && type !== null) return `Drafted: ${docTitle(type)}, ${F.plural(blanks, 'item')} to confirm`;
    if (status === 'failed' || status === 'exhausted') return `Draft failed: ${reason ?? 'no usable draft'}`;
    if (status === 'pending' || status === 'running') return `Not drafted: ${reason ?? 'not drafted yet'}`;
    if (status === 'skipped') return `Not drafted: ${reason ?? 'no document type was chosen'}`;
    if (o.tier === 'C') return 'Not drafted: seen too rarely to count';
    const total = o.dollars_per_month_cents.automatable;
    if (bar !== null && total < bar) {
      // Where the shown whole dollars would read as at or over the bar, the line gives exact cents.
      const shown = shownDollars.get(o.key) ?? roundHalfUp(total, 100);
      return shown * 100 >= bar
        ? `Not drafted: ${F.moneyExact(total, 'total')} a month is under the ${F.moneyExact(bar, 'total')} drafting line`
        : `Not drafted: ${F.dollars(shown, 'total')} a month is under the ${F.money(bar, 'total')} drafting line`;
    }
    return `Not drafted: past the cap of ${F.plural(scoring.artifacts.cap, 'document')}`;
  }

  // ---- The headline and its blocks ----
  const ab = rows.filter((r) => r.in_total);
  const below = rows.filter((r) => !r.in_total);
  const all = opportunities.headline.all_tiers_cents;
  const sumOf = (rs: Row[], f: (r: Row) => number) => rs.reduce((n, r) => n + f(r), 0);
  if (sumOf(ab, (r) => r.total.v) !== h.total) throw new BuildError('the rows in the total do not add up to the headline');
  const [hc, he] = F.parts([h.counted_email, h.estimated_work], h.total, ['counted', 'estimated']) as [string, string];
  // The reading time: the counted part's reads, at the published rates, per month, over the rows in
  // the total.
  const reading = ab.reduce((n, r) => {
    const p = rolled.get(r.key) as ProcessRollup;
    let auto = 0;
    for (const s of p.action_sources) if (s.priced && s.type === 'read') auto += rates.minutes.read * rates.automatable_pct.read * s.share_x100;
    return n + centsOf(perMonthX100(roundHalfUp(auto, 100), p.window.months_x100));
  }, 0);
  const oneRows = ab.filter((r) => r.one_mailbox);
  const oneCents = sumOf(oneRows, (r) => r.total.v);
  // The whole dollars a set of rows shows: the sum of their shown dollars (so a sum on the page is the
  // sum of the figures above it).
  const shownSum = (rs: Row[]): number => rs.reduce((n, r) => n + (shownDollars.get(r.key) as number), 0);
  const oneShown = F.dollars(shownSum(oneRows), 'total');
  const belowCents = sumOf(below, (r) => r.total.v);
  const drafted = rows.filter((r) => r.document?.status === 'done');
  const draftedAb = ab.filter((r) => r.document?.status === 'done');

  // ---- Coverage: every message in one of seven buckets ----
  const countedIds = new Set(keysOfMessage.keys());
  const unassignedIds = new Set(rollup.unassigned.message_ids);
  const buckets: Record<CoverageBucket, string[]> = { counted: [], unassigned: [], personal: [], noise: [], automated: [], flagged: [], duplicates: [] };
  for (const m of messages) {
    const e = entries.get(m.id);
    if (duplicateOf.has(m.id)) buckets.duplicates.push(m.id);
    else if (countedIds.has(m.id)) buckets.counted.push(m.id);
    else if (e !== undefined && e.role === 'injection_attempt') buckets.flagged.push(m.id);
    else if (e !== undefined && e.processes.length === 0 && (e.role === 'personal' || e.role === 'noise' || e.role === 'automated')) buckets[e.role].push(m.id);
    // Tagged but counted under no process; and any message no accepted extraction classified.
    else buckets.unassigned.push(m.id);
  }
  const notClassified = buckets.unassigned.filter((id) => !unassignedIds.has(id)).length;
  const bucketWords: Record<CoverageBucket, string> = {
    counted: 'Messages counted under a recurring process.',
    unassigned:
      `Messages that fit no recurring process: tagged with a process name the merge did not keep (${F.plural(rollup.unassigned.slugs.length, 'proposed name')}).` +
      (notClassified > 0 ? ` ${F.plural(notClassified, 'message')} no accepted extraction classified ${notClassified === 1 ? 'is' : 'are'} counted here too.` : ''),
    personal: 'Personal mail, read and set aside.',
    noise: 'Newsletters, notices and other noise, read and set aside.',
    automated: 'Messages sent by systems, read and set aside.',
    flagged: 'Messages addressed to an automated reviewer: flagged, excluded from every count, their instructions not followed.',
    duplicates: 'Copies of another message in the archive: the copy is counted once, as the original.',
  };
  const BUCKETS: CoverageBucket[] = ['counted', 'unassigned', 'personal', 'noise', 'automated', 'flagged', 'duplicates'];
  const coverageNum = (b: CoverageBucket): Num => countNum(buckets[b].length, { kind: 'coverage', bucket: b });

  // ---- Scope ----
  const dated = messages.map((m) => usable(m.id)).filter((d): d is string => d !== null).sort(byText);
  const first = dated[0] ?? '';
  const last = dated.at(-1) ?? '';
  const mailboxScope: MailboxScope[] = mailboxKeys.map((key) => {
    const b = mailboxBasics.get(key) as NonNullable<ReturnType<typeof mailboxBasics.get>>;
    const mostly = ab.filter((r) => r.one_mailbox && r.top_mailbox === key);
    return {
      key,
      owner: b.owner,
      messages: countNum(b.messages, { kind: 'mailbox', key }),
      first_utc: b.first,
      last_utc: b.last,
      own_messages: b.own,
      received_only: b.ownerId !== null && b.own * 20 < b.messages,
      rows_mostly: countNum(mostly.length, { kind: 'mailbox', key }),
      rows_mostly_cents: moneyNum(sumOf(mostly, (r) => r.total.v), 'total', { kind: 'mailbox', key }, F.dollars(shownSum(mostly), 'total')),
    };
  });

  // ---- Sentences (section 2.2) ----
  const archiveMonths = first === '' ? 0 : F.monthsSpanned(first, last);
  const sentences = {
    scope: first === '' ? 'Found in the email of no dated mailbox.' : F.scopeLine({ mailboxes: mailboxKeys.length, first_utc: first, last_utc: last }),
    split: F.splitSentence(h.counted_email, h.estimated_work),
    range: F.rangeSentence(h.low, h.high),
    // What the work costs today beside the part that could be automated, and that both are floors.
    today: `This work costs ${F.money(h.today, 'total')} a month today (${F.hours(h.hours_x100.today)} hours); the ${F.money(h.total, 'total')} is the part that could be automated. Both are floors: email shows only part of the work.`,
    // What a rerun does to these figures: the same run reproduces them; a fresh one asks the model again.
    rerun: 'Running /observe again reproduces these figures exactly. A fresh run (/observe --force) asks the model again, so its process list and work estimates, and the dollars built on them, can differ; the counting and arithmetic are exact either way.',
    concentration: F.concentrationSentence({ rows: oneRows.length, of: ab.length, worth: oneShown, total: F.money(h.total, 'total') }),
    caution: F.cautionSentence({ drafted_one: draftedAb.filter((r) => r.one_mailbox).length, drafted: draftedAb.length }),
    threshold: F.thresholdSentence(scoring),
    sensitivity: F.thresholdSensitivity(
      ab.map((r) => ({ low: r.low.v, mid: r.total.v, high: r.high.v })),
      bar,
    ),
    averaging: F.averagingSentence(ab[0] === undefined ? 0 : (rolled.get(ab[0].key) as ProcessRollup).window.months_x100, archiveMonths),
    not_included: F.notIncludedSentence(below.length, belowCents, buckets.unassigned.length),
    no_reply: F.noReplySentence(),
    reading: F.readingSentence(reading, { minutes: rates.minutes.read, automatable_pct: rates.automatable_pct.read }),
  };

  // ---- The chart's scale ----
  const above = (cents: number, step: number): number => (Math.floor(cents / step) + 1) * step;
  const yStep = 50_000;
  const rangeStep = h.high > 300_000 ? 100_000 : 50_000;
  const yMax = above(h.total, yStep);
  const yMaxRange = above(h.high, rangeStep);
  const labels = (max: number, step: number): string[] => Array.from({ length: max / step + 1 }, (_, i) => F.money(i * step, 'total'));
  const lastDrafted = ab.reduce((n, r, i) => (r.document?.status === 'done' ? i + 1 : n), 0);

  // ---- The running total ----
  // Its text is the prefix sum of the rows' shown dollars, so it reads as their sum and ends at the
  // shown headline; its value, exact text and share are from cents.
  let running = 0;
  let runShown = 0;
  let runLow = 0;
  let runHigh = 0;
  const cumulative = ab.map((r) => {
    running += r.total.v;
    runShown += shownDollars.get(r.key) as number;
    runLow += r.low.v;
    runHigh += r.high.v;
    return {
      key: r.key,
      cents: moneyNum(running, 'total', { kind: 'total' }, F.dollars(runShown, 'total')),
      share: countNum(F.pctValue(running, h.total), { kind: 'total' }, F.pct(running, h.total)),
      low_cents: runLow,
      high_cents: runHigh,
    };
  });

  // ---- The three findings ----
  // The stall of each is the one its summary came from (the most cited); its quote, the first cited
  // id that resolves, else the process's first evidence quote.
  const findings = ab.slice(0, 3).map((r) => {
    const file = processes.find((x) => x.key === r.key) as ProcessData;
    const stalls = opps.find((o) => o.key === r.key)?.synthesis?.stalls ?? [];
    const pick = stalls.map((s, i) => ({ s, i })).sort((a, b) => b.s.evidence_ids.length - a.s.evidence_ids.length || a.i - b.i)[0];
    const ids = pick === undefined ? [] : [...pick.s.evidence_ids];
    const quote = ids.map(resolve).find((q): q is QuoteRef => q !== null) ?? file.evidence[0] ?? null;
    return { key: r.key, stall_summary: r.stall_summary, stall_ids: ids, quote, fix: r.fix };
  });

  // ---- Next steps, built from the data (section 5.1) ----
  const recentLoops = loops.filter((l) => l.recent);
  const draftedKeys = new Set(drafted.map((r) => r.key));
  const recentInDrafted = recentLoops.filter((l) => l.processes.some((k) => draftedKeys.has(k))).length;
  const blanksTotal = sumOf(drafted, (r) => r.document?.blanks?.v ?? 0);
  const nDrafted = drafted.length;
  const draftedOne = drafted.filter((r) => r.one_mailbox);
  const pcts = draftedOne.map((r) => r.top_pct).sort((a, b) => a - b);
  const blanksNum = countNum(blanksTotal, { kind: 'documents' }, F.plural(blanksTotal, 'item'));
  const recentNum = countNum(recentLoops.length, { kind: 'loops', recent: true }, F.plural(recentLoops.length, 'thread'));
  const inDraftedNum = countNum(recentInDrafted, { kind: 'loops', recent: true, drafted: true });
  const oneNum = countNum(draftedOne.length, { kind: 'rows', filter: 'drafted_one_mailbox' });
  const next_steps: DashboardData['next_steps'] = [
    nDrafted === 0
      ? { title: 'Give each document an owner', text: 'No document was drafted on this run.', nums: [] }
      : {
          title: 'Give each document an owner',
          text: `Name an owner for each of the ${F.plural(nDrafted, 'drafted document')} and have them confirm its open items: ${blanksNum.t} across the ${F.count(nDrafted)}.`,
          nums: [blanksNum],
        },
    nDrafted === 0
      ? { title: 'Ask for more mail', text: `${F.concentrationSentence({ rows: oneRows.length, of: ab.length, worth: oneShown, total: F.money(h.total, 'total') })} Other people’s mail would show whether the same work happens elsewhere.`, nums: [] }
      : draftedOne.length === nDrafted
        ? {
            title: 'Ask for more mail',
            text: `${nDrafted === 1 ? 'The drafted process comes' : `All ${oneNum.t} drafted processes come`} almost only from one mailbox (${pcts[0] === pcts.at(-1) ? `${pcts[0]}%` : `${pcts[0]}% to ${pcts.at(-1)}%`}). Other people’s mail would show whether the same work happens elsewhere.`,
            nums: [oneNum],
          }
        : {
            title: 'Ask for more mail',
            text: `${oneNum.t} of the ${F.count(nDrafted)} drafted processes ${draftedOne.length === 1 ? 'comes' : 'come'} almost only from one mailbox. Other people’s mail would show whether the same work happens elsewhere.`,
            nums: [oneNum],
          },
    {
      title: 'Check what was still open',
      text: `${recentNum.t} ${recentLoops.length === 1 ? 'was' : 'were'} still waiting on someone when their mailbox’s record stops; ${inDraftedNum.t} ${recentInDrafted === 1 ? 'is' : 'are'} in drafted processes.`,
      nums: [recentNum, inDraftedNum],
    },
  ];

  // ---- Documents: every eligible row ----
  const documents: DocumentEntry[] = inputs.artifacts.artifacts
    .slice()
    .sort((a, b) => shownRank(a.key) - shownRank(b.key) || byText(a.key, b.key))
    .map((a) => {
      const r = rows.find((x) => x.key === a.key);
      return { key: a.key, type: a.artifact_type === 'none' ? null : a.artifact_type, status: a.status, path: a.path, blanks: r?.document?.blanks ?? null, reason: a.reason };
    });

  // ---- Run facts, from the run's log ----
  const run = runFacts(inputs.run);

  const data: Built['data'] = {
    version: 1,
    run: {
      id: run.id,
      date: run.id === null ? null : `${run.id.slice(0, 4)}-${run.id.slice(4, 6)}-${run.id.slice(6, 8)}`,
      minutes: run.minutes,
      agents: run.agentsNum,
      fix_rounds: run.fixNum,
      later_runs: run.laterNum,
      log: run.log,
    },
    scope: {
      files: countNum(messages.length, { kind: 'method', section: 'coverage' }),
      unique: countNum(messages.length - buckets.duplicates.length, { kind: 'method', section: 'coverage' }),
      first_utc: first,
      last_utc: last,
      mailboxes: mailboxScope,
    },
    headline: {
      total: moneyNum(h.total, 'total', { kind: 'total' }),
      counted: moneyNum(h.counted_email, 'counted', { kind: 'total' }, hc),
      estimated: moneyNum(h.estimated_work, 'estimated', { kind: 'total' }, he),
      low: moneyNum(h.low, 'total', { kind: 'method', section: 'explainer' }),
      high: moneyNum(h.high, 'total', { kind: 'method', section: 'explainer' }),
      today: moneyNum(h.today, 'total', { kind: 'total' }),
      hours: hoursNum(h.hours_x100.automatable, 'total', { kind: 'total' }),
      hours_today: hoursNum(h.hours_x100.today, 'total', { kind: 'total' }),
      reading: moneyNum(reading, 'counted', { kind: 'total' }),
      rows_in_total: countNum(ab.length, { kind: 'rows', filter: 'in_total' }),
      rows_below: countNum(below.length, { kind: 'rows', filter: 'below' }),
      below_cents: moneyNum(belowCents, 'total', { kind: 'rows', filter: 'below' }),
      unassigned_messages: coverageNum('unassigned'),
      one_mailbox_rows: countNum(oneRows.length, { kind: 'rows', filter: 'one_mailbox' }),
      one_mailbox_cents: moneyNum(oneCents, 'total', { kind: 'rows', filter: 'one_mailbox' }, oneShown),
      all_tiers: {
        // Shown as the headline's dollars plus the rows below the bar's, so the three figures add up.
        total: moneyNum(all.total, 'total', { kind: 'rows', filter: 'all' }, F.dollars(shownSum(ab) + shownSum(below), 'total')),
        low: moneyNum(all.low, 'total', { kind: 'method', section: 'explainer' }),
        high: moneyNum(all.high, 'total', { kind: 'method', section: 'explainer' }),
      },
      label: first === '' ? F.scopeLabel({ mailboxes: mailboxKeys.length, first_utc: '', last_utc: '' }) : F.scopeLabel({ mailboxes: mailboxKeys.length, first_utc: first, last_utc: last }),
    },
    sentences,
    rates: {
      hourly_cents: CENTS_PER_HOUR,
      hourly: moneyNum(CENTS_PER_HOUR, 'total', { kind: 'method', section: 'rates' }),
      file: inputs.files.rates,
      sha: inputs.files.rates_sha,
      minutes: { ...rates.minutes },
      automatable_pct: { ...rates.automatable_pct },
      read_cap: rates.read_cap_per_message,
      buckets: { short_max: rates.own_chars_buckets.short_max, medium_max: rates.own_chars_buckets.medium_max },
    },
    scoring: {
      file: inputs.files.scoring,
      sha: inputs.files.scoring_sha,
      tiers: { A: { ...scoring.tiers.A }, B: { ...scoring.tiers.B } },
      threshold_cents: bar,
      threshold: bar === null ? null : moneyNum(bar, 'total', { kind: 'method', section: 'threshold' }),
      cap: scoring.artifacts.cap,
      floor: scoring.artifacts.floor,
      estimates: { ...scoring.estimates },
    },
    chart: {
      y_max_cents: yMax,
      y_step_cents: yStep,
      y_max_range_cents: yMaxRange,
      y_step_range_cents: rangeStep,
      drafted: lastDrafted,
      axis_labels: labels(yMax, yStep),
      axis_labels_range: labels(yMaxRange, rangeStep),
    },
    findings,
    rows,
    cumulative,
    next_steps,
    documents,
  };

  // ---- The message index ----
  const index: MessageIndexRow[] = messages.map((m) => {
    const e = entries.get(m.id);
    const t = threadOf.get(m.id);
    const flags = [...(m.flags.suspected_injection ? ['flagged'] : []), ...(m.flags.oversize ? ['oversize'] : [])];
    return {
      id: m.id,
      mailbox: m.mailbox,
      folder: m.folder,
      date_utc: m.date_status === 'usable' ? m.date_utc : null,
      date_status: m.date_status,
      from: (m.from?.email ?? '').toLowerCase(),
      from_name: m.from?.name ?? null,
      subject: m.subject,
      recipients: new Set([...m.to, ...m.cc].map((a) => a.email.toLowerCase())).size,
      thread_id: t?.thread_id ?? null,
      occurrence_id: occurrenceOf.get(m.id) ?? null,
      duplicate_of: duplicateOf.get(m.id) ?? null,
      role: e?.role ?? null,
      processes: keysOfMessage.get(m.id) ?? [],
      flags,
    };
  });

  // ---- Methodology ----
  const together = togetherIn(inputs.messages);
  const left = foldReport(inputs.people, rates, together);
  const FOLD_RULES: FoldRule[] = ['display_name', 'middle_initial', 'last_name', 'first_last', 'initial_last'];
  const folded = inputs.people.filter((p) => p.canonical !== p.email).sort((a, b) => byText(a.email, b.email));
  const foldsBy = FOLD_RULES.map((rule) => {
    // An address is listed under the rule of its own first link (its `fold`), its canonical the end of the chain.
    const items = folded.filter((p) => p.fold === rule).map((p) => ({ email: p.email, canonical: p.canonical, name: p.name }));
    return { rule, words: foldRuleWords[rule], count: countNum(items.length, { kind: 'method', section: 'identity' }), items };
  });
  const foldTotal = sumOf2(foldsBy.map((f) => f.count.v));
  const mergeCounts = inputs.merge.counts;
  const q = inputs.validation.quotes.total;
  const estimates = opps
    .filter((o) => o.estimated !== null)
    .map((o) => {
      const e = o.estimated as NonNullable<Opportunity['estimated']>;
      return {
        key: o.key,
        name: o.name,
        rank: shownRank(o.key),
        low: e.minutes_per_occurrence.low,
        mid: e.minutes_per_occurrence.mid,
        high: e.minutes_per_occurrence.high,
        automatable_pct: e.automatable_pct,
        basis: basisWords[e.basis] ?? e.basis,
        source: e.source,
        occurrences_cited: e.occurrences_cited,
        senders_cited: e.senders_cited,
        override_file: e.source === 'override' ? opportunities.estimates_file : null,
      };
    });
  const b = scoring.estimates;
  const synthName = describeSynthesizer(inputs.synthesizer);
  const method: MethodData = {
    version: 1,
    coverage: BUCKETS.map((bucket) => ({ bucket, words: bucketWords[bucket], count: coverageNum(bucket), ids: buckets[bucket] })),
    unassigned_slugs: rollup.unassigned.slugs.map((s) => ({ slug: s.slug, messages: s.messages, status: s.status, reason: s.reason })),
    identity: {
      folds: foldsBy,
      left_apart: left,
      lists: inputs.people.filter((p) => p.kind === 'list').map((p) => p.email).sort(byText),
      system: inputs.people.filter((p) => p.kind === 'system').map((p) => p.email).sort(byText),
      stats: { folds: { ...identity.stats.folds }, ambiguous: identity.stats.ambiguous, lists: identity.stats.lists, system: identity.stats.system },
    },
    merge: {
      counts: { ...mergeCounts },
      sentence:
        `${F.plural(mergeCounts.slugs, 'name')} proposed while reading: ${F.count(mergeCounts.mapped)} mapped to the ${F.plural(inputs.taxonomy.processes.length, 'starting process', 'starting processes')}, ` +
        `${F.count(mergeCounts.promoted)} promoted to new processes (with ${F.plural(mergeCounts.aliases, 'alias', 'aliases')}), ${F.count(mergeCounts.unassigned)} left unassigned` +
        (mergeCounts.demoted > 0 ? `, ${F.count(mergeCounts.demoted)} promoted but too small when counted.` : '.'),
      promoted: inputs.merge.promoted.map((x) => ({ key: x.key, name: x.name, aliases: [...x.aliases], messages: x.messages, occurrences: x.occurrences, threads: x.threads, active_months: x.active_months })),
      slugs: inputs.merge.slugs.map((s) => ({ slug: s.slug, messages: s.messages, batches: s.batches, status: s.status, to: s.to, reason: s.reason })),
    },
    taxonomy: inputs.taxonomy.processes.map((x) => ({ key: x.key, name: x.name, definition: x.definition })).sort((a, b) => byText(a.key, b.key)),
    quotes: {
      counts: { evidence: { ...inputs.validation.quotes.evidence }, stall: { ...inputs.validation.quotes.stall }, ownership: { ...inputs.validation.quotes.ownership }, total: { ...q } },
      sentence: `${F.plural(q.exact, 'quote')} matched their message exactly, ${F.count(q.repaired)} after repair, ${F.count(q.rejected)} rejected.`,
      rejections: inputs.validation.rejections.map((r) => ({ kind: r.kind, message_id: r.message_id, process: r.process, quote: r.quote, reason: r.reason })),
    },
    flagged: inputs.validation.flagged.map((f) => ({
      message_id: f.message_id,
      markers: [...f.markers],
      role: f.role,
      tags: [...f.tags],
      sentence: 'Addressed to an automated reviewer: flagged, excluded from every count, its instructions not followed. Its text is shown as data.',
    })),
    dates: messages
      .filter((m) => m.date_status !== 'usable')
      .map((m) => ({ message_id: m.id, date_raw: m.date_raw, status: m.date_status, words: dateStatusWords[m.date_status] ?? m.date_status })),
    dedup: inputs.dedup.groups.map((g) => ({ canonical: g.canonical, duplicates: g.duplicates.map((d) => ({ id: d.id, rule: d.rule, recipients_differ: d.recipients_differ })) })),
    gold:
      inputs.gold === null
        ? null
        : {
            sentence:
              inputs.gold.exact.of === 0
                ? 'No hand label was scored.'
                : `${F.count(inputs.gold.exact.agree)} of ${F.plural(inputs.gold.exact.of, 'hand label')} matched exactly (${F.percentTenths(inputs.gold.exact.agree, inputs.gold.exact.of)}).`,
            exact: { ...inputs.gold.exact },
            overlap: { ...inputs.gold.overlap },
            role: { ...inputs.gold.role },
            mismatches: inputs.gold.mismatches.map((m) => ({ id: m.id, label: { processes: [...m.label.processes], role: m.label.role }, extracted: { processes: [...m.extracted.processes], role: m.extracted.role } })),
          },
    estimates,
    run: {
      id: run.id,
      log: run.log,
      later_runs: run.later,
      minutes: run.minutes,
      agents: run.agents,
      fix_rounds: run.fixRounds,
      stages: run.stages,
      synthesizer: { model: inputs.synthesizer.model, effort: inputs.synthesizer.effort },
    },
    words: {
      rounding: [
        'Cents throughout. Whole dollars and hours to one decimal on the page; exact cents one level down.',
        'Each process’s dollars are its counted part’s cents plus its estimated part’s cents, so the rows add up to the total to the cent.',
        'What the page shows adds up, by the largest remainder: each figure gets its whole dollars, and the dollars left over go one each to the figures with the largest cents. The rows in the total share out the headline’s whole dollars this way (the rows below the bar their own total), so the rows add up to the headline and the running total, the sum of the rows above it, ends exactly at it; hours a month are shared out the same way, to one decimal.',
        'Each row’s counted and estimated parts share out that row’s shown dollars, so a row’s parts add up to it; summed down the page, the counted and the estimated columns can differ from the headline’s split by a few dollars.',
        'Where a row’s shown dollars would read as at or over the drafting line while its cents are under it, its status gives the exact cents.',
      ],
      tiers: [
        `In the total: seen ${tierRuleWords('B', scoring.tiers).replace(/^in the total: /, '')}. ${F.plural(ab.length, 'process', 'processes')}.`,
        `Seen steadily: ${tierRuleWords('A', scoring.tiers).replace(/^seen steadily: /, '')}. ${F.plural(rows.filter((r) => r.tier === 'A').length, 'process', 'processes')}.`,
        `Seen too rarely to count: ${F.plural(below.length, 'process', 'processes')}, ${F.money(belowCents, 'total')} a month, listed after the total and not in it.`,
      ],
      threshold: [
        sentences.threshold,
        sentences.sensitivity,
        capGuard(rows, scoring),
      ],
      estimates: [
        'One estimate per process: hands-on minutes a round (low, middle, high) and the share of that work that could be automated.',
        `Proposed once by ${synthName} from ${F.count(b.min_evidence)} to ${F.count(b.max_evidence)} cited quotes from ${F.count(b.min_senders)} or more senders, for a process seen ${F.count(b.min_occurrences)} or more times.`,
        `Checked by code: no more than ${F.plural(b.max_minutes_per_occurrence, 'minute')} a round or ${b.max_automatable_pct}% automatable, every citation real, never one sender alone. Cached, and overridable from a file without a model call.`,
        `${F.plural(estimates.filter((x) => x.source === 'model').length, 'estimate')} accepted, ${F.count(estimates.filter((x) => x.source === 'override').length)} set by the project team, ${F.count(opps.length - estimates.length)} missing.`,
      ],
      identity: [
        `One person’s several addresses fold into one by a published rule, each fold only onto a unique candidate: ${F.plural(foldTotal, 'fold')}, each listed by rule.`,
        `Left apart: ${F.count(left.ambiguous.length)} m..last addresses with several candidates, ${F.count(left.no_initial.length)} with one candidate but no middle initial to confirm it, ${F.count(left.shared_message.length)} refused because the two share a message, ${F.count(left.no_candidate.length)} with no candidate.`,
        `${F.plural(identity.stats.lists, 'distribution list')} and ${F.plural(identity.stats.system, 'system sender')} are never staff.`,
        'A round tagged with two processes is shared between them.',
        `A contradiction in the run’s summaries is dropped when every owner claim it cites names one and the same person: ${F.plural(droppedTotal, 'contradiction')} dropped on this run; the rest are shown beside the claims they cite.`,
      ],
    },
    contradictions_dropped: droppedTotal,
  };

  // ---- run-summary.json ----
  const artCounts = { drafted: 0, exhausted: 0, skipped: 0, failed: 0, pending: 0 };
  for (const a of inputs.artifacts.artifacts) {
    if (a.status === 'done') artCounts.drafted++;
    else if (a.status === 'exhausted') artCounts.exhausted++;
    else if (a.status === 'skipped') artCounts.skipped++;
    else if (a.status === 'failed') artCounts.failed++;
    else artCounts.pending++;
  }
  const summary: RunSummary = {
    version: 1,
    run: { id: run.id, later_runs: run.later.map((r) => r.id), wall_seconds: run.minutes?.v ?? null, agents: Object.fromEntries(run.agents.map((a) => [a.type, a.count])), fix_rounds: run.fixNum?.v ?? 0 },
    quotes: { exact: q.exact, repaired: q.repaired, rejected: q.rejected },
    merge: { ...mergeCounts },
    estimates: { accepted: estimates.filter((x) => x.source === 'model').length, missing: opps.length - estimates.length, overridden: estimates.filter((x) => x.source === 'override').length },
    folds: { ...identity.stats.folds },
    headline: { total_cents: h.total, counted_cents: h.counted_email, estimated_cents: h.estimated_work, low_cents: h.low, high_cents: h.high, all_tiers_cents: all.total, hours_x100: h.hours_x100.automatable },
    artifacts: artCounts,
    coverage: Object.fromEntries(BUCKETS.map((x) => [x, buckets[x].length])) as Record<CoverageBucket, number>,
    loops: { all: loops.length, recent: recentLoops.length },
    contradictions_dropped: droppedTotal,
  };

  return { data, method, processes, index, loops, summary };
}

const sumOf2 = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

// "the synthesizer agent (model opus, effort medium, set in its agent definition)": read from the
// agent's frontmatter, never written here.
export function describeSynthesizer(s: { model: string | null; effort: string | null }): string {
  const parts = [s.model === null ? null : `model ${s.model}`, s.effort === null ? null : `effort ${s.effort}`].filter((x): x is string => x !== null);
  return parts.length === 0 ? 'the synthesizer agent' : `the synthesizer agent (${parts.join(', ')}, set in its agent definition)`;
}

// Whether the cap or the minimum of the drafting rule bound this run, in words.
export function capGuard(rows: readonly Row[], scoring: Scoring): string {
  const { cap, floor, min_automatable_cents: bar } = scoring.artifacts;
  const ab = rows.filter((r) => r.in_total);
  const over = ab.filter((r) => bar === null || r.total.v >= bar).length;
  const capBound = over > cap;
  const minBound = over < floor;
  const rule = `The cap of ${F.plural(cap, 'document')} and the minimum of ${F.count(floor)} are run-time guards`;
  if (!capBound && !minBound) return `${rule}; neither bound this run.`;
  if (capBound) return `${rule}; the cap bound this run: ${F.count(over)} processes cleared the bar and the first ${F.count(cap)} were drafted.`;
  return `${rule}; the minimum bound this run: ${F.count(over)} cleared the bar, so the top ${F.count(floor)} in the total were drafted.`;
}

// ---- Run facts (section 3.6): from the run logs of the span (src/report/build.ts runSpanOf) ----

type RunFacts = {
  id: string | null; // the cold run's
  log: string | null;
  later: Array<{ id: string; log: string }>;
  minutes: Num | null;
  agentsNum: Num | null;
  fixNum: Num | null;
  laterNum: Num | null;
  agents: Array<{ type: string; count: number }>;
  fixRounds: Array<{ job: string; rounds: number }>;
  stages: Array<{ name: string; ms: number; summary: string }>;
};

// Milliseconds of a log timestamp ("2026-10-19T00:19:24.279Z"), by its parts.
function tsMs(ts: unknown): number | null {
  if (typeof ts !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(ts)) return null;
  const frac = /\.(\d{1,3})Z$/.exec(ts)?.[1] ?? '0';
  return utcMs(ts) + Number(frac.padEnd(3, '0'));
}

// The facts of the span: the agents and the fix rounds summed over its runs, the minutes as the sum
// over its runs of each run's first event to its last step of work (so the wait between a stopped
// run and its resume is not counted), the stage steps in order. Each log is cut after its last step
// of work and holds no build event, so a build during the run and one after it write the same facts.
export function runFacts(span: RunSpan | null): RunFacts {
  const [cold, ...later] = span?.runs ?? [];
  if (cold === undefined) return { id: null, log: null, later: [], minutes: null, agentsNum: null, fixNum: null, laterNum: null, agents: [], fixRounds: [], stages: [] };
  const runs = [cold, ...later];
  let ms = 0;
  for (const r of runs) {
    const times = r.events.map((e) => tsMs(e.ts)).filter((t): t is number => t !== null);
    if (times.length >= 2) ms += Math.max(...times) - Math.min(...times);
  }
  const seconds = Math.round(ms / 1000);
  const events = runs.flatMap((r) => r.events);
  const agents = new Map<string, number>();
  for (const e of events) if (e.event === 'SubagentStart') agents.set(String(e.agent_type ?? 'unknown'), (agents.get(String(e.agent_type ?? 'unknown')) ?? 0) + 1);
  const fixes = new Map<string, number>();
  for (const e of events) if (e.event === 'gate' && e.status === 'failed') fixes.set(String(e.batch_id ?? 'unknown'), (fixes.get(String(e.batch_id ?? 'unknown')) ?? 0) + 1);
  const agentList = [...agents].sort(([a], [b]) => byText(a, b)).map(([type, count]) => ({ type, count }));
  const fixList = [...fixes].sort(([a], [b]) => byText(a, b)).map(([job, rounds]) => ({ job, rounds }));
  const nAgents = agentList.reduce((n, a) => n + a.count, 0);
  const nFix = fixList.reduce((n, a) => n + a.rounds, 0);
  const d: Target = { kind: 'method', section: 'run' };
  return {
    id: cold.id,
    log: cold.path,
    later: later.map((r) => ({ id: r.id, log: r.path })),
    minutes: num(seconds, F.minutesOfSeconds(seconds), d, { x: F.plural(seconds, 'second') }),
    agentsNum: countNum(nAgents, d),
    fixNum: countNum(nFix, d),
    laterNum: countNum(later.length, d),
    agents: agentList,
    fixRounds: fixList,
    stages: events.filter((e) => e.event === 'stage').map((e) => ({ name: String(e.name ?? ''), ms: typeof e.ms === 'number' ? e.ms : 0, summary: String(e.summary ?? '') })),
  };
}
