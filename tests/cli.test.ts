import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  const r = obs('serve');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /"serve" is not built yet \(milestone M7\)/);
});
