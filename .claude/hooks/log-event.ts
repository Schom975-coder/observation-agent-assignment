// SubagentStart and SubagentStop: one line per event in the run log, out/runs/<run_id>.jsonl
// (out/runs/adhoc.jsonl outside a run), so per-batch wall time and stop/block loops can be read
// back afterwards. Logging must never get in the way: any failure is reported and ignored.
import { appendRunLog, parseInput, projectRoot, readStdin, reportFailure, str } from './lib.ts';

let root: string | null = null;
try {
  const input = parseInput(await readStdin());
  if (input !== null) {
    root = projectRoot(input);
    appendRunLog(root, {
      event: str(input.hook_event_name),
      agent_type: str(input.agent_type),
      agent_id: str(input.agent_id),
    });
  }
} catch (err) {
  reportFailure('log-event', err, root ?? projectRoot(null));
}
process.exitCode = 0;
