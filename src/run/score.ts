// The score stage (ARCHITECTURE.md 4 stage 11, 5.4, 7.2 step 8):
//   node obs.mjs score                        writes out/opportunities.json
//   node obs.mjs score --rates <file>         re-scores with other per-action rates, no model call
//   node obs.mjs score --estimates <file>     re-scores with other work estimates, no model call
// A re-score writes out/opportunities.<name>.json (the files' names) and leaves the run's own file
// alone. config/estimates.json, when present, applies by default (labelled override). Reads the
// current rollup, the done groups' validated syntheses and the config; the arithmetic is
// src/metrics/score.ts. Always reruns; out/opportunities.json records its input hashes, so
// `status` can tell whether it is current.
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { ConfigError, loadEffortRates, loadEstimatesOverride, loadScoring, type EffortRates } from '../config.ts';
import { score } from '../metrics/score.ts';
import { sha256 } from '../util/hash.ts';
import { normalizeNewlines } from '../util/text.ts';
import { LedgerError, batchViews, fileSha, logStage, opportunitiesFile, readText, rollupFile, synthIndexFile, validatedFile, withoutRoot, writeJsonAtomic, type BatchView } from './ledger.ts';
import { rollupFreshness } from './rollup.ts';
import type { EstimatesOverride, Opportunities, Rollup, ValidatedSynthesis } from '../types.ts';

export type ScoreFreshness = 'current' | 'stale' | 'missing';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const scoringFile = (root: string): string => join(root, 'config', 'scoring.json');
export const estimatesFile = (root: string): string => join(root, 'config', 'estimates.json');
const baseRatesFile = (root: string): string => join(root, 'config', 'effort-rates.json');

// ---- Freshness ----

// What the score reads of the synthesis stage: every group in index order with its status, and a
// done group's validated file, newline-normalised. No index yet (views null) hashes as "none".
export function synthesisSha(root: string, views?: readonly BatchView[] | null): string {
  let groups: readonly BatchView[];
  try {
    if (views === null) return sha256('none');
    groups = views ?? batchViews(root, 'synth');
  } catch {
    return sha256('none');
  }
  const lines = groups.map((v) => {
    const body = v.status === 'done' ? sha256(normalizeNewlines(readText(validatedFile(root, v.entry.id)) ?? '')) : v.status;
    return `${v.entry.id}\n${body}\n`;
  });
  return sha256(lines.join(''));
}

// current: out/opportunities.json records the rollup, the synthesis, the rates, the scoring
// config and the default estimates override as they are now.
export function scoreFreshness(root: string, synthesis?: string): ScoreFreshness {
  try {
    const text = readText(opportunitiesFile(root));
    if (text === null) return 'missing';
    const opp: unknown = JSON.parse(text);
    if (!isRecord(opp) || !isRecord(opp.inputs)) return 'stale';
    const now: Record<string, string | null> = {
      rollup_sha: fileSha(rollupFile(root)) ?? sha256('none'),
      synthesis_sha: synthesis ?? synthesisSha(root),
      rates_sha: fileSha(baseRatesFile(root)) ?? sha256('none'),
      scoring_sha: fileSha(scoringFile(root)) ?? sha256('none'),
      estimates_sha: fileSha(estimatesFile(root)),
    };
    for (const [k, v] of Object.entries(now)) if (opp.inputs[k] !== v) return 'stale';
    return 'current';
  } catch {
    return 'stale';
  }
}

// ---- The command ----

export class ScoreError extends Error {
  override name = 'ScoreError';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (c: number): string => `$${Math.floor(c / 100).toLocaleString('en-US')}.${String(c % 100).padStart(2, '0')}`;

// A Windows-safe name part from a file name: lowercase letters, digits and hyphens.
const namePart = (file: string): string =>
  basename(file)
    .replace(/\.json$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'alt';

function parseArgs(args: readonly string[]): { rates: string | null; estimates: string | null } {
  const out = { rates: null as string | null, estimates: null as string | null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const value = args[i + 1];
    if ((a === '--rates' || a === '--estimates') && value !== undefined && !value.startsWith('--')) {
      out[a === '--rates' ? 'rates' : 'estimates'] = value;
      i++;
      continue;
    }
    throw new ScoreError(`unexpected argument "${a}". Usage: node obs.mjs score [--rates <file>] [--estimates <file>]`);
  }
  return out;
}

// The alternative rates may change minutes and automatable shares only: what decides how a message
// is counted (the length buckets, the read cap, who is staff, which senders are systems) was fixed
// when the rollup counted.
function sameCounting(base: EffortRates, alt: EffortRates): boolean {
  return (
    base.read_cap_per_message === alt.read_cap_per_message &&
    base.own_chars_buckets.short_max === alt.own_chars_buckets.short_max &&
    base.own_chars_buckets.medium_max === alt.own_chars_buckets.medium_max &&
    JSON.stringify(base.priced_domains) === JSON.stringify(alt.priced_domains) &&
    JSON.stringify(base.system_senders) === JSON.stringify(alt.system_senders)
  );
}

// What a score says: the headline line, and notes about groups not done and overrides that cannot
// apply, one line each.
export type ScoreResult = { summary: string; notes: string[] };

// The score stage's one step, as `score` and `advance` take it: price every process with the
// published rates and the default estimates override, write out/opportunities.json, and return the
// headline line and the notes (the command prints them to stderr, advance lists them in its steps,
// so nothing reaches stderr ahead of advance's JSON). Throws ScoreError, ConfigError or
// LedgerError, each one line for the caller to print.
export function scoreStep(root: string): ScoreResult {
  const started = performance.now();
  const result = runScore(root, { rates: null, estimates: null });
  logStage(root, 'score', started, result.summary);
  return result;
}

export function scoreCommand(root: string, args: string[]): number {
  try {
    const opts = parseArgs(args);
    const { summary, notes } = opts.rates === null && opts.estimates === null ? scoreStep(root) : runScore(root, opts);
    for (const note of notes) console.error(note);
    console.log(summary);
    return 0;
  } catch (err) {
    if (err instanceof ScoreError || err instanceof ConfigError || err instanceof LedgerError) {
      console.error(`score: ${withoutRoot(err.message, root).replace(/\s*\n\s*/g, ' ')}`);
      return 1;
    }
    throw err;
  }
}

// A score with these rates and estimates (null: the defaults), written to out/opportunities.json
// or, for another file, out/opportunities.<name>.json. Notes about groups not done and overrides
// that cannot apply are returned as notes, beside the headline line.
function runScore(root: string, opts: { rates: string | null; estimates: string | null }): ScoreResult {
  const notes: string[] = [];
  const fromCwd = (f: string) => (isAbsolute(f) ? f : resolve(process.cwd(), f));
  // Repo-relative; a file outside the repo by its name only (the output may be committed).
  const rel = (f: string) => {
    const r = withoutRoot(f, root).replaceAll('\\', '/');
    return isAbsolute(r) || /^[A-Za-z]:\//.test(r) ? basename(f) : r;
  };
  const rollupState = rollupFreshness(root);
  if (rollupState !== 'current') throw new ScoreError(`out/rollup.json is ${rollupState === 'missing' ? 'missing' : 'not current'}: run node obs.mjs rollup first.`);
  const rollup = JSON.parse(readText(rollupFile(root)) as string) as Rollup;

  const base = loadEffortRates(baseRatesFile(root));
  const ratesPath = opts.rates === null ? baseRatesFile(root) : fromCwd(opts.rates);
  const rates = opts.rates === null ? base : loadEffortRates(ratesPath);
  if (!sameCounting(base, rates)) {
    throw new ScoreError(
      `${rel(ratesPath)} changes how actions are counted (length buckets, read cap, priced domains or system senders), which the rollup fixed: --rates may change minutes and automatable shares only. ` +
        'To count differently, change config/effort-rates.json and run node obs.mjs rollup.',
    );
  }
  const scoring = loadScoring(scoringFile(root));
  const estimatesPath = opts.estimates !== null ? fromCwd(opts.estimates) : existsSync(estimatesFile(root)) ? estimatesFile(root) : null;
  if (estimatesPath !== null && !existsSync(estimatesPath)) throw new ScoreError(`${rel(estimatesPath)} does not exist.`);
  const estimates: EstimatesOverride | null = estimatesPath === null ? null : loadEstimatesOverride(estimatesPath, scoring.estimates);

  // The done groups' syntheses; the processes of any other group are scored without one.
  const groups = existsSync(synthIndexFile(root)) ? batchViews(root, 'synth') : null;
  const done = (groups ?? []).filter((v) => v.status === 'done');
  const synthesis = done.map((v) => JSON.parse(readText(validatedFile(root, v.entry.id)) as string) as ValidatedSynthesis);
  const open = (groups ?? []).filter((v) => v.status !== 'done' && v.status !== 'exhausted').map((v) => v.entry.id);
  if (open.length > 0) notes.push(`score: ${plural(open.length, 'synthesis group is', 'synthesis groups are')} not done (${open.join(', ')}); their processes are scored without a synthesis.`);

  // Overrides that cannot apply are said out loud, one line each.
  const seen = new Map(rollup.processes.map((p) => [p.key, p.occurrences]));
  for (const k of Object.keys(estimates?.estimates ?? {})) {
    const n = seen.get(k);
    if (n === undefined) notes.push(`score: ${rel(estimatesPath as string)} names "${k}", which is not a process of this rollup; it is ignored.`);
    else if (n < scoring.estimates.min_occurrences) {
      notes.push(`score: ${rel(estimatesPath as string)} sets an estimate for "${k}", seen ${plural(n, 'time')}; an estimate needs at least ${scoring.estimates.min_occurrences} occurrences, so it is ignored.`);
    }
  }

  const result: Opportunities = score({
    rollup,
    synthesis,
    rates,
    scoring,
    estimates,
    files: { rates: rel(ratesPath), estimates: estimatesPath === null ? null : rel(estimatesPath) },
    shas: {
      rollup_sha: fileSha(rollupFile(root)) ?? sha256('none'),
      synthesis_sha: synthesisSha(root, groups),
      rates_sha: fileSha(ratesPath) ?? sha256('none'),
      scoring_sha: fileSha(scoringFile(root)) ?? sha256('none'),
      estimates_sha: estimatesPath === null ? null : fileSha(estimatesPath),
    },
  });
  const names = [...(opts.rates === null ? [] : [namePart(opts.rates)]), ...(opts.estimates === null ? [] : [namePart(opts.estimates)])];
  const out = names.length === 0 ? opportunitiesFile(root) : join(root, 'out', `opportunities.${names.join('.')}.json`);
  writeJsonAtomic(out, result);

  const h = result.headline;
  const tiers = { A: 0, B: 0, C: 0 };
  for (const o of result.opportunities) tiers[o.tier]++;
  const missing = result.opportunities.filter((o) => o.estimated === null).length;
  const summary =
    `score: tiers A+B ${money(h.tiers_ab_cents.total)}/mo automatable (counted email ${money(h.tiers_ab_cents.counted_email)} + estimated work ${money(h.tiers_ab_cents.estimated_work)}), ` +
    `all tiers ${money(h.all_tiers_cents.total)}/mo, ${h.label}; ${plural(result.opportunities.length, 'opportunity', 'opportunities')} ` +
    `(${tiers.A} A, ${tiers.B} B, ${tiers.C} C); ${plural(missing, 'estimate')} missing; wrote ${rel(out)}.`;
  return { summary, notes };
}
