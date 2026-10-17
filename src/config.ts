// Loads and checks the two published config files. Every number in the headline
// traces back to these files, so a malformed value stops the run with a clear message.
import { readFileSync } from 'node:fs';

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

export type Scoring = {
  version: number;
  tiers: { A: { min_occurrences: number; min_participants: number }; B: { min_occurrences: number } };
  artifacts: { min_automatable_cents: number | null; cap: number; floor: number };
};

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

export function loadScoring(file: string): Scoring {
  const raw = readJson(file);
  const problems: string[] = [];
  if (!isRecord(raw)) throw new ConfigError(file, ['top level must be an object']);
  if (!isPosInt(raw.version)) problems.push('version must be a positive integer');
  const tiers = raw.tiers;
  if (!isRecord(tiers) || !isRecord(tiers.A) || !isRecord(tiers.B)) {
    problems.push('tiers needs A and B objects');
  } else {
    if (!isPosInt(tiers.A.min_occurrences)) problems.push('tiers.A.min_occurrences must be a positive integer');
    if (!isPosInt(tiers.A.min_participants)) problems.push('tiers.A.min_participants must be a positive integer');
    if (!isPosInt(tiers.B.min_occurrences)) problems.push('tiers.B.min_occurrences must be a positive integer');
    if (isPosInt(tiers.A.min_occurrences) && isPosInt(tiers.B.min_occurrences) && tiers.B.min_occurrences > tiers.A.min_occurrences) {
      problems.push('tiers.B.min_occurrences must not exceed tiers.A.min_occurrences');
    }
  }
  const art = raw.artifacts;
  if (!isRecord(art)) {
    problems.push('artifacts must be an object');
  } else {
    if (art.min_automatable_cents !== null && !isNonNegInt(art.min_automatable_cents)) {
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
