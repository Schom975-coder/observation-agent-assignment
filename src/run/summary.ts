// `node obs.mjs summary`: the run facts NOTES.md is written from, as plain labelled lines (or, with
// --json, the RunFactsReport). The figures are out/run-summary.json's, which `build` writes from the
// same data the dashboard shows, so the two cannot disagree; nothing here computes a second wall
// time, agent count or fix-round total. Beside them, a timeline of the stages read from the run
// logs of the run facts' span (src/report/build.ts runSpanOf), by the event names the code writes:
//   prepare            `prepare` (src/pipeline/prepare.ts), with its ms and whether it skipped
//   a stage step       `stage` with its name and ms (logStage, buildStep): taxonomy prompt and
//                      accept, merge prompt and accept, rollup, score, artifacts prepare and collect,
//                      build, run end
//   a hand-out         `advance` with stage_after and the number of agents it returned
//                      (src/run/commands.ts)
//   an agent           SubagentStart and SubagentStop with agent_type (.claude/hooks/log-event.ts);
//                      guard_* with agent_type and batch_id (.claude/hooks/guard-corpus.ts)
//   a verdict          `gate` with batch_id and status (.claude/hooks/gate-subagent.ts); the
//                      `recorded` list of an advance, and of a run start (the jobs an earlier
//                      session left running, stamped then)
// Every time comes from the logs (no clock is read); dates go through the UTC helpers, never the
// built-in date parser.
import { join } from 'node:path';
import { runSpanOf } from '../report/build.ts';
import { runFacts, type RunSpan } from '../report/data.ts';
import { count, hundredths, money, plural } from '../report/format.ts';
import type { RunSummary } from '../report/types.ts';
import { utcMs } from '../util/time.ts';
import { readText } from './ledger.ts';

export type StageTiming = { stage: string; seconds: number; jobs: number; agents: number; fix_rounds: number };
export type RunFactsReport = { summary: RunSummary; stages: StageTiming[]; logs: string[] };

export class SummaryError extends Error {
  override name = 'SummaryError';
}

export const SUMMARY_FILE = 'out/run-summary.json';
export const SUMMARY_MISSING = `${SUMMARY_FILE} is missing: run node obs.mjs build first.`;

// The pipeline's stages, in order. The artifacts step (briefs and collection) is part of drafting.
export const STAGES = ['prepare', 'taxonomy', 'extraction', 'merge', 'rollup', 'synthesis', 'score', 'drafting', 'build'] as const;
type StageName = (typeof STAGES)[number];

// A stage step's name (logStage, buildStep) -> its stage; `run end` belongs to none.
const STEP_STAGE: Readonly<Record<string, StageName>> = {
  'taxonomy prompt': 'taxonomy',
  'taxonomy accept': 'taxonomy',
  'merge prompt': 'merge',
  'merge accept': 'merge',
  rollup: 'rollup',
  score: 'score',
  'artifacts prepare': 'drafting',
  'artifacts collect': 'drafting',
  build: 'build',
};
// An agent type -> the stage it works in.
const AGENT_STAGE: Readonly<Record<string, StageName>> = { taxonomist: 'taxonomy', extractor: 'extraction', merger: 'merge', synthesizer: 'synthesis', drafter: 'drafting' };
// A ledger job's ID prefix -> its stage.
const JOB_STAGE: Readonly<Record<string, StageName>> = { batch: 'extraction', synth: 'synthesis', draft: 'drafting' };
// The stage `advance` reports after handing agents out (src/run/commands.ts Stage) -> the stage.
const ADVANCE_STAGE: Readonly<Record<string, StageName>> = { taxonomy: 'taxonomy', extraction: 'extraction', merge: 'merge', synthesis: 'synthesis', artifacts: 'drafting', drafting: 'drafting' };

type Event = Readonly<Record<string, unknown>>;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const jobStage = (id: unknown): StageName | null => {
  const m = typeof id === 'string' ? /^(batch|synth|draft)-\d{3,6}$/.exec(id) : null;
  return m === null ? null : (JOB_STAGE[m[1] as string] as StageName);
};

// The stage an event belongs to, or null (the run start, the Stop hook, the claim, an advance that
// handed nothing out, the run end).
function stageOf(e: Event): StageName | null {
  switch (e.event) {
    case 'prepare':
      return 'prepare';
    case 'stage':
      return STEP_STAGE[str(e.name) ?? ''] ?? null;
    case 'advance':
      return typeof e.agents === 'number' && e.agents > 0 ? (ADVANCE_STAGE[str(e.stage_after) ?? ''] ?? null) : null;
    default:
      return jobStage(e.batch_id) ?? AGENT_STAGE[str(e.agent_type) ?? ''] ?? null;
  }
}

// Milliseconds of a log timestamp ("2026-10-19T00:19:24.279Z"), from its parts; null for anything else.
function tsMs(ts: unknown): number | null {
  if (typeof ts !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(ts)) return null;
  return utcMs(ts) + Number((/\.(\d{1,3})Z$/.exec(ts)?.[1] ?? '0').padEnd(3, '0'));
}

// When an event's work happened: a step that logs its duration (`prepare`, `stage`) ran for its ms
// before it was logged; anything else is the moment it was logged.
function interval(e: Event): { from: number; to: number } | null {
  const to = tsMs(e.ts);
  if (to === null) return null;
  const ms = (e.event === 'prepare' || e.event === 'stage') && typeof e.ms === 'number' && Number.isFinite(e.ms) && e.ms >= 0 ? e.ms : 0;
  return { from: to - ms, to };
}

// Each stage's milliseconds in one run: from its first event's start to its last event's end.
function stageMs(events: readonly Event[]): Map<StageName, number> {
  const spans = new Map<StageName, { from: number; to: number }>();
  for (const e of events) {
    const stage = stageOf(e);
    const at = stage === null ? null : interval(e);
    if (stage === null || at === null) continue;
    const s = spans.get(stage);
    spans.set(stage, s === undefined ? at : { from: Math.min(s.from, at.from), to: Math.max(s.to, at.to) });
  }
  return new Map([...spans].map(([stage, s]) => [stage, s.to - s.from]));
}

// A run log read whole, torn lines skipped.
function wholeLog(root: string, path: string): Event[] {
  const events: Event[] = [];
  for (const line of (readText(join(root, path)) ?? '').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const e: unknown = JSON.parse(line);
      if (isRecord(e)) events.push(e);
    } catch {
      // a torn line is skipped
    }
  }
  return events;
}

// The jobs a stage completed: ledger jobs with a done verdict (a gate's, or one an advance or a run
// start recorded), each once over the whole span (`done` is shared by the span's runs); accepted
// taxonomy and merge proposals; steps run (a prepare that did not skip itself, a rollup, a score,
// a build). A job checked by hand with `validate` leaves no log line and is not counted.
function stageJobs(events: readonly Event[], done: Set<string>): Map<StageName, number> {
  const jobs = new Map<StageName, number>();
  const add = (stage: StageName): void => void jobs.set(stage, (jobs.get(stage) ?? 0) + 1);
  const finished = (id: unknown): void => {
    const stage = jobStage(id);
    if (stage === null || done.has(id as string)) return;
    done.add(id as string);
    add(stage);
  };
  for (const e of events) {
    if (e.event === 'gate' && e.status === 'done') finished(e.batch_id);
    if ((e.event === 'advance' || e.event === 'run_start') && Array.isArray(e.recorded)) for (const r of e.recorded) if (isRecord(r) && r.status === 'done') finished(r.id);
    if (e.event === 'prepare' && e.skipped !== true) add('prepare');
    if (e.event !== 'stage') continue;
    const name = str(e.name) ?? '';
    // The accept step's summary says "not accepted" when the proposal was refused (src/run/taxonomy.ts, merge.ts).
    if ((name === 'taxonomy accept' || name === 'merge accept') && !/\bnot accepted\b/.test(str(e.summary) ?? '')) add(STEP_STAGE[name] as StageName);
    if (name === 'rollup' || name === 'score' || name === 'build') add(name as StageName);
  }
  return jobs;
}

// The stage timeline of the span. Agents and the job stages' fix rounds come from runFacts, as the
// run facts' totals do: SubagentStart events by type, and failed gate verdicts by job. The taxonomy's
// and the merge's fix rounds are their prompts after the first. The build's events are not in the
// span (it leaves them out, so a build cannot change the facts it writes), so they are read from the
// span's own logs, whole.
export function stageTimeline(root: string, span: RunSpan | null): StageTiming[] {
  const runs = span?.runs ?? [];
  const facts = runFacts(span);
  const ms = new Map<StageName, number>();
  const jobs = new Map<StageName, number>();
  const addTo = (into: Map<StageName, number>, from: Map<StageName, number>): void => {
    for (const [stage, n] of from) into.set(stage, (into.get(stage) ?? 0) + n);
  };
  const done = new Set<string>();
  for (const r of runs) {
    addTo(ms, stageMs(r.events));
    addTo(jobs, stageJobs(r.events, done));
    const builds = wholeLog(root, r.path).filter((e) => e.event === 'stage' && e.name === 'build');
    addTo(ms, stageMs(builds));
    addTo(jobs, stageJobs(builds, done));
  }
  const agents = new Map<StageName, number>();
  for (const a of facts.agents) {
    const stage = AGENT_STAGE[a.type];
    if (stage !== undefined) agents.set(stage, (agents.get(stage) ?? 0) + a.count);
  }
  const fixes = new Map<StageName, number>();
  for (const f of facts.fixRounds) {
    const stage = jobStage(f.job);
    if (stage !== null) fixes.set(stage, (fixes.get(stage) ?? 0) + f.rounds);
  }
  for (const e of runs.flatMap((r) => r.events)) {
    if (e.event === 'stage' && (e.name === 'taxonomy prompt' || e.name === 'merge prompt') && typeof e.attempt === 'number' && e.attempt > 1) {
      const stage = STEP_STAGE[e.name] as StageName;
      fixes.set(stage, (fixes.get(stage) ?? 0) + 1);
    }
  }
  return STAGES.map((stage) => ({
    stage,
    seconds: Math.round((ms.get(stage) ?? 0) / 100) / 10,
    jobs: jobs.get(stage) ?? 0,
    agents: agents.get(stage) ?? 0,
    fix_rounds: fixes.get(stage) ?? 0,
  }));
}

// ---- out/run-summary.json ----

const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const counts = (v: unknown, keys: readonly string[] | null = null): boolean =>
  isRecord(v) && Object.values(v).every(isCount) && (keys === null || keys.every((k) => isCount(v[k])));

// The file as `build` writes it (src/report/types.ts RunSummary, version 1), or a SummaryError.
export function parseRunSummary(text: string): RunSummary {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SummaryError(`${SUMMARY_FILE} is not valid JSON: run node obs.mjs build again.`);
  }
  const run = isRecord(raw) ? raw.run : null;
  const ok =
    isRecord(raw) &&
    raw.version === 1 &&
    isRecord(run) &&
    (run.id === null || typeof run.id === 'string') &&
    Array.isArray(run.later_runs) &&
    run.later_runs.every((x) => typeof x === 'string') &&
    (run.wall_seconds === null || isCount(run.wall_seconds)) &&
    counts(run.agents) &&
    isCount(run.fix_rounds) &&
    counts(raw.quotes, ['exact', 'repaired', 'rejected']) &&
    counts(raw.merge) &&
    counts(raw.estimates, ['accepted', 'missing', 'overridden']) &&
    counts(raw.folds) &&
    counts(raw.headline, ['total_cents', 'counted_cents', 'estimated_cents', 'low_cents', 'high_cents', 'all_tiers_cents', 'hours_x100']) &&
    counts(raw.artifacts, ['drafted', 'exhausted', 'skipped', 'failed', 'pending']) &&
    counts(raw.coverage) &&
    counts(raw.loops, ['all', 'recent']) &&
    isCount(raw.contradictions_dropped);
  if (!ok) throw new SummaryError(`${SUMMARY_FILE} is not a run summary this version reads: run node obs.mjs build again.`);
  return raw as RunSummary;
}

// Reads out/run-summary.json (written by `build`) and the run logs of the run facts' span
// (src/report/build.ts runSpanOf); null when out/run-summary.json is missing. A file that is not a
// run summary is a SummaryError.
export function runFactsFor(root: string): RunFactsReport | null {
  const text = readText(join(root, SUMMARY_FILE));
  if (text === null) return null;
  const summary = parseRunSummary(text);
  const span = runSpanOf(root);
  return { summary, stages: stageTimeline(root, span), logs: (span?.runs ?? []).map((r) => r.path) };
}

// ---- The lines `node obs.mjs summary` prints ----

// "25 min 12 s", "45 s"; tenths under a minute when there are any ("3.3 s").
function duration(seconds: number): string {
  if (seconds < 60) return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}
// "about $2,050", from cents: whole dollars as the one formatter writes them (src/report/format.ts).
const aboutDollars = (cents: number): string => `about ${money(cents, 'total')}`;
const pairs = (record: Readonly<Record<string, number>>): string =>
  Object.entries(record)
    .map(([k, v]) => `${k} ${count(v)}`)
    .join(', ');
const sum = (record: Readonly<Record<string, number>>): number => Object.values(record).reduce((a, b) => a + b, 0);

const MERGE_KEYS = ['slugs', 'mapped', 'promoted', 'aliases', 'unassigned', 'demoted', 'messages_mapped', 'messages_promoted', 'messages_unassigned'];

function mergeLine(m: Readonly<Record<string, number>>): string {
  if (!MERGE_KEYS.every((k) => isCount(m[k]))) return `Merge: ${pairs(m)}.`;
  const n = (k: string): number => m[k] as number;
  return (
    `Merge: ${plural(n('slugs'), 'proposed key')}: ${count(n('mapped'))} mapped, ${count(n('aliases'))} in ${plural(n('promoted'), 'promoted process', 'promoted processes')}, ` +
    `${count(n('unassigned'))} unassigned, ${count(n('demoted'))} demoted; messages ${count(n('messages_mapped'))} mapped, ${count(n('messages_promoted'))} promoted, ${count(n('messages_unassigned'))} unassigned.`
  );
}

// What a stage's `jobs` counts, in words: one and many.
const STAGE_JOB: Readonly<Record<StageName, [string, string]>> = {
  prepare: ['run', 'runs'],
  taxonomy: ['proposal accepted', 'proposals accepted'],
  extraction: ['batch done', 'batches done'],
  merge: ['proposal accepted', 'proposals accepted'],
  rollup: ['run', 'runs'],
  synthesis: ['group done', 'groups done'],
  score: ['run', 'runs'],
  drafting: ['draft done', 'drafts done'],
  build: ['run', 'runs'],
};

// "  merge       4 min 44 s; 1 proposal accepted; 1 agent": the parts that are not zero.
function stageLine(s: StageTiming, width: number): string {
  const parts = [duration(s.seconds)];
  const job = STAGE_JOB[s.stage as StageName] ?? ['job', 'jobs'];
  if (s.jobs > 0) parts.push(`${count(s.jobs)} ${s.jobs === 1 ? job[0] : job[1]}`);
  if (s.agents > 0) parts.push(plural(s.agents, 'agent'));
  if (s.fix_rounds > 0) parts.push(plural(s.fix_rounds, 'fix round'));
  return `  ${s.stage.padEnd(width)}  ${parts.join('; ')}`;
}

// The lines `node obs.mjs summary` prints: labelled facts a person can read and copy, then the stage
// timeline, one line per stage. No model name: the agents are named by their role.
export function formatRunFacts(r: RunFactsReport): string {
  const s = r.summary;
  const run = s.run;
  const later = run.later_runs.length === 0 ? '' : `, continued in ${plural(run.later_runs.length, 'later run')} (${run.later_runs.join(', ')})`;
  const askedAgain = r.stages.filter((x) => x.stage === 'taxonomy' || x.stage === 'merge').reduce((n, x) => n + x.fix_rounds, 0);
  const h = s.headline;
  const artifacts = [`${count(s.artifacts.drafted)} drafted`, `${count(s.artifacts.exhausted)} exhausted`, `${count(s.artifacts.skipped)} skipped`, `${count(s.artifacts.failed)} failed`];
  if (s.artifacts.pending > 0) artifacts.push(`${count(s.artifacts.pending)} pending`);
  const lines = [
    run.id === null ? 'Run: none (no run log when the summary was built).' : `Run: ${run.id}${later}.`,
    `Wall time: ${run.wall_seconds === null ? 'not measured (no run log)' : duration(run.wall_seconds)}.`,
    `Agents: ${count(sum(run.agents))} in total${Object.keys(run.agents).length === 0 ? '' : `; ${pairs(run.agents)}`}.`,
    `Fix rounds: ${count(run.fix_rounds)} (failed checks of batches, groups and drafts)` +
      (askedAgain === 0 ? '.' : `; the taxonomist and the merger were also asked again ${askedAgain === 1 ? 'once' : `${count(askedAgain)} times`}.`),
    `Quotes: ${count(s.quotes.exact)} exact, ${count(s.quotes.repaired)} repaired, ${count(s.quotes.rejected)} rejected.`,
    mergeLine(s.merge),
    `Estimates: ${count(s.estimates.accepted)} accepted, ${count(s.estimates.missing)} missing, ${count(s.estimates.overridden)} overridden.`,
    `Folds: ${count(sum(s.folds))} in total${Object.keys(s.folds).length === 0 ? '' : `; ${pairs(s.folds)}`}.`,
    `Headline: ${aboutDollars(h.total_cents)} a month automatable in tiers A and B (${count(h.total_cents)} cents: counted email ${count(h.counted_cents)}, ` +
      `estimated work ${count(h.estimated_cents)}); low ${aboutDollars(h.low_cents)}, high ${aboutDollars(h.high_cents)}; all tiers ${aboutDollars(h.all_tiers_cents)}.`,
    `Hours: ${hundredths(h.hours_x100)} a month automatable in tiers A and B.`,
    `Artifacts: ${artifacts.join(', ')}.`,
    `Coverage: ${pairs(s.coverage)} (${count(sum(s.coverage))} messages in all).`,
    `Open loops: ${count(s.loops.all)} in all, ${count(s.loops.recent)} recent.`,
    `Contradictions dropped: ${count(s.contradictions_dropped)}.`,
    `Logs: ${r.logs.length === 0 ? 'none' : r.logs.join(', ')}.`,
    "Stages (each run's first event of the stage to its last, added up over the runs):",
    ...r.stages.map((x) => stageLine(x, Math.max(...r.stages.map((y) => y.stage.length)))),
  ];
  // The logs moved on since the summary was built (a later run did work, or a run went on after
  // the build): the stage lines are read from the logs as they are now, so say so rather than let
  // them disagree with the figures above unremarked.
  const logIds = r.logs.map((p) => p.replace(/^out\/runs\//, '').replace(/\.jsonl$/, ''));
  const built = run.id === null ? [] : [run.id, ...run.later_runs];
  const stageAgents = r.stages.reduce((n, x) => n + x.agents, 0);
  const stageFixes = r.stages.filter((x) => x.stage === 'extraction' || x.stage === 'synthesis' || x.stage === 'drafting').reduce((n, x) => n + x.fix_rounds, 0);
  if (logIds.join(',') !== built.join(',') || stageAgents !== sum(run.agents) || stageFixes !== run.fix_rounds) {
    lines.push(
      `Note: the run logs (${logIds.length === 0 ? 'none' : logIds.join(', ')}) have moved on since ${SUMMARY_FILE} was built, and the stage lines are read from them as they are now; ` +
        'run node obs.mjs build to bring the two together.',
    );
  }
  return lines.join('\n');
}

// `node obs.mjs summary [--json]`.
export function summaryCommand(root: string, args: readonly string[]): number {
  const unknown = args.filter((a) => a !== '--json');
  if (unknown.length > 0) {
    console.error(`summary: unexpected argument "${unknown[0]}". Usage: node obs.mjs summary [--json]`);
    return 1;
  }
  let report: RunFactsReport | null;
  try {
    report = runFactsFor(root);
  } catch (err) {
    if (!(err instanceof SummaryError)) throw err;
    console.error(`summary: ${err.message}`);
    return 1;
  }
  if (report === null) {
    console.error(`summary: ${SUMMARY_MISSING}`);
    return 1;
  }
  console.log(args.includes('--json') ? JSON.stringify(report) : formatRunFacts(report));
  return 0;
}
