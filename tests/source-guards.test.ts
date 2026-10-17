// Rules from CLAUDE.md that a grep can enforce. They fail the build instead of relying on review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const self = relative(root, fileURLToPath(import.meta.url)).replaceAll('\\', '/');
const CODE = /\.(ts|mts|js|mjs|cjs|json)$/;
const TEXT = /\.(ts|mts|js|mjs|cjs|json|md|yml|yaml)$/;

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
      if (kind.test(rel) && rel !== self) files.push(rel);
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

test('public repo: no local file paths in anything we commit', () => {
  const ours = filesIn(TEXT, 'src', 'tests', 'config', '.claude', '.github', 'CLAUDE.md', 'package.json', 'obs.mjs');
  assert.deepEqual(violations(ours, /[A-Za-z]:[\\/]Users[\\/]|\/Users\/[A-Za-z]|\/home\/[A-Za-z]|AppData[\\/]/), []);
});
