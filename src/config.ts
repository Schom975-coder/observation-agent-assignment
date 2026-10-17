// Loads and checks the published config files: the effort rates, the scoring rules and the optional
// estimates override. Every number in the headline traces back to these files, so a malformed value
// stops the run with a clear message.
import { readFileSync } from 'node:fs';
import type { EstimatesOverride } from './types.ts';

export const ACTION_TYPES = [
  'authored_short',
  'authored_medium',
  'authored_long',
  'forward',
  'chaser',
  'read',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export type EffortRates = {
  version: number;
  minutes: Record<ActionType, number>;
  automatable_pct: Record<ActionType, number>;
  rationale: Record<ActionType, string>;
  read_cap_per_message: number;
  own_chars_buckets: { short_max: number; medium_max: number };
  priced_domains: string[];
};

// config/scoring.json (ARCHITECTURE.md 4.2): the tier rules, the size a promoted process needs,
// the bounds on a work estimate, and the artifact threshold. Every value a whole number.
export type TierRule = { min_occurrences: number; min_active_months: number; min_staff: number };
export type Scoring = {
  version: number;
  tiers: { A: TierRule; B: TierRule };
  merge: { promote_min: { messages: number; occurrences: number; threads: number; active_months: number } };
  estimates: {
    max_minutes_per_occurrence: number;
    max_automatable_pct: number;
    min_occurrences: number; // fewer occurrences: no estimate; and the cited ids must come from this many
    min_evidence: number;
    max_evidence: number;
    min_senders: number;
  };
  artifacts: { min_automatable_cents: number | null; cap: number; floor: number };
};

// The shape, key by key: a loaded file has exactly these keys, so the M4 file (tiers by
// participants, no merge or estimates section) is refused with every key named.
const SCORING_KEYS = ['version', 'tiers', 'merge', 'estimates', 'artifacts'] as const;
const TIER_KEYS = ['min_occurrences', 'min_active_months', 'min_staff'] as const;
const PROMOTE_KEYS = ['messages', 'occurrences', 'threads', 'active_months'] as const;
const ESTIMATE_KEYS = ['max_minutes_per_occurrence', 'max_automatable_pct', 'min_occurrences', 'min_evidence', 'max_evidence', 'min_senders'] as const;
const ARTIFACT_KEYS = ['min_automatable_cents', 'cap', 'floor'] as const;

export class ConfigError extends Error {
  constructor(file: string, problems: string[]) {
    super(`${file} is invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(file, [`cannot read as JSON: ${(err as Error).message}`]);
  }
}

// One map per action type: every type present, nothing extra, each value passing `check`.
function checkActionMap(
  raw: Record<string, unknown>,
  key: string,
  check: (v: unknown) => boolean,
  expected: string,
  problems: string[],
): void {
  const map = raw[key];
  if (!isRecord(map)) {
    problems.push(`${key} must be an object keyed by action type`);
    return;
  }
  for (const type of ACTION_TYPES) {
    if (!check(map[type])) problems.push(`${key}.${type} must be ${expected}`);
  }
  for (const extra of Object.keys(map).filter((k) => !(ACTION_TYPES as readonly string[]).includes(k))) {
    problems.push(`${key}.${extra} is not an action type`);
  }
}

export function loadEffortRates(file: string): EffortRates {
  const raw = readJson(file);
  const problems: string[] = [];
  if (!isRecord(raw)) throw new ConfigError(file, ['top level must be an object']);
  if (!isPosInt(raw.version)) problems.push('version must be a positive integer');
  checkActionMap(raw, 'minutes', isPosInt, 'a positive whole number of minutes', problems);
  checkActionMap(raw, 'automatable_pct', (v) => isNonNegInt(v) && (v as number) <= 100, 'a whole percentage 0-100', problems);
  checkActionMap(raw, 'rationale', (v) => typeof v === 'string' && v.trim().length > 0, 'a non-empty sentence', problems);
  if (!isPosInt(raw.read_cap_per_message)) problems.push('read_cap_per_message must be a positive integer');
  const buckets = raw.own_chars_buckets;
  if (!isRecord(buckets) || !isPosInt(buckets.short_max) || !isPosInt(buckets.medium_max)) {
    problems.push('own_chars_buckets needs positive integers short_max and medium_max');
  } else if (buckets.short_max >= buckets.medium_max) {
    problems.push('own_chars_buckets.short_max must be below medium_max');
  }
  const domains = raw.priced_domains;
  if (!Array.isArray(domains) || domains.length === 0) {
    problems.push('priced_domains must list at least one domain');
  } else {
    for (const d of domains) {
      if (typeof d !== 'string' || d !== d.trim().toLowerCase() || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) {
        problems.push(`priced_domains entry ${JSON.stringify(d)} must be a lowercase domain like "enron.com"`);
      }
    }
  }
  if (problems.length > 0) throw new ConfigError(file, problems);
  return raw as unknown as EffortRates;
}

// Exactly `keys` in `obj` (named `at`): every missing and every unknown key is a problem.
function exactKeys(at: string, obj: Record<string, unknown>, keys: readonly string[], problems: string[]): void {
  for (const k of keys) if (!Object.hasOwn(obj, k)) problems.push(`${at}.${k} is missing`);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) problems.push(`${at}.${k} is not a setting here (allowed: ${keys.join(', ')})`);
}

// The object at `obj[key]` (named `at`) checked for exactly `keys`; null, with the problem
// recorded, when it is not an object.
function section(obj: Record<string, unknown>, key: string, keys: readonly string[], problems: string[], at = key): Record<string, unknown> | null {
  const v = obj[key];
  if (!isRecord(v)) {
    problems.push(v === undefined ? `${at} is missing` : `${at} must be an object`);
    return null;
  }
  exactKeys(at, v, keys, problems);
  return v;
}

// Rejects anything but the M5 shape (the M4 file is refused with its missing and unknown keys
// named), a B rule above the A rule, and any value that is not a whole number.
export function loadScoring(file: string): Scoring {
  const raw = readJson(file);
  const problems: string[] = [];
  if (!isRecord(raw)) throw new ConfigError(file, ['top level must be an object']);
  for (const k of Object.keys(raw)) {
    if (!(SCORING_KEYS as readonly string[]).includes(k)) problems.push(`${k} is not a setting here (allowed: ${SCORING_KEYS.join(', ')})`);
  }
  if (!isPosInt(raw.version)) problems.push('version must be a positive integer');
  const whole = (at: string, v: unknown, min = 1): void => {
    if (v !== undefined && !(Number.isInteger(v) && (v as number) >= min)) problems.push(`${at} must be a whole number of at least ${min}`);
  };

  const tiers = section(raw, 'tiers', ['A', 'B'], problems);
  if (tiers !== null) {
    const a = section(tiers, 'A', TIER_KEYS, problems, 'tiers.A');
    const b = section(tiers, 'B', TIER_KEYS, problems, 'tiers.B');
    for (const k of TIER_KEYS) {
      whole(`tiers.A.${k}`, a?.[k]);
      whole(`tiers.B.${k}`, b?.[k]);
      const av = a?.[k];
      const bv = b?.[k];
      if (isPosInt(av) && isPosInt(bv) && bv > av) problems.push(`tiers.B.${k} must not exceed tiers.A.${k}: B is the lower tier`);
    }
  }
  const merge = section(raw, 'merge', ['promote_min'], problems);
  if (merge !== null) {
    const p = section(merge, 'promote_min', PROMOTE_KEYS, problems, 'merge.promote_min');
    for (const k of PROMOTE_KEYS) whole(`merge.promote_min.${k}`, p?.[k]);
  }
  const est = section(raw, 'estimates', ESTIMATE_KEYS, problems);
  if (est !== null) {
    for (const k of ESTIMATE_KEYS) whole(`estimates.${k}`, est[k], k === 'max_automatable_pct' ? 0 : 1);
    if (Number.isInteger(est.max_automatable_pct) && (est.max_automatable_pct as number) > 100) problems.push('estimates.max_automatable_pct must be at most 100');
    if (isPosInt(est.min_evidence) && isPosInt(est.max_evidence) && est.min_evidence > est.max_evidence) {
      problems.push('estimates.min_evidence must not exceed estimates.max_evidence');
    }
  }
  const art = section(raw, 'artifacts', ARTIFACT_KEYS, problems);
  if (art !== null) {
    if (art.min_automatable_cents !== null && art.min_automatable_cents !== undefined && !isNonNegInt(art.min_automatable_cents)) {
      problems.push('artifacts.min_automatable_cents must be null (not set yet) or a whole number of cents');
    }
    if (!isNonNegInt(art.cap) || !isNonNegInt(art.floor)) {
      problems.push('artifacts.cap and artifacts.floor must be whole numbers');
    } else if (art.floor > art.cap) {
      problems.push('artifacts.floor must not exceed artifacts.cap');
    }
  }
  if (problems.length > 0) throw new ConfigError(file, problems);
  return raw as unknown as Scoring;
}

// config/estimates.json (optional; ARCHITECTURE.md 5.3): work estimates by process key that replace
// the model's. Each passes the same bounds as a model's (E1): whole minutes with
// 1 <= low <= mid <= high <= max_minutes_per_occurrence, an automatable share from 0 to
// max_automatable_pct, and a rationale.
export const OVERRIDE_RATIONALE_MAX_CHARS = 600;

export function loadEstimatesOverride(file: string, bounds: Scoring['estimates']): EstimatesOverride {
  const raw = readJson(file);
  const problems: string[] = [];
  if (!isRecord(raw)) throw new ConfigError(file, ['top level must be an object {"version": 1, "estimates": {...}}']);
  for (const k of Object.keys(raw)) if (k !== 'version' && k !== 'estimates') problems.push(`${k} is not a setting here (allowed: version, estimates)`);
  if (raw.version !== 1) problems.push('version must be 1');
  if (!isRecord(raw.estimates)) {
    problems.push('estimates must be an object keyed by process key');
    throw new ConfigError(file, problems);
  }
  for (const [key, e] of Object.entries(raw.estimates)) {
    const at = `estimates.${key}`;
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key)) problems.push(`${JSON.stringify(key)} is not a process key (a lowercase slug)`);
    if (!isRecord(e)) {
      problems.push(`${at} must be an object {minutes_per_occurrence, automatable_pct, rationale}`);
      continue;
    }
    exactKeys(at, e, ['minutes_per_occurrence', 'automatable_pct', 'rationale'], problems);
    const m = e.minutes_per_occurrence;
    if (!isRecord(m)) {
      problems.push(`${at}.minutes_per_occurrence must be an object {low, mid, high}`);
    } else {
      exactKeys(`${at}.minutes_per_occurrence`, m, ['low', 'mid', 'high'], problems);
      const [low, mid, high] = [m.low, m.mid, m.high];
      if (!Number.isInteger(low) || !Number.isInteger(mid) || !Number.isInteger(high)) {
        problems.push(`${at}.minutes_per_occurrence: low, mid and high must be whole minutes`);
      } else if (!(1 <= (low as number) && (low as number) <= (mid as number) && (mid as number) <= (high as number) && (high as number) <= bounds.max_minutes_per_occurrence)) {
        problems.push(`${at}.minutes_per_occurrence must satisfy 1 <= low <= mid <= high <= ${bounds.max_minutes_per_occurrence}, got ${low}/${mid}/${high}`);
      }
    }
    const pct = e.automatable_pct;
    if (!(Number.isInteger(pct) && (pct as number) >= 0 && (pct as number) <= bounds.max_automatable_pct)) {
      problems.push(`${at}.automatable_pct must be a whole percentage from 0 to ${bounds.max_automatable_pct}, got ${JSON.stringify(pct)}`);
    }
    if (typeof e.rationale !== 'string' || e.rationale.trim() === '' || [...e.rationale].length > OVERRIDE_RATIONALE_MAX_CHARS) {
      problems.push(`${at}.rationale must say why, in 1-${OVERRIDE_RATIONALE_MAX_CHARS} characters`);
    }
  }
  if (problems.length > 0) throw new ConfigError(file, problems);
  return raw as unknown as EstimatesOverride;
}
