// Shared by the hook scripts in this folder. Claude Code runs each as `node <file>.ts` (exec form,
// see .claude/settings.json) with the hook input as JSON on stdin, and reads a decision from stdout
// (https://code.claude.com/docs/en/hooks). A hook exits fast when it doesn't apply and never dies
// with a stack trace: each script catches everything and decides what a failure means for it.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRun, withoutRoot } from '../../src/run/ledger.ts';

export type HookInput = Record<string, unknown>;

// The pipeline's own subagents (frontmatter `name`, which hooks receive as `agent_type`).
export const PIPELINE_AGENTS: readonly string[] = ['extractor', 'synthesizer', 'drafter'];

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

// The input object, or null when stdin is not a JSON object.
export function parseInput(text: string): HookInput | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

// The project the session runs in: CLAUDE_PROJECT_DIR (Claude Code sets it for every hook), else
// the input's cwd, else the checkout this file belongs to.
export function projectRoot(input: HookInput | null): string {
  const env = process.env.CLAUDE_PROJECT_DIR;
  if (env !== undefined && env !== '') return env;
  const cwd = input === null ? null : str(input.cwd);
  if (cwd !== null && cwd !== '') return cwd;
  return fileURLToPath(new URL('../..', import.meta.url));
}

// One JSON line on stdout: the decision Claude Code reads.
export function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s*\n\s*/g, ' ');

// Append one record to the active run's log, out/runs/<run_id>.jsonl, or out/runs/adhoc.jsonl when
// no run is active. One short line per append, so concurrent hooks don't interleave inside a line.
// The log is committed, so the project folder is cut out of everything in it.
export function appendRunLog(root: string, record: Record<string, unknown>): void {
  let runId = 'adhoc';
  try {
    const run = readRun(root);
    if (run.active && run.run_id !== null && /^[A-Za-z0-9_-]{1,64}$/.test(run.run_id)) runId = run.run_id;
  } catch {
    // an unreadable run state still gets its events logged, as adhoc
  }
  const dir = join(root, 'out', 'runs');
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }, (_key, value: unknown) =>
    typeof value === 'string' ? withoutRoot(value, root) : value,
  );
  appendFileSync(join(dir, `${runId}.jsonl`), `${line}\n`);
}

// A last word on stderr for a hook that failed: Claude Code shows it as a hook error, never a
// trace, and with the project folder cut out of it.
export function reportFailure(hook: string, err: unknown, root: string): void {
  process.stderr.write(`${hook}: ${withoutRoot(errorText(err), root)}\n`);
}
