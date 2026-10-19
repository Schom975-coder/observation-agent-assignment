// The build stage (ARCHITECTURE.md 4 stage 15): `node obs.mjs build` writes the dashboard's data and
// the report from a complete run's outputs, with no model call:
//   out/dashboard/data.json, method.json, loops.json, messages/index.json, process/<slug>.json
//   out/dashboard/<every file of dashboard/, copied as found> (the page, its script, the fonts)
//   out/report.html, out/report.md, out/run-summary.json
// It is also the run's stage after drafting: `advance` runs it once the artifacts are collected,
// and the stage ladder reaches `done` only when buildCurrent says the files match their inputs.
// Every file is rewritten only when its bytes would change; the same inputs give the same bytes on
// every OS (no clock, no randomness, no platform-dependent formatting), and data.json records the
// hashes of its inputs and of every other file written, so buildCurrent and a reviewer can check them.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigError, loadEffortRates, loadScoring } from '../config.ts';
import { artifactSlug } from '../model/artifacts.ts';
import { IdentityError, identityOf } from '../normalize/identity.ts';
import { artifactsCollected } from '../run/artifacts.ts';
import {
  LedgerError,
  artifactsFile,
  batchViews,
  fileSha,
  logRunEvent,
  opportunitiesFile,
  readText,
  removeFile,
  rollupFile,
  validatedFile,
  withoutRoot,
  writeFileAtomic,
} from '../run/ledger.ts';
import { ratesFile, rollupFreshness, type ValidationReport } from '../run/rollup.ts';
import { scoreFreshness, scoringFile } from '../run/score.ts';
import { sha256 } from '../util/hash.ts';
import { normalizeNewlines } from '../util/text.ts';
import { FormatError, plural } from './format.ts';
import { BuildError, buildData, type BuildInputs, type BuildOptions, type Built, type RunLog } from './data.ts';
import { buildReport, renderHtml, renderMd, type ReportModel } from './report.ts';
import type { GoldScore } from '../gold/score.ts';
import type { Taxonomy } from '../model/taxonomy.ts';
import type { Artifacts, Coverage, DuplicateGroup, MergeTable, Opportunities, ParsedMessage, Person, Rollup, Thread, ValidatedExtraction } from '../types.ts';
import type { DashboardData } from './types.ts';

export { BuildError };

// Every failure on the build path as one BuildError line: a config, ledger, identity or format
// error, or unreadable JSON, keeps its message on one line; anything else is a bug and is thrown.
function asBuildError(err: unknown, root: string): unknown {
  if (err instanceof BuildError) return err;
  if (err instanceof ConfigError || err instanceof LedgerError || err instanceof IdentityError || err instanceof FormatError || err instanceof SyntaxError) {
    return new BuildError(withoutRoot(err.message, root).replace(/\s*\n\s*/g, ' '));
  }
  return err;
}

export const BUILD_USAGE = 'Usage: node obs.mjs build';

// What the build cannot do without (amendment 3): the report's CSS and the vendored fonts. Every
// other file in dashboard/ (the page, its scripts and styles) is copied as found.
export const REQUIRED_ASSETS = [
  'report.css',
  'fonts/archivo-latin-wght-normal.woff2',
  'fonts/ibm-plex-mono-latin-400-normal.woff2',
  'fonts/ibm-plex-mono-latin-500-normal.woff2',
  'fonts/LICENSE-Archivo.txt',
  'fonts/LICENSE-IBMPlexMono.txt',
  'fonts/SOURCES.md',
] as const;
// The two faces report.html inlines (the page loads all three from fonts/).
const REPORT_FONTS = [
  { family: 'Archivo', weight: '300 800', file: 'fonts/archivo-latin-wght-normal.woff2' },
  { family: 'IBM Plex Mono', weight: '400', file: 'fonts/ibm-plex-mono-latin-400-normal.woff2' },
] as const;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const isBinary = (path: string): boolean => /\.woff2$/i.test(path);
const dashboardDir = (root: string): string => join(root, 'dashboard');
const outDashboard = (root: string): string => join(root, 'out', 'dashboard');
export const dataFile = (root: string): string => join(outDashboard(root), 'data.json');
// The server's own state file in out/dashboard/ (git-ignored): never removed or hashed by the build.
const SERVER_FILE = '.server.json';

// ---- The source assets ----

export type Asset = { path: string; bytes: Buffer };

// Every file under dashboard/, by path ("fonts/x.woff2", "/" separators), sorted. Dot files are left out.
export function readAssets(root: string): Asset[] {
  const dir = dashboardDir(root);
  if (!existsSync(dir)) return [];
  const paths = (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[])
    .map((p) => p.replaceAll('\\', '/'))
    .filter((p) => !p.split('/').some((seg) => seg.startsWith('.')) && statSync(join(dir, p)).isFile())
    .sort(byText);
  return paths.map((path) => ({ path, bytes: readFileSync(join(dir, path)) }));
}

// A file's hash as the build records it: raw bytes for a font, newline-normalised text otherwise, so
// a checkout that converted line endings still reads as current.
const contentSha = (path: string, bytes: Buffer | string): string =>
  isBinary(path) ? sha256(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes) : sha256(normalizeNewlines(typeof bytes === 'string' ? bytes : bytes.toString('utf8')));

export const assetsSha = (assets: readonly Asset[]): string => sha256(assets.map((a) => `${a.path}\n${contentSha(a.path, a.bytes)}\n`).join(''));

// The input hashes a build made now would record (data.json `inputs`). Never throws: a missing file
// hashes as "none".
export function currentBuildInputs(root: string, assets: readonly Asset[] = readAssets(root)): DashboardData['inputs'] {
  const none = sha256('none');
  const out = (f: string) => fileSha(join(root, 'out', f)) ?? none;
  return {
    opportunities_sha: fileSha(opportunitiesFile(root)) ?? none,
    rollup_sha: fileSha(rollupFile(root)) ?? none,
    artifacts_sha: fileSha(artifactsFile(root)) ?? none,
    people_sha: out('people.json'),
    messages_sha: out('messages.jsonl'),
    threads_sha: out('threads.json'),
    assets_sha: assetsSha(assets),
    config_sha: sha256(`${fileSha(ratesFile(root)) ?? none}\n${fileSha(scoringFile(root)) ?? none}\n`),
    gold_sha: out('gold-score.json'),
    synthesizer_sha: synthesizerSha(synthesizerConfig(root)),
  };
}

// The synthesizer's configuration as the build prints it (model and effort), hashed.
const synthesizerSha = (c: { model: string | null; effort: string | null }): string => sha256(`model ${c.model ?? 'none'}\neffort ${c.effort ?? 'none'}\n`);

// ---- Freshness ----

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// Current: out/dashboard/data.json parses, records the inputs as they are now, and every file it
// lists is on disk with the hash it recorded. Never throws.
export function buildCurrent(root: string): boolean {
  try {
    const text = readText(dataFile(root));
    if (text === null) return false;
    const data: unknown = JSON.parse(text);
    if (!isRecord(data) || !isRecord(data.inputs) || !isRecord(data.outputs)) return false;
    const now = currentBuildInputs(root);
    for (const [k, v] of Object.entries(now)) if (data.inputs[k] !== v) return false;
    for (const [path, sha] of Object.entries(data.outputs)) {
      const file = join(root, 'out', ...path.split('/'));
      if (!existsSync(file) || contentSha(path, readFileSync(file)) !== sha) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---- Reading the inputs ----

function readJson<T>(root: string, rel: string, stage: string): T {
  const text = readText(join(root, ...rel.split('/')));
  if (text === null) throw new BuildError(`${rel} is missing: run node obs.mjs ${stage} first.`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BuildError(`${rel} is not valid JSON: run node obs.mjs ${stage} again.`);
  }
}

const RUN_FILE = /^\d{8}T\d{6}Z\.jsonl$/;

// The events of one run log, torn lines skipped.
function readLog(dir: string, id: string): Array<Record<string, unknown>> {
  const text = readText(join(dir, `${id}.jsonl`)) ?? '';
  const events: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
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

// Whether a run did any work before the build's own first stage event: started a subagent, ran a
// stage step other than the build and the run end, or ran a prepare that did not skip itself.
export function didWork(events: ReadonlyArray<Record<string, unknown>>): boolean {
  for (const e of events) {
    if (e.event === 'stage' && e.name === 'build') return false;
    if (e.event === 'SubagentStart') return true;
    if (e.event === 'stage' && e.name !== 'run end') return true;
    if (e.event === 'prepare' && e.skipped !== true) return true;
  }
  return false;
}

// The run the facts describe: the newest run (by its id, which is its start time) that did any work
// (didWork), so a later run that found everything done, or only rebuilt, never replaces the facts of
// the run that made the outputs; with no such run, the newest. Null when there is no run log.
export function runLogOf(root: string): RunLog | null {
  const dir = join(root, 'out', 'runs');
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => RUN_FILE.test(n)).sort(byText).reverse();
  } catch {
    names = [];
  }
  if (names.length === 0) return null;
  const ids = names.map((n) => n.slice(0, -'.jsonl'.length));
  for (const id of ids) {
    const events = readLog(dir, id);
    if (didWork(events)) return { id, path: `out/runs/${id}.jsonl`, events };
  }
  const id = ids[0] as string;
  return { id, path: `out/runs/${id}.jsonl`, events: readLog(dir, id) };
}

// The synthesizer's model and effort, from its agent definition's frontmatter.
export function synthesizerConfig(root: string): { model: string | null; effort: string | null } {
  const text = readText(join(root, '.claude', 'agents', 'synthesizer.md'));
  const front = text === null ? null : /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const field = (name: string): string | null => {
    const m = front === undefined || front === null ? null : new RegExp(`^${name}:[ \\t]*([A-Za-z0-9._-]+)[ \\t]*$`, 'm').exec(front);
    return m === null ? null : (m[1] as string);
  };
  return { model: field('model'), effort: field('effort') };
}

// Everything the build reads, checked in the order of the spec's table: the score, the rollup and
// the artifacts current; the identities; the prepared files, the merge and the taxonomy; the done
// extractions; the config; the assets. Throws BuildError (or ConfigError, LedgerError), one line.
export function loadInputs(root: string): { inputs: BuildInputs; shas: DashboardData['inputs']; assets: Asset[] } {
  try {
    return readInputs(root);
  } catch (err) {
    throw asBuildError(err, root);
  }
}

function readInputs(root: string): { inputs: BuildInputs; shas: DashboardData['inputs']; assets: Asset[] } {
  if (scoreFreshness(root) !== 'current') throw new BuildError('out/opportunities.json is missing or not current: run node obs.mjs score first.');
  if (rollupFreshness(root) !== 'current') throw new BuildError('out/rollup.json is missing or not current: run node obs.mjs rollup first.');
  if (!artifactsCollected(root)) throw new BuildError('the artifacts are not collected: run node obs.mjs artifacts collect first.');
  const rates = loadEffortRates(ratesFile(root));
  const people = readJson<Person[]>(root, 'out/people.json', 'prepare');
  try {
    identityOf(people, rates);
  } catch (err) {
    if (err instanceof IdentityError) throw new BuildError(err.message);
    throw err;
  }
  const messagesText = readText(join(root, 'out', 'messages.jsonl'));
  if (messagesText === null) throw new BuildError('out/messages.jsonl is missing: run node obs.mjs prepare first.');
  const messages: ParsedMessage[] = [];
  try {
    for (const line of messagesText.split('\n')) if (line.trim() !== '') messages.push(JSON.parse(line) as ParsedMessage);
  } catch {
    throw new BuildError('out/messages.jsonl is not valid JSON lines: run node obs.mjs prepare again.');
  }
  const threads = readJson<Thread[]>(root, 'out/threads.json', 'prepare');
  readJson<unknown>(root, 'out/manifest.json', 'prepare');
  const dedup = readJson<{ groups: DuplicateGroup[] }>(root, 'out/dedup.json', 'prepare');
  readJson<unknown>(root, 'out/prepare-stats.json', 'prepare');
  const coverage = readJson<Coverage>(root, 'out/coverage.json', 'rollup');
  const validation = readJson<ValidationReport>(root, 'out/validation-report.json', 'rollup');
  const merge = readJson<MergeTable>(root, 'out/merge.json', 'merge');
  const taxonomy = readJson<Taxonomy>(root, 'out/taxonomy.json', 'taxonomy');
  const opportunities = readJson<Opportunities>(root, 'out/opportunities.json', 'score');
  const rollup = readJson<Rollup>(root, 'out/rollup.json', 'rollup');
  const artifacts = readJson<Artifacts>(root, 'out/artifacts/artifacts.json', 'artifacts collect');
  const validated = batchViews(root, 'batch')
    .filter((v) => v.status === 'done')
    .map((v) => {
      const text = readText(validatedFile(root, v.entry.id));
      if (text === null) throw new BuildError(`out/validated/${v.entry.id}.json is missing: run node obs.mjs verify.`);
      try {
        return JSON.parse(text) as ValidatedExtraction;
      } catch {
        throw new BuildError(`out/validated/${v.entry.id}.json is not valid JSON: run node obs.mjs verify.`);
      }
    });
  const artifactText = new Map<string, string>();
  for (const a of artifacts.artifacts) {
    if (a.status !== 'done' || a.path === null) continue;
    const text = readText(join(root, ...a.path.split('/')));
    if (text === null) throw new BuildError(`${a.path} is missing: run node obs.mjs artifacts collect first.`);
    artifactText.set(a.path, normalizeNewlines(text));
  }
  const scoring = loadScoring(scoringFile(root));
  const goldText = readText(join(root, 'out', 'gold-score.json'));
  let gold: GoldScore | null = null;
  try {
    gold = goldText === null ? null : (JSON.parse(goldText) as GoldScore);
  } catch {
    gold = null;
  }
  const assets = readAssets(root);
  const have = new Set(assets.map((a) => a.path));
  for (const req of REQUIRED_ASSETS) if (!have.has(req)) throw new BuildError(`dashboard/${req} is missing from the repo.`);
  const shas = currentBuildInputs(root, assets);
  const inputs: BuildInputs = {
    opportunities,
    rollup,
    artifacts,
    artifactText,
    people,
    rates,
    scoring,
    messages,
    threads,
    dedup,
    coverage,
    validation,
    merge,
    taxonomy,
    validated,
    gold,
    run: runLogOf(root),
    synthesizer: synthesizerConfig(root),
    files: {
      rates: opportunities.rates_file,
      scoring: 'config/scoring.json',
      rates_sha: opportunities.inputs.rates_sha,
      scoring_sha: opportunities.inputs.scoring_sha,
    },
  };
  return { inputs, shas, assets };
}

// ---- The files ----

export type Rendered = { files: Map<string, string | Buffer>; built: Built; report: ReportModel };

// Every file the build writes, by path under out/ ("dashboard/data.json", "report.md"), from the
// inputs as read. Pure: nothing is written. `redact` replaces every data-text field first (the
// refused-word test).
export function renderOutputs(inputs: BuildInputs, assets: readonly Asset[], shas: DashboardData['inputs'], opts: BuildOptions = {}): Rendered {
  try {
    return render(inputs, assets, shas, opts);
  } catch (err) {
    throw asBuildError(err, '');
  }
}

function render(inputs: BuildInputs, assets: readonly Asset[], shas: DashboardData['inputs'], opts: BuildOptions): Rendered {
  const built = buildData(inputs, opts);
  const files = new Map<string, string | Buffer>();
  for (const a of assets) files.set(`dashboard/${a.path}`, isBinary(a.path) ? a.bytes : normalizeNewlines(a.bytes.toString('utf8')));
  files.set('dashboard/method.json', json(built.method));
  files.set('dashboard/loops.json', json(built.loops));
  files.set('dashboard/messages/index.json', json(built.index));
  for (const p of built.processes) files.set(`dashboard/process/${artifactSlug(p.key)}.json`, json(p));
  const report = buildReport(built.data, built.processes, built.method);
  const byPath = new Map(assets.map((a) => [a.path, a.bytes]));
  const fonts = REPORT_FONTS.map((f) => ({ family: f.family, weight: f.weight, base64: (byPath.get(f.file) as Buffer).toString('base64') }));
  const css = (byPath.get('report.css') as Buffer).toString('utf8');
  const ids = new Set(built.index.map((m) => m.id));
  files.set('report.md', renderMd(report));
  files.set('report.html', renderHtml(report, { css, fonts }, ids));
  files.set('run-summary.json', json(built.summary));
  const outputs: Record<string, string> = {};
  for (const path of [...files.keys()].sort(byText)) outputs[path] = contentSha(path, files.get(path) as string | Buffer);
  const { version, ...rest } = built.data;
  const data: DashboardData = { version, inputs: shas, outputs, ...rest };
  files.set('dashboard/data.json', json(data));
  return { files, built, report };
}

// Write `content` unless the file already holds exactly it. A font (a Buffer) is copied from its
// source in dashboard/ with copyFileSync, byte for byte, to a temporary name and renamed into place.
function writeIfChanged(file: string, content: string | Buffer, source: string | null): boolean {
  if (existsSync(file)) {
    const now = readFileSync(file);
    if (typeof content === 'string' ? now.toString('utf8') === content : now.equals(content)) return false;
  }
  if (typeof content === 'string' || source === null) {
    writeFileAtomic(file, typeof content === 'string' ? content : content.toString('utf8'));
    return true;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  copyFileSync(source, tmp);
  renameSync(tmp, file);
  return true;
}

// Files under out/dashboard/ that the build no longer writes (a process gone from the run, a file
// removed from dashboard/), by path under out/; the server's state file stays.
function leftOver(root: string, keep: ReadonlySet<string>): string[] {
  const dir = outDashboard(root);
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[])
    .map((p) => p.replaceAll('\\', '/'))
    .filter((p) => p !== SERVER_FILE && statSync(join(dir, p)).isFile() && !keep.has(`dashboard/${p}`))
    .map((p) => `dashboard/${p}`)
    .sort(byText);
}

// The build stage's one step, as `build` and `advance` take it: read, build, write what changed,
// remove what is left over, log a `stage` event, and return the summary line.
export function buildStep(root: string): string {
  const started = performance.now();
  const { inputs, shas, assets } = loadInputs(root);
  const { files, built } = renderOutputs(inputs, assets, shas);
  let changed = 0;
  for (const [path, content] of files) {
    const source = typeof content === 'string' ? null : join(dashboardDir(root), ...path.slice('dashboard/'.length).split('/'));
    if (writeIfChanged(join(root, 'out', ...path.split('/')), content, source)) changed++;
  }
  const gone = leftOver(root, new Set(files.keys()));
  for (const path of gone) removeFile(join(root, 'out', ...path.split('/')));
  const rows = built.data.rows;
  const inTotal = rows.filter((r) => r.in_total).length;
  const drafted = rows.filter((r) => r.document?.status === 'done').length;
  const recent = built.loops.filter((l) => l.recent).length;
  const dashboardFiles = [...files.keys()].filter((p) => p.startsWith('dashboard/')).length;
  const line =
    `build: ${plural(rows.length, 'process', 'processes')} (${inTotal} in the total), ${plural(drafted, 'document')}, ${plural(built.loops.length, 'open loop')} (${recent} recent); ` +
    `wrote out/dashboard/ (${plural(dashboardFiles, 'file')}), out/report.html, out/report.md and out/run-summary.json; ${plural(changed, 'file')} changed` +
    (gone.length > 0 ? `, ${plural(gone.length, 'file')} removed.` : '.');
  logRunEvent(root, { event: 'stage', name: 'build', ms: Math.round(performance.now() - started), summary: line });
  return line;
}

export function buildCommand(root: string, args: readonly string[]): number {
  try {
    if (args.length > 0) throw new BuildError(`unexpected argument "${args[0]}". ${BUILD_USAGE}`);
    console.log(buildStep(root));
    return 0;
  } catch (err) {
    const e = asBuildError(err, root);
    if (e instanceof BuildError) {
      console.error(`build: ${withoutRoot(e.message, root).replace(/\s*\n\s*/g, ' ')}`);
      return 1;
    }
    throw err;
  }
}
