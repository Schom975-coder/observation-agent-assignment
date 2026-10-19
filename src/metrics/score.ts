// The score (ARCHITECTURE.md 4.1, 5.4, 6.2): per process, the counted email part (priced actions x
// the published per-action minutes, split by share) plus the estimated work part (counted
// occurrence shares x the checked estimate's mid minutes per occurrence), each per month over the
// counted window, in hours and in cents at $85/hour; tiers from counts only; ranking, the headline
// and the artifact threshold. Every quantity is a whole number of hundredths, rounded once, at the
// end, from integers, so the same inputs give the same bytes on every OS; a row's dollars are its
// two parts' cents added, so the parts shown add up to the total exactly. The model's estimate
// enters the total through two numbers, `mid` and `automatable_pct` (modelEstimate): it multiplies
// counted occurrences and nothing else, and sets no count, tier, rank or threshold. Its `low` and
// `high` minutes give the range shown beside the total, with the automatable share fixed.
import { ACTION_TYPES, type ActionType, type EffortRates, type Scoring } from '../config.ts';
import { stallsByKind } from './rollup.ts';
import { roundHalfUp } from '../util/round.ts';
import type { EstimatesOverride, HeadlineCents, MinutesPair, Opportunities, Opportunity, ProcessRollup, Rollup, Tier, ValidatedSynthesis } from '../types.ts';

export const CENTS_PER_HOUR = 8500; // the brief's $85/hour
export const HEADLINE_LABEL = 'observed in 4 mailboxes, 1999-2002';

// Hundredths of a minute over the window -> hundredths of a minute per month.
export const perMonthX100 = (totalX100: number, monthsX100: number): number => roundHalfUp(totalX100 * 100, monthsX100);
// Hundredths of a minute -> hundredths of an hour.
export const hoursX100 = (minutesX100: number): number => roundHalfUp(minutesX100, 60);
// Hundredths of a minute -> cents at CENTS_PER_HOUR (8500 cents / 6000 hundredths of a minute).
export const cents = (minutesX100: number): number => roundHalfUp(minutesX100 * CENTS_PER_HOUR, 6000);

// A: seen often, over months, by several staff; B: recurring but thin; C: a lead (outside the headline).
export function tierOf(p: Pick<ProcessRollup, 'occurrences' | 'staff_participants'> & { window: Pick<ProcessRollup['window'], 'active_months'> }, scoring: Scoring): Tier {
  for (const tier of ['A', 'B'] as const) {
    const r = scoring.tiers[tier];
    if (p.occurrences >= r.min_occurrences && p.window.active_months >= r.min_active_months && p.staff_participants >= r.min_staff) return tier;
  }
  return 'C';
}

// What score takes from a validated synthesis estimate: the two numbers the arithmetic uses (mid,
// automatable_pct), and what is shown beside them (the range, basis, rationale, the cited ids and
// how many occurrences and senders they come from). Nothing else of the synthesis file is numeric.
export type UsedEstimate = NonNullable<Opportunity['estimated']>;
export function modelEstimate(p: ValidatedSynthesis['processes'][number]): Omit<UsedEstimate, 'work_per_month_x100'> | null {
  const e = p.work_estimate;
  if (e === null) return null;
  return {
    source: 'model',
    minutes_per_occurrence: { low: e.minutes_per_occurrence.low, mid: e.minutes_per_occurrence.mid, high: e.minutes_per_occurrence.high },
    automatable_pct: e.automatable_pct,
    basis: e.basis,
    rationale: e.rationale,
    evidence_ids: [...e.evidence_ids],
    occurrences_cited: p.estimate_check?.occurrences_cited ?? 0,
    senders_cited: p.estimate_check?.senders_cited ?? 0,
  };
}

// E1 again, against the bounds in force now: an estimate validated under other bounds is not used.
const withinBounds = (e: { minutes_per_occurrence: { low: number; mid: number; high: number }; automatable_pct: number }, b: Scoring['estimates']): boolean => {
  const m = e.minutes_per_occurrence;
  return (
    [m.low, m.mid, m.high, e.automatable_pct].every((x) => Number.isInteger(x)) &&
    1 <= m.low &&
    m.low <= m.mid &&
    m.mid <= m.high &&
    m.high <= b.max_minutes_per_occurrence &&
    e.automatable_pct >= 0 &&
    e.automatable_pct <= b.max_automatable_pct
  );
};

// ---- Formatting: hundredths shown as numbers, "4,657.50" ----

const x100 = (n: number): string => `${Math.floor(n / 100).toLocaleString('en-US')}.${String(n % 100).padStart(2, '0')}`;
const dollars = (c: number): string => `$${x100(c)}`;
const SHORT_NAMES: Record<ActionType, string> = { authored_short: 'short', authored_medium: 'medium', authored_long: 'long', forward: 'fwd', chaser: 'chaser', read: 'read' };

// "104 occ (103.50 after sharing) over 241 d = 7.92 mo; email: 12 short x2 + ... = 338.00 min =
// 42.68 min/mo; automatable 60/40/30/80/100/50% = 154.30 min = 19.48 min/mo"
function countedFormula(p: ProcessRollup, rates: EffortRates, email: MinutesPair, perMonth: MinutesPair): string {
  const w = p.window;
  const sharing = p.occurrence_share_x100 === p.occurrences * 100 ? '' : ` (${x100(p.occurrence_share_x100)} after sharing)`;
  const span = w.first_utc === null ? 'no usable dates, counted as' : `over ${w.span_days.toLocaleString('en-US')} d =`;
  const terms = ACTION_TYPES.map((t) => `${p.actions.priced[t]} ${SHORT_NAMES[t]} x${rates.minutes[t]}`).join(' + ');
  // The plain sum of count x minutes, and what the shares make of it when they differ.
  const unshared = ACTION_TYPES.reduce((n, t) => n + p.actions.priced[t] * rates.minutes[t] * 100, 0);
  const unsharedAuto = roundHalfUp(ACTION_TYPES.reduce((n, t) => n + p.actions.priced[t] * rates.minutes[t] * rates.automatable_pct[t] * 100, 0), 100);
  const total = (plain: number, shared: number) => (plain === shared ? `${x100(shared)} min` : `${x100(plain)} min, ${x100(shared)} min after sharing`);
  const pcts = ACTION_TYPES.map((t) => rates.automatable_pct[t]).join('/');
  return (
    `${p.occurrences.toLocaleString('en-US')} occ${sharing} ${span} ${x100(w.months_x100)} mo; email: ${terms} = ${total(unshared, email.today)} = ${x100(perMonth.today)} min/mo; ` +
    `automatable ${pcts}% = ${total(unsharedAuto, email.automatable)} = ${x100(perMonth.automatable)} min/mo`
  );
}

// "103.50 occ x 45 min/occ (estimate, mid of 30-60, basis observed, 6 quotes from 5 occurrences) =
// 4,657.50 min = 588.07 min/mo; automatable 60% (estimate) = 352.84 min/mo; at the low end 30
// min/occ = $360.84/mo, at the high end 60 min/occ = $694.07/mo (the row's automatable total)"
function estimatedFormula(p: ProcessRollup, e: UsedEstimate, work: number, file: string | null, range: { low: number; high: number }): string {
  const m = e.minutes_per_occurrence;
  const what =
    e.source === 'model'
      ? `estimate, mid of ${m.low}-${m.high}, basis ${e.basis}, ${e.evidence_ids.length} quotes from ${e.occurrences_cited} occurrences`
      : `override, mid of ${m.low}-${m.high}, from ${file ?? 'the estimates file'}`;
  const label = e.source === 'model' ? 'estimate' : 'override';
  return (
    `${x100(p.occurrence_share_x100)} occ x ${m.mid} min/occ (${what}) = ${x100(work)} min = ${x100(e.work_per_month_x100.today)} min/mo; ` +
    `automatable ${e.automatable_pct}% (${label}) = ${x100(e.work_per_month_x100.automatable)} min/mo; ` +
    `at the low end ${m.low} min/occ = ${dollars(range.low)}/mo, at the high end ${m.high} min/occ = ${dollars(range.high)}/mo (the row's automatable total)`
  );
}

// "today 630.75 min/mo = 10.51 h/mo = $893.56/mo (email 42.68 min/mo = $60.46 + work 588.07 min/mo =
// $833.10); automatable 372.32 min/mo = 6.21 h/mo = $527.46/mo (counted email 19.48 min/mo = $27.60
// + estimated work 352.84 min/mo = $499.86)": the dollars part by part, so a hand check runs on the
// parts, which add up to the total exactly.
function totalFormula(perMonth: MinutesPair, hours: MinutesPair, money: MinutesPair, emailPm: MinutesPair, workPm: MinutesPair | null): string {
  const parts = (email: number, work: number | null, emailLabel: string, workLabel: string) =>
    `${emailLabel} ${x100(email)} min/mo = ${dollars(cents(email))}` +
    (work === null ? '; no work estimate' : ` + ${workLabel} ${x100(work)} min/mo = ${dollars(cents(work))}`);
  return (
    `today ${x100(perMonth.today)} min/mo = ${x100(hours.today)} h/mo = ${dollars(money.today)}/mo (${parts(emailPm.today, workPm?.today ?? null, 'email', 'work')}); ` +
    `automatable ${x100(perMonth.automatable)} min/mo = ${x100(hours.automatable)} h/mo = ${dollars(money.automatable)}/mo ` +
    `(${parts(emailPm.automatable, workPm?.automatable ?? null, 'counted email', 'estimated work')})`
  );
}

export type ScoreInputs = {
  rollup: Rollup;
  synthesis: readonly ValidatedSynthesis[]; // the done groups
  rates: EffortRates;
  scoring: Scoring;
  estimates: EstimatesOverride | null;
  files: { rates: string; estimates: string | null }; // repo-relative, for the record and the formulas
  shas: Opportunities['inputs'];
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function score(inputs: ScoreInputs): Opportunities {
  const { rollup, rates, scoring, estimates } = inputs;
  const synthesized = new Map<string, ValidatedSynthesis['processes'][number]>();
  for (const g of inputs.synthesis) for (const p of g.processes) synthesized.set(p.key, p);
  const bounds = scoring.estimates;

  const scored = rollup.processes.map((p) => {
    // The counted email part, re-priced from the action sources at these rates.
    let today = 0;
    let auto = 0;
    for (const s of p.action_sources) {
      if (!s.priced) continue;
      today += rates.minutes[s.type] * s.share_x100;
      auto += rates.minutes[s.type] * rates.automatable_pct[s.type] * s.share_x100;
    }
    const email: MinutesPair = { today, automatable: roundHalfUp(auto, 100) };
    const emailPm: MinutesPair = { today: perMonthX100(email.today, p.window.months_x100), automatable: perMonthX100(email.automatable, p.window.months_x100) };

    // The estimate: the override file's for the keys it names, else the validated model's; none
    // for a process seen fewer than min_occurrences times, or outside the bounds in force.
    const synth = synthesized.get(p.key);
    const flags = [...p.flags];
    // An own property only: a process key such as "constructor" must not find Object.prototype.
    const override = estimates !== null && Object.hasOwn(estimates.estimates, p.key) ? estimates.estimates[p.key] : undefined;
    let chosen: Omit<UsedEstimate, 'work_per_month_x100'> | null = null;
    if (p.occurrences >= bounds.min_occurrences) {
      if (override !== undefined && withinBounds(override, bounds)) {
        chosen = {
          source: 'override',
          minutes_per_occurrence: { ...override.minutes_per_occurrence },
          automatable_pct: override.automatable_pct,
          basis: 'override',
          rationale: override.rationale,
          evidence_ids: [],
          occurrences_cited: 0,
          senders_cited: 0,
        };
      } else if (synth !== undefined) {
        const model = modelEstimate(synth);
        if (model !== null && withinBounds(model, bounds)) chosen = model;
      }
    }
    if (synth === undefined) flags.push('synthesis_missing');
    if (chosen === null) flags.push('estimate_missing');
    else if (chosen.source === 'override') flags.push('estimate_override');

    // The work part at `minutes` per occurrence (none without an estimate): the whole window, and
    // per month today and automatable.
    const workAt = (minutes: keyof UsedEstimate['minutes_per_occurrence']): { work: number; pm: MinutesPair } => {
      if (chosen === null) return { work: 0, pm: { today: 0, automatable: 0 } };
      const work = p.occurrence_share_x100 * chosen.minutes_per_occurrence[minutes];
      return { work, pm: { today: perMonthX100(work, p.window.months_x100), automatable: perMonthX100(roundHalfUp(work * chosen.automatable_pct, 100), p.window.months_x100) } };
    };
    const { work, pm: workPm } = workAt('mid');
    const estimated: Opportunity['estimated'] = chosen === null ? null : { ...chosen, work_per_month_x100: workPm };
    const perMonth: MinutesPair = { today: emailPm.today + workPm.today, automatable: emailPm.automatable + workPm.automatable };
    const hours: MinutesPair = { today: hoursX100(perMonth.today), automatable: hoursX100(perMonth.automatable) };
    // The dollars are the two parts' cents added, so the parts shown add up to the total exactly.
    const money: MinutesPair = { today: cents(emailPm.today) + cents(workPm.today), automatable: cents(emailPm.automatable) + cents(workPm.automatable) };
    // The range: the estimate at its low and at its high minutes, the automatable share fixed; with
    // no estimate both ends are the email part.
    const [low, high] = [workAt('low').pm.automatable, workAt('high').pm.automatable];
    const range_per_month_x100 = { low: emailPm.automatable + low, high: emailPm.automatable + high };
    const range_cents = { low: cents(emailPm.automatable) + cents(low), high: cents(emailPm.automatable) + cents(high) };
    const opportunity: Opportunity = {
      rank: 0,
      key: p.key,
      name: p.name,
      origin: p.origin,
      tier: tierOf(p, scoring),
      counted: {
        occurrences: p.occurrences,
        occurrence_share_x100: p.occurrence_share_x100,
        shared_occurrences: p.shared_occurrences,
        window: { ...p.window },
        staff_participants: p.staff_participants,
        participants: p.participants,
        actions: p.actions,
        email_x100: email,
        email_per_month_x100: emailPm,
        reply_gap: { n: p.reply_gap_n, median_h: p.median_reply_gap_h },
      },
      estimated,
      per_month_x100: perMonth,
      hours_per_month_x100: hours,
      dollars_per_month_cents: money,
      range_per_month_x100,
      range_cents,
      formula: {
        counted: countedFormula(p, rates, email, emailPm),
        estimated: estimated === null ? null : estimatedFormula(p, estimated, work, inputs.files.estimates, range_cents),
        total: totalFormula(perMonth, hours, money, emailPm, estimated === null ? null : workPm),
      },
      rates_sha: inputs.shas.rates_sha,
      scoring_sha: inputs.shas.scoring_sha,
      estimates_sha: inputs.shas.estimates_sha,
      synthesis:
        synth === undefined
          ? null
          : {
              description: synth.description,
              steps: [...synth.steps],
              stalls: synth.stalls.map((s) => ({ summary: s.summary, evidence_ids: [...s.evidence_ids] })),
              contradictions: synth.contradictions.map((s) => ({ summary: s.summary, evidence_ids: [...s.evidence_ids] })),
              automation: { ...synth.automation },
            },
      stalls_counted: stallsByKind(p.stalls),
      ownership_conflicts: p.ownership_conflicts,
      evidence_ids: p.evidence_ids,
      artifact: null,
      artifact_eligible: false,
      flags,
    };
    return { opportunity, emailCents: cents(emailPm.automatable), workCents: cents(workPm.automatable) };
  });

  // Ranked by automatable cents, ties by key.
  scored.sort((a, b) => b.opportunity.dollars_per_month_cents.automatable - a.opportunity.dollars_per_month_cents.automatable || byText(a.opportunity.key, b.opportunity.key));
  scored.forEach((s, i) => (s.opportunity.rank = i + 1));

  // The artifact threshold: tier A or B, at or over the bar (none when it is null), at most `cap`;
  // at least `floor` of the top A/B processes whatever the bar.
  const { min_automatable_cents: bar, cap, floor } = scoring.artifacts;
  const candidates = scored.map((s) => s.opportunity).filter((o) => o.tier !== 'C');
  const over = candidates.filter((o) => bar === null || o.dollars_per_month_cents.automatable >= bar).slice(0, cap);
  for (const o of over.length >= floor ? over : candidates.slice(0, floor)) o.artifact_eligible = true;

  // Sums over the rows: the total is the counted email plus the estimated work, exactly.
  const sum = (rows: typeof scored, of: (s: (typeof scored)[number]) => number): number => rows.reduce((n, s) => n + of(s), 0);
  const headline = (rows: typeof scored): HeadlineCents => ({
    total: sum(rows, (s) => s.opportunity.dollars_per_month_cents.automatable),
    counted_email: sum(rows, (s) => s.emailCents),
    estimated_work: sum(rows, (s) => s.workCents),
    low: sum(rows, (s) => s.opportunity.range_cents.low),
    high: sum(rows, (s) => s.opportunity.range_cents.high),
    today: sum(rows, (s) => s.opportunity.dollars_per_month_cents.today),
    hours_x100: { today: sum(rows, (s) => s.opportunity.hours_per_month_x100.today), automatable: sum(rows, (s) => s.opportunity.hours_per_month_x100.automatable) },
  });
  return {
    version: 1,
    inputs: inputs.shas,
    rates_file: inputs.files.rates,
    estimates_file: inputs.files.estimates,
    headline: { label: HEADLINE_LABEL, tiers_ab_cents: headline(scored.filter((s) => s.opportunity.tier !== 'C')), all_tiers_cents: headline(scored) },
    opportunities: scored.map((s) => s.opportunity),
    unassigned: { messages: rollup.unassigned.messages, slugs: rollup.unassigned.slugs.length },
  };
}
