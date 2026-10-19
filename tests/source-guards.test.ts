// Rules from CLAUDE.md that a grep can enforce. They fail the build instead of relying on review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const self = relative(root, fileURLToPath(import.meta.url)).replaceAll('\\', '/');
const CODE = /\.(ts|mts|js|mjs|cjs|json)$/;
const TEXT = /\.(ts|mts|js|mjs|cjs|json|md|yml|yaml|html|css|txt)$/;

const codeFiles = (...dirs: string[]) => filesIn(CODE, ...dirs);

function filesIn(kind: RegExp, ...dirs: string[]): string[] {
  const files: string[] = [];
  for (const dir of dirs) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isFile()) {
      files.push(dir);
      continue;
    }
    for (const entry of readdirSync(abs, { recursive: true, encoding: 'utf8' })) {
      const rel = `${dir}/${entry.replaceAll('\\', '/')}`;
      // site/dist is the site's git-ignored build output: nothing there is committed.
      if (kind.test(rel) && rel !== self && !/^site\/dist(\.building)?\//.test(rel)) files.push(rel);
    }
  }
  return files;
}

// Every line in `files` matching `pattern` and not excused by `allow`.
function violations(files: string[], pattern: RegExp, allow?: (line: string) => boolean): string[] {
  const hits: string[] = [];
  for (const file of files) {
    readFileSync(join(root, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (pattern.test(line) && !allow?.(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
  }
  return hits;
}

const pipeline = codeFiles('src', 'obs.mjs', '.claude/hooks', 'dashboard');

test('no JavaScript built-in date parsing (it silently turns 31 Apr into 1 May)', () => {
  assert.deepEqual(violations(pipeline, /Date\.parse\(/), []);
  // new Date() for "now" is fine; anything else must be epoch arithmetic marked `date-ok`.
  assert.deepEqual(
    violations(pipeline, /new Date\(/, (line) => /new Date\(\)/.test(line) || line.includes('date-ok')),
    [],
  );
});

test('no logic keyed to the 16-digit Message-ID shape of the planted test messages', () => {
  assert.deepEqual(violations([...pipeline, ...codeFiles('tests')], /\{16\}|\\d\{16/), []);
});

test('no paid API: no Anthropic SDK and no API key anywhere in code or config', () => {
  const everything = [...pipeline, ...codeFiles('tests', 'config', '.claude', 'package.json')];
  assert.deepEqual(violations(everything, /@anthropic-ai|ANTHROPIC_API_KEY/), []);
});

test('pipeline code never reads the browsing copy corpus-view/', () => {
  assert.deepEqual(violations(pipeline, /corpus-view/), []);
});

// A9: one formatter writes every money figure, with its kind. Outside src/report/format.ts, nothing
// in the report code or the dashboard builds a dollar string by hand or with the locale.
test('money strings come from the one formatter (src/report/format.ts) only', () => {
  const files = codeFiles('src/report', 'dashboard').filter((f) => f !== 'src/report/format.ts');
  assert.deepEqual(violations(files, /'\$' \+|"\$" \+|`\$\$\{|toLocaleString\('en-US'/), []);
});

// A16: the build is deterministic and model-free: no clock, no randomness, no child process, no
// platform test in the report code.
test('the report code reads no clock, no randomness, no child process and no platform', () => {
  const files = codeFiles('src/report');
  assert.deepEqual(violations(files, /Date\.now|Math\.random|new Date\(|node:child_process|process\.platform/), []);
});

// Same on every OS: nothing in the code or the page tests the platform except the server's choice of
// the command that opens a browser (`serve --open`).
test('process.platform is read in src/serve/server.ts only', () => {
  const files = codeFiles('src', 'dashboard', 'obs.mjs').filter((f) => f !== 'src/serve/server.ts');
  assert.deepEqual(violations(files, /process\.platform/), []);
});

// A16 for the server: the one child process it starts is itself (`serve --background`), by spawn of
// this Node with an argv array; the browser command goes through an injected spawn. No shell, no
// other way to run a program.
test('the server starts no child process but itself and the browser, never through a shell', () => {
  const files = codeFiles('src/serve');
  assert.ok(files.includes('src/serve/server.ts'));
  assert.deepEqual(
    violations(files, /node:child_process/, (line) => line.trim() === "import { spawn, type SpawnOptions } from 'node:child_process';"),
    [],
  );
  assert.deepEqual(violations(files, /(?<![.\w])(?:spawnSync|execSync|execFileSync|execFile|exec|fork)\s*\(|\bshell\s*:/), []);
  assert.deepEqual(violations(files, /\bspawn\(/, (line) => line.includes('spawn(process.execPath, [')), []);
});

const LOCAL_PATH = /[A-Za-z]:[\\/]Users[\\/]|\/Users\/[A-Za-z]|\/home\/[A-Za-z]|AppData[\\/]/;

test('public repo: no local file paths in anything we commit', () => {
  const ours = filesIn(TEXT, 'src', 'tests', 'config', '.claude', '.github', 'dashboard', 'CLAUDE.md', 'package.json', 'obs.mjs', 'README.md', 'NOTES.md', 'BRIEF.md', 'site');
  assert.deepEqual(violations(ours, LOCAL_PATH), []);
});

// The run's outputs are committed too (run logs, ledger files, extractions): every text file Git
// tracks under out/, the built dashboard and report included. Skipped outside a Git checkout, where
// there is no list of committed files.
test('public repo: no local file paths in the committed out/ files', (t) => {
  const r = spawnSync('git', ['ls-files', '-z', '--', 'out'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) {
    t.skip('not a Git checkout');
    return;
  }
  const committed = r.stdout.split('\0').filter((f) => f !== '' && /\.(json|jsonl|md|txt|html|css|js)$/.test(f) && existsSync(join(root, f)));
  assert.ok(committed.length > 0 || !existsSync(join(root, 'out')), 'the committed out/ files were listed');
  assert.deepEqual(violations(committed, LOCAL_PATH), []);
});
