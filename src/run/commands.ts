// The ledger commands the orchestrator (and a person) runs: status, dispatch, validate, run.
// Output is short on purpose: the orchestrator reads it after every subagent completion.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkExtraction } from '../model/validate-extraction.ts';
import {
  BATCH_STATUSES,
  LedgerError,
  batchViews,
  findBatch,
  isSetupProblem,
  loadIndex,
  markDispatched,
  newRunId,
  normalizeBatchId,
  nowUtc,
  outDir,
  readRun,
  recordValidation,
  requireRunning,
  taxonomyFile,
  withoutRoot,
  writeRun,
  type BatchStatus,
  type BatchView,
  type RunState,
} from './ledger.ts';

// Absolute, forward slashes on every OS: the form the subagent's file tools take everywhere.
const absolute = (root: string, rel: string): string => resolve(root, rel).replaceAll('\\', '/');

// The one prompt every extractor gets. The agent definition holds the instructions; this names
// the files. The OUTPUT line is what the SubagentStop gate reads to find the result.
export function extractorPrompt(root: string, batchId: string): string {
  const taxonomy = existsSync(taxonomyFile(root))
    ? `Taxonomy file: ${absolute(root, 'out/taxonomy.json')}`
    : 'Taxonomy file: none yet. Every process key must be new:<slug>, each defined in new_processes.';
  return [
    `Extract batch ${batchId}.`,
    `Batch file: ${absolute(root, `out/batches/${batchId}.md`)}`,
    taxonomy,
    `Output file: ${absolute(root, `out/extract/${batchId}.json`)}`,
    'When the output file is written, end your reply with exactly this line:',
    `OUTPUT: out/extract/${batchId}.json`,
  ].join('\n');
}

// "batch-000, batch-002..batch-005": consecutive batch numbers collapse into a range.
export function compactIds(ids: readonly string[]): string {
  const nums = ids.map((id) => ({ id, n: Number(id.slice(id.lastIndexOf('-') + 1)) }));
  const parts: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && (nums[j + 1] as { n: number }).n === (nums[j] as { n: number }).n + 1) j++;
    const first = (nums[i] as { id: string }).id;
    const last = (nums[j] as { id: string }).id;
    parts.push(j === i ? first : j === i + 1 ? `${first}, ${last}` : `${first}..${last}`);
    i = j + 1;
  }
  return parts.join(', ');
}

export type StatusReport = {
  batches: number;
  counts: Record<BatchStatus, number>;
  extraction: 'complete' | 'incomplete'; // complete: nothing pending or running
  run: RunState;
} & Record<BatchStatus, string[]>;

export function statusReport(root: string, views: readonly BatchView[] = batchViews(root)): StatusReport {
  const lists = { pending: [] as string[], running: [] as string[], done: [] as string[], failed: [] as string[] };
  for (const v of views) lists[v.status].push(v.entry.batch_id);
  const counts = { pending: lists.pending.length, running: lists.running.length, done: lists.done.length, failed: lists.failed.length };
  return {
    batches: views.length,
    counts,
    extraction: counts.pending + counts.running === 0 ? 'complete' : 'incomplete',
    run: readRun(root),
    ...lists,
  };
}

// Commands report a LedgerError as one line and exit 1; anything else is a bug and is thrown.
function guarded(name: string, run: () => number): number {
  try {
    return run();
  } catch (err) {
    if (err instanceof LedgerError) {
      console.error(`${name}: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

export function statusCommand(root: string, args: readonly string[]): number {
  return guarded('status', () => {
    const json = args.includes('--json');
    const unknown = args.filter((a) => a !== '--json');
    if (unknown.length > 0) throw new LedgerError(`unexpected argument "${unknown[0]}". Usage: node obs.mjs status [--json]`);
    const views = batchViews(root);
    const report = statusReport(root, views);
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    const c = report.counts;
    const run = report.run.active ? `run ${report.run.run_id} active` : 'no run active';
    // "complete" means nothing is left to hand out or wait for; failed batches are named with it.
    const extraction = report.extraction === 'complete' && c.failed > 0 ? `complete, ${c.failed} failed` : report.extraction;
    console.log(
      `status: ${report.batches} batches: ${c.done} done, ${c.running} running, ${c.pending} pending, ${c.failed} failed; ` +
        `extraction: ${extraction}; ${run}.`,
    );
    for (const status of BATCH_STATUSES) {
      if (report[status].length > 0) console.log(`  ${status}: ${compactIds(report[status])}`);
    }
    const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
    for (const v of views.filter((x) => x.status === 'failed')) {
      const s = v.state;
      console.log(
        `  ${v.entry.batch_id} failed: ${n(s.problems ?? 0, 'problem', 'problems')} after ${n(s.gate_blocks, 'gate block', 'gate blocks')}, ` +
          `${n(s.dispatches, 'dispatch', 'dispatches')}.`,
      );
    }
    return 0;
  });
}

// One batch ID: "batch-074", or just "74".
function oneBatchArg(command: string, args: readonly string[]): string {
  if (args.length !== 1 || (args[0] as string).startsWith('-')) {
    throw new LedgerError(`expected one batch ID. Usage: node obs.mjs ${command} <batch_id> (batch-074, or just 74)`);
  }
  return normalizeBatchId(args[0] as string);
}

export function dispatchCommand(root: string, args: readonly string[]): number {
  return guarded('dispatch', () => {
    const entry = findBatch(loadIndex(root), oneBatchArg('dispatch', args));
    markDispatched(root, entry);
    // Only the prompt goes to stdout, so the orchestrator can pass it on unchanged.
    console.log(extractorPrompt(root, entry.batch_id));
    return 0;
  });
}

export const MAX_PROBLEMS_SHOWN = 10;

export function validateCommand(root: string, args: readonly string[]): number {
  return guarded('validate', () => {
    const entry = findBatch(loadIndex(root), oneBatchArg('validate', args));
    requireRunning(root, entry.batch_id);
    const check = checkExtraction(root, entry.batch_id, { outDir: outDir(root) });
    const shown = check.problems.map((p) => withoutRoot(p, root));
    if (check.problems.some(isSetupProblem)) {
      // Not the extraction's fault: nothing is stamped, the batch stays running for a rerun.
      console.log(`validate: ${entry.batch_id} could not be checked; it stays running.`);
      for (const p of shown.slice(0, MAX_PROBLEMS_SHOWN)) console.log(`  - ${p}`);
      return 1;
    }
    const state = recordValidation(root, entry, check);
    const q = state.quote_stats;
    const quotes = q === null ? 'no quotes checked' : `quotes ${q.exact} exact, ${q.repaired} repaired, ${q.rejected} rejected`;
    const problems = `${check.problems.length} problem${check.problems.length === 1 ? '' : 's'}`;
    console.log(`validate: ${entry.batch_id} ${state.status}: ${problems}, ${quotes}.`);
    for (const p of shown.slice(0, MAX_PROBLEMS_SHOWN)) console.log(`  - ${p}`);
    if (check.problems.length > MAX_PROBLEMS_SHOWN) console.log(`  (${check.problems.length - MAX_PROBLEMS_SHOWN} more)`);
    return check.ok ? 0 : 1;
  });
}

export function runCommand(root: string, args: readonly string[]): number {
  return guarded('run', () => {
    const [sub, ...rest] = args;
    if ((sub !== 'start' && sub !== 'end') || rest.length > 0) throw new LedgerError('Usage: node obs.mjs run start|end');
    if (sub === 'start') {
      let previous: RunState | null = null;
      try {
        previous = readRun(root);
      } catch {
        // an unreadable run file is replaced
      }
      const started_utc = nowUtc();
      const run: RunState = { active: true, run_id: newRunId(started_utc), started_utc };
      writeRun(root, run);
      const replaced = previous?.active ? ` (replaces run ${previous.run_id}, which never ended)` : '';
      console.log(`run: started ${run.run_id}${replaced}. The corpus guard now applies to every tool call.`);
      return 0;
    }
    let current: RunState = { active: false, run_id: null, started_utc: null };
    try {
      current = readRun(root);
    } catch {
      // reset below
    }
    writeRun(root, { ...current, active: false });
    console.log(current.active ? `run: ended ${current.run_id}.` : 'run: no run was active; marked inactive.');
    return 0;
  });
}
