// Everything that differs between the two kinds of ledger job, in one place (ARCHITECTURE.md 6.21):
// an extraction batch ("batch-NNN": one extractor, checked by checkExtraction) and a synthesis
// group ("synth-NNN": one synthesizer, checked by checkSynthesis). The paths, index, agent file and
// cache-key parts of each kind live in the ledger (JOB_KINDS) and are re-exported here; this module
// adds what needs the checkers and the prompts. The ledger, the commands, the Stop hook and the
// skill all go through these functions, so a third kind would be added here and in JOB_KINDS only.
import { checkSynthesis } from '../model/synthesis.ts';
import { checkExtraction } from '../model/validate-extraction.ts';
import { MAX_DISPATCHES, countedDispatches, jobPaths, kindOf, loadJobs, outDir, projectFolder, readBatchState, sharedKeyParts, type JobPaths } from './ledger.ts';
import type { JobCheck, JobKind, ValidatedExtraction, ValidatedSynthesis } from '../types.ts';

export { jobPaths, kindOf, loadJobs, sharedKeyParts, type JobPaths };

// The Agent call's description for a job: the skill uses it, and the Stop hook reads the job back
// out of it ("Extract batch-017", "Synthesize synth-003").
export function descriptionFor(id: string): string {
  return kindOf(id) === 'batch' ? `Extract ${id}` : `Synthesize ${id}`;
}

// Check a job's output file the way its kind's validator does: the same call for the gate,
// `validate`, run start and `verify`.
export function checkJob(root: string, id: string): JobCheck<ValidatedExtraction | ValidatedSynthesis> {
  return kindOf(id) === 'batch' ? checkExtraction(root, id, { outDir: outDir(root) }) : checkSynthesis(root, id, { outDir: outDir(root) });
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// The verb a job prompt starts with, by kind: the same word the Agent description starts with.
const VERB: Record<JobKind, string> = { batch: 'Extract', synth: 'Synthesize' };

// "fix round 2 of 3": the job's counted dispatches, read from the ledger after dispatch. A forced
// dispatch past the usual rounds says only which round it is.
function fixRound(root: string, id: string): string {
  const round = Math.max(1, countedDispatches(readBatchState(root, id)) - 1);
  return `fix round ${round}${round <= MAX_DISPATCHES - 1 ? ` of ${MAX_DISPATCHES - 1}` : ''}`;
}

// How many problems a fix round names: the recorded count, else the fix file's lines.
const problemCount = (root: string, id: string, fix: readonly string[]): number => readBatchState(root, id).problems ?? fix.length;

// The prompt for a job of either kind (ARCHITECTURE.md 6.22, 15.5): two lines, the job and the
// project folder.
//   Extract batch-017.
//   Project folder: <abs>
// On a fix round (`fix` = the lines of the job's fix file) the first line also says which round
// and how many problems there are:
//   Extract batch-017 (fix round 2 of 3): 2 problems in the problems file.
// The agent definition names every file relative to the folder, so the prompt carries no other
// path; the orchestrator types this text into each Agent call, and short is what makes a wave of
// twenty start quickly. The problems themselves go only through the fix file, never through the
// prompt, which the orchestrator passes on and so reads.
export function jobPrompt(root: string, id: string, fix: string[] | null): string {
  const job = `${VERB[kindOf(id)]} ${id}`;
  const first = fix === null ? `${job}.` : `${job} (${fixRound(root, id)}): ${plural(problemCount(root, id, fix), 'problem')} in the problems file.`;
  return [first, `Project folder: ${projectFolder(root)}`].join('\n');
}
