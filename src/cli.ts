// Command-line entry for every deterministic stage. The /observe skill calls these;
// a person can too. Commands land milestone by milestone (see .claude/plan/ARCHITECTURE.md).
import { fileURLToPath } from 'node:url';
import { ingestCommand } from './corpus/ingest.ts';

// The repo root, wherever the command is run from.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

type Command = {
  summary: string;
  milestone: string;
  run?: (args: string[]) => Promise<number> | number;
};

export const COMMANDS: Record<string, Command> = {
  prepare: { summary: 'Run ingest, parse, normalize and batch in one go', milestone: 'M2' },
  ingest: {
    summary: 'List every corpus message and check its bytes against Git',
    milestone: 'M1',
    run: () => ingestCommand(ROOT),
  },
  parse: { summary: 'Parse headers, UTC dates and body segments', milestone: 'M2' },
  normalize: { summary: 'Find duplicates, build threads and occurrences, list people', milestone: 'M2' },
  batch: { summary: 'Pack messages into batch files for the extractor subagents', milestone: 'M2' },
  status: { summary: 'Show the run ledger: what is done, running and pending', milestone: 'M3' },
  dispatch: { summary: 'Mark a batch as handed to an extractor', milestone: 'M3' },
  validate: { summary: 'Check model output: schema, coverage, verbatim quotes', milestone: 'M3' },
  rollup: { summary: 'Count occurrences, actions, participants and stalls per process', milestone: 'M5' },
  score: { summary: 'Price counted actions at the published rates and $85/hour', milestone: 'M5' },
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
