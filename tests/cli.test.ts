import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../src/cli.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

function obs(...args: string[]) {
  return spawnSync(process.execPath, ['obs.mjs', ...args], { cwd: root, encoding: 'utf8' });
}

test('--help exits 0 and lists every command', () => {
  const r = obs('--help');
  assert.equal(r.status, 0, r.stderr);
  for (const name of Object.keys(COMMANDS)) assert.match(r.stdout, new RegExp(`^  ${name} `, 'm'));
});

test('no arguments prints the same help', () => {
  const r = obs();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Usage: node obs\.mjs <command>/);
});

test('an unknown command exits 1 and points at --help', () => {
  const r = obs('frobnicate');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command "frobnicate".*--help/);
});

test('--help lists every command as built: no milestone marker and no legend for one', () => {
  const r = obs('--help');
  const lines = r.stdout.split('\n');
  for (const name of Object.keys(COMMANDS)) {
    const line = lines.find((l) => l.startsWith(`  ${name} `));
    assert.ok(line !== undefined && !/\[M\d\]$/.test(line.trim()), `${name}: ${line}`);
  }
  assert.ok(Object.values(COMMANDS).every((cmd) => cmd.run !== undefined), 'every command has a run');
  assert.ok(lines.includes('Commands:') && !r.stdout.includes('[Mx]'), r.stdout);
});

// The CLI resolves its own folder as the project root, so it is copied into an empty project whose
// path holds a space; build and summary there refuse with one line each.
test('node obs.mjs build and summary on an empty project print one refusal each and exit 1', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'obs cli '));
  try {
    cpSync(join(root, 'src'), join(tmp, 'src'), { recursive: true });
    copyFileSync(join(root, 'obs.mjs'), join(tmp, 'obs.mjs'));
    copyFileSync(join(root, 'package.json'), join(tmp, 'package.json'));
    const run = (...args: string[]) => spawnSync(process.execPath, [join(tmp, 'obs.mjs'), ...args], { cwd: tmp, encoding: 'utf8' });
    const build = run('build');
    assert.equal(build.status, 1, build.stderr);
    assert.equal(build.stderr.trim(), 'build: out/opportunities.json is missing or not current: run node obs.mjs score first.');
    for (const args of [['summary'], ['summary', '--json']]) {
      const summary = run(...args);
      assert.deepEqual([summary.status, summary.stdout, summary.stderr], [1, '', 'summary: out/run-summary.json is missing: run node obs.mjs build first.\n'], args.join(' '));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
