// "Every number drills to messages" (A4) and "every count equals the list it opens" (A5), checked by
// the walk of src/report/targets.ts: on the fixture build, on the report model, on hand-broken
// copies (each kind of problem is caught), and on the committed out/ or the project OBS_BUILD_ROOT
// names (skipped while its build is not current).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCurrent } from '../src/report/build.ts';
import { buildReport, reportNums } from '../src/report/report.ts';
import { checkTargets, dollarsOf, numsIn, type Bundle } from '../src/report/targets.ts';
import type { DashboardData, MethodData, Num, ProcessData } from '../src/report/types.ts';
import { builtProject } from './fixtures/pipeline.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'obs targets '));
after(() => rmSync(tmp, { recursive: true, force: true }));

// The built files of a project, as the walk takes them.
export function bundleOf(root: string): Bundle {
  const dir = join(root, 'out', 'dashboard');
  const read = (f: string) => JSON.parse(readFileSync(join(dir, ...f.split('/')), 'utf8')) as unknown;
  const processes = readdirSync(join(dir, 'process'))
    .sort()
    .map((f) => read(`process/${f}`) as ProcessData);
  return { data: read('data.json') as DashboardData, method: read('method.json') as MethodData, loops: read('loops.json') as Bundle['loops'], processes, index: read('messages/index.json') as Bundle['index'] };
}

let fixture: Bundle;
before(() => {
  fixture = bundleOf(builtProject(tmp));
});

test('A4, A5: every Num of the fixture build has a target that resolves, and every count equals its list', () => {
  assert.deepEqual(checkTargets(fixture), []);
  const all = [...numsIn(fixture.data), ...numsIn(fixture.method), ...fixture.processes.flatMap((p) => numsIn(p))];
  assert.ok(all.length > 200, `${all.length} figures walked`);
  for (const { num, path } of all) assert.ok(typeof num.d?.kind === 'string', path);
});

test('the report places only Nums with targets: the same walk over the report model', () => {
  const model = buildReport(fixture.data, fixture.processes, fixture.method);
  const nums = reportNums(model);
  assert.ok(nums.length > 50);
  assert.deepEqual(checkTargets(fixture, [{ name: 'report', value: nums, counts: false }]), []);
});

test('the walk catches each kind of problem', () => {
  const broken = (edit: (b: Bundle) => void): string[] => {
    const b = structuredClone(fixture) as Bundle;
    edit(b);
    return checkTargets(b);
  };
  const row = (b: Bundle) => b.data.rows[0] as DashboardData['rows'][number];
  assert.match(broken((b) => void delete (row(b).total as Partial<Num>).d).join('\n'), /has no drill target/);
  assert.match(broken((b) => void (row(b).occurrences.d = { kind: 'occurrences', key: 'no-such-process' })).join('\n'), /not a process/);
  assert.match(broken((b) => void (row(b).occurrences.v += 1)).join('\n'), /counts \d+ but its occurrences list holds \d+/);
  assert.match(broken((b) => void (row(b).staff.v += 1)).join('\n'), /participants list/);
  assert.match(broken((b) => void (row(b).loops.v += 1)).join('\n'), /loops list/);
  assert.match(broken((b) => void (b.data.headline.estimated.t = '$999,999')).join('\n'), /does not add up/);
  assert.match(broken((b) => void (row(b).counted.v += 1)).join('\n'), /parts' cents do not add up|rows in the total add up/);
  assert.match(broken((b) => void (b.data.cumulative.at(-1) as DashboardData['cumulative'][number]).cents.v++).join('\n'), /cumulative: ends at/);
  assert.match(broken((b) => void (b.method.coverage[0] as MethodData['coverage'][number]).ids.push((b.method.coverage[0] as MethodData['coverage'][number]).ids[0] as string)).join('\n'), /two buckets|buckets hold/);
  assert.match(broken((b) => void (row(b).total.d = { kind: 'message', id: 'corpus/none/1.' })).join('\n'), /not in the index/);
  assert.match(broken((b) => void (row(b).occurrences.d = { kind: 'actions', key: row(b).key, type: 'bogus' as never })).join('\n'), /not an action type/);
  // A count of rows equals the rows its filter opens; a count whose target opens no list fails; the
  // loops in drafted processes are counted as such; a target kind the walk does not know fails.
  assert.match(broken((b) => void b.data.headline.rows_in_total.v++).join('\n'), /counts \d+ but its rows list holds \d+/);
  assert.match(broken((b) => void (b.data.headline.one_mailbox_rows.d = { kind: 'rows', filter: 'below' })).join('\n'), /rows list/);
  assert.match(broken((b) => void (row(b).occurrences.d = { kind: 'process', key: row(b).key })).join('\n'), /is a count, but its process target opens no list/);
  const nums = (b: Bundle) => b.data.next_steps.flatMap((x) => x.nums);
  assert.match(broken((b) => void nums(b).filter((x) => x.d.kind === 'loops').forEach((x) => x.v++)).join('\n'), /loops list/);
  assert.match(broken((b) => void (row(b).total.d = { kind: 'bogus' } as unknown as Num['d'])).join('\n'), /no drill target of a known kind/);
  assert.match(broken((b) => void (b.data.run.agents !== null && (b.data.run.agents.v += 1))).join('\n'), /data\.run\.agents: "\d+" counts \d+ but its method list holds \d+/);
  // A share and a duration are not counts (NOT_A_LIST): changing one breaks no count.
  assert.deepEqual(broken((b) => void ((b.data.cumulative[0] as DashboardData['cumulative'][number]).share.v += 1)).filter((p) => /counts|opens no list/.test(p)), []);
  // What the page shows adds up: a row's shown dollars, the running total, the hours.
  assert.match(broken((b) => void (row(b).total.t = '$999,999')).join('\n'), /shown: the rows in the total show/);
  assert.match(broken((b) => void ((b.data.cumulative[0] as DashboardData['cumulative'][number]).cents.t = '$1')).join('\n'), /shown: the running total/);
  assert.match(broken((b) => void (row(b).hours.t = '99.9')).join('\n'), /shown: the rows' hours/);
});

test('dollarsOf reads whole-dollar figures only', () => {
  assert.equal(dollarsOf('$1,511'), 1511);
  assert.equal(dollarsOf('$0'), 0);
  assert.equal(dollarsOf('$2,050.47'), null);
  assert.equal(dollarsOf('1,511'), null);
});

// The committed out/, or another project: OBS_BUILD_ROOT=<a project folder> npm test.
test('A4, A5 on the real build', (t) => {
  const real = process.env.OBS_BUILD_ROOT ?? repo;
  if (!buildCurrent(real)) {
    t.skip('its build is not current: run node obs.mjs build there first');
    return;
  }
  const b = bundleOf(real);
  assert.deepEqual(checkTargets(b, [{ name: 'report', value: reportNums(buildReport(b.data, b.processes, b.method)), counts: false }]), []);
  const total = b.method.coverage.reduce((n, c) => n + c.ids.length, 0);
  assert.equal(total, b.data.scope.files.v, 'the seven buckets hold every message');
});
