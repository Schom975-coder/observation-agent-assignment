// Shared by the hook scripts in this folder. Claude Code runs each as `node <file>.ts` (exec form,
// see .claude/settings.json) with the hook input as JSON on stdin, and reads a decision from stdout
// (https://code.claude.com/docs/en/hooks). A hook exits fast when it doesn't apply and never dies
// with a stack trace: each script catches everything and decides what a failure means for it.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appendRunLog, stopGateFile, withoutRoot, writeJsonAtomic } from '../../src/run/ledger.ts';

export type HookInput = Record<string, unknown>;

// The pipeline's own subagents (frontmatter `name`, which hooks receive as `agent_type`).
export const PIPELINE_AGENTS: readonly string[] = ['extractor', 'taxonomist', 'merger', 'synthesizer', 'drafter'];

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

// Every spelling of the project folder a tool path may start with: as given, and resolved through
// symlinks and junctions both ways Node knows (a checkout reached through a link, macOS /tmp being
// /private/tmp). A folder that can't be resolved is given as is.
export function rootVariants(root: string): string[] {
  const variants = [root];
  for (const resolve of [realpathSync, realpathSync.native]) {
    try {
      variants.push(resolve(root));
    } catch {
      // not resolvable here: the given spelling is all there is
    }
  }
  return [...new Set(variants)];
}

// One JSON line on stdout: the decision Claude Code reads.
export function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s*\n\s*/g, ' ');

// Append one record to the active run's log (out/runs/<run_id>.jsonl, or adhoc.jsonl outside a run),
// with the project folder cut out. It lives in the ledger, which `run start` also logs through.
export { appendRunLog };

// A last word on stderr for a hook that failed: Claude Code shows it as a hook error, never a
// trace, and with the project folder cut out of it.
export function reportFailure(hook: string, err: unknown, root: string): void {
  process.stderr.write(`${hook}: ${withoutRoot(errorText(err), root)}\n`);
}

// ---- out/ledger/stop-gate.json: the Stop hook's memory for one run (git-ignored) ----
//
// session_id: the orchestrator's session, recorded by `run start` from the claim the corpus guard
// wrote when the session typed it (or, failing that, by the guard when a session starts a pipeline
// subagent during the run), so the Stop hook steers that session only and never another Claude
// Code session open in the same folder. last_block: the reason key of the Stop hook's
// previous block, so it never blocks twice in a row for the same reason. Both belong to run_id:
// what another run left behind reads as empty.
export type StopGate = { run_id: string | null; session_id: string | null; last_block: string | null };

// Missing, unreadable or another run's: empty. The file only ever narrows what the Stop hook does.
export function readStopGate(root: string, runId: string | null): StopGate {
  try {
    const raw: unknown = JSON.parse(readFileSync(stopGateFile(root), 'utf8'));
    if (isRecord(raw) && runId !== null && raw.run_id === runId) return { run_id: runId, session_id: str(raw.session_id), last_block: str(raw.last_block) };
  } catch {
    // fall through
  }
  return { run_id: runId, session_id: null, last_block: null };
}

export const writeStopGate = (root: string, gate: StopGate): void => writeJsonAtomic(stopGateFile(root), gate);
