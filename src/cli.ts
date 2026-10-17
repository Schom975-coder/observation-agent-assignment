// Command-line entry for every deterministic stage. The /observe skill calls these;
// a person can too. Commands land milestone by milestone (see .claude/plan/ARCHITECTURE.md).
import { fileURLToPath } from 'node:url';
import { ingestCommand } from './corpus/ingest.ts';
import { prepareCommand } from './pipeline/prepare.ts';
import { dispatchCommand, refillCommand, runCommand, statusCommand, validateCommand, verifyCommand } from './run/commands.ts';
import { goldCommand } from './run/gold.ts';
import { mergeCommand } from './run/merge.ts';
import { rollupCommand } from './run/rollup.ts';
import { scoreCommand } from './run/score.ts';
import { taxonomyCommand } from './run/taxonomy.ts';

// The repo root, wherever the command is run from.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

type Command = {
  summary: string;
  milestone: string;
  run?: (args: string[]) => Promise<number> | number;
};

export const COMMANDS: Record<string, Command> = {
  prepare: {
    summary: 'Ingest, parse, de-duplicate, thread and batch every message (skips itself when nothing changed; --force always runs)',
    milestone: 'M2',
    run: (args) => prepareCommand(ROOT, args),
  },
  ingest: {
    summary: 'List every corpus message and check its bytes against Git',
    milestone: 'M1',
    run: () => ingestCommand(ROOT),
  },
  status: {
    summary: 'Show the run ledger and the stage the run is in: what is done, running and pending (--json for the orchestrator)',
    milestone: 'M3',
    run: (args) => statusCommand(ROOT, args),
  },
  dispatch: {
    summary: 'Mark a batch or synthesis group as handed to its subagent and print the prompt',
    milestone: 'M3',
    run: (args) => dispatchCommand(ROOT, args),
  },
  validate: {
    summary: 'Check the model output of a batch or synthesis group (schema, coverage, quotes, estimate rules) and record it',
    milestone: 'M3',
    run: (args) => validateCommand(ROOT, args),
  },
  refill: {
    summary: 'After completions: validate the named jobs, dispatch everything next, print the prompts as JSON',
    milestone: 'M5',
    run: (args) => refillCommand(ROOT, args),
  },
  run: {
    summary: 'Start or end a pipeline run (start | end); the corpus guard covers every tool call during one',
    milestone: 'M3',
    run: (args) => runCommand(ROOT, args),
  },
  taxonomy: {
    summary: 'Print the taxonomist prompt (or "taxonomy: fresh"); "accept" validates the proposal and writes out/taxonomy.json',
    milestone: 'M4',
    run: (args) => taxonomyCommand(ROOT, args),
  },
  verify: {
    summary: 'Re-check every done batch and synthesis group against its inputs and its committed validated file',
    milestone: 'M4',
    run: (args) => verifyCommand(ROOT, args),
  },
  gold: {
    summary: 'Tagging accuracy: "sample" picks messages to label by hand; "score" compares confirmed labels with the extractions',
    milestone: 'M4',
    run: (args) => goldCommand(ROOT, args),
  },
  merge: {
    summary: 'Build the merge input and print the merger prompt (or "merge: fresh"); "accept" checks the proposal and writes out/merge.json',
    milestone: 'M5',
    run: (args) => mergeCommand(ROOT, args),
  },
  rollup: {
    summary: 'Count occurrences, actions, participants and stalls per merged process; write the synthesis group inputs',
    milestone: 'M5',
    run: (args) => rollupCommand(ROOT, args),
  },
  score: {
    summary: 'Price each process at $85/hour: counted email actions at the published rates plus counted rounds x the checked work estimate (--rates <file>, --estimates <file> re-score)',
    milestone: 'M5',
    run: (args) => scoreCommand(ROOT, args),
  },
  'artifacts-prep': { summary: 'Write briefs for the opportunities that earn a drafted artifact', milestone: 'M6' },
  build: { summary: 'Build the report and the dashboard data', milestone: 'M7' },
  summary: { summary: 'Print the run summary', milestone: 'M8' },
  serve: { summary: 'Serve the dashboard on 127.0.0.1', milestone: 'M7' },
};

function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = Object.entries(COMMANDS).map(
    ([name, cmd]) => `  ${name.padEnd(width)}  ${cmd.summary}${cmd.run ? '' : `  [${cmd.milestone}]`}`,
  );
  return [
    'Usage: node obs.mjs <command> [options]',
    '',
    'Commands ([Mx] = not built yet, lands in that milestone):',
    ...lines,
    '',
    'The whole pipeline runs from Claude Code with /observe.',
  ].join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
    console.log(usage());
    return 0;
  }
  const command = COMMANDS[name];
  if (command === undefined) {
    console.error(`obs: unknown command "${name}". Run node obs.mjs --help for the list.`);
    return 1;
  }
  if (command.run === undefined) {
    console.error(`obs: "${name}" is not built yet (milestone ${command.milestone}).`);
    return 2;
  }
  return command.run(rest);
}
