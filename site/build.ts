// The project site's generator: node site/build.ts [--out <dir>] [--dist <dir>] [--strict]
//
// Builds the GitHub Pages site into site/dist/ (git-ignored) from what is in the repository at build
// time: site/site.json (the base URL, the pages in nav order), the pages in site/pages/, README.md,
// NOTES.md and BRIEF.md, the files under .claude/, and the run output (--out, default out): the run
// summary, the report, the drafted documents, the coverage, the gold score, the run logs, and the
// dashboard, which site/dashboard.ts copies with every message pre-written. Every figure on the site
// is read from the run output here, or shown as a marker; none is typed into a page. Each page is
// written twice: as HTML and as its Markdown twin, for readers that want text.
//
// Lenient by default: a missing run output, a missing screenshot or a {{name}} placeholder left in
// README.md, NOTES.md or a page shows as a visible marker and the build exits 0. --strict refuses
// all of these, any other token left as written, a link to a repository path Git does not track or
// to an anchor no page defines, and a link with a scheme the site does not use, with one line per
// problem and exit 1; it writes nothing and leaves an earlier build as it was. The site is built in
// a folder beside the dist (<dist>.building) and moved into place only when it is complete.
//
// Deterministic: the same inputs give byte-identical files (no clock, no randomness; the date shown
// is the run's own). No dependency, no network; paths through node:path, text written as UTF-8
// with LF line ends.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { count, date as dayOf, hours, minutesOfSeconds, money, parts, percentTenths } from '../src/report/format.ts';
import { renderMarkdownHtml } from '../src/report/markdown.ts';
import type { RunSummary } from '../src/report/types.ts';
import { runFactsFor, type StageTiming } from '../src/run/summary.ts';
import { writeStaticDashboard, type StaticDashboard } from './dashboard.ts';
import { escapeHtml, githubIds, mdText, renderInline, renderMarkdown } from './markdown.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = dirname(HERE);

// ---- Configuration ----

export type PageDef = {
  file: string;
  nav: string;
  title: string;
  description: string;
  source?: string;
  kind?: 'dashboard' | 'report';
  prefix?: string;
  ids?: string[];
};
export type SiteConfig = { title: string; author: string; base_url: string; repo_url: string; ref: string; note: string; masthead: string; summary: string; pages: PageDef[] };

export type SiteOptions = {
  root?: string; // the repository: README, NOTES, BRIEF, .claude/, and the paths pages link to
  site?: string; // the site's sources (site.json, pages/, diagrams/, assets/, site.css); default <root>/site
  docs?: string; // where README.md, NOTES.md and BRIEF.md are read; default the root
  out?: string; // the run output; default <root>/out
  dist?: string; // default <site>/dist
  strict?: boolean;
};

export type SiteResult = {
  ok: boolean;
  dist: string;
  problems: string[]; // what --strict refuses (in a lenient build: what shows as markers)
  markers: number;
  files: number;
  bytes: number;
  llmsFull: number;
  llmsFullDocuments: boolean; // whether llms-full.txt holds the drafted documents (dropped first over the cap)
  dashboard: StaticDashboard | null;
};

const PLACEHOLDER = /\{\{([a-z0-9_.]+)\}\}/g;
// Anything in double braces: a placeholder, a site token, or a token written wrong.
const ANY_TOKEN = /\{\{[^}\n]*\}\}/g;
const TOKEN = /\{\{(fig|block|shot|diagram):([a-z0-9_-]+)\}\}|\{\{\/diagram\}\}/;
// A line the Markdown renderer passes through as raw HTML in a page (and the twin leaves out).
const HTML_LINE = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$)/;
const LLMS_FULL_CAP = 200 * 1024;
export const NOT_COMMITTED = 'The submitted run’s outputs are not committed yet; this page shows their place.';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const readText = (file: string): string => readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
const posixRel = (from: string, to: string): string => relative(from, to).split(sep).join('/');
const oneLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
const marker = (name: string): string => `[to fill: ${name}]`;
// Sizes to one decimal: "10.5 KB", "14.2 MB".
function tenthsOf(bytes: number, unit: number): string {
  const t = Math.round((bytes * 10) / unit);
  return `${count(Math.floor(t / 10))}.${t % 10}`;
}
const kb = (bytes: number): string => `${tenthsOf(bytes, 1024)} KB`;
const mb = (bytes: number): string => `${tenthsOf(bytes, 1024 * 1024)} MB`;
const cap = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
// Element text: only what HTML needs escaped there, so the note's wording stays exact in the page.
const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function loadConfig(siteDir: string): SiteConfig {
  const raw = readJson(join(siteDir, 'site.json'));
  if (!isRecord(raw) || !Array.isArray(raw.pages)) throw new Error('site.json: expected an object with a pages list');
  const cfg = raw as unknown as SiteConfig;
  for (const k of ['title', 'author', 'base_url', 'repo_url', 'ref', 'note', 'masthead', 'summary'] as const) {
    if (typeof cfg[k] !== 'string' || cfg[k] === '') throw new Error(`site.json: ${k} must be a non-empty string`);
  }
  if (!cfg.base_url.endsWith('/')) throw new Error('site.json: base_url must end with /');
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(cfg.repo_url)) throw new Error('site.json: repo_url must be https://github.com/<owner>/<repo>');
  return cfg;
}

// ---- The run output ----

type ArtifactEntry = { key: string; rank: number; slug: string; artifact_type: string; status: string; path: string | null; reason: string | null };
type Doc = { entry: ArtifactEntry; title: string; text: string };
type RunData = {
  out: string;
  project: string;
  summary: RunSummary | null;
  processes: number | null;
  inTotal: string | null;
  scope: string | null;
  threshold: string | null;
  artifacts: ArtifactEntry[] | null;
  docs: Doc[];
  gold: { exact: [number, number]; overlap: [number, number]; role: [number, number] } | null;
  logs: Array<{ name: string; bytes: number }>;
  stages: StageTiming[] | null;
  stagesProblem: string | null;
  dashboard: boolean;
  missing: string[];
};

const AGENT_ORDER = ['taxonomist', 'extractor', 'merger', 'synthesizer', 'drafter'];
const TYPE_WORDS: Record<string, string> = { sop: 'SOP', checklist: 'checklist', email_template: 'email template', template: 'template' };
// Where a drafted document may be: code writes out/artifacts/<process>/<type>.md.
const DOCUMENT_PATH = /^out\/artifacts\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_-]*\.md$/;

function goldPair(v: unknown): [number, number] | null {
  return isRecord(v) && typeof v.agree === 'number' && typeof v.of === 'number' ? [v.agree, v.of] : null;
}

function loadRun(outDir: string): RunData {
  const project = dirname(outDir);
  const run: RunData = {
    out: outDir,
    project,
    summary: null,
    processes: null,
    inTotal: null,
    scope: null,
    threshold: null,
    artifacts: null,
    docs: [],
    gold: null,
    logs: [],
    stages: null,
    stagesProblem: null,
    dashboard: false,
    missing: [],
  };
  const at = (rel: string) => join(outDir, ...rel.split('/'));
  // The rank the dashboard shows each process at, so the documents list agrees with it.
  const shownRanks = new Map<string, number>();
  const need = (rel: string): boolean => {
    if (existsSync(at(rel))) return true;
    run.missing.push(rel);
    return false;
  };
  if (need('run-summary.json')) {
    const s = readJson(at('run-summary.json'));
    if (isRecord(s) && isRecord(s.run) && isRecord(s.headline) && isRecord(s.coverage)) run.summary = s as unknown as RunSummary;
    else run.missing.push('run-summary.json (unreadable)');
  }
  need('report.html');
  need('report.md');
  need('coverage.json');
  need('manifest.json');
  if (need('dashboard/data.json')) {
    const d = readJson(at('dashboard/data.json'));
    if (isRecord(d) && Array.isArray(d.rows) && isRecord(d.headline)) {
      run.processes = d.rows.length;
      for (const r of d.rows) if (isRecord(r) && typeof r.key === 'string' && typeof r.rank === 'number') shownRanks.set(r.key, r.rank);
      const h = d.headline;
      run.inTotal = isRecord(h.rows_in_total) && typeof h.rows_in_total.t === 'string' ? h.rows_in_total.t : null;
      run.scope = typeof h.label === 'string' ? h.label : null;
      run.threshold = isRecord(d.sentences) && typeof d.sentences.threshold === 'string' ? d.sentences.threshold : null;
      run.dashboard = true;
    } else run.missing.push('dashboard/data.json (unreadable)');
  }
  if (need('artifacts/artifacts.json')) {
    const a = readJson(at('artifacts/artifacts.json'));
    if (isRecord(a) && Array.isArray(a.artifacts)) {
      run.artifacts = (a.artifacts as unknown[])
        .filter(isRecord)
        .map((x) => ({
          key: String(x.key),
          rank: shownRanks.get(String(x.key)) ?? Number(x.rank),
          slug: String(x.slug),
          artifact_type: String(x.artifact_type),
          status: String(x.status),
          path: typeof x.path === 'string' ? x.path : null,
          reason: typeof x.reason === 'string' ? x.reason : null,
        }))
        .sort((p, q) => p.rank - q.rank || (p.key < q.key ? -1 : 1));
      for (const e of run.artifacts) {
        if (e.status !== 'done' || e.path === null) continue;
        if (!/^[a-z0-9][a-z0-9-]*$/.test(e.slug) || !DOCUMENT_PATH.test(e.path)) {
          run.missing.push(`a drafted document at an unexpected path (${e.slug})`);
          continue;
        }
        const rel = e.path.slice('out/'.length);
        if (!need(rel)) continue;
        const text = readText(at(rel));
        const title = /^# +(.+)$/m.exec(text)?.[1]?.trim() ?? `${e.key}: ${TYPE_WORDS[e.artifact_type] ?? e.artifact_type}`;
        run.docs.push({ entry: e, title, text });
      }
    } else run.missing.push('artifacts/artifacts.json (unreadable)');
  }
  if (existsSync(at('gold-score.json'))) {
    const g = readJson(at('gold-score.json'));
    if (isRecord(g)) {
      const exact = goldPair(g.exact);
      const overlap = goldPair(g.overlap);
      const role = goldPair(g.role);
      if (exact !== null && overlap !== null && role !== null) run.gold = { exact, overlap, role };
    }
  }
  if (existsSync(at('runs'))) {
    run.logs = readdirSync(at('runs'))
      .filter((f) => f.endsWith('.jsonl') && f !== 'adhoc.jsonl' && f !== 'stream.jsonl')
      .sort()
      .map((name) => ({ name, bytes: statSync(join(at('runs'), name)).size }));
  }
  if (run.logs.length === 0) run.missing.push('runs/*.jsonl');
  // The stage timeline, from the run log span, as `node obs.mjs summary` prints it. It reads
  // <project>/out, so it needs the output folder to be a project's out/.
  if (run.summary !== null) {
    if (basename(outDir) !== 'out') run.stagesProblem = 'the stage timeline needs the run output in a folder named out';
    else {
      try {
        const facts = runFactsFor(project);
        if (facts === null || facts.stages.length === 0) run.stagesProblem = 'no stages in the run log';
        else run.stages = facts.stages;
      } catch (err) {
        run.stagesProblem = `the run log could not be read: ${oneLine(err)}`;
      }
    }
  }
  return run;
}

// ---- Figures: the named values a page can place with {{fig:name}} (site/pages/README.md) ----

function figures(run: RunData): Map<string, string> {
  const f = new Map<string, string>();
  const s = run.summary;
  if (s !== null) {
    const c = s.coverage;
    const files = Object.values(c).reduce((a, b) => a + b, 0);
    const h = s.headline;
    const [counted, estimated] = parts([h.counted_cents, h.estimated_cents], h.total_cents, ['counted', 'estimated']);
    const agents = Object.values(s.run.agents).reduce((a, b) => a + b, 0);
    f.set('messages_read', count(files));
    f.set('unique', count(files - c.duplicates));
    f.set('duplicates', count(c.duplicates));
    f.set('counted_messages', count(c.counted));
    f.set('headline', money(h.total_cents, 'total'));
    f.set('headline_counted', counted as string);
    f.set('headline_estimated', estimated as string);
    f.set('headline_low', money(h.low_cents, 'total'));
    f.set('headline_high', money(h.high_cents, 'total'));
    f.set('hours', hours(h.hours_x100));
    f.set('documents', count(s.artifacts.drafted));
    if (s.run.wall_seconds !== null) f.set('wall_minutes', minutesOfSeconds(s.run.wall_seconds));
    f.set('agents', count(agents));
    f.set('fix_rounds', count(s.run.fix_rounds));
    f.set('quotes_exact', count(s.quotes.exact));
    f.set('quotes_repaired', count(s.quotes.repaired));
    f.set('quotes_rejected', count(s.quotes.rejected));
    f.set('loops_recent', count(s.loops.recent));
    f.set('loops_all', count(s.loops.all));
    if (s.run.id !== null) {
      f.set('run_id', s.run.id);
      const d = /^(\d{4})(\d{2})(\d{2})T/.exec(s.run.id);
      if (d !== null) f.set('run_date', dayOf(`${d[1]}-${d[2]}-${d[3]}`));
    }
  }
  if (run.processes !== null) f.set('processes', count(run.processes));
  if (run.inTotal !== null) f.set('processes_in_total', run.inTotal);
  if (run.scope !== null) f.set('scope', run.scope);
  if (run.threshold !== null) f.set('threshold_sentence', run.threshold);
  if (run.gold !== null) f.set('gold_exact', percentTenths(run.gold.exact[0], run.gold.exact[1]));
  return f;
}

export const FIGURE_NAMES = [
  'messages_read', 'unique', 'duplicates', 'counted_messages', 'headline', 'headline_counted', 'headline_estimated', 'headline_low',
  'headline_high', 'hours', 'documents', 'wall_minutes', 'agents', 'fix_rounds', 'quotes_exact', 'quotes_repaired', 'quotes_rejected',
  'loops_recent', 'loops_all', 'run_id', 'run_date', 'processes', 'processes_in_total', 'scope', 'threshold_sentence', 'gold_exact',
];

// ---- The repository as Git sees it ----

// The paths Git tracks, and every folder above them; null outside a Git checkout, where the disk is
// asked instead. A page may link only to what a reader can open on GitHub.
type Tracked = { files: Set<string>; dirs: Set<string> } | null;
function trackedPaths(root: string): Tracked {
  const r = spawnSync('git', ['ls-files', '-z', '--cached'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) return null;
  const files = new Set(r.stdout.split('\0').filter((p) => p !== ''));
  const dirs = new Set<string>();
  for (const f of files) for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i));
  return { files, dirs };
}

// ---- The .claude layer ----

type Front = { fields: Record<string, string>; body: string };
function frontmatter(text: string): Front {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (m === null) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of (m[1] as string).split('\n')) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (kv !== null) fields[kv[1] as string] = (kv[2] as string).replace(/^"(.*)"$/, '$1').trim();
  }
  return { fields, body: text.slice(m[0].length) };
}
const firstParagraph = (body: string): string => (body.trim().split(/\n[ \t]*\n/)[0] ?? '').replace(/\s*\n\s*/g, ' ').trim();
// The first sentence of a description or a header comment, across its lines: up to the first period
// outside parentheses that ends a word (followed by a blank or the end); one is added when there is
// none.
function firstSentence(text: string): string {
  const s = text.trim().replace(/\s+/g, ' ');
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === '.' && depth === 0 && (i + 1 === s.length || s[i + 1] === ' ')) return s.slice(0, i + 1);
  }
  return s === '' ? s : `${s.replace(/[;:,]$/, '')}.`;
}

export type AgentInfo = { name: string; file: string; model: string; effort: string; tools: string; maxTurns: string; permissionMode: string; role: string; excerpt: string };
type SkillInfo = { name: string; file: string; allowed: string; disable: string; effort: string; role: string };
type HookInfo = { file: string; events: string[]; role: string };
type ClaudeLayer = { files: Array<{ path: string; bytes: number }>; agents: AgentInfo[]; skills: SkillInfo[]; hooks: HookInfo[]; settings: Record<string, unknown> | null };

export function readAgents(root: string): AgentInfo[] {
  const dir = join(root, '.claude', 'agents');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  const agents = files.map((f) => {
    const { fields, body } = frontmatter(readText(join(dir, f)));
    const desc = (fields.description ?? '').replace(/^Pipeline stage\.\s*/, '');
    return {
      name: fields.name ?? f.replace(/\.md$/, ''),
      file: `.claude/agents/${f}`,
      model: fields.model ?? '',
      effort: fields.effort ?? '',
      tools: fields.tools ?? '',
      maxTurns: fields.maxTurns ?? '',
      permissionMode: fields.permissionMode ?? '',
      role: firstSentence(desc),
      excerpt: firstParagraph(body),
    };
  });
  const rank = (n: string) => (AGENT_ORDER.includes(n) ? AGENT_ORDER.indexOf(n) : AGENT_ORDER.length);
  return agents.sort((a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : 1));
}

// The files under .claude/ as committed (Git's list), or, outside a Git checkout, as on disk
// without the user's local settings.
function claudeFiles(root: string, tracked: Tracked): Array<{ path: string; bytes: number }> {
  let paths: string[];
  if (tracked !== null) paths = [...tracked.files].filter((p) => p.startsWith('.claude/'));
  else {
    const dir = join(root, '.claude');
    paths = existsSync(dir)
      ? (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[])
          .map((p) => `.claude/${p.split(sep).join('/')}`)
          .filter((p) => statSync(join(root, ...p.split('/'))).isFile() && !/\.local\./.test(p))
      : [];
  }
  return paths
    .filter((p) => existsSync(join(root, ...p.split('/'))))
    .sort()
    .map((path) => ({ path, bytes: statSync(join(root, ...path.split('/'))).size }));
}

function readClaude(root: string, tracked: Tracked): ClaudeLayer {
  const files = claudeFiles(root, tracked);
  const agents = readAgents(root);
  const skills: SkillInfo[] = [];
  const skillDir = join(root, '.claude', 'skills');
  if (existsSync(skillDir)) {
    for (const d of readdirSync(skillDir).sort()) {
      const file = join(skillDir, d, 'SKILL.md');
      if (!existsSync(file)) continue;
      const { fields } = frontmatter(readText(file));
      skills.push({
        name: fields.name ?? d,
        file: `.claude/skills/${d}/SKILL.md`,
        allowed: fields['allowed-tools'] ?? '',
        disable: fields['disable-model-invocation'] ?? 'false',
        effort: fields.effort ?? '',
        role: firstSentence(fields.description ?? ''),
      });
    }
  }
  let settings: Record<string, unknown> | null = null;
  const settingsFile = join(root, '.claude', 'settings.json');
  if (existsSync(settingsFile)) {
    const s = readJson(settingsFile);
    if (isRecord(s)) settings = s;
  }
  const events = new Map<string, string[]>();
  if (settings !== null && isRecord(settings.hooks)) {
    for (const [event, entries] of Object.entries(settings.hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const e of entries) {
        if (!isRecord(e) || !Array.isArray(e.hooks)) continue;
        const matcher = typeof e.matcher === 'string' ? e.matcher : null;
        for (const h of e.hooks) {
          if (!isRecord(h) || !Array.isArray(h.args)) continue;
          const name = /([\w-]+\.ts)$/.exec(String(h.args[0] ?? ''))?.[1];
          if (name === undefined) continue;
          const list = events.get(name) ?? [];
          list.push(matcher === null || matcher === '*' ? `${event}${matcher === '*' ? ' (every tool)' : ''}` : `${event} (${matcher.split('|').join(', ')})`);
          events.set(name, list);
        }
      }
    }
  }
  const hooks: HookInfo[] = [];
  const hookDir = join(root, '.claude', 'hooks');
  if (existsSync(hookDir)) {
    for (const f of readdirSync(hookDir).filter((x) => x.endsWith('.ts')).sort()) {
      const head: string[] = [];
      for (const line of readText(join(hookDir, f)).split('\n')) {
        if (!line.startsWith('//')) break;
        head.push(line.replace(/^\/\/ ?/, ''));
      }
      hooks.push({ file: `.claude/hooks/${f}`, events: events.get(f) ?? [], role: firstSentence(head.join(' ')) });
    }
  }
  return { files, agents, skills, hooks, settings };
}

// ---- Screenshots: the files site/assets/screenshots/README.md names, with their alt text ----

type Shot = { file: string; alt: string; present: boolean };
function readShots(siteDir: string): Shot[] {
  const dir = join(siteDir, 'assets', 'screenshots');
  const listing = join(dir, 'README.md');
  if (!existsSync(listing)) return [];
  const shots: Shot[] = [];
  for (const line of readText(listing).split('\n')) {
    const m = /^\|\s*`([a-z0-9-]+\.png)`\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (m !== null) shots.push({ file: m[1] as string, alt: (m[2] as string).trim(), present: existsSync(join(dir, m[1] as string)) });
  }
  return shots;
}

// ---- Links ----

// A link target in a page's Markdown: a site page ("run.html#facts"), a repository path written by
// hand ("/src/metrics/score.ts", checked by --strict) or by the generator ("repo:out/runs/x.jsonl",
// not checked: it names the run output given), a commit ("commit:63ffa97"), a fragment, a URL, or
// a scheme the site never uses ("javascript:"), which is refused.
type LinkTarget = { kind: 'site' | 'repo' | 'commit' | 'external' | 'fragment' | 'refused'; href: string; checked: boolean };

function classify(href: string): LinkTarget {
  if (/^(https?:|mailto:)/i.test(href)) return { kind: 'external', href, checked: false };
  if (href.startsWith('commit:')) return { kind: 'commit', href: href.slice('commit:'.length), checked: true };
  if (href.startsWith('repo:')) return { kind: 'repo', href: href.slice('repo:'.length), checked: false };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || href.startsWith('//')) return { kind: 'refused', href, checked: true };
  if (href.startsWith('#')) return { kind: 'fragment', href, checked: false };
  if (href.startsWith('/')) return { kind: 'repo', href: href.slice(1), checked: true };
  return { kind: 'site', href, checked: true };
}

type Ctx = {
  cfg: SiteConfig;
  root: string;
  siteDir: string;
  docsDir: string;
  run: RunData;
  figs: Map<string, string>;
  claude: ClaudeLayer;
  tracked: Tracked;
  shots: Shot[];
  dash: StaticDashboard | null;
  dashProblem: string | null;
  problems: string[];
  markers: { n: number };
  repoLinks: Array<{ from: string; path: string; fragment: string | null }>;
};

const inRepo = (ctx: Ctx, path: string): boolean =>
  path === '' || (ctx.tracked === null ? existsSync(join(ctx.root, ...path.split('/'))) : ctx.tracked.files.has(path) || ctx.tracked.dirs.has(path));
const isRepoDir = (ctx: Ctx, path: string): boolean =>
  ctx.tracked === null ? existsSync(join(ctx.root, ...path.split('/'))) && statSync(join(ctx.root, ...path.split('/'))).isDirectory() : ctx.tracked.dirs.has(path);

function repoUrl(ctx: Ctx, path: string): string {
  const [p, frag] = path.split('#', 2) as [string, string | undefined];
  const clean = p.replace(/^\.\//, '').replace(/\/$/, '');
  const dir = p.endsWith('/') || isRepoDir(ctx, clean);
  const url = clean === '' ? ctx.cfg.repo_url : `${ctx.cfg.repo_url}/${dir ? 'tree' : 'blob'}/${ctx.cfg.ref}/${clean}`;
  return frag === undefined ? url : `${url}#${frag}`;
}
// An image in the repository, as the raw file (a blob URL is a page, not the image).
const rawUrl = (ctx: Ctx, path: string): string => `${ctx.cfg.repo_url.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/${ctx.cfg.ref}/${path.replace(/^\.?\//, '')}`;

// A link's address in a Markdown twin: a page of the site points at that page's twin; the report
// (report.html, a separate artifact with its own report.md) and the dashboard copy keep their HTML.
function twinUrl(cfg: SiteConfig, page: string, href: string): string {
  if (href.startsWith('#')) return `${cfg.base_url}${page}.md${href}`;
  const [p, frag] = href.split('#', 2) as [string, string | undefined];
  let target = p;
  if (/\.html$/.test(p) && p !== 'report.html' && !p.startsWith('dashboard/')) target = p.replace(/\.html$/, '.md');
  return `${cfg.base_url}${target}${frag === undefined ? '' : `#${frag}`}`;
}

// Rewrites every Markdown link target outside fenced blocks and code spans.
function rewriteMdLinks(md: string, fn: (href: string) => string): string {
  let fence: string | null = null;
  return md
    .split('\n')
    .map((line) => {
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (f !== null) {
        const m = f[1] as string;
        if (fence === null) fence = m;
        else if (m[0] === fence[0] && m.length >= fence.length) fence = null;
        return line;
      }
      if (fence !== null) return line;
      return line
        .split(/(`+[^`]*`+)/)
        .map((seg, k) => (k % 2 === 1 ? seg : seg.replace(/\]\(([^)\s]+)/g, (_m, h: string) => `](${fn(h)}`)))
        .join('');
    })
    .join('\n');
}

// Every line outside fenced blocks, with its number.
function unfenced(text: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  let fence: string | null = null;
  text.split('\n').forEach((line, i) => {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f !== null) {
      const m = f[1] as string;
      if (fence === null) fence = m;
      else if (m[0] === fence[0] && m.length >= fence.length) fence = null;
      return;
    }
    if (fence === null) out.push([i + 1, line]);
  });
  return out;
}

// ---- Generated blocks (Markdown, rendered on the page and kept in the twin) ----

const cell = (s: string): string => mdText(s);
// A code span for a generated table cell: a pipe is escaped, as GitHub tables need even inside code.
const code = (s: string): string => `\`${s.replace(/`/g, '').replace(/\|/g, '\\|')}\``;
const repoLink = (path: string, text = path): string => `[${code(text)}](repo:${path})`;

function block(name: string, ctx: Ctx, from: string): string {
  const run = ctx.run;
  const s = run.summary;
  const notYet = (what: string) => {
    ctx.markers.n++;
    return marker(what);
  };
  switch (name) {
    case 'pages':
      return ctx.cfg.pages
        .filter((p) => p.file !== 'index')
        .map((p) => `- [${p.title}](${pageHref(p)}): ${p.description}`)
        .join('\n');
    case 'run_facts': {
      if (s === null) return notYet('run facts (out/run-summary.json)');
      const agents = Object.entries(s.run.agents).sort(([a], [b]) => AGENT_ORDER.indexOf(a) - AGENT_ORDER.indexOf(b) || (a < b ? -1 : 1));
      const total = agents.reduce((a, [, n]) => a + n, 0);
      const c = s.coverage;
      const files = Object.values(c).reduce((a, b) => a + b, 0);
      const h = s.headline;
      const [counted, estimated] = parts([h.counted_cents, h.estimated_cents], h.total_cents, ['counted', 'estimated']);
      const later = s.run.later_runs.length;
      const mergeWords: Record<string, string> = {
        slugs: 'proposed keys',
        mapped: 'mapped to a taxonomy key',
        promoted: 'promoted processes',
        aliases: 'aliases of promoted processes',
        unassigned: 'left unassigned',
        demoted: 'demoted by the size check',
        messages_mapped: 'messages mapped',
        messages_promoted: 'messages in promoted processes',
        messages_unassigned: 'messages left unassigned',
      };
      const folds = Object.entries(s.folds);
      const rows: Array<[string, string]> = [
        ['Run', `${code(s.run.id ?? 'unknown')}${ctx.figs.has('run_date') ? `, ${ctx.figs.get('run_date')}` : ''}${later > 0 ? `, continued in ${count(later)} later ${later === 1 ? 'run' : 'runs'}` : ''}`],
        ['Run time', s.run.wall_seconds === null ? 'not recorded' : `${minutesOfSeconds(s.run.wall_seconds)} minutes: from each run’s first event to its last step of work, summed over the runs`],
        ['Subagents started', `${count(total)}: ${agents.map(([a, n]) => `${count(n)} ${n === 1 ? a : `${a}s`}`).join(', ')}`],
        ['Fix rounds', count(s.run.fix_rounds)],
        ['Quotes checked against the raw bytes', `${count(s.quotes.exact)} exact, ${count(s.quotes.repaired)} repaired, ${count(s.quotes.rejected)} rejected`],
        ['Merge', Object.entries(s.merge).map(([k, n]) => `${count(n)} ${mergeWords[k] ?? k.replace(/_/g, ' ')}`).join('; ')],
        ['Work estimates', `${count(s.estimates.accepted)} accepted, ${count(s.estimates.missing)} missing, ${count(s.estimates.overridden)} overridden`],
        ['Coverage', `${count(files)} files = ${Object.entries(c).map(([k, n]) => `${count(n)} ${k}`).join(' + ')}`],
        ['Headline (tiers A and B)', `${money(h.total_cents, 'total')} a month = ${counted} counted + ${estimated} estimated; the estimates put it between ${money(h.low_cents, 'total')} and ${money(h.high_cents, 'total')}; ${hours(h.hours_x100)} hours a month`],
        ['Documents', `${count(s.artifacts.drafted)} drafted, ${count(s.artifacts.exhausted)} exhausted, ${count(s.artifacts.skipped)} skipped, ${count(s.artifacts.failed)} failed`],
        ['Open loops', `${count(s.loops.all)} threads end on a chase or a wait for an answer; ${count(s.loops.recent)} of them in the last 90 days of their mailbox`],
        ['Identity folds', `${count(folds.reduce((a, [, n]) => a + n, 0))} addresses folded into another: ${folds.map(([k, n]) => `${count(n)} ${k.replace(/_/g, ' ')}`).join(', ')}`],
        ['Contradictions dropped', count(s.contradictions_dropped)],
      ];
      if (run.gold !== null) {
        const g = run.gold;
        rows.push(['Tagging accuracy (gold set)', `${percentTenths(g.exact[0], g.exact[1])} exact (${count(g.exact[0])} of ${count(g.exact[1])}), ${percentTenths(g.overlap[0], g.overlap[1])} overlap, ${percentTenths(g.role[0], g.role[1])} role`]);
      } else rows.push(['Tagging accuracy (gold set)', notYet('out/gold-score.json')]);
      return ['| Fact | Value |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
    }
    case 'timeline': {
      if (s === null) return notYet('stage timeline (out/run-summary.json)');
      if (run.stages === null) {
        ctx.problems.push(`stage timeline: ${run.stagesProblem ?? 'not read'}`);
        return notYet('stage timeline: the run log could not be read (the build lists why)');
      }
      const mmss = (sec: number) => {
        const t = Math.round(sec);
        return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      };
      return [
        '| Stage | Time (m:ss) | Jobs | Subagents | Fix rounds |',
        '|---|---:|---:|---:|---:|',
        ...run.stages.map((st) => `| ${cell(st.stage)} | ${mmss(st.seconds)} | ${count(st.jobs)} | ${count(st.agents)} | ${count(st.fix_rounds)} |`),
      ].join('\n');
    }
    case 'logs': {
      if (run.logs.length === 0) return notYet('the run logs (out/runs/)');
      return ['| Log | What it is | Size |', '|---|---|---:|', ...orderedLogs(run).map((l) => `| [${code(l.name)}](repo:out/runs/${l.name}) | ${l.what} | ${kb(l.bytes)} |`)].join('\n');
    }
    case 'documents': {
      if (run.artifacts === null) return notYet('the drafted documents (out/artifacts/artifacts.json)');
      if (run.artifacts.length === 0) return 'No opportunity cleared the drafting threshold in this run.';
      const status = (e: ArtifactEntry) =>
        e.status === 'done' ? 'drafted' : e.status === 'exhausted' ? 'not drafted: it failed its check twice' : e.reason === null ? e.status : `${e.status}: ${e.reason}`;
      const lines = ['| Rank | Document | Type | Status |', '|---:|---|---|---|'];
      for (const e of run.artifacts) {
        const doc = run.docs.find((d) => d.entry === e);
        const name = doc === undefined ? cell(e.key) : `[${cell(doc.title)}](documents/${e.slug}.html)`;
        lines.push(`| ${count(e.rank)} | ${name} | ${TYPE_WORDS[e.artifact_type] ?? cell(e.artifact_type)} | ${cell(status(e))} |`);
      }
      return lines.join('\n');
    }
    case 'dashboard_copy': {
      if (ctx.dash !== null) {
        return `The copy holds ${count(ctx.dash.messages)} messages, ${count(ctx.dash.files)} files in all, ${mb(ctx.dash.bytes)}. [Open it](dashboard/index.html).`;
      }
      return notYet(ctx.run.dashboard ? 'the dashboard copy (written when the site is built)' : 'the dashboard copy (out/dashboard/)');
    }
    case 'claude_files':
      return ['| File | Size | Role |', '|---|---:|---|', ...ctx.claude.files.map((f) => `| ${repoLink(f.path)} | ${kb(f.bytes)} | ${cell(fileRole(f.path, ctx.claude))} |`)].join('\n');
    case 'agents': {
      const lines = ['| Agent | Model | Effort | Tools | Max turns | Permission mode |', '|---|---|---|---|---:|---|'];
      for (const a of ctx.claude.agents) lines.push(`| ${repoLink(a.file, a.name)} | ${code(a.model)} | ${code(a.effort)} | ${cell(a.tools)} | ${cell(a.maxTurns)} | ${code(a.permissionMode)} |`);
      lines.push('');
      for (const a of ctx.claude.agents) lines.push(`### ${a.name} {#agent-${a.name}}`, '', `${cell(a.role)}`, '', `> ${a.excerpt}`, '');
      return lines.join('\n').trimEnd();
    }
    case 'skills': {
      const tools = (s2: string) => (s2.match(/[A-Za-z]+(?:\([^)]*\))?/g) ?? []).map(code).join(' ');
      return [
        '| Skill | Allowed tools | Model can invoke it | Effort | What it does |',
        '|---|---|---|---|---|',
        ...ctx.claude.skills.map((k) => `| ${repoLink(k.file, `/${k.name}`)} | ${tools(k.allowed)} | ${k.disable === 'true' ? 'no' : 'yes'} | ${k.effort === '' ? 'the session’s' : code(k.effort)} | ${cell(k.role)} |`),
      ].join('\n');
    }
    case 'hooks':
      return [
        '| Hook | Fires on | What it does |',
        '|---|---|---|',
        ...ctx.claude.hooks.map((k) => `| ${repoLink(k.file, basename(k.file))} | ${k.events.length === 0 ? 'not wired: shared code' : cell(k.events.join('; '))} | ${cell(k.role)} |`),
      ].join('\n');
    case 'settings': {
      const st = ctx.claude.settings;
      if (st === null) return 'There is no `.claude/settings.json`.';
      const perms = isRecord(st.permissions) ? st.permissions : {};
      const list = (v: unknown) => (Array.isArray(v) && v.length > 0 ? v.map((x) => code(String(x))).join(', ') : 'none');
      const lines = [`- Allowed without asking: ${list(perms.allow)}.`, `- Denied in every mode: ${list(perms.deny)}.`, '', '| Event | Matcher | Runs | Timeout (s) |', '|---|---|---|---:|'];
      if (isRecord(st.hooks)) {
        for (const [event, entries] of Object.entries(st.hooks)) {
          if (!Array.isArray(entries)) continue;
          for (const e of entries) {
            if (!isRecord(e) || !Array.isArray(e.hooks)) continue;
            for (const h of e.hooks) {
              if (!isRecord(h)) continue;
              const script = /([\w-]+\.ts)$/.exec(Array.isArray(h.args) ? String(h.args[0] ?? '') : '')?.[1] ?? String(h.command ?? '');
              lines.push(`| ${event} | ${typeof e.matcher === 'string' ? code(e.matcher) : 'every stop'} | ${code(`node ${script}`)} | ${typeof h.timeout === 'number' ? count(h.timeout) : ''} |`);
            }
          }
        }
      }
      return lines.join('\n');
    }
    default:
      ctx.problems.push(`${from}: unknown block {{block:${name}}}`);
      return marker(`block ${name}`);
  }
}

function fileRole(path: string, claude: ClaudeLayer): string {
  const agent = claude.agents.find((a) => a.file === path);
  if (agent !== undefined) return `The ${agent.name} subagent: ${agent.role.charAt(0).toLowerCase()}${agent.role.slice(1)}`;
  const skill = claude.skills.find((k) => k.file === path);
  if (skill !== undefined) return `The /${skill.name} skill: ${skill.role.charAt(0).toLowerCase()}${skill.role.slice(1)}`;
  const hook = claude.hooks.find((h) => h.file === path);
  if (hook !== undefined) return hook.role;
  const known: Record<string, string> = {
    '.claude/settings.json': 'Permissions and the hook wiring.',
    '.claude/plan/ARCHITECTURE.md': 'The design: stages, data contracts, decisions, the Claude Code layer, tests and the build order.',
    '.claude/notes/DECISIONS.md': 'One line per non-obvious choice: what was chosen, what was rejected, and why.',
    '.claude/notes/NOTES-LOG.md': 'The running log NOTES.md was written from.',
  };
  return known[path] ?? '';
}

// Every role line the Claude Code layer page and llms.txt show: each file's, each agent's, each
// skill's and each hook's.
export function claudeRoles(root: string): Array<[string, string]> {
  const claude = readClaude(root, trackedPaths(root));
  return [
    ...claude.files.map((f): [string, string] => [f.path, fileRole(f.path, claude)]),
    ...claude.agents.map((a): [string, string] => [a.file, a.role]),
    ...claude.skills.map((k): [string, string] => [k.file, k.role]),
    ...claude.hooks.map((h): [string, string] => [h.file, h.role]),
  ];
}

// The run logs: the submitted run's first (its cold run, then the runs that continued it), then the
// earlier runs kept as timing evidence, each with what it is.
function orderedLogs(run: RunData): Array<{ name: string; bytes: number; what: string }> {
  const s = run.summary;
  const span = s === null ? [] : [s.run.id, ...s.run.later_runs].filter((x): x is string => x !== null).map((id) => `${id}.jsonl`);
  const inSpan = run.logs.filter((l) => span.includes(l.name)).sort((a, b) => span.indexOf(a.name) - span.indexOf(b.name));
  const others = run.logs.filter((l) => !span.includes(l.name));
  return [
    ...inSpan.map((l, i) => ({ ...l, what: i === 0 ? 'the submitted run' : 'the same run, continued' })),
    ...others.map((l) => ({ ...l, what: l.name.startsWith('cold-clone-') ? 'an earlier timed rehearsal in a fresh clone' : 'an earlier run, kept as timing evidence' })),
  ];
}

const pageHref = (p: PageDef): string => (p.kind === 'dashboard' ? 'dashboard/index.html' : `${p.file}.html`);

// ---- Diagrams and screenshots ----

function diagramSvg(ctx: Ctx, name: string): string | null {
  const file = join(ctx.siteDir, 'diagrams', `${name}.svg`);
  if (!existsSync(file)) return null;
  return readText(file)
    .replace(/<\?xml[^>]*\?>\s*/, '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .join('\n')
    .trim();
}
const svgTitle = (svg: string): string => /<title[^>]*>([^<]*)<\/title>/.exec(svg)?.[1]?.trim() ?? 'Diagram';

// ---- Expanding a page source: tokens to Markdown (and slots of HTML for the page) ----

type Expanded = { page: string; twin: string; slots: string[]; usesRun: boolean };

function fill(text: string, ctx: Ctx, from: string, mode: 'page' | 'twin'): { text: string; usesRun: boolean } {
  let usesRun = false;
  const out = text.replace(/\{\{fig:([a-z0-9_]+)\}\}/g, (_m, name: string) => {
    usesRun = true;
    if (!FIGURE_NAMES.includes(name)) {
      if (mode === 'page') ctx.problems.push(`${from}: unknown figure {{fig:${name}}}`);
      return marker(`fig.${name}`);
    }
    const v = ctx.figs.get(name);
    if (v === undefined) {
      if (mode === 'page') {
        ctx.markers.n++;
        // With every run output present, a figure without a value is a fault of its own.
        if (ctx.run.missing.length === 0) ctx.problems.push(`${from}: figure {{fig:${name}}} has no value in this run's output`);
      }
      return marker(`fig.${name}`);
    }
    return mdText(v);
  });
  return { text: placeholders(out, ctx, mode), usesRun };
}

// A {{name}} placeholder becomes a visible marker (--strict refuses them before this runs).
function placeholders(text: string, ctx: Ctx, mode: 'page' | 'twin'): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => {
    if (mode === 'page') ctx.markers.n++;
    return marker(name);
  });
}

function expand(source: string, ctx: Ctx, from: string): Expanded {
  const pageLines: string[] = [];
  const twinLines: string[] = [];
  const slots: string[] = [];
  let usesRun = false;
  const slot = (html: string): string => `<div data-slot="${slots.push(html) - 1}"></div>`;
  for (const raw of source.split('\n')) {
    const t = raw.trim();
    const tok = TOKEN.exec(t);
    if (tok !== null && tok[0] === t) {
      const [, kind, name] = tok;
      if (t === '{{/diagram}}') {
        pageLines.push('', '</details>', '');
        twinLines.push('');
        continue;
      }
      if (kind === 'block') {
        if (['run_facts', 'timeline', 'logs', 'documents', 'dashboard_copy'].includes(name as string)) usesRun = true;
        if (name === 'figures') {
          usesRun = true;
          const f = figuresBlock(ctx);
          pageLines.push(slot(f.html));
          twinLines.push(f.md);
          continue;
        }
        const md = block(name as string, ctx, from);
        pageLines.push(md);
        twinLines.push(md);
        continue;
      }
      if (kind === 'diagram') {
        const svg = diagramSvg(ctx, name as string);
        if (svg === null) {
          ctx.problems.push(`${from}: no diagram site/diagrams/${name}.svg`);
          pageLines.push(marker(`diagram ${name}`));
          twinLines.push(marker(`diagram ${name}`));
          continue;
        }
        const title = svgTitle(svg);
        pageLines.push(slot(`<figure class="diagram" aria-labelledby="${name}-title">${svg}</figure>`), `<details class="diagram-text"><summary>The diagram in words</summary>`, '');
        twinLines.push(`Diagram: ${mdText(title)} ([SVG](diagrams/${name}.svg)). In words:`, '');
        continue;
      }
      if (kind === 'shot') {
        const shot = ctx.shots.find((x) => x.file === `${name}.png`);
        if (shot === undefined) {
          ctx.problems.push(`${from}: {{shot:${name}}} is not listed in site/assets/screenshots/README.md`);
          continue;
        }
        if (!shot.present) {
          ctx.markers.n++;
          const m = marker(`screenshot ${shot.file}: ${shot.alt}`);
          pageLines.push(m);
          twinLines.push(m);
          continue;
        }
        pageLines.push(slot(`<figure class="shot"><img src="assets/screenshots/${shot.file}" alt="${escapeHtml(shot.alt)}" width="1280" loading="lazy"><figcaption>${escapeHtml(shot.alt)}</figcaption></figure>`));
        twinLines.push(`[Screenshot: ${mdText(shot.alt)}](assets/screenshots/${shot.file})`);
        continue;
      }
    }
    const p = fill(raw, ctx, from, 'page');
    const w = fill(raw, ctx, from, 'twin');
    usesRun ||= p.usesRun;
    pageLines.push(p.text);
    if (!HTML_LINE.test(t)) twinLines.push(w.text);
  }
  const page = pageLines.join('\n');
  // A token that is not alone on its line, or is written wrong, would ship as written.
  for (const [n, line] of unfenced(source)) {
    if (TOKEN.exec(line.trim())?.[0] === line.trim()) continue;
    for (const m of line.matchAll(ANY_TOKEN)) if (!/^\{\{(fig:[a-z0-9_]+|[a-z0-9_.]+)\}\}$/.test(m[0])) ctx.problems.push(`${from}:${n}: ${m[0]} is not a token this build fills (a block, a diagram or a screenshot goes alone on its line)`);
  }
  // The twin keeps no anchor syntax: a heading's {#id} and a table row's leading {#id} go.
  const twin = twinLines
    .join('\n')
    .replace(/^(#{1,6}[ \t].*?)[ \t]*\{#[a-z0-9][a-z0-9-]*\}[ \t]*$/gm, '$1')
    .replace(/^\|[ \t]*\{#[a-z0-9][a-z0-9-]*\}[ \t]*/gm, '| ')
    .replace(/\n{3,}/g, '\n\n');
  return { page, twin, slots, usesRun };
}

// The figures strip of the index: the headline with its counted and estimated parts (solid and
// hatched, as the dashboard draws them), then the run's counts, each labelled with what kind of
// figure it is.
function figuresBlock(ctx: Ctx): { html: string; md: string } {
  const f = (name: string): string => {
    const v = ctx.figs.get(name);
    if (v !== undefined) return v;
    ctx.markers.n++;
    return marker(`fig.${name}`);
  };
  const e = escapeHtml;
  const scope = ctx.figs.get('scope');
  const headline = f('headline');
  const counted = f('headline_counted');
  const estimated = f('headline_estimated');
  const mainNote = `${f('hours')} hours a month. The estimates put it between ${f('headline_low')} and ${f('headline_high')}.${scope === undefined ? '' : ` ${cap(scope)}.`}`;
  const rounds = ctx.figs.get('fix_rounds') === '1' ? 'fix round' : 'fix rounds';
  const items: Array<{ k: string; kind: string; v: string; note: string }> = [
    { k: 'Messages read', kind: 'counted', v: f('messages_read'), note: `${f('unique')} after ${f('duplicates')} duplicates` },
    { k: 'Recurring processes', kind: 'counted', v: f('processes'), note: `${f('processes_in_total')} seen often enough to count in the total` },
    { k: 'Documents drafted', kind: 'counted', v: f('documents'), note: 'for the opportunities above the threshold' },
    { k: 'Run time', kind: 'measured', v: `${f('wall_minutes')} min`, note: 'from the run log' },
    { k: 'Subagents started', kind: 'counted', v: f('agents'), note: `${f('fix_rounds')} ${rounds}` },
    { k: 'Quotes exact', kind: 'counted', v: f('quotes_exact'), note: `${f('quotes_repaired')} repaired, ${f('quotes_rejected')} rejected` },
  ];
  const html = [
    '<div class="figs">',
    `<div class="fig fig-main"><p class="fig-k">Automatable work a month <span class="kind">counted + estimated</span></p><p class="fig-v">${e(headline)} <span class="fig-unit">a month</span></p>`,
    `<p class="fig-parts"><span><i class="sw sw-c" aria-hidden="true"></i>${e(counted)} counted email time</span> <span class="plus">+</span> <span><i class="sw sw-e" aria-hidden="true"></i>${e(estimated)} estimated hands-on work</span></p>`,
    `<p class="fig-note">${e(mainNote)}</p></div>`,
    ...items.map((x) => `<div class="fig"><p class="fig-k">${e(x.k)} <span class="kind">${e(x.kind)}</span></p><p class="fig-v">${e(x.v)}</p><p class="fig-note">${e(x.note)}</p></div>`),
    '</div>',
  ].join('\n');
  // The twin: values escaped as Markdown text, markers kept as written.
  const mt = (v: string): string => v.split(/(\[to fill: [^\]]*\])/).map((part, k) => (k % 2 === 1 ? part : mdText(part))).join('');
  const md = [
    `- Automatable work a month (counted + estimated): ${mt(headline)} = ${mt(counted)} counted email time + ${mt(estimated)} estimated hands-on work. ${mt(mainNote)}`,
    ...items.map((x) => `- ${x.k} (${x.kind}): ${mt(x.v)}; ${mt(x.note)}.`),
  ].join('\n');
  return { html, md };
}

// ---- The page shell ----

type ShellInput = { ctx: Ctx; path: string; title: string; description: string; navFile: string; body: string; kicker?: string; banner: boolean; twin: string };

function canonical(cfg: SiteConfig, path: string): string {
  return path === 'index.html' ? cfg.base_url : `${cfg.base_url}${path}`;
}

const COPY_SCRIPT = `<script>
(() => {
  const button = document.getElementById('copy-url');
  const url = document.getElementById('page-url');
  if (!button || !url) return;
  button.hidden = false;
  const select = () => {
    const range = document.createRange();
    range.selectNodeContents(url);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  };
  button.addEventListener('click', () => {
    const text = url.textContent || '';
    const selected = () => { select(); button.textContent = 'Selected: press Ctrl+C or Cmd+C'; };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => { button.textContent = 'Copied'; }, selected);
    else selected();
  });
})();
</script>`;

function shell(x: ShellInput): string {
  const { ctx } = x;
  const cfg = ctx.cfg;
  const up = x.path.includes('/') ? '../'.repeat(x.path.split('/').length - 1) : '';
  const runId = ctx.figs.get('run_id');
  const runDate = ctx.figs.get('run_date');
  const url = canonical(cfg, x.path);
  // Two groups: the pages about the project, and the system's own output (the dashboard and the
  // report keep the product's look, so the sidebar marks them as the deliverable).
  const item = (p: (typeof cfg.pages)[number]) => {
    const href = `${up}${pageHref(p)}`;
    const current = p.file === x.navFile ? ' aria-current="page"' : '';
    return `<li><a href="${href}"${current}>${escapeHtml(p.nav)}</a></li>`;
  };
  const about = cfg.pages.filter((p) => p.kind === undefined).map(item).join('');
  const output = cfg.pages.filter((p) => p.kind !== undefined).map(item).join('');
  const runline = runDate !== undefined && runId !== undefined ? `Submitted run of ${escapeHtml(runDate)}` : 'Submitted run: not committed yet';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(x.navFile === 'index' ? cfg.title : `${x.title} · ${cfg.title}`)}</title>
<meta name="description" content="${escapeHtml(x.description)}">
${runId === undefined ? '' : `<meta name="obs-run" content="${escapeHtml(runId)}">\n`}<link rel="canonical" href="${escapeHtml(url)}">
<link rel="alternate" type="text/markdown" href="${escapeHtml(x.twin)}">
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${up}site.css">
</head>
<body>
<aside class="ai-note" aria-label="Reading with an AI assistant">
<p class="ai-text">${escapeText(cfg.note)}</p>
<p class="ai-url"><code id="page-url">${escapeHtml(url)}</code> <button type="button" id="copy-url" class="copy" hidden>Copy address</button></p>
</aside>
<header class="mast">
<div class="mast-in">
<p class="mast-k">Take-home assignment · Project write-up</p>
<p class="mast-t"><a href="${up}index.html">${escapeHtml(cfg.title)}</a></p>
<p class="mast-d">${escapeText(cfg.masthead)}</p>
<p class="mast-m">${escapeHtml(cfg.author)} · ${runline} · <a href="${escapeHtml(cfg.repo_url)}">Repository</a></p>
</div>
</header>
<div class="layout">
<nav class="side" aria-label="Pages">
<p class="side-h" id="nav-about">About the project</p>
<ul class="nav" aria-labelledby="nav-about">${about}</ul>
<p class="side-h" id="nav-output">The system's output</p>
<ul class="nav out" aria-labelledby="nav-output">${output}</ul>
</nav>
<div class="col">
<main id="main">
${x.kicker === undefined ? '' : `<p class="kicker">${escapeHtml(x.kicker)}</p>\n`}${x.banner ? `<p class="banner">${escapeHtml(NOT_COMMITTED)}</p>\n` : ''}${x.body}
</main>
<footer class="foot">
<p><a href="${escapeHtml(cfg.repo_url)}">The repository on GitHub</a> · ${escapeHtml(cfg.author)} · <a href="${escapeHtml(x.twin)}">This page in Markdown</a> · <a href="${up}llms.txt">llms.txt</a> · <a href="${up}llms-full.txt">llms-full.txt</a></p>
</footer>
</div>
</div>
${COPY_SCRIPT}
</body>
</html>
`;
}

// The rendered body: the slots filled, and the markers styled, in text only (never inside a tag).
function finish(html: string, slots: readonly string[]): string {
  return html
    .replace(/<div data-slot="(\d+)"><\/div>/g, (_m, i: string) => slots[Number(i)] ?? '')
    .split(/(<[^>]*>)/)
    .map((seg, k) => (k % 2 === 1 ? seg : seg.replace(/\[to fill: [^\]<]*\]/g, (m) => `<mark class="fill">${m}</mark>`)))
    .join('');
}

// ---- Pages ----

type Out = Map<string, string | Buffer>;
type PageOut = { html: string; twin: string; ids: Set<string> };

function htmlLinker(ctx: Ctx, from: string, up: string): (href: string) => string {
  return (href: string) => {
    const t = classify(href);
    if (t.kind === 'external' || t.kind === 'fragment') return href;
    if (t.kind === 'refused') {
      ctx.problems.push(`${from}: a link to ${href}, a kind of address the site does not use`);
      return '#';
    }
    if (t.kind === 'commit') return `${ctx.cfg.repo_url}/commit/${t.href}`;
    if (t.kind === 'repo') {
      if (t.checked) {
        const [p, frag] = t.href.split('#', 2) as [string, string | undefined];
        ctx.repoLinks.push({ from, path: p, fragment: frag ?? null });
      }
      return repoUrl(ctx, t.href);
    }
    return `${up}${href}`;
  };
}

// A page source named in site.json ("site/pages/run.md"), read from the site's folder.
const sourceFile = (ctx: Ctx, source: string): string => join(ctx.siteDir, ...source.replace(/^site\//, '').split('/'));
const idsIn = (html: string, into: Set<string>): Set<string> => {
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) into.add(m[1] as string);
  return into;
};

function authoredPage(ctx: Ctx, p: PageDef): PageOut {
  const from = p.source as string;
  const file = sourceFile(ctx, from);
  const path = `${p.file}.html`;
  if (!existsSync(file)) {
    ctx.problems.push(`${from} is missing`);
    return { html: shell({ ctx, path, title: p.title, description: p.description, navFile: p.file, body: `<h1>${escapeHtml(p.title)}</h1>\n<p>${escapeHtml(marker(from))}</p>`, banner: false, twin: `${p.file}.md` }), twin: `# ${p.title}\n`, ids: new Set() };
  }
  const ex = expand(readText(file), ctx, from);
  const ids = new Set<string>();
  const r = renderMarkdown(ex.page, { html: true, ids, link: htmlLinker(ctx, from, '') });
  const banner = ex.usesRun && ctx.run.summary === null;
  const body = finish(r.html, ex.slots);
  idsIn(body, ids);
  const twin = rewriteMdLinks(ex.twin, (h) => twinHref(ctx, p.file, h)).trim();
  return {
    html: shell({ ctx, path, title: p.title, description: p.description, navFile: p.file, body, banner, twin: `${p.file}.md` }),
    twin: `${banner ? `${NOT_COMMITTED}\n\n` : ''}${twin}\n`,
    ids,
  };
}

function twinHref(ctx: Ctx, page: string, href: string): string {
  const t = classify(href);
  if (t.kind === 'external') return href;
  if (t.kind === 'refused') return '#';
  if (t.kind === 'commit') return `${ctx.cfg.repo_url}/commit/${t.href}`;
  if (t.kind === 'repo') return repoUrl(ctx, t.href);
  return twinUrl(ctx.cfg, page, href);
}

// README, NOTES or BRIEF: every tag in it shows as text; its headings get the ids GitHub gives them;
// its relative links go to the file on GitHub (images to the raw file), and --strict checks that
// Git tracks each one.
function docPage(ctx: Ctx, p: PageDef): PageOut {
  const name = p.source as string;
  const file = join(ctx.docsDir, name);
  const path = `${p.file}.html`;
  const toRepo = (href: string, image: boolean): string => {
    const t = classify(href);
    if (t.kind === 'external' || t.kind === 'fragment') return href;
    if (t.kind === 'refused') {
      ctx.problems.push(`${name}: a link to ${href}, a kind of address the site does not use`);
      return '#';
    }
    const target = href.replace(/^\//, '');
    const [rel, frag] = target.split('#', 2) as [string, string | undefined];
    ctx.repoLinks.push({ from: name, path: rel.replace(/^\.\//, ''), fragment: frag ?? null });
    return image ? rawUrl(ctx, rel) : repoUrl(ctx, target);
  };
  const prefix = p.prefix ?? '';
  const sourceLink = `[${name} on GitHub](${repoUrl(ctx, name)})`;
  if (!existsSync(file)) {
    ctx.markers.n++;
    ctx.problems.push(`${name} is missing`);
    const body = `<p class="prefix">${renderInline(prefix)}</p>\n<p><mark class="fill">${escapeHtml(marker(`${name}: not in the repository yet`))}</mark></p>`;
    return { html: shell({ ctx, path, title: p.title, description: p.description, navFile: p.file, kicker: p.title, body, banner: false, twin: `${p.file}.md` }), twin: `${prefix}\n\n${marker(name)}\n`, ids: new Set() };
  }
  const text = readText(file);
  const ids = new Set<string>();
  const r = renderMarkdown(placeholders(text, ctx, 'page'), { html: false, ids, idStyle: 'github', link: (h) => toRepo(h, false), image: (h) => toRepo(h, true) });
  const body = `<p class="prefix">${renderInline(prefix)} ${renderInline(sourceLink)}</p>\n${finish(r.html, [])}`;
  idsIn(body, ids);
  const twin = `${prefix}\n\n${rewriteMdLinks(placeholders(text, ctx, 'twin'), (h) => {
    const t = classify(h);
    if (t.kind === 'external' || t.kind === 'fragment') return h;
    return t.kind === 'refused' ? '#' : repoUrl(ctx, h.replace(/^\//, ''));
  }).trim()}\n`;
  return { html: shell({ ctx, path, title: p.title, description: p.description, navFile: p.file, kicker: p.title, body, banner: false, twin: `${p.file}.md` }), twin, ids };
}

function documentPage(ctx: Ctx, d: Doc): PageOut {
  const path = `documents/${d.entry.slug}.html`;
  const type = TYPE_WORDS[d.entry.artifact_type] ?? d.entry.artifact_type;
  const body = [
    `<p class="kicker">Drafted document · rank ${escapeHtml(count(d.entry.rank))} · ${escapeHtml(type)}</p>`,
    `<h1>${escapeHtml(d.title)}</h1>`,
    `<p class="prefix">Drafted by the run for the process owner to review. The body is model prose that passed the draft gate; the title, the line under it and the Evidence section are written by code, and every quote in the Evidence section is checked against the raw message. <a href="../run.html#documents">All the drafted documents</a>.</p>`,
    `<div class="doc">${renderMarkdownHtml(d.text, { base: 2 })}</div>`,
  ].join('\n');
  return {
    html: shell({ ctx, path, title: d.title, description: `A drafted ${type} for one of the recurring processes the run found, with its evidence quoted exactly from the emails.`, navFile: 'run', body, banner: false, twin: `${d.entry.slug}.md` }),
    twin: d.text,
    ids: idsIn(body, new Set()),
  };
}

// The page standing in for the report or the dashboard copy while the run's outputs are missing;
// its Markdown twin is written beside it.
function placeholderPage(ctx: Ctx, path: string, title: string, navFile: string, what: string): string {
  return shell({ ctx, path, title, description: `${title}: built from the submitted run's outputs.`, navFile, body: `<h1>${escapeHtml(title)}</h1>\n<p><mark class="fill">${escapeHtml(marker(what))}</mark></p>`, banner: true, twin: basename(path).replace(/\.html$/, '.md') });
}

// ---- The agent-readable files ----

function llmsTxt(ctx: Ctx, summary: string, docs: Doc[]): string {
  const cfg = ctx.cfg;
  const lines = [`# ${cfg.title}`, '', `> ${summary}`, '', `Everything in one file: ${cfg.base_url}llms-full.txt`, '', '## Pages', ''];
  for (const p of cfg.pages) {
    if (p.kind === 'dashboard') lines.push(`- [${p.title}](${cfg.base_url}dashboard/index.html): ${p.description}`);
    else if (p.kind === 'report') lines.push(`- [${p.title}](${cfg.base_url}report.md): ${p.description} The printable page is ${cfg.base_url}report.html.`);
    else lines.push(`- [${p.title}](${cfg.base_url}${p.file}.md): ${p.description} HTML: ${canonical(cfg, `${p.file}.html`)}`);
  }
  lines.push('', '## The run’s output', '');
  lines.push(`- [The report in Markdown](${cfg.base_url}report.md): every figure of the dashboard, in Markdown.`);
  for (const d of docs) lines.push(`- [${mdText(d.title)}](${cfg.base_url}documents/${d.entry.slug}.md): drafted ${TYPE_WORDS[d.entry.artifact_type] ?? d.entry.artifact_type}, rank ${d.entry.rank}.`);
  for (const l of orderedLogs(ctx.run)) lines.push(`- [Run log ${l.name}](${repoUrl(ctx, `out/runs/${l.name}`)}): ${l.what}; JSON lines, ${kb(l.bytes)}.`);
  lines.push('', '## The repository', '');
  const repo: Array<[string, string]> = [
    ['README.md', 'how to get the code, run it and test it'],
    ['NOTES.md', 'the notes the brief asks for'],
    ['BRIEF.md', 'the assignment, verbatim'],
    ['CLAUDE.md', 'the project rules every session follows'],
    ['.claude/', 'the Claude Code layer exactly as used: agents, skills, hooks, settings'],
    ['out/', 'the submitted run’s outputs'],
  ];
  for (const [path, what] of repo) lines.push(`- [${path}](${repoUrl(ctx, path)}): ${what}.`);
  // The Claude Code layer and the records file by file, as raw text an agent can fetch whole.
  lines.push('', '## The Claude Code layer and the records, as plain text', '');
  const layer = ctx.claude.files.map((f) => f.path).filter((p) => /^\.claude\/(agents\/[^/]+\.md|skills\/[^/]+\/SKILL\.md|hooks\/[^/]+\.ts)$/.test(p));
  for (const path of [...layer, '.claude/settings.json', '.claude/plan/ARCHITECTURE.md', '.claude/notes/DECISIONS.md', '.claude/notes/NOTES-LOG.md']) {
    const role = fileRole(path, ctx.claude);
    lines.push(`- [${path}](${rawUrl(ctx, path)})${role === '' ? '' : `: ${mdText(role)}`}`);
  }
  return `${lines.join('\n')}\n`;
}

function llmsFull(ctx: Ctx, twins: Map<string, string>, docs: Doc[]): { text: string; docsIncluded: boolean } {
  const cfg = ctx.cfg;
  const strip = (md: string) => md.replace(/^# [^\n]*\n+/, '');
  const pageParts: string[] = [];
  for (const p of cfg.pages) {
    if (p.kind !== undefined) continue;
    const twin = twins.get(`${p.file}.md`);
    if (twin === undefined) continue;
    pageParts.push(`# ${p.title}\n${cfg.base_url}${p.file}.md\n\n${strip(twin).trim()}\n`);
  }
  const docParts = docs.map((d) => `# ${d.title}\n${cfg.base_url}documents/${d.entry.slug}.md\n\n${strip(d.text).trim()}\n`);
  const claudeParts = [...ctx.claude.agents.map((a) => a.file), ...ctx.claude.skills.map((k) => k.file)].map((f) => `# ${f}\n${repoUrl(ctx, f)}\n\n${readText(join(ctx.root, ...f.split('/'))).trim()}\n`);
  const head = `# ${cfg.title}: the whole site in one file\n${cfg.base_url}llms-full.txt\n\nThe site's pages in order, then the drafted documents, then the agent and skill definitions under .claude/ as used. The report is not included: it is ${cfg.base_url}report.md.\n`;
  const withDocs = [head, ...pageParts, ...docParts, ...claudeParts].join('\n');
  if (Buffer.byteLength(withDocs, 'utf8') <= LLMS_FULL_CAP) return { text: withDocs, docsIncluded: true };
  const docLinks = `# The drafted documents\n${cfg.base_url}run.md#documents\n\nLeft out of this file to keep it under ${LLMS_FULL_CAP / 1024} KB; each is a Markdown file:\n\n${docs.map((d) => `- ${cfg.base_url}documents/${d.entry.slug}.md`).join('\n')}\n`;
  return { text: [head, ...pageParts, docLinks, ...claudeParts].join('\n'), docsIncluded: false };
}

function sitemap(cfg: SiteConfig, htmlPaths: string[]): string {
  const locs = [...new Set(htmlPaths)].sort().map((p) => `<url><loc>${escapeHtml(canonical(cfg, p))}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs.join('\n')}\n</urlset>\n`;
}

// ---- Checks ----

// Every relative href and src in the site's own HTML: the file it names exists, and so does the id
// after a "#". `exists` answers for files written by site/dashboard.ts (the dashboard copy) and the
// files copied as they are.
function checkSiteLinks(files: Out, exists: (path: string) => string | null): string[] {
  const problems: string[] = [];
  const idCache = new Map<string, Set<string>>();
  const ids = (path: string): Set<string> | null => {
    const cached = idCache.get(path);
    if (cached !== undefined) return cached;
    const own = files.get(path);
    const text = own !== undefined ? own.toString() : exists(path);
    if (text === null) return null;
    const s = idsIn(text, new Set());
    idCache.set(path, s);
    return s;
  };
  for (const [path, content] of files) {
    if (!path.endsWith('.html') || path === 'report.html') continue;
    const html = content.toString();
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    for (const m of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      const href = (m[1] as string).replace(/&amp;/g, '&');
      if (/^(https?:|mailto:|data:)/.test(href) || href === '#') continue;
      const [p, frag] = href.split('#', 2) as [string, string | undefined];
      let target = path;
      if (p !== '') {
        const stack: string[] = [];
        for (const s of [...(dir === '' ? [] : dir.split('/')), ...p.split('/')]) {
          if (s === '..') stack.pop();
          else if (s !== '.' && s !== '') stack.push(s);
        }
        target = stack.join('/');
      }
      if (!files.has(target) && exists(target) === null) {
        problems.push(`${path}: links to ${href}, which is not in the site`);
        continue;
      }
      if (frag !== undefined && frag !== '' && target.endsWith('.html')) {
        const set = ids(target);
        if (set !== null && !set.has(frag)) problems.push(`${path}: links to ${href}, which has no such anchor`);
      }
    }
  }
  return problems;
}

// Every repository path a page, README or NOTES links to is one Git tracks (so it opens on
// GitHub), and an anchor into a tracked .md file is one of the ids GitHub gives its headings.
function checkRepoLinks(ctx: Ctx): string[] {
  const problems: string[] = [];
  const mdIds = new Map<string, Set<string>>();
  for (const l of ctx.repoLinks) {
    const clean = l.path.replace(/\/$/, '');
    if (!inRepo(ctx, clean)) {
      problems.push(`${l.from}: links to ${l.path}, which is not in the repository`);
      continue;
    }
    if (l.fragment !== null && clean.endsWith('.md')) {
      let set = mdIds.get(clean);
      if (set === undefined) {
        set = githubIds(readText(join(ctx.root, ...clean.split('/'))));
        mdIds.set(clean, set);
      }
      if (!set.has(l.fragment)) problems.push(`${l.from}: links to ${l.path}#${l.fragment}, which has no such heading`);
    }
  }
  return [...new Set(problems)];
}

// ---- The build ----

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[])
    .map((p) => p.split(sep).join('/'))
    .filter((p) => statSync(join(dir, ...p.split('/'))).isFile())
    .sort();
}

const inside = (a: string, b: string): boolean => {
  const r = relative(b, a);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

// Whether `dir` may be written: it is not the repository or the run output, and neither holds the
// repository nor sits in the run output.
function checkPlace(dir: string, root: string, out: string): void {
  if (inside(root, dir) || inside(out, dir) || inside(dir, out)) throw new Error(`refusing to use ${dir} as the output folder: it holds the repository or the run output, or sits in the run output`);
}

// Whether `dir` may be removed and replaced: a place checkPlace allows, empty or a previous build of
// this site (.nojekyll and llms.txt, no .git).
function checkReplaceable(dir: string, root: string, out: string): void {
  checkPlace(dir, root, out);
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
  const entries = readdirSync(dir);
  if (entries.length === 0) return;
  if (entries.includes('.git')) throw new Error(`refusing to clear ${dir}: it is a Git working tree`);
  if (!entries.includes('.nojekyll') || !entries.includes('llms.txt')) throw new Error(`refusing to clear ${dir}: it is not empty and is not a previous build of this site`);
}

// Moves the finished build into place; a folder still held open (an editor, a scan on Windows) gets
// a few more tries.
function moveInto(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const busy = err instanceof Error && 'code' in err && ['EPERM', 'EBUSY', 'EACCES'].includes(String((err as { code: unknown }).code));
      if (!busy || attempt >= 5) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

function strictChecks(ctx: Ctx, pages: PageDef[]): string[] {
  const problems: string[] = [];
  const scan = (label: string, file: string, docs: boolean) => {
    if (!existsSync(file)) return;
    for (const [n, line] of unfenced(readText(file))) {
      for (const m of line.matchAll(ANY_TOKEN)) {
        if (/^\{\{[a-z0-9_.]+\}\}$/.test(m[0])) problems.push(`${label}:${n}: placeholder ${m[0]} is not filled`);
        else if (docs) problems.push(`${label}:${n}: ${m[0]} is not a placeholder this build can show`);
      }
    }
  };
  for (const p of pages) {
    if (p.source === undefined) continue;
    if (p.source.startsWith('site/')) scan(p.source, sourceFile(ctx, p.source), false);
    else if (p.source !== 'BRIEF.md') scan(p.source, join(ctx.docsDir, p.source), true);
  }
  for (const m of ctx.run.missing) problems.push(`run output missing: ${m}`);
  for (const s of ctx.shots) if (!s.present) problems.push(`screenshot missing: site/assets/screenshots/${s.file}`);
  return problems;
}

type Rendered = { files: Out; twins: Map<string, string>; htmlPaths: string[] };

function renderAll(ctx: Ctx): Rendered {
  const files: Out = new Map();
  const twins = new Map<string, string>();
  const htmlPaths: string[] = [];
  const add = (path: string, content: string | Buffer) => {
    files.set(path, content);
    if (path.endsWith('.html')) htmlPaths.push(path);
  };
  for (const p of ctx.cfg.pages) {
    if (p.kind !== undefined) continue;
    const out = p.source !== undefined && p.source.startsWith('site/') ? authoredPage(ctx, p) : docPage(ctx, p);
    add(`${p.file}.html`, out.html);
    add(`${p.file}.md`, out.twin);
    twins.set(`${p.file}.md`, out.twin);
    for (const id of p.ids ?? []) if (!out.ids.has(id)) ctx.problems.push(`${p.file}.html: no element with id "${id}"${p.source !== undefined && !p.source.startsWith('site/') ? ` (${p.source} lacks that heading)` : ''}`);
  }
  for (const d of ctx.run.docs) {
    const out = documentPage(ctx, d);
    add(`documents/${d.entry.slug}.html`, out.html);
    add(`documents/${d.entry.slug}.md`, out.twin);
  }
  const at = (rel: string) => join(ctx.run.out, ...rel.split('/'));
  if (existsSync(at('report.html'))) add('report.html', readFileSync(at('report.html')));
  else add('report.html', placeholderPage(ctx, 'report.html', 'Report', 'report', 'the report (out/report.html)'));
  if (existsSync(at('report.md'))) add('report.md', readFileSync(at('report.md')));
  else add('report.md', `# Report\n\n${NOT_COMMITTED}\n`);
  if (ctx.dash === null && !ctx.run.dashboard) {
    add('dashboard/index.html', placeholderPage(ctx, 'dashboard/index.html', 'Dashboard', 'dashboard/index', ctx.dashProblem === null ? 'the dashboard copy (out/dashboard/)' : 'the dashboard copy could not be written (the build lists why)'));
    add('dashboard/index.md', `# Dashboard\n\n${NOT_COMMITTED}\n`);
  } else htmlPaths.push('dashboard/index.html');
  return { files, twins, htmlPaths };
}

export async function buildSite(opts: SiteOptions = {}): Promise<SiteResult> {
  const root = resolve(opts.root ?? REPO);
  const siteDir = resolve(opts.site ?? join(root, 'site'));
  const docsDir = resolve(opts.docs ?? root);
  const outDir = resolve(opts.out ?? join(root, 'out'));
  const dist = resolve(opts.dist ?? join(siteDir, 'dist'));
  const staging = `${dist}.building`;
  const strict = opts.strict === true;
  checkReplaceable(dist, root, outDir);
  // The staging folder is this build's own (named after the dist); one a crash left is replaced.
  checkPlace(staging, root, outDir);
  const cfg = loadConfig(siteDir);
  const run = loadRun(outDir);
  const tracked = trackedPaths(root);
  const ctx: Ctx = {
    cfg,
    root,
    siteDir,
    docsDir,
    run,
    figs: figures(run),
    claude: readClaude(root, tracked),
    tracked,
    shots: readShots(siteDir),
    dash: null,
    dashProblem: null,
    problems: [],
    markers: { n: 0 },
    repoLinks: [],
  };
  const result: SiteResult = { ok: true, dist, problems: [], markers: 0, files: 0, bytes: 0, llmsFull: 0, llmsFullDocuments: false, dashboard: null };

  // First pass: everything but the dashboard copy, to find the problems before anything is written.
  const preProblems = strictChecks(ctx, cfg.pages);
  const outDash = join(outDir, 'dashboard');
  const fromDashboard = (path: string): string | null => {
    if (!path.startsWith('dashboard/') || !run.dashboard) return null;
    const f = join(outDash, ...path.slice('dashboard/'.length).split('/'));
    return existsSync(f) && statSync(f).isFile() ? (path.endsWith('.html') ? readText(f) : '') : null;
  };
  const staticFile = (path: string): string | null => {
    const asset = (dir: string, sub: string) => (path.startsWith(`${sub}/`) && existsSync(join(dir, ...path.slice(sub.length + 1).split('/'))) ? '' : null);
    return fromDashboard(path) ?? asset(join(siteDir, 'diagrams'), 'diagrams') ?? asset(join(siteDir, 'assets'), 'assets') ?? asset(join(root, 'dashboard', 'fonts'), 'fonts') ?? (['site.css', 'llms.txt', 'llms-full.txt', 'sitemap.xml', 'robots.txt'].includes(path) ? '' : null);
  };
  const first = renderAll(ctx);
  const firstProblems = [...new Set([...preProblems, ...ctx.problems, ...checkSiteLinks(first.files, staticFile), ...checkRepoLinks(ctx)])];
  if (strict && firstProblems.length > 0) return { ...result, ok: false, problems: firstProblems, markers: ctx.markers.n };

  // Second pass, into the staging folder: the dashboard copy first (the run page prints what it
  // wrote), then the pages. Nothing touches the dist until the build is complete and accepted.
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const late: string[] = [];
    if (run.dashboard) {
      try {
        ctx.dash = writeStaticDashboard(run.project, outDir, staging);
      } catch (err) {
        ctx.dashProblem = oneLine(err);
        late.push(`dashboard copy: ${ctx.dashProblem}`);
        run.dashboard = false;
      }
    }
    ctx.problems = [];
    ctx.markers.n = 0;
    ctx.repoLinks = [];
    const final = renderAll(ctx);
    const files = final.files;
    const llms = llmsFull(ctx, final.twins, run.docs);
    files.set('llms.txt', llmsTxt(ctx, fill(cfg.summary, ctx, 'site.json', 'twin').text, run.docs));
    files.set('llms-full.txt', llms.text);
    files.set('sitemap.xml', sitemap(cfg, final.htmlPaths));
    files.set('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${cfg.base_url}sitemap.xml\n`);
    files.set('.nojekyll', '');
    files.set('site.css', readFileSync(join(siteDir, 'site.css')));
    for (const f of filesUnder(join(siteDir, 'diagrams'))) if (f.endsWith('.svg')) files.set(`diagrams/${f}`, readFileSync(join(siteDir, 'diagrams', f)));
    for (const f of filesUnder(join(root, 'dashboard', 'fonts'))) files.set(`fonts/${f}`, readFileSync(join(root, 'dashboard', 'fonts', ...f.split('/'))));
    for (const s of ctx.shots) if (s.present) files.set(`assets/screenshots/${s.file}`, readFileSync(join(siteDir, 'assets', 'screenshots', s.file)));
    const llmsBytes = Buffer.byteLength(llms.text, 'utf8');
    if (llmsBytes > LLMS_FULL_CAP) late.push(`llms-full.txt is ${kb(llmsBytes)}, over the ${LLMS_FULL_CAP / 1024} KB cap even without the drafted documents`);
    const problems = [...new Set([...firstProblems, ...ctx.problems, ...late])];
    if (strict && problems.length > 0) {
      rmSync(staging, { recursive: true, force: true });
      return { ...result, ok: false, problems, markers: ctx.markers.n };
    }
    let bytes = ctx.dash?.bytes ?? 0;
    for (const path of [...files.keys()].sort()) {
      const target = join(staging, ...path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      const content = files.get(path) as string | Buffer;
      const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      writeFileSync(target, buf);
      bytes += buf.length;
    }
    checkReplaceable(dist, root, outDir);
    rmSync(dist, { recursive: true, force: true });
    moveInto(staging, dist);
    return {
      ...result,
      problems,
      markers: ctx.markers.n,
      files: files.size + (ctx.dash?.files ?? 0),
      bytes,
      llmsFull: llmsBytes,
      llmsFullDocuments: llms.docsIncluded,
      dashboard: ctx.dash,
    };
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

// ---- Command line ----

const USAGE = 'Usage: node site/build.ts [--out <dir>] [--dist <dir>] [--strict]';

function parseArgs(argv: string[]): SiteOptions | string {
  const opts: SiteOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--strict') opts.strict = true;
    else if (a === '--out' || a === '--dist') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return `${a} needs a folder. ${USAGE}`;
      if (a === '--out') opts.out = v;
      else opts.dist = v;
    } else if (a === '--help' || a === '-h') return USAGE;
    else return `unknown argument ${a}. ${USAGE}`;
  }
  return opts;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof opts === 'string') {
    if (opts === USAGE) {
      console.log(USAGE);
      return 0;
    }
    console.error(opts);
    return 1;
  }
  let r: SiteResult;
  try {
    r = await buildSite(opts);
  } catch (err) {
    console.error(`site: ${oneLine(err)}`);
    return 1;
  }
  const where = posixRel(process.cwd(), r.dist) || '.';
  if (!r.ok) {
    for (const p of r.problems) console.error(`site: ${p}`);
    console.error(`site: --strict refused the build: ${count(r.problems.length)} ${r.problems.length === 1 ? 'problem' : 'problems'}; ${where} left as it was`);
    return 1;
  }
  console.log(`site: ${count(r.files)} files, ${mb(r.bytes)}, in ${where}; llms-full.txt ${kb(r.llmsFull)}${r.llmsFullDocuments ? '' : ' (the drafted documents linked, not included)'}`);
  if (r.dashboard !== null) console.log(`site: dashboard copy: ${count(r.dashboard.messages)} messages, ${count(r.dashboard.files)} files, ${mb(r.dashboard.bytes)}`);
  if (r.problems.length > 0) {
    console.log(`site: lenient build: ${count(r.problems.length)} ${r.problems.length === 1 ? 'item' : 'items'} --strict would refuse (${count(r.markers)} markers on the pages):`);
    for (const p of r.problems) console.log(`site:   ${p}`);
  }
  return 0;
}

// Run as a command: this file is the script Node was given (compared as real paths, so a checkout
// reached through a symlink or a junction runs too).
function invokedDirectly(): boolean {
  try {
    return process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = await main();
