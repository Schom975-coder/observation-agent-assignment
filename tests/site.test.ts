// The project site (site/build.ts, site/markdown.ts, site/publish.ts): a complete small project made
// by the pipeline fixture (tests/fixtures/pipeline.ts), with a README and NOTES carrying the contract
// headings, built into a temporary dist with a copy of the site's sources and stand-in screenshots;
// then the dist checked: the agent-readable files, no external resource, the note, the copied
// report, the agents as their files set them, every id and internal link, the cited commits, two
// builds byte for byte, strict refusals one line each with the earlier build left alone, the
// commands' exit codes, README and drafted documents escaped, no local path, the dashboard copy's
// wiring, and the gh-pages publish on a temporary repository with its refusals.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite, claudeRoles, freshRunOf, loadConfig, NOT_COMMITTED, readAgents, type SiteResult } from '../site/build.ts';
import { githubIds, renderMarkdown, slugId } from '../site/markdown.ts';
import { publish } from '../site/publish.ts';
import { buildStep } from '../src/report/build.ts';
import { count } from '../src/report/format.ts';
import { fixRunLog, fixtureM5, REPO, runPipeline } from './fixtures/pipeline.ts';

const tmp = mkdtempSync(join(tmpdir(), 'obs site '));
after(() => rmSync(tmp, { recursive: true, force: true }));

// The pattern of tests/source-guards.test.ts, copied (not imported from a test).
const LOCAL_PATH = /[A-Za-z]:[\\/]Users[\\/]|\/Users\/[A-Za-z]|\/home\/[A-Za-z]|AppData[\\/]/;
const LEFT_TOKEN = /\{\{[a-z0-9_.]+\}\}|\{\{(?:fig|block|shot|diagram):/;
const cfg = loadConfig(join(REPO, 'site'));

const README = `# Observation agent

A test README.

## What this is

It reads mail.

## See the results without running anything

[The run's output](out/) and [the agents](.claude/agents/), with [the notes](NOTES.md#what-it-took-on-faith).

## Prerequisites

Node.

## Get the code

### macOS and Linux

Clone it.

### Windows

\`\`\`
git clone --no-checkout <url> obs
\`\`\`

## Run it

1. Open Claude Code.
2. Type \`/observe\`.

### Warm and cold runs

Warm.

### Folder trust and permissions

Trust.

### Unattended

Headless.

## Open the dashboard

\`node obs.mjs serve\`

## Tests

\`npm test\`

## Where things are

| Path | What |
|---|---|
| [\`src/\`](src/) | the code |

## Reading this with an AI assistant

The site.
`;

const NOTES = `# Notes

${[
  'How we drove Claude Code',
  'What we handed to subagents, and why',
  'How we budgeted their context',
  'What ran in parallel',
  'Where Claude Code got it wrong, and how we caught it',
  'What we would build next with another week',
  'Where the system is most likely wrong',
  'What it took on faith',
  'What we drafted, and why',
]
  .map((h) => `## ${h}\n\nA sentence.\n`)
  .join('\n')}`;

// A 1x1 PNG.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

let project = '';
let siteDir = '';
let dist = '';
let result: SiteResult;

// A copy of the site's sources (no generator code, no dist) with every listed screenshot present.
function copySite(to: string): string {
  mkdirSync(to, { recursive: true });
  copyFileSync(join(REPO, 'site', 'site.json'), join(to, 'site.json'));
  copyFileSync(join(REPO, 'site', 'site.css'), join(to, 'site.css'));
  for (const d of ['pages', 'diagrams', 'assets']) cpSync(join(REPO, 'site', d), join(to, d), { recursive: true, filter: (src) => !src.endsWith('.png') });
  for (const line of readFileSync(join(to, 'assets', 'screenshots', 'README.md'), 'utf8').split('\n')) {
    const m = /^\|\s*`([a-z0-9-]+\.png)`/.exec(line);
    if (m !== null) writeFileSync(join(to, 'assets', 'screenshots', m[1] as string), PNG);
  }
  return to;
}

// A folder of README, NOTES and BRIEF for a build.
function docsDir(name: string, readme = README, notes = NOTES): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), readme);
  writeFileSync(join(dir, 'NOTES.md'), notes);
  copyFileSync(join(REPO, 'BRIEF.md'), join(dir, 'BRIEF.md'));
  return dir;
}

function filesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[])
    .map((p) => p.replaceAll('\\', '/'))
    .filter((p) => statSync(join(dir, ...p.split('/'))).isFile())
    .sort();
}
const read = (rel: string, d = dist): string => readFileSync(join(d, ...rel.split('/')), 'utf8');
// The site's own HTML pages: everything but the dashboard copy and the copied report.
const ownHtml = (d = dist): string[] => filesUnder(d).filter((f) => f.endsWith('.html') && !f.startsWith('dashboard/') && f !== 'report.html');
const node = (args: string[]) => spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8' });

before(async () => {
  project = fixtureM5(tmp, 'project');
  // The fixture copies only the build's required assets; the dashboard copy needs the page itself.
  for (const f of ['index.html', 'app.js', 'styles.css', 'viewer.js']) copyFileSync(join(REPO, 'dashboard', f), join(project, 'dashboard', f));
  runPipeline(project);
  fixRunLog(project);
  buildStep(project);
  writeFileSync(join(project, 'README.md'), README);
  writeFileSync(join(project, 'NOTES.md'), NOTES);
  copyFileSync(join(REPO, 'BRIEF.md'), join(project, 'BRIEF.md'));
  siteDir = copySite(join(tmp, 'site'));
  dist = join(tmp, 'dist');
  result = await buildSite({ root: REPO, site: siteDir, docs: project, out: join(project, 'out'), dist, strict: true });
  assert.equal(result.ok, true, result.problems.join('\n'));
});

test('the Markdown renderer: ids, fixed ids, lists, fences, tables, links, and HTML only where allowed', () => {
  const md = [
    '# Title',
    '## What we handed to subagents, and why',
    '## Fixed {#fixed}',
    '- one',
    '  - nested `code` and **bold** and *it*',
    '- two',
    '',
    '1. step',
    '',
    '   ```',
    '   git clone <x>',
    '   ```',
    '',
    '| A | B |',
    '|---|--:|',
    '| {#row-1} [a](x.html#y) | 2 |',
    '',
    '> quoted',
    '',
    '<div class="start">',
    '',
    'Text with a_snake_name and <b>tag</b> and https://example.com/a.',
  ].join('\n');
  const page = renderMarkdown(md, { html: true }).html;
  assert.match(page, /<h2 id="what-we-handed-to-subagents-and-why">/);
  assert.match(page, /<h2 id="fixed">Fixed<\/h2>/);
  assert.match(page, /<ul><li>one\n?<ul><li>nested <code>code<\/code> and <strong>bold<\/strong> and <em>it<\/em><\/li><\/ul><\/li><li>two<\/li><\/ul>/);
  assert.match(page, /<pre><code>git clone &lt;x&gt;<\/code><\/pre>/);
  assert.match(page, /<tr id="row-1"><td data-label="A"><a href="x.html#y">a<\/a><\/td><td data-label="B" class="right">2<\/td><\/tr>/);
  assert.match(page, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(page, /^<div class="start">$/m);
  assert.match(page, /a_snake_name and &lt;b&gt;tag&lt;\/b&gt; and <a href="https:\/\/example.com\/a">https:\/\/example.com\/a<\/a>\./);
  const doc = renderMarkdown('<div class="x">\n\n<script>alert(1)</script>', { html: false }).html;
  assert.ok(!doc.includes('<div') && !doc.includes('<script'), doc);
  // GitHub's ids for README, NOTES and BRIEF: underscores and double hyphens kept, repeats numbered from 1.
  const gh = renderMarkdown('## a_b -- c\n## Setup\n## Setup', { idStyle: 'github' }).html;
  assert.match(gh, /id="a_b----c"[\s\S]*id="setup"[\s\S]*id="setup-1"/);
  assert.equal(slugId('macOS and Linux'), 'macos-and-linux');
  assert.ok(githubIds('## 6.2 Hours = counted, x (decided)\n').has('62-hours--counted-x-decided'));
  assert.ok(githubIds('## Setup\n## Setup\n').has('setup-1'));
});

test('1: every page in llms.txt is in the dist with its Markdown twin; the sitemap lists every page; llms-full holds every title under the cap', () => {
  const llms = read('llms.txt');
  const pages = [...(llms.split('## The run')[0] as string).matchAll(/^- \[([^\]]+)\]\((\S+?)\)/gm)];
  assert.equal(pages.length, cfg.pages.length);
  for (const [, , url] of pages) {
    assert.ok((url as string).startsWith(cfg.base_url), url);
    const rel = (url as string).slice(cfg.base_url.length);
    assert.ok(existsSync(join(dist, ...rel.split('/'))), rel);
    if (rel.endsWith('.md')) assert.ok(existsSync(join(dist, ...rel.replace(/\.md$/, '.html').split('/'))), `${rel} has its page`);
  }
  for (const f of ownHtml()) assert.ok(existsSync(join(dist, ...f.replace(/\.html$/, '.md').split('/'))), `${f} has a twin`);
  const sitemap = read('sitemap.xml');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => (m[1] as string).slice(cfg.base_url.length));
  const expected = [...ownHtml(), 'report.html', 'dashboard/index.html'].map((f) => (f === 'index.html' ? '' : f)).sort();
  assert.deepEqual([...locs].sort(), expected);
  const full = read('llms-full.txt');
  assert.ok(Buffer.byteLength(full) < 200 * 1024, `${Buffer.byteLength(full)} bytes`);
  for (const p of cfg.pages) if (p.kind === undefined) assert.ok(full.includes(`# ${p.title}\n`), p.title);
  for (const f of ['.claude/agents/extractor.md', '.claude/skills/observe/SKILL.md']) assert.ok(full.includes(`# ${f}\n`), f);
  assert.ok(existsSync(join(dist, '.nojekyll')));
  assert.match(read('robots.txt'), /^Sitemap: https:\/\/\S+sitemap\.xml$/m);
});

test('2: no script or style from elsewhere, no token left in a strict build', () => {
  for (const f of ownHtml()) {
    const html = read(f);
    assert.ok(!/<script[^>]*\ssrc=/.test(html), `${f}: a script source`);
    // Every resource a page loads (a script, an image, a stylesheet, the icon) is the site's own; the
    // canonical and alternate links name addresses and load nothing.
    for (const m of html.matchAll(/<(link|script|img)\b[^>]*\s(?:src|href)="([^"]*)"[^>]*>/g)) {
      if (m[1] === 'link' && /\srel="(canonical|alternate)"/.test(m[0])) continue;
      assert.ok(!/^(https?:)?\/\//.test(m[2] as string), `${f}: ${m[1]} loads ${m[2]}`);
    }
    assert.equal((html.match(/<script>/g) ?? []).length, 1, `${f}: the copy button's script only`);
  }
  for (const f of filesUnder(dist).filter((x) => /\.(html|md|txt)$/.test(x) && !x.startsWith('dashboard/'))) assert.ok(!LEFT_TOKEN.test(read(f)), `${f} holds a token`);
});

test('2: --strict refuses, one line per problem, and leaves an earlier build as it was; a lenient build exits 0 with visible markers', async () => {
  const bad = copySite(join(tmp, 'bad-site'));
  rmSync(join(bad, 'assets', 'screenshots', 'viewer.png'));
  const page = join(bad, 'pages', 'design.md');
  writeFileSync(
    page,
    `${readFileSync(page, 'utf8')}\nSee [nothing](/src/no-such-file.ts), [no anchor](run.html#no-such-anchor), [a script](javascript:alert(1)) and {{fig:nope}}.\n\n{{block:run_facts}} with text after it.\n`,
  );
  const docs = docsDir('bad-docs', `${README}\nIt took {{fig:headline}} and [a missing file](docs/missing.md).\n`, NOTES.replace('A sentence.', 'It took {{run.wall}}.'));
  const out = join(project, 'out');
  const reportMd = readFileSync(join(out, 'report.md'));
  rmSync(join(out, 'report.md'));
  // An earlier good build in the folder a refused build must leave alone.
  const keep = join(tmp, 'keep-dist');
  cpSync(dist, keep, { recursive: true });
  const before = read('index.html', keep);
  try {
    const r = await buildSite({ root: REPO, site: bad, docs, out, dist: keep, strict: true });
    assert.equal(r.ok, false);
    const one = (re: RegExp) => assert.equal(r.problems.filter((p) => re.test(p)).length, 1, `${re}: ${r.problems.join('\n')}`);
    one(/^NOTES\.md:\d+: placeholder \{\{run\.wall\}\} is not filled$/);
    one(/^README\.md:\d+: \{\{fig:headline\}\} is not a placeholder this build can show$/);
    one(/^README\.md: links to docs\/missing\.md, which is not in the repository$/);
    one(/^screenshot missing: site\/assets\/screenshots\/viewer\.png$/);
    one(/^run output missing: report\.md$/);
    one(/^site\/pages\/design\.md: links to src\/no-such-file\.ts, which is not in the repository$/);
    one(/^design\.html: links to run\.html#no-such-anchor, which has no such anchor$/);
    one(/^site\/pages\/design\.md: a link to javascript:alert\(1\), a kind of address the site does not use$/);
    one(/^site\/pages\/design\.md: unknown figure \{\{fig:nope\}\}$/);
    one(/^site\/pages\/design\.md:\d+: \{\{block:run_facts\}\} is not a token this build fills/);
    assert.equal(read('index.html', keep), before, 'the earlier build is untouched');
    assert.equal(existsSync(`${keep}.building`), false, 'no staging folder left');
  } finally {
    writeFileSync(join(out, 'report.md'), reportMd);
  }
  const empty = join(tmp, 'empty-out', 'out');
  mkdirSync(empty, { recursive: true });
  const lenientDist = join(tmp, 'lenient-dist');
  const r = await buildSite({ root: REPO, site: siteDir, docs: project, out: empty, dist: lenientDist });
  assert.equal(r.ok, true);
  assert.ok(r.problems.some((p) => p === 'run output missing: run-summary.json'));
  const index = read('index.html', lenientDist);
  assert.ok(index.includes(`<p class="banner">${NOT_COMMITTED}</p>`), 'the banner');
  assert.match(index, /<mark class="fill">\[to fill: fig\.messages_read\]<\/mark>/);
  assert.match(read('index.md', lenientDist), /\[to fill: fig\.headline\]/);
  for (const f of ['report.html', 'dashboard/index.html', 'dashboard/index.md']) assert.ok(existsSync(join(lenientDist, ...f.split('/'))), `${f} stands in`);
  for (const f of filesUnder(lenientDist)) assert.ok(!LOCAL_PATH.test(read(f, lenientDist)), `${f} holds a local path`);
});

test('2: the build refuses an output folder it must not clear, before anything is written', async () => {
  const stranger = join(tmp, 'stranger');
  mkdirSync(stranger);
  writeFileSync(join(stranger, 'notes.txt'), 'mine');
  const opts = { root: REPO, site: siteDir, docs: project, out: join(project, 'out') };
  await assert.rejects(buildSite({ ...opts, dist: stranger }), /is not a previous build of this site/);
  assert.equal(read('notes.txt', stranger), 'mine');
  const checkout = join(tmp, 'checkout');
  mkdirSync(join(checkout, '.git'), { recursive: true });
  for (const f of ['.nojekyll', 'llms.txt']) writeFileSync(join(checkout, f), '');
  await assert.rejects(buildSite({ ...opts, dist: checkout }), /Git working tree/);
  await assert.rejects(buildSite({ ...opts, dist: REPO }), /holds the repository/);
  await assert.rejects(buildSite({ ...opts, dist: project }), /holds the repository or the run output/);
  await assert.rejects(buildSite({ ...opts, dist: join(project, 'out', 'site') }), /sits in the run output/);
});

test('the commands: --help, a lenient build that exits 0, a strict refusal that exits 1 and writes nothing', () => {
  const help = node(['site/build.ts', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: node site\/build\.ts/);
  assert.equal(node(['site/publish.ts', '--help']).status, 0);
  const empty = join(tmp, 'cli-out', 'out');
  mkdirSync(empty, { recursive: true });
  const cliDist = join(tmp, 'cli-dist');
  const strict = node(['site/build.ts', '--out', empty, '--dist', cliDist, '--strict']);
  assert.equal(strict.status, 1, strict.stdout + strict.stderr);
  assert.match(strict.stderr, /^site: run output missing: run-summary\.json$/m);
  assert.match(strict.stderr, /--strict refused the build: [\d,]+ problems; .* left as it was$/m);
  assert.equal(existsSync(cliDist), false);
  const lenient = node(['site/build.ts', '--out', empty, '--dist', cliDist]);
  assert.equal(lenient.status, 0, lenient.stderr);
  assert.match(lenient.stdout, /^site: [\d,]+ files, /);
  assert.match(lenient.stdout, /lenient build: [\d,]+ items --strict would refuse/);
  assert.ok(existsSync(join(cliDist, 'index.html')));
  assert.equal(node(['site/build.ts', '--bogus']).status, 1);
});

test('3: the note is on every page once, word for word; the report is copied byte for byte', () => {
  for (const f of ownHtml()) {
    const html = read(f);
    assert.equal(html.split(cfg.note).length - 1, 1, `${f}: the note`);
    assert.match(html, /<button type="button" id="copy-url" class="copy" hidden>Copy address<\/button>/);
    const canonical = /<link rel="canonical" href="([^"]+)">/.exec(html)?.[1];
    assert.ok(canonical !== undefined && html.includes(`<code id="page-url">${canonical}</code>`), `${f}: the address is in the page`);
  }
  assert.ok(readFileSync(join(dist, 'report.html')).equals(readFileSync(join(project, 'out', 'report.html'))));
  assert.ok(!read('report.html').includes(cfg.note));
});

test('4: the agents table and the claude-code diagram say what the five agent files say', () => {
  const agents = readAgents(REPO);
  assert.deepEqual(agents.map((a) => a.name), ['taxonomist', 'extractor', 'merger', 'synthesizer', 'drafter']);
  const page = read('claude-dir.html');
  const svg = readFileSync(join(REPO, 'site', 'diagrams', 'claude-code.svg'), 'utf8');
  assert.deepEqual([...svg.matchAll(/data-agent="([a-z]+)"/g)].map((m) => m[1]), agents.map((a) => a.name));
  for (const a of agents) {
    for (const v of [a.model, a.effort, a.tools, a.maxTurns, a.permissionMode]) assert.ok(v !== '', `${a.name}: a field is empty`);
    const row = new RegExp(`<tr><td[^>]*><a [^>]*><code>${a.name}</code></a></td><td[^>]*><code>${a.model}</code></td><td[^>]*><code>${a.effort}</code></td><td[^>]*>${a.tools}</td><td[^>]*>${a.maxTurns}</td><td[^>]*><code>${a.permissionMode}</code></td></tr>`);
    assert.match(page, row, `${a.name}'s row`);
    const group = new RegExp(`data-agent="${a.name}">([\\s\\S]*?)</g>`).exec(svg)?.[1] ?? '';
    const texts = [...group.matchAll(/>([^<]+)<\/text>/g)].map((m) => m[1]);
    assert.deepEqual(texts, [a.name, `${a.model} · ${a.effort} effort`, `${a.tools} · ${a.maxTurns} turns`], `${a.name} in the diagram`);
  }
});

test('4: every role line of the Claude Code layer is one complete sentence: balanced parentheses, a final period', () => {
  const roles = claudeRoles(REPO);
  assert.ok(roles.length >= 20, `${roles.length} role lines`);
  for (const [path, role] of roles) {
    if (role === '') continue;
    assert.match(role, /[^.]\.$|\.\)\.$/, `${path}: "${role}" does not end with a period`);
    let depth = 0;
    for (const c of role) {
      if (c === '(') depth++;
      if (c === ')') depth--;
      assert.ok(depth >= 0, `${path}: a parenthesis closes before it opens`);
    }
    assert.equal(depth, 0, `${path}: "${role}" leaves a parenthesis open`);
    // One sentence: no full stop followed by a new sentence outside parentheses.
    assert.ok(!/\.\s+[A-Z]/.test(role.replace(/\([^()]*\)/g, '')), `${path}: "${role}" runs into a second sentence`);
  }
  const files = roles.filter(([p]) => /^\.claude\/(agents|skills|hooks)\//.test(p));
  assert.ok(files.every(([, r]) => r !== ''), 'every agent, skill and hook file has a role');
});

test('the Markdown twins point at twins for pages, and keep the report and the dashboard as HTML', () => {
  const index = read('index.md');
  assert.ok(index.includes(`[Read the report](${cfg.base_url}report.html)`), 'the report stays report.html');
  assert.ok(index.includes(`[in Markdown](${cfg.base_url}report.md)`));
  assert.ok(index.includes(`(${cfg.base_url}dashboard/index.html)`));
  assert.ok(index.includes(`(${cfg.base_url}run.md#documents)`), 'a page links to its twin');
  assert.ok(read('how-to-use.md').includes(`[\`report.html\`](${cfg.base_url}report.html)`));
  const llms = read('llms.txt');
  const raw = 'https://raw.githubusercontent.com/Schom975-coder/observation-agent-assignment/main/';
  for (const f of ['.claude/agents/extractor.md', '.claude/skills/observe/SKILL.md', '.claude/hooks/guard-corpus.ts', '.claude/plan/ARCHITECTURE.md', '.claude/notes/DECISIONS.md', '.claude/notes/NOTES-LOG.md']) {
    assert.ok(llms.includes(`[${f}](${raw}${f})`), `llms.txt lists ${f} as raw text`);
  }
  assert.ok(llms.includes('(https://github.com/Schom975-coder/observation-agent-assignment/tree/main/.claude)'), 'the .claude/ tree link stays');
  assert.ok(llms.includes(`[.claude/settings.json](${raw}.claude/settings.json): Permissions and the hook wiring.`), 'llms.txt lists settings.json as raw text');
  assert.ok(llms.split('## Pages')[0]?.includes(`Everything in one file: ${cfg.base_url}llms-full.txt`), 'llms.txt points at llms-full.txt before the pages');
  for (const f of ownHtml()) assert.match(read(f), /<a href="(\.\.\/)?llms-full\.txt">llms-full\.txt<\/a>/, `${f}: the footer links llms-full.txt`);
});

test('5: every fixed id is on its page, and every link inside the site resolves to a file and an id', () => {
  for (const p of cfg.pages) {
    if (p.kind !== undefined) continue;
    const html = read(`${p.file}.html`);
    for (const id of p.ids ?? []) assert.ok(html.includes(` id="${id}"`), `${p.file}.html #${id}`);
  }
  const ids = new Map<string, Set<string>>();
  const idsOf = (f: string) => {
    let s = ids.get(f);
    if (s === undefined) {
      s = new Set([...read(f).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] as string));
      ids.set(f, s);
    }
    return s;
  };
  let checked = 0;
  for (const f of ownHtml()) {
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    for (const m of read(f).matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      const href = (m[1] as string).replace(/&amp;/g, '&');
      if (/^(https?:|mailto:|data:)/.test(href)) continue;
      const [path, frag] = href.split('#') as [string, string | undefined];
      const parts: string[] = [];
      for (const s of [...(dir === '' || path === '' ? [] : dir.split('/')), ...(path === '' ? f.split('/') : path.split('/'))]) {
        if (s === '..') parts.pop();
        else if (s !== '.' && s !== '') parts.push(s);
      }
      const target = parts.join('/');
      assert.ok(existsSync(join(dist, ...parts)), `${f}: ${href} has no file`);
      if (frag !== undefined && frag !== '') assert.ok(idsOf(target).has(frag), `${f}: ${href} has no such id`);
      checked++;
    }
  }
  assert.ok(checked > 200, `${checked} links checked`);
});

test('6: every commit the process page cites is in the repository', (t) => {
  const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: REPO, encoding: 'utf8' });
  if (shallow.status !== 0 || shallow.stdout.trim() === 'true') {
    t.skip(shallow.status !== 0 ? 'not a Git checkout' : 'a shallow clone has no history to check against');
    return;
  }
  const hashes = [...new Set([...read('process.html').matchAll(/\/commit\/([0-9a-f]{7,40})"/g)].map((m) => m[1] as string))];
  assert.ok(hashes.length >= 20, `${hashes.length} commits cited`);
  for (const h of hashes) assert.equal(spawnSync('git', ['cat-file', '-e', `${h}^{commit}`], { cwd: REPO }).status, 0, `${h} is not a commit here`);
});

test('7: two builds of the same inputs are byte for byte the same', async () => {
  const again = join(tmp, 'dist-again');
  const r = await buildSite({ root: REPO, site: siteDir, docs: project, out: join(project, 'out'), dist: again, strict: true });
  assert.equal(r.ok, true, r.problems.join('\n'));
  const a = filesUnder(dist);
  assert.deepEqual(filesUnder(again), a);
  for (const f of a) assert.ok(readFileSync(join(dist, ...f.split('/'))).equals(readFileSync(join(again, ...f.split('/')))), `${f} differs`);
});

test('9: no local path anywhere in the dist', () => {
  for (const f of filesUnder(dist).filter((x) => /\.(html|md|txt|xml|json|css|js|svg)$/.test(x))) assert.ok(!LOCAL_PATH.test(read(f)), `${f} holds a local path`);
});

test('11: the dashboard copy is wired in: marked static, one message file per manifest entry, out of the sitemap, its figures on the run page', () => {
  assert.ok(result.dashboard !== null);
  assert.match(read('dashboard/index.html'), /<html lang="en" data-static="1">/);
  const manifest = JSON.parse(readFileSync(join(project, 'out', 'manifest.json'), 'utf8')) as { entries: unknown[] };
  const messages = filesUnder(join(dist, 'dashboard', 'm'));
  assert.equal(messages.length, manifest.entries.length);
  assert.equal(result.dashboard.messages, manifest.entries.length);
  const sitemap = read('sitemap.xml');
  assert.ok(sitemap.includes(`${cfg.base_url}dashboard/index.html`));
  assert.ok(!/\/m\/|\.json/.test(sitemap));
  for (const f of ['llms.txt', 'llms-full.txt']) assert.ok(!/dashboard\/m\//.test(read(f)), f);
  assert.ok(read('run.html').includes(`The copy holds ${count(result.dashboard.messages)} messages, ${count(result.dashboard.files)} files in all`));
});

test('the authored pages name no model and use no em dash, en dash, spaced double hyphen or exclamation mark', () => {
  for (const f of readdirSync(join(REPO, 'site', 'pages')).filter((x) => x.endsWith('.md'))) {
    const text = readFileSync(join(REPO, 'site', 'pages', f), 'utf8');
    assert.ok(!/opus|sonnet|haiku/i.test(text), `${f} names a model`);
    assert.ok(!/[–—]| -- |!/.test(text), `${f} has a dash or an exclamation mark`);
  }
});

test('10: publish writes the dist as one gh-pages commit without a checkout, continues its history, never pushes, and refuses what it must', () => {
  const repo = join(tmp, 'pub repo');
  mkdirSync(repo);
  const git = (args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(['init', '-q', '-b', 'work']);
  git(['config', 'user.name', 'test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'README.md'), 'x\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'start']);
  const pubDist = join(tmp, 'pub dist');
  const want = new Map<string, Buffer>();
  const put = (rel: string, bytes: Buffer) => {
    mkdirSync(join(pubDist, ...rel.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(pubDist, ...rel.split('/')), bytes);
    want.set(rel, bytes);
  };
  put('.nojekyll', Buffer.alloc(0));
  put('index.html', Buffer.from('<!doctype html><meta name="obs-run" content="20261019T000000Z">\r\nCRLF kept\n'));
  put('fonts/a font.woff2', Buffer.from([0, 1, 2, 255, 13, 10, 0]));
  // Over one batch of hash-object (1,000 paths), in nested folders.
  for (let i = 0; i < 1100; i++) put(`dashboard/m/box-${i % 4}/folder-${i % 7}/${i}.json`, Buffer.from(`{"n":${i}}\n`));
  const started = performance.now();
  const one = publish({ repo, dist: pubDist });
  const ms = Math.round(performance.now() - started);
  const blobSha = (b: Buffer) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
  const listed = new Map(
    git(['ls-tree', '-r', '-z', 'gh-pages'])
      .split('\0')
      .filter((l) => l !== '')
      .map((l) => [l.split('\t')[1] as string, (l.split('\t')[0] as string).split(' ')[2] as string] as const),
  );
  assert.equal(listed.size, want.size);
  for (const [rel, bytes] of want) assert.equal(listed.get(rel), blobSha(bytes), `${rel} in the tree with its bytes`);
  assert.ok(listed.has('.nojekyll'));
  assert.equal(one.parent, null);
  assert.match(git(['log', '-1', '--format=%s', 'gh-pages']), /^Site from [0-9a-f]+, run 20261019T000000Z$/);
  assert.equal(git(['symbolic-ref', '--short', 'HEAD']), 'work', 'HEAD and the working tree are left alone');
  assert.equal(git(['status', '--porcelain']), '');
  put('index.html', Buffer.from('<meta name="obs-run" content="20261019T000000Z">changed\n'));
  const two = publish({ repo, dist: pubDist, message: 'Second' });
  assert.equal(two.parent, one.commit);
  assert.equal(git(['rev-list', '--count', 'gh-pages']), '2');
  assert.equal(git(['rev-parse', 'gh-pages^']), one.commit);
  assert.equal(publish({ repo, dist: pubDist }).unchanged, true);
  assert.equal(git(['rev-list', '--count', 'gh-pages']), '2');
  // A fresh clone has origin's gh-pages only: the next commit continues it, so no force is needed.
  git(['update-ref', 'refs/remotes/origin/gh-pages', two.commit]);
  git(['update-ref', '-d', 'refs/heads/gh-pages']);
  put('index.html', Buffer.from('<meta name="obs-run" content="20261019T000000Z">third\n'));
  const three = publish({ repo, dist: pubDist });
  assert.equal(three.parent, two.commit);
  assert.equal(git(['rev-list', '--count', 'gh-pages']), '3');
  assert.equal(spawnSync('git', ['remote'], { cwd: repo, encoding: 'utf8' }).stdout.trim(), '', 'no remote was touched');
  // Refusals.
  assert.throws(() => publish({ repo, dist: join(tmp, 'no such dist') }), /missing/);
  assert.throws(() => publish({ repo, dist: pubDist, branch: 'work' }), /checked out here/);
  assert.throws(() => publish({ repo, dist: pubDist, branch: 'main' }), /refusing to publish onto main/);
  assert.throws(() => publish({ repo, dist: pubDist, branch: 'refs/heads/x' }), /not a usable branch name/);
  put('run.html', Buffer.from('<p><mark class="fill">[to fill: fig.headline]</mark></p>'));
  assert.throws(() => publish({ repo, dist: pubDist }), /still show placeholders/);
  rmSync(join(pubDist, 'run.html'));
  put('index.html', Buffer.from('no run named\n'));
  assert.throws(() => publish({ repo, dist: pubDist }), /names no run/);
  put('index.html', Buffer.from('<meta name="obs-run" content="20261019T000000Z">\n'));
  git(['checkout', '-q', '--detach']);
  assert.throws(() => publish({ repo, dist: pubDist }), /detached/);
  console.log(`# publish: ${want.size} files in ${ms} ms`);
});

test('8: README and drafted documents are rendered as text: no tag of theirs survives', async () => {
  const hostile = JSON.parse(readFileSync(join(REPO, 'tests', 'fixtures', 'dashboard', 'hostile.json'), 'utf8')) as { markdown: string };
  const index = JSON.parse(readFileSync(join(project, 'out', 'artifacts', 'artifacts.json'), 'utf8')) as { artifacts: Array<{ slug: string; status: string; path: string }> };
  const art = index.artifacts.find((a) => a.status === 'done');
  assert.ok(art !== undefined);
  const file = join(project, ...art.path.split('/'));
  const saved = readFileSync(file);
  writeFileSync(file, hostile.markdown);
  const docs = docsDir('hostile-docs', `${README}\n<script>alert(1)</script>\n\n<img src=x onerror=alert(2)> and [x](javascript:alert(3)) and ![p](//example.invalid/p.png)\n`);
  const hostileDist = join(tmp, 'hostile-dist');
  try {
    const r = await buildSite({ root: REPO, site: siteDir, docs, out: join(project, 'out'), dist: hostileDist });
    assert.equal(r.ok, true);
  } finally {
    writeFileSync(file, saved);
  }
  const html = read(`documents/${art.slug}.html`, hostileDist);
  const doc = html.slice(html.indexOf('<div class="doc">'), html.indexOf('</main>'));
  assert.ok(doc.length > 100, 'the document is on its page');
  for (const tag of ['<script', '<img', '<b>', '<i>', 'href="javascript']) assert.ok(!doc.includes(tag), `${tag} survived`);
  assert.ok(doc.includes('&lt;script&gt;alert(&#39;doc&#39;)&lt;/script&gt;'), 'shown as text');
  assert.match(html, /<h1>Hostile: SOP<\/h1>/);
  assert.equal(read(`documents/${art.slug}.md`, hostileDist), hostile.markdown, 'the twin is the file as it is');
  const readme = read('how-to-run.html', hostileDist);
  const main = readme.slice(readme.indexOf('<main'), readme.indexOf('</main>'));
  for (const tag of ['<script', '<img src=x', 'href="javascript', 'src="//']) assert.ok(!main.includes(tag), `README: ${tag} survived`);
  assert.ok(!/<img[^>]*onerror/.test(main), 'README: an image with a handler survived');
  assert.ok(main.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'README tags shown as text');
});

test('freshRunOf: a forced run that wrote its scores gives its headline; anything else gives none', () => {
  const line = (e: Record<string, unknown>) => `${JSON.stringify(e)}\n`;
  const score = (total: string, missing: string) => ({
    event: 'stage',
    name: 'score',
    summary: `score: tiers A+B $${total}/mo automatable (counted email $526.19 + estimated work $1,704.94), all tiers $2,683.45/mo, observed in 4 mailboxes, 1999-2002; 60 opportunities (13 A, 29 B, 18 C); ${missing}; wrote out/opportunities.json.`,
  });
  const forced = line({ event: 'run_start', force: true });
  assert.deepEqual(freshRunOf(`${forced}not json\n${line(score('2,231.13', '2 estimates missing'))}`), { total: '2,231.13', counted: '526.19', estimated: '1,704.94', processes: 60, missing: 2 });
  assert.equal(freshRunOf(forced + line(score('2,231.13', '1 estimate missing')))?.missing, 1);
  // A later re-score in the same log wins, as it would in the file.
  assert.equal(freshRunOf(forced + line(score('1,000.00', '0 estimates missing')) + line(score('2,231.13', '0 estimates missing')))?.total, '2,231.13');
  assert.equal(freshRunOf(line({ event: 'run_start', force: false }) + line(score('2,231.13', '0 estimates missing'))), null, 'not forced');
  assert.equal(freshRunOf(forced + line({ event: 'stage', name: 'merge accept', summary: 'merge: accepted' })), null, 'never scored');
  assert.equal(freshRunOf(forced + line({ event: 'stage', name: 'score', summary: 'score: refused, 1 problem.' })), null, 'a refused score wrote nothing');
  assert.equal(freshRunOf(''), null);
});

