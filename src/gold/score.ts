// Scoring the extractors' tags against the hand-confirmed gold labels (ARCHITECTURE.md 6.18).
// Over confirmed entries only: exact key-set agreement, any-overlap agreement (both empty counts as
// agreement) and role agreement, with every disagreement listed. Any "new:<slug>" key, on either
// side, counts as the one key "new:*": the question is whether a message belongs to a known process.
// From M5 the same three rates are also given on the merged keys when a merge table is passed: a
// new: key (on either side) that the merge maps or promotes counts as its target, any other as
// "new:*", so the two scores side by side show how much the merge recovers.
import { mergeTarget } from '../model/merge.ts';
import { MESSAGE_ROLES, type MergeTable, type MessageRole } from '../types.ts';
import type { GoldLabel, GoldLabels } from './sample.ts';

const LABEL_KEYS = ['id', 'processes', 'role', 'confirmed', 'note'] as const;
const TOP_KEYS = ['version', 'taxonomy_sha', 'labels'] as const;
const EMPTY_ROLES: readonly string[] = ['personal', 'noise', 'automated', 'injection_attempt'];

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const shown = (s: string): string => JSON.stringify(s.length > 60 ? `${s.slice(0, 60)}...` : s);

// The labels file typed, or null with every problem found. Confirmed entries must be complete and
// use the taxonomy's keys; unconfirmed ones only need the right shape.
export function checkLabels(value: unknown, taxonomyKeys: ReadonlySet<string>): { labels: GoldLabels | null; problems: string[] } {
  const problems: string[] = [];
  const add = (p: string) => problems.push(p);
  if (!isObject(value)) return { labels: null, problems: ['the file must be a JSON object {"version": 1, "taxonomy_sha": ..., "labels": [...]}'] };
  for (const k of Object.keys(value)) if (!(TOP_KEYS as readonly string[]).includes(k)) add(`unknown top-level key ${shown(k)} (allowed: ${TOP_KEYS.join(', ')})`);
  if (value.version !== 1) add('version must be 1');
  if (typeof value.taxonomy_sha !== 'string') add('taxonomy_sha must be a string');
  if (!Array.isArray(value.labels)) {
    add('labels must be an array');
    return { labels: null, problems };
  }
  const seen = new Set<string>();
  value.labels.forEach((l, i) => {
    const at = isObject(l) && typeof l.id === 'string' ? `labels[${i}] (${l.id})` : `labels[${i}]`;
    if (!isObject(l)) {
      add(`${at} must be an object`);
      return;
    }
    for (const k of Object.keys(l)) if (!(LABEL_KEYS as readonly string[]).includes(k)) add(`${at} has unknown key ${shown(k)} (allowed: ${LABEL_KEYS.join(', ')})`);
    for (const k of LABEL_KEYS) if (!Object.hasOwn(l, k)) add(`${at} is missing key "${k}"`);
    if (typeof l.id !== 'string') add(`${at}.id must be a string`);
    else if (seen.has(l.id)) add(`${at}.id appears twice`);
    else seen.add(l.id);
    const processes = Array.isArray(l.processes) && l.processes.every((p) => typeof p === 'string') ? (l.processes as string[]) : null;
    if (processes === null && l.processes !== undefined) add(`${at}.processes must be an array of strings`);
    if (l.role !== null && l.role !== undefined && !(MESSAGE_ROLES as readonly unknown[]).includes(l.role)) {
      add(`${at}.role must be null or one of ${MESSAGE_ROLES.join(', ')}`);
    }
    if (l.confirmed !== undefined && typeof l.confirmed !== 'boolean') add(`${at}.confirmed must be true or false`);
    if (l.note !== undefined && typeof l.note !== 'string') add(`${at}.note must be a string`);
    if (l.confirmed !== true) return;
    if (l.role === null) add(`${at} is confirmed but has no role`);
    for (const p of processes ?? []) {
      if (!taxonomyKeys.has(p) && !/^new:\S+$/.test(p)) add(`${at}.processes: ${shown(p)} is not a taxonomy key (or new:<slug>)`);
    }
    if (processes !== null && new Set(processes).size !== processes.length) add(`${at}.processes lists a key twice`);
    if (processes?.length === 0 && typeof l.role === 'string' && !EMPTY_ROLES.includes(l.role)) {
      add(`${at}.processes is [] but role ${shown(l.role)} needs at least one process ([] goes only with ${EMPTY_ROLES.join(', ')})`);
    }
  });
  return { labels: problems.length === 0 ? (value as GoldLabels) : null, problems };
}

export type Agreement = { agree: number; of: number; pct: number | null };
export type Tagging = { processes: string[]; role: string };
export type GoldMismatch = { id: string; label: Tagging; extracted: Tagging; exact: boolean; overlap: boolean; role: boolean };

// The three rates over the scored entries, and the disagreements behind them.
export type GoldRates = { exact: Agreement; overlap: Agreement; role: Agreement; mismatches: GoldMismatch[] };

// out/gold-score.json
export type GoldScore = {
  taxonomy_sha: string;
  labels: number; // entries in the file
  confirmed: number;
  scored: number; // confirmed and found in an extraction
  missing: string[]; // confirmed, but in no batch the ledger counts as done yet
  exact: Agreement; // the same set of keys
  overlap: Agreement; // at least one key in common, or both empty
  role: Agreement;
  mismatches: GoldMismatch[]; // every scored entry where the key set or the role differs
  merged: GoldRates | null; // the same on the merged keys; null without a fresh merge table
};

const agreement = (agree: number, of: number): Agreement => ({ agree, of, pct: of === 0 ? null : Math.round((1000 * agree) / of) / 10 });
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
// The key set compared: a new: key is "new:*", unless `table` maps or promotes it.
const keySet = (processes: readonly string[], table: MergeTable | null): string[] =>
  [...new Set(processes.map((p) => (p.startsWith('new:') ? ((table === null ? null : mergeTarget(p, table)) ?? 'new:*') : p)))].sort(byText);

type Scored = { label: GoldLabel & { role: MessageRole }; extracted: Tagging };

function rates(scored: readonly Scored[], table: MergeTable | null): GoldRates {
  const mismatches: GoldMismatch[] = [];
  let exact = 0;
  let overlap = 0;
  let role = 0;
  for (const { label: l, extracted: e } of scored) {
    const a = keySet(l.processes, table);
    const b = keySet(e.processes, table);
    const same = a.length === b.length && a.every((k, i) => k === b[i]);
    const shared = (a.length === 0 && b.length === 0) || a.some((k) => b.includes(k));
    const sameRole = l.role === e.role;
    if (same) exact++;
    if (shared) overlap++;
    if (sameRole) role++;
    if (!same || !sameRole) {
      mismatches.push({ id: l.id, label: { processes: [...l.processes], role: l.role }, extracted: { processes: [...e.processes], role: e.role }, exact: same, overlap: shared, role: sameRole });
    }
  }
  return { exact: agreement(exact, scored.length), overlap: agreement(overlap, scored.length), role: agreement(role, scored.length), mismatches };
}

// `extracted`: message ID -> its tags, from the batches the ledger counts as done. `table`: the
// fresh merge table, when there is one.
export function scoreGold(labels: GoldLabels, extracted: ReadonlyMap<string, Tagging>, table: MergeTable | null = null): GoldScore {
  const confirmed = labels.labels.filter((l): l is GoldLabel & { role: MessageRole } => l.confirmed && l.role !== null);
  const missing: string[] = [];
  const scored: Scored[] = [];
  for (const l of confirmed) {
    const e = extracted.get(l.id);
    if (e === undefined) missing.push(l.id);
    else scored.push({ label: l, extracted: e });
  }
  const raw = rates(scored, null);
  return {
    taxonomy_sha: labels.taxonomy_sha,
    labels: labels.labels.length,
    confirmed: confirmed.length,
    scored: scored.length,
    missing,
    exact: raw.exact,
    overlap: raw.overlap,
    role: raw.role,
    mismatches: raw.mismatches,
    merged: table === null ? null : rates(scored, table),
  };
}
