// The artifacts stage (ARCHITECTURE.md 5.9, 6.12, 6.23), two deterministic steps around the drafting
// jobs:
//   node obs.mjs artifacts prepare   one brief per eligible opportunity with an artifact type
//                                    (out/artifacts/input/draft-NNN.json) and the index the ledger
//                                    reads (out/artifacts/index.json)
//   node obs.mjs artifacts collect   the rendered artifact of every done draft
//                                    (out/artifacts/<slug>/<type>.md) and the record of every
//                                    eligible opportunity, drafted or not (out/artifacts/artifacts.json)
// Between them the drafts run through the ledger like batches and synthesis groups. Both steps are
// quick and byte-identical on unchanged inputs; neither rewrites a file whose bytes would not change,
// so a warm run that finds every draft done rewrites nothing.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, loadEffortRates } from '../config.ts';
import { ARTIFACT_FILES, ArtifactError, BOM, STAGE_FOLDERS, artifactPath, artifactSlug, buildBriefs, renderArtifact } from '../model/artifacts.ts';
import { IdentityError, identityOf, type Identity } from '../normalize/identity.ts';
import { sha256 } from '../util/hash.ts';
import { normalizeNewlines } from '../util/text.ts';
import {
  LedgerError,
  artifactIndexFile,
  artifactsDir,
  artifactsFile,
  batchViews,
  fileSha,
  jobPaths,
  logStage,
  opportunitiesFile,
  readText,
  removeFile,
  rollupFile,
  validatedFile,
  withoutRoot,
  writeFileAtomic,
  type BatchView,
} from './ledger.ts';
import { ratesFile } from './rollup.ts';
import { scoreFreshness } from './score.ts';
import type { ArtifactBrief, ArtifactIndex, Artifacts, Opportunities, ParsedMessage, Person, Rollup, Thread, ValidatedDraft, ValidatedExtraction } from '../types.ts';

export { ArtifactError };

export type ArtifactsFreshness = 'current' | 'stale' | 'missing';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const inputDir = (root: string): string => join(artifactsDir(root), 'input');

// The input hashes an index built now would record.
const currentInputs = (root: string): ArtifactIndex['inputs'] => ({
  opportunities_sha: fileSha(opportunitiesFile(root)) ?? sha256('none'),
  rollup_sha: fileSha(rollupFile(root)) ?? sha256('none'),
});

function readJson(root: string, file: string, hint: string): unknown {
  const text = readText(file);
  if (text === null) throw new ArtifactError(`${withoutRoot(file, root).replaceAll('\\', '/')} is missing: ${hint}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ArtifactError(`${withoutRoot(file, root).replaceAll('\\', '/')} is not valid JSON: ${hint}`);
  }
}

// ---- Freshness ----

// current: the index records the opportunities and the rollup as they are now, and every brief it
// names is there with its content_sha (the briefs are committed, so a clone has them).
export function artifactsFreshness(root: string): ArtifactsFreshness {
  try {
    const text = readText(artifactIndexFile(root));
    if (text === null) return 'missing';
    const index: unknown = JSON.parse(text);
    if (!isRecord(index) || !isRecord(index.inputs) || !Array.isArray(index.jobs)) return 'stale';
    const now = currentInputs(root);
    if (index.inputs.opportunities_sha !== now.opportunities_sha || index.inputs.rollup_sha !== now.rollup_sha) return 'stale';
    for (const j of index.jobs) {
      if (!isRecord(j) || typeof j.job_id !== 'string' || !/^draft-\d{3,6}$/.test(j.job_id)) return 'stale';
      const brief = readText(join(inputDir(root), `${j.job_id}.json`));
      if (brief === null || sha256(brief) !== j.content_sha) return 'stale';
    }
    return 'current';
  } catch {
    return 'stale';
  }
}

// ---- prepare ----

// The prepared messages and threads, who each address is (out/people.json read with the published
// rates), and the validated extractions of the done batches: what the briefs' quotes are placed with.
function quoteInputs(root: string): { validated: ValidatedExtraction[]; messages: Map<string, ParsedMessage>; identity: Identity; threads: Thread[] } {
  const validated = batchViews(root, 'batch')
    .filter((v) => v.status === 'done')
    .map((v) => readJson(root, validatedFile(root, v.entry.id), 'the ledger says this batch is done; run node obs.mjs verify') as ValidatedExtraction);
  const text = readText(join(root, 'out', 'messages.jsonl'));
  if (text === null) throw new ArtifactError('out/messages.jsonl is missing: run node obs.mjs prepare first.');
  const messages = new Map<string, ParsedMessage>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const m = JSON.parse(line) as ParsedMessage;
    messages.set(m.id, m);
  }
  const people = readJson(root, join(root, 'out', 'people.json'), 'run node obs.mjs prepare first.') as Person[];
  let identity: Identity;
  try {
    identity = identityOf(people, loadEffortRates(ratesFile(root)));
  } catch (err) {
    if (err instanceof IdentityError) throw new ArtifactError(err.message);
    throw err;
  }
  return { validated, messages, identity, threads: readJson(root, join(root, 'out', 'threads.json'), 'run node obs.mjs prepare first.') as Thread[] };
}

// Write `text` unless the file already holds exactly it.
function writeIfChanged(file: string, text: string): boolean {
  if (readText(file) === text) return false;
  writeFileAtomic(file, text);
  return true;
}

// The artifacts stage's first step, as `artifacts prepare` and `advance` take it: the briefs, then
// the index that names them (a brief no longer in the index goes). Returns the summary line. Throws
// ArtifactError (or LedgerError, ConfigError), each one line for the caller to print.
export function artifactsPrepareStep(root: string): string {
  const started = performance.now();
  const score = scoreFreshness(root);
  if (score !== 'current') throw new ArtifactError(`out/opportunities.json is ${score === 'missing' ? 'missing' : 'not current'}: run node obs.mjs score first.`);
  const opportunities = readJson(root, opportunitiesFile(root), 'run node obs.mjs score first.') as Opportunities;
  const rollup = readJson(root, rollupFile(root), 'run node obs.mjs rollup first.') as Rollup;
  const { index, briefs } = buildBriefs({ opportunities, rollup, ...quoteInputs(root), shas: currentInputs(root) });
  const keep = new Set<string>();
  for (const b of briefs) {
    writeIfChanged(join(inputDir(root), `${b.job_id}.json`), b.text);
    keep.add(`${b.job_id}.json`);
  }
  let names: string[] = [];
  try {
    names = readdirSync(inputDir(root));
  } catch {
    // no briefs before
  }
  for (const name of names) if (/^draft-\d{3,6}\.json$/.test(name) && !keep.has(name)) removeFile(join(inputDir(root), name));
  writeIfChanged(artifactIndexFile(root), `${JSON.stringify(index, null, 2)}\n`);
  const line = `artifacts: ${plural(index.jobs.length, 'brief')}, ${index.skipped.length} skipped; wrote out/artifacts/index.json.`;
  logStage(root, 'artifacts prepare', started, line);
  return line;
}

// ---- collect ----

// Every file collect writes, by repo-relative path, and the counts its summary gives.
type CollectPlan = { record: string; files: Map<string, string>; counts: Record<Artifacts['artifacts'][number]['status'], number> };

// Why an eligible process has no document, in plain words (artifacts.json is read by people).
const REASONS: Record<string, string> = {
  'artifact_type none': 'no document type was chosen for this process',
  'synthesis missing': 'no description of this process was accepted, so there was nothing to draft from',
};

// What collect would write now, from the index, the ledger, the briefs and the done drafts' bodies.
// `views`: the drafts' ledger views, when the caller has them.
function collectPlan(root: string, views: readonly BatchView[] = batchViews(root, 'draft')): CollectPlan {
  const index = readJson(root, artifactIndexFile(root), 'run node obs.mjs artifacts prepare first.') as ArtifactIndex;
  const byId = new Map(views.map((v) => [v.entry.id, v]));
  const files = new Map<string, string>();
  const counts: CollectPlan['counts'] = { done: 0, failed: 0, exhausted: 0, pending: 0, running: 0, skipped: 0 };
  const rows: Artifacts['artifacts'] = [];
  for (const j of index.jobs) {
    const v = byId.get(j.job_id);
    const status = v?.status ?? 'pending';
    const dispatches = v !== undefined && v.state.cache_key === v.cache_key ? v.state.dispatches : 0;
    let path: string | null = null;
    if (status === 'done') {
      const brief = readJson(root, join(inputDir(root), `${j.job_id}.json`), 'run node obs.mjs artifacts prepare again.') as ArtifactBrief;
      const raw = readText(jobPaths(root, j.job_id).output);
      const record = readJson(root, validatedFile(root, j.job_id), 'run node obs.mjs verify.') as ValidatedDraft;
      const body = raw === null ? null : normalizeNewlines(raw.startsWith(BOM) ? raw.slice(1) : raw);
      if (body === null || sha256(body) !== record.body_sha) {
        throw new ArtifactError(`out/artifacts/raw/${j.job_id}.md is not the body that passed its check; run node obs.mjs verify, then node obs.mjs dispatch ${j.job_id} --force`);
      }
      path = artifactPath(j.slug, j.artifact_type);
      files.set(path, renderArtifact(brief, body));
    }
    counts[status]++;
    const reason =
      status === 'exhausted'
        ? `no usable draft after ${plural(dispatches, 'attempt')}; see the problems in out/ledger/${j.job_id}.json`
        : status === 'failed'
          ? 'the draft did not pass its check; it gets one more attempt'
          : status === 'running'
            ? 'being drafted'
            : status === 'pending'
              ? 'not drafted yet'
              : null;
    rows.push({ key: j.key, rank: j.rank, slug: j.slug, artifact_type: j.artifact_type, status, path, dispatches, reason });
  }
  for (const s of index.skipped) {
    counts.skipped++;
    rows.push({ key: s.key, rank: s.rank, slug: artifactSlug(s.key), artifact_type: 'none', status: 'skipped', path: null, dispatches: 0, reason: REASONS[s.reason] ?? s.reason });
  }
  rows.sort((a, b) => a.rank - b.rank);
  const record: Artifacts = { version: 1, artifacts: rows };
  return { record: `${JSON.stringify(record, null, 2)}\n`, files, counts };
}

// The rendered artifacts on disk now: every file with an artifact type's name in a folder under
// out/artifacts/ that is not one of the stage's own.
function renderedOnDisk(root: string): string[] {
  const found: string[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(artifactsDir(root), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !STAGE_FOLDERS.includes(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const names = new Set(Object.values(ARTIFACT_FILES));
  for (const dir of dirs) {
    let inside: string[] = [];
    try {
      inside = readdirSync(join(artifactsDir(root), dir));
    } catch {
      continue;
    }
    for (const name of inside) if (names.has(name)) found.push(`out/artifacts/${dir}/${name}`);
  }
  return found.sort();
}

// Collected: artifacts.json and every rendered artifact are what collect would write now, and no
// other rendered artifact is left over from earlier inputs. Never throws: anything unreadable is
// not collected.
export function artifactsCollected(root: string, views?: readonly BatchView[]): boolean {
  try {
    const plan = collectPlan(root, views);
    const now = readText(artifactsFile(root));
    if (now === null || normalizeNewlines(now) !== plan.record) return false;
    for (const [path, text] of plan.files) {
      const disk = readText(join(root, path));
      if (disk === null || normalizeNewlines(disk) !== text) return false;
    }
    const disk = renderedOnDisk(root);
    return disk.length === plan.files.size && disk.every((p) => plan.files.has(p));
  } catch {
    return false;
  }
}

// What `verify` checks of the artifacts, beyond re-checking every done draft: every brief still has
// the content_sha the index records, and, once collected, artifacts.json and every rendered artifact
// are byte for byte what collect would write now, with no rendered artifact left over. `checked`:
// whether there was anything to check (an index). Read-only; each failure one line.
export function verifyArtifacts(root: string): { checked: boolean; collected: boolean; failures: string[] } {
  const text = readText(artifactIndexFile(root));
  if (text === null) return { checked: false, collected: false, failures: [] };
  const failures: string[] = [];
  let index: ArtifactIndex;
  try {
    index = JSON.parse(text) as ArtifactIndex;
    if (!isRecord(index) || !Array.isArray(index.jobs)) throw new Error('not an artifact index');
  } catch {
    return { checked: true, collected: false, failures: ['out/artifacts/index.json is not an artifact index'] };
  }
  for (const j of index.jobs) {
    const brief = readText(join(inputDir(root), `${j.job_id}.json`));
    if (brief === null) failures.push(`out/artifacts/input/${j.job_id}.json is missing`);
    else if (sha256(brief) !== j.content_sha) failures.push(`out/artifacts/input/${j.job_id}.json does not match its content_sha in out/artifacts/index.json`);
  }
  const record = readText(artifactsFile(root));
  const rendered = renderedOnDisk(root);
  if (record === null && rendered.length === 0) return { checked: true, collected: false, failures };
  let plan: CollectPlan;
  try {
    plan = collectPlan(root);
  } catch (err) {
    failures.push(`the artifacts cannot be collected: ${err instanceof Error ? err.message : String(err)}`);
    return { checked: true, collected: true, failures };
  }
  if (record === null || normalizeNewlines(record) !== plan.record) failures.push('out/artifacts/artifacts.json differs from what node obs.mjs artifacts collect writes now');
  for (const [path, want] of plan.files) {
    const disk = readText(join(root, path));
    if (disk === null) failures.push(`${path} is missing: node obs.mjs artifacts collect writes it`);
    else if (normalizeNewlines(disk) !== want) failures.push(`${path} differs from what node obs.mjs artifacts collect writes now`);
  }
  for (const path of rendered) if (!plan.files.has(path)) failures.push(`${path} is left over: no done draft renders it`);
  return { checked: true, collected: true, failures };
}

// The artifacts stage's last step, as `artifacts collect` and `advance` take it: render every done
// draft, remove rendered artifacts the current index no longer has, and write artifacts.json.
// Returns the summary line.
export function artifactsCollectStep(root: string): string {
  const started = performance.now();
  const plan = collectPlan(root);
  for (const [path, text] of plan.files) writeIfChanged(join(root, path), text);
  for (const path of renderedOnDisk(root)) {
    if (plan.files.has(path)) continue;
    removeFile(join(root, path));
    const dir = join(root, path, '..');
    try {
      if (readdirSync(dir).length === 0) removeFile(dir);
    } catch {
      // already gone
    }
  }
  writeIfChanged(artifactsFile(root), plan.record);
  const c = plan.counts;
  const parts = [`${c.done} drafted`, `${c.exhausted} exhausted`, ...(c.skipped > 0 ? [`${c.skipped} skipped`] : []), ...(c.pending + c.running + c.failed > 0 ? [`${c.pending + c.running + c.failed} not done`] : [])];
  const line = `artifacts: ${parts.join(', ')}; wrote out/artifacts/artifacts.json.`;
  logStage(root, 'artifacts collect', started, line);
  return line;
}

// ---- The command ----

export const ARTIFACTS_USAGE = 'Usage: node obs.mjs artifacts prepare | collect';

export function artifactsCommand(root: string, args: readonly string[]): number {
  try {
    if (args.length !== 1 || (args[0] !== 'prepare' && args[0] !== 'collect')) throw new ArtifactError(`expected "prepare" or "collect". ${ARTIFACTS_USAGE}`);
    console.log(args[0] === 'prepare' ? artifactsPrepareStep(root) : artifactsCollectStep(root));
    return 0;
  } catch (err) {
    if (err instanceof ArtifactError || err instanceof LedgerError || err instanceof ConfigError) {
      console.error(`artifacts: ${withoutRoot(err.message, root).replace(/\s*\n\s*/g, ' ')}`);
      return 1;
    }
    throw err;
  }
}
