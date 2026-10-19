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

test('a planned command that is not built yet exits 2 and names its milestone', () => {
  const r = obs('summary');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /"summary" is not built yet \(milestone M8\)/);
});

test('--help lists build and serve as built', () => {
  const lines = obs('--help').stdout.split('\n');
  for (const name of ['build', 'serve']) {
    const line = lines.find((l) => l.startsWith(`  ${name} `));
    assert.ok(line !== undefined && !/\[M\d\]$/.test(line.trim()), `${name}: ${line}`);
  }
});

// The CLI resolves its own folder as the project root, so it is copied into an empty project whose
// path holds a space; build there refuses with its first line.
test('node obs.mjs build on an empty project prints the first refusal and exits 1', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'obs cli '));
  try {
    cpSync(join(root, 'src'), join(tmp, 'src'), { recursive: true });
    copyFileSync(join(root, 'obs.mjs'), join(tmp, 'obs.mjs'));
    copyFileSync(join(root, 'package.json'), join(tmp, 'package.json'));
    const r = spawnSync(process.execPath, [join(tmp, 'obs.mjs'), 'build'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr.trim(), 'build: out/opportunities.json is missing or not current: run node obs.mjs score first.');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
