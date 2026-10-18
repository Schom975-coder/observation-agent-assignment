// The synthesis output check (ARCHITECTURE.md 5.3, 6.20): one synthesizer's file for one group,
// out/synthesis/raw/<group_id>.json, against the group's input. Deterministic and model-free, run
// by the SubagentStop gate, `node obs.mjs validate synth-NNN`, run start and `verify`.
//
// Checked in this order, each problem one bounded line for the fix file: strict JSON and schema
// (unknown keys rejected, so a number anywhere but inside work_estimate is an unknown key or a type
// error); group_id; the key set equals the input's; every cited id is one the input shows under
// that process; lengths; every free-text field passes the taxonomy gate's steering check, and only
// the description and the two rationales may carry a number of hours, minutes, dollars or percent;
// then the estimate rules from config/scoring.json:
//   E1 whole minutes 1 <= low <= mid <= high <= max_minutes_per_occurrence, automatable share 0 to
//      max_automatable_pct;
//   E2 min_evidence-max_evidence distinct ids, from at least min_occurrences occurrences and
//      min_senders senders (the input's sidecar has both per id);
//   E3 basis self_reported needs SELF_REPORTED_MIN_SENDERS senders: one person's statement of how
//      long something takes is a claim, corroborated or not used;
//   E4 a process the input shows with fewer than min_occurrences occurrences has work_estimate null.
// Character caps are enforced LENGTH_MARGIN_PCT over the cap the agent definition states.
// The validated record is the raw one, keys in contract order and processes in the input's order,
// plus the input's content_sha and, per estimate, the occurrences and senders its ids come from.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, loadScoring, type Scoring } from '../config.ts';
import { sha256 } from '../util/hash.ts';
import { checkProse } from './taxonomy.ts';
import { modelText } from './schema.ts';
import { errorText, repoPath } from './validate-extraction.ts';
import {
  ARTIFACT_TYPES,
  ESTIMATE_BASES,
  type JobCheck,
  type SynthEntry,
  type SynthesisGroup,
  type SynthesisProcess,
  type SynthSidecar,
  type ValidatedSynthesis,
} from '../types.ts';

export const DESCRIPTION_MIN_CHARS = 40;
export const DESCRIPTION_MAX_CHARS = 600;
export const STEPS_MIN = 1;
export const STEPS_MAX = 8;
export const STEP_MAX_CHARS = 200;
export const FINDINGS_MAX = 10; // stalls and contradictions, each
export const SUMMARY_MAX_CHARS = 400;
export const APPROACH_MAX_CHARS = 600;
export const RATIONALE_MAX_CHARS = 600;
export const SELF_REPORTED_MIN_SENDERS = 3;
// The largest raw output read: four processes at every limit, the margin included, come to about
// two thirds of it.
export const SYNTHESIS_OUTPUT_MAX_BYTES = 100_000;
// Every character cap above is stated to the model as written and enforced with this margin
// (ARCHITECTURE.md 5.3): a description a few characters over its stated cap is not worth a serial
// fix round at the stage's tail. The validated file keeps the text as written.
export const LENGTH_MARGIN_PCT = 20;
export const withMargin = (max: number): number => Math.floor((max * (100 + LENGTH_MARGIN_PCT)) / 100);

type Obj = Record<string, unknown>;
const BOM = String.fromCharCode(0xfeff);
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const chars = (s: string): number => [...s].length;
function kindOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'object') return 'an object';
  if (typeof v === 'string') return 'a string';
  return `a ${typeof v}`;
}

const TOP_KEYS = ['group_id', 'processes'] as const;
const PROCESS_KEYS = ['key', 'description', 'steps', 'stalls', 'contradictions', 'automation', 'work_estimate'] as const;
const FINDING_KEYS = ['summary', 'evidence_ids'] as const;
const AUTOMATION_KEYS = ['approach', 'artifact_type', 'rationale'] as const;
const ESTIMATE_KEYS = ['minutes_per_occurrence', 'automatable_pct', 'basis', 'rationale', 'evidence_ids'] as const;
const MINUTES_KEYS = ['low', 'mid', 'high'] as const;

// The strict structural check: every key present, nothing else, types and enums exact. A number
// is allowed only for minutes_per_occurrence.low/mid/high and automatable_pct.
class Checker {
  readonly errors: string[] = [];
  add(where: string, what: string): void {
    this.errors.push(`schema: ${where} ${what}`);
  }
  object(where: string, v: unknown, keys: readonly string[]): v is Obj {
    if (!isObject(v)) {
      this.add(where, `must be an object, got ${kindOf(v)}`);
      return false;
    }
    for (const k of Object.keys(v)) {
      if (keys.includes(k)) continue;
      const numeric = typeof v[k] === 'number' ? '; a number may appear only inside work_estimate' : '';
      this.add(where, `has unknown key ${modelText(k, 60)}: remove it${numeric} (allowed keys: ${keys.join(', ')})`);
    }
    for (const k of keys) if (!Object.hasOwn(v, k)) this.add(where, `is missing key "${k}"${k === 'work_estimate' ? ' (use null when there is none)' : ''}`);
    return true;
  }
  string(where: string, v: unknown): void {
    if (v !== undefined && typeof v !== 'string') this.add(where, `must be a string, got ${kindOf(v)}${typeof v === 'number' ? '; a number may appear only inside work_estimate' : ''}`);
  }
  strings(where: string, v: unknown): void {
    if (v === undefined) return;
    if (!Array.isArray(v)) {
      this.add(where, `must be an array of strings, got ${kindOf(v)}`);
      return;
    }
    v.forEach((s, i) => this.string(`${where}[${i}]`, s));
  }
  oneOf(where: string, v: unknown, options: readonly string[]): void {
    if (v === undefined || (typeof v === 'string' && options.includes(v))) return;
    this.add(where, `must be one of ${options.map((o) => `"${o}"`).join(', ')}, got ${typeof v === 'string' ? modelText(v, 60) : kindOf(v)}`);
  }
  number(where: string, v: unknown): void {
    if (v !== undefined && typeof v !== 'number') this.add(where, `must be a number, got ${kindOf(v)}`);
  }
  array(where: string, v: unknown, item: (where: string, value: unknown) => void): void {
    if (v === undefined) return;
    if (!Array.isArray(v)) {
      this.add(where, `must be an array, got ${kindOf(v)}`);
      return;
    }
    v.forEach((value, i) => item(`${where}[${i}]`, value));
  }
}

// The group typed, or null with every reason it does not fit the contract.
export function checkSynthesisSchema(value: unknown): { group: SynthesisGroup | null; errors: string[] } {
  const c = new Checker();
  if (c.object('the top level', value, TOP_KEYS)) {
    c.string('group_id', value.group_id);
    c.array('processes', value.processes, (where, p) => {
      const at = isObject(p) && typeof p.key === 'string' ? `${where} (${modelText(p.key)})` : where;
      if (!c.object(at, p, PROCESS_KEYS)) return;
      c.string(`${at}.key`, p.key);
      c.string(`${at}.description`, p.description);
      c.strings(`${at}.steps`, p.steps);
      for (const field of ['stalls', 'contradictions'] as const) {
        c.array(`${at}.${field}`, p[field], (w, f) => {
          if (!c.object(w, f, FINDING_KEYS)) return;
          c.string(`${w}.summary`, f.summary);
          c.strings(`${w}.evidence_ids`, f.evidence_ids);
        });
      }
      if (p.automation !== undefined && c.object(`${at}.automation`, p.automation, AUTOMATION_KEYS)) {
        c.string(`${at}.automation.approach`, p.automation.approach);
        c.oneOf(`${at}.automation.artifact_type`, p.automation.artifact_type, ARTIFACT_TYPES);
        c.string(`${at}.automation.rationale`, p.automation.rationale);
      }
      const e = p.work_estimate;
      if (e !== null && e !== undefined && c.object(`${at}.work_estimate`, e, ESTIMATE_KEYS)) {
        if (e.minutes_per_occurrence !== undefined && c.object(`${at}.work_estimate.minutes_per_occurrence`, e.minutes_per_occurrence, MINUTES_KEYS)) {
          for (const k of MINUTES_KEYS) c.number(`${at}.work_estimate.minutes_per_occurrence.${k}`, e.minutes_per_occurrence[k]);
        }
        c.number(`${at}.work_estimate.automatable_pct`, e.automatable_pct);
        c.oneOf(`${at}.work_estimate.basis`, e.basis, ESTIMATE_BASES);
        c.string(`${at}.work_estimate.rationale`, e.rationale);
        c.strings(`${at}.work_estimate.evidence_ids`, e.evidence_ids);
      }
    });
  }
  return { group: c.errors.length === 0 ? (value as SynthesisGroup) : null, errors: c.errors };
}

const failed = (problems: string[]): JobCheck<ValidatedSynthesis> => ({ ok: false, setup: null, problems, validated: null });
const setupFailed = (setup: string): JobCheck<ValidatedSynthesis> => ({ ok: false, setup, problems: [], validated: null });

const LIST_MAX = 10;
const listed = (items: readonly string[]): string => (items.length <= LIST_MAX ? items.join(', ') : `${items.slice(0, LIST_MAX).join(', ')}, and ${items.length - LIST_MAX} more`);

export type SynthesisCheckOptions = { outDir?: string; scoring?: Scoring };

export function checkSynthesis(root: string, groupId: string, options: SynthesisCheckOptions = {}): JobCheck<ValidatedSynthesis> {
  const outDir = options.outDir ?? join(root, 'out');
  const shown = (file: string) => repoPath(root, file, outDir);
  const indexPath = join(outDir, 'synthesis', 'index.json');
  let entry: SynthEntry | undefined;
  try {
    const index: unknown = JSON.parse(readFileSync(indexPath, 'utf8'));
    entry = Array.isArray(index) ? (index as SynthEntry[]).find((g) => g?.group_id === groupId) : undefined;
  } catch (err) {
    return setupFailed(`cannot read ${shown(indexPath)} (${errorText(err)}); run "node obs.mjs rollup"`);
  }
  if (entry === undefined) return setupFailed(`${groupId} is not a group in ${shown(indexPath)}`);
  const input = join(outDir, 'synthesis', 'input', `${groupId}.md`);
  if (existsSync(input) && sha256(readFileSync(input, 'utf8')) !== entry.content_sha) {
    return setupFailed(`${shown(input)} changed since the index was written; run "node obs.mjs rollup" again`);
  }
  const sidecarPath = join(outDir, 'synthesis', 'input', `${groupId}.json`);
  let sidecar: SynthSidecar;
  try {
    sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as SynthSidecar;
    if (!isObject(sidecar) || sidecar.group_id !== groupId || !Array.isArray(sidecar.processes)) throw new Error('not the sidecar of this group');
  } catch (err) {
    return setupFailed(`cannot read ${shown(sidecarPath)} (${errorText(err)}); run "node obs.mjs rollup"`);
  }
  let scoring: Scoring;
  try {
    scoring = options.scoring ?? loadScoring(join(root, 'config', 'scoring.json'));
  } catch (err) {
    return setupFailed(`config/scoring.json is missing or invalid (${err instanceof ConfigError ? 'see node obs.mjs score' : errorText(err)}); fix it first`);
  }

  const file = join(outDir, 'synthesis', 'raw', `${groupId}.json`);
  let text: string;
  try {
    // A file over the cap is not read at all: a group's synthesis is a few kilobytes.
    const bytes = statSync(file).size;
    if (bytes > SYNTHESIS_OUTPUT_MAX_BYTES) {
      return failed([`${shown(file)} is ${bytes} bytes, over the cap of ${SYNTHESIS_OUTPUT_MAX_BYTES}: write only the fields of the schema, within their limits`]);
    }
    text = readFileSync(file, 'utf8');
  } catch {
    return failed([`${shown(file)} does not exist or cannot be read: write the synthesis for ${groupId} there`]);
  }
  let value: unknown;
  try {
    value = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
  } catch (err) {
    return failed([`${shown(file)} is not valid JSON (${errorText(err)}): write exactly one JSON object, with no comments, trailing commas or text around it`]);
  }
  const schema = checkSynthesisSchema(value);
  if (schema.group === null) return failed(schema.errors);
  return check(schema.group, groupId, entry, sidecar, scoring.estimates);
}

function check(g: SynthesisGroup, groupId: string, entry: SynthEntry, sidecar: SynthSidecar, bounds: Scoring['estimates']): JobCheck<ValidatedSynthesis> {
  const problems: string[] = [];
  const add = (p: string) => void problems.push(p);
  if (g.group_id !== groupId) add(`group_id is ${modelText(g.group_id)} but this file is for ${groupId}: set "group_id": "${groupId}"`);

  // The key set: exactly the input's processes, each once.
  const expected = sidecar.processes.map((p) => p.key);
  const seen = new Map<string, number>();
  g.processes.forEach((p, i) => {
    if (!expected.includes(p.key)) add(`processes[${i}] (${modelText(p.key)}) is not a process of ${groupId}: the input's processes are ${expected.join(', ')}`);
    else if (seen.has(p.key)) add(`processes[${i}] (${p.key}) repeats processes[${seen.get(p.key)}]: write each process once`);
    else seen.set(p.key, i);
  });
  const missing = expected.filter((k) => !seen.has(k));
  if (missing.length > 0) add(`processes is missing ${listed(missing)}: write one entry for every process of the input`);

  // Which process shows each id.
  const owner = new Map<string, string>();
  for (const p of sidecar.processes) for (const c of p.cited) owner.set(c.id, p.key);

  const validated: ValidatedSynthesis['processes'] = [];
  for (const sp of sidecar.processes) {
    const i = seen.get(sp.key);
    if (i === undefined) continue;
    const p = g.processes[i] as SynthesisProcess;
    const at = `processes[${i}] (${sp.key})`;
    const cited = new Map(sp.cited.map((c) => [c.id, c]));
    // Every cited id is one the input shows under this process.
    const ids = (where: string, list: readonly string[], min: number): void => {
      if (list.length < min) add(`${at}.${where} cites no evidence: cite at least ${min} id${min === 1 ? '' : 's'} from this process's section of the input`);
      for (const id of list) {
        if (cited.has(id)) continue;
        const other = owner.get(id);
        add(
          other !== undefined
            ? `${at}.${where}: ${id} is listed under ${other}, not ${sp.key}: cite ids from this process's section only`
            : `${at}.${where}: ${modelText(id)} is not an id the input shows: copy ids exactly as the input lists them (e.g. batch-021:e4)`,
        );
      }
    };
    // Lengths, then the steering check (and, where numbers are not allowed, the effort-number check).
    // A cap is enforced LENGTH_MARGIN_PCT over; the problem states the cap as the prompt does.
    const text = (where: string, s: string, min: number, max: number, numbers: boolean): void => {
      const n = chars(s.trim());
      if (n < min || chars(s) > withMargin(max)) add(`${at}.${where} must be ${min}-${max} characters, got ${chars(s)}`);
      checkProse(at, where, s, add, numbers);
    };
    text('description', p.description, DESCRIPTION_MIN_CHARS, DESCRIPTION_MAX_CHARS, true);
    if (p.steps.length < STEPS_MIN || p.steps.length > STEPS_MAX) add(`${at}.steps must have ${STEPS_MIN}-${STEPS_MAX} entries, got ${p.steps.length}`);
    p.steps.forEach((s, j) => text(`steps[${j}]`, s, 1, STEP_MAX_CHARS, false));
    for (const field of ['stalls', 'contradictions'] as const) {
      if (p[field].length > FINDINGS_MAX) add(`${at}.${field} must have at most ${FINDINGS_MAX} entries, got ${p[field].length}`);
      p[field].forEach((f, j) => {
        text(`${field}[${j}].summary`, f.summary, 1, SUMMARY_MAX_CHARS, false);
        ids(`${field}[${j}].evidence_ids`, f.evidence_ids, 1);
      });
    }
    text('automation.approach', p.automation.approach, 1, APPROACH_MAX_CHARS, false);
    text('automation.rationale', p.automation.rationale, 1, RATIONALE_MAX_CHARS, true);

    // The estimate rules.
    let estimateCheck: ValidatedSynthesis['processes'][number]['estimate_check'] = null;
    const e = p.work_estimate;
    if (sp.occurrences < bounds.min_occurrences) {
      if (e !== null) {
        add(`${at}.work_estimate must be null: the input shows ${sp.occurrences} occurrence${sp.occurrences === 1 ? '' : 's'} of this process, and an estimate needs at least ${bounds.min_occurrences} (E4)`);
      }
    } else if (e !== null) {
      const m = e.minutes_per_occurrence;
      const whole = [m.low, m.mid, m.high].every((x) => Number.isInteger(x));
      if (!whole) add(`${at}.work_estimate.minutes_per_occurrence: low, mid and high must be whole minutes (E1)`);
      else if (!(1 <= m.low && m.low <= m.mid && m.mid <= m.high && m.high <= bounds.max_minutes_per_occurrence)) {
        add(`${at}.work_estimate.minutes_per_occurrence must satisfy 1 <= low <= mid <= high <= ${bounds.max_minutes_per_occurrence}, got ${m.low}/${m.mid}/${m.high} (E1)`);
      }
      if (!(Number.isInteger(e.automatable_pct) && e.automatable_pct >= 0 && e.automatable_pct <= bounds.max_automatable_pct)) {
        add(`${at}.work_estimate.automatable_pct must be a whole percentage from 0 to ${bounds.max_automatable_pct}, got ${e.automatable_pct} (E1)`);
      }
      text('work_estimate.rationale', e.rationale, 1, RATIONALE_MAX_CHARS, true);
      const distinct = [...new Set(e.evidence_ids)];
      if (distinct.length !== e.evidence_ids.length) add(`${at}.work_estimate.evidence_ids lists an id twice: cite each id once (E2)`);
      if (distinct.length < bounds.min_evidence || distinct.length > bounds.max_evidence) {
        add(`${at}.work_estimate.evidence_ids must cite ${bounds.min_evidence}-${bounds.max_evidence} ids, got ${distinct.length} (E2)`);
      }
      ids('work_estimate.evidence_ids', e.evidence_ids, 0);
      const known = distinct.map((id) => cited.get(id)).filter((c) => c !== undefined);
      const occurrences = new Set(known.map((c) => c.occurrence_id).filter((o) => o !== '')).size;
      const senders = new Set(known.map((c) => c.sender).filter((s) => s !== '')).size;
      // What this process's section shows at all: when it is short of the rule, no choice of ids
      // can meet it, and the fix is null, not another round of trying.
      const shown = {
        occurrences: new Set(sp.cited.map((c) => c.occurrence_id).filter((o) => o !== '')).size,
        senders: new Set(sp.cited.map((c) => c.sender).filter((s) => s !== '')).size,
      };
      const e2 = (n: number, noun: string, min: number, available: number): string =>
        `${at}.work_estimate.evidence_ids come from ${n} ${noun}${n === 1 ? '' : 's'}; ` +
        (available < min
          ? `this process's section shows quotes from only ${available} ${noun}${available === 1 ? '' : 's'}, so no estimate can meet the rule: set work_estimate to null (E2)`
          : `cite quotes from at least ${min} different ${noun}s, or set work_estimate to null (E2)`);
      if (occurrences < bounds.min_occurrences) add(e2(occurrences, 'occurrence', bounds.min_occurrences, shown.occurrences));
      if (senders < bounds.min_senders) add(e2(senders, 'sender', bounds.min_senders, shown.senders));
      if (e.basis === 'self_reported' && senders < SELF_REPORTED_MIN_SENDERS) {
        add(
          `${at}.work_estimate.basis is "self_reported" with quotes from ${senders} sender${senders === 1 ? '' : 's'}; what people say about their own time needs ${SELF_REPORTED_MIN_SENDERS} senders to be a basis (E3): ` +
            'cite more people, use "observed" or "inferred" from what the mail shows, or set work_estimate to null',
        );
      }
      estimateCheck = { occurrences_cited: occurrences, senders_cited: senders };
    }
    validated.push({
      key: sp.key,
      description: p.description,
      steps: [...p.steps],
      stalls: p.stalls.map((f) => ({ summary: f.summary, evidence_ids: [...f.evidence_ids] })),
      contradictions: p.contradictions.map((f) => ({ summary: f.summary, evidence_ids: [...f.evidence_ids] })),
      automation: { approach: p.automation.approach, artifact_type: p.automation.artifact_type, rationale: p.automation.rationale },
      work_estimate:
        e === null
          ? null
          : {
              minutes_per_occurrence: { low: e.minutes_per_occurrence.low, mid: e.minutes_per_occurrence.mid, high: e.minutes_per_occurrence.high },
              automatable_pct: e.automatable_pct,
              basis: e.basis,
              rationale: e.rationale,
              evidence_ids: [...e.evidence_ids],
            },
      estimate_check: estimateCheck,
    });
  }
  return { ok: problems.length === 0, setup: null, problems, validated: { group_id: groupId, content_sha: entry.content_sha, processes: validated } };
}
