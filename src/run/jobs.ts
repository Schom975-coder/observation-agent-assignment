// Everything that differs between the two kinds of ledger job, in one place (ARCHITECTURE.md 6.21):
// an extraction batch ("batch-NNN": one extractor, checked by checkExtraction) and a synthesis
// group ("synth-NNN": one synthesizer, checked by checkSynthesis). The paths, index, agent file and
// cache-key parts of each kind live in the ledger (JOB_KINDS) and are re-exported here; this module
// adds what needs the checkers and the prompts. The ledger, the commands, the Stop hook and the
// skill all go through these functions, so a third kind would be added here and in JOB_KINDS only.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkSynthesis } from '../model/synthesis.ts';
import { checkExtraction } from '../model/validate-extraction.ts';
import { MAX_DISPATCHES, countedDispatches, jobPaths, kindOf, loadJobs, outDir, readBatchState, sharedKeyParts, taxonomyFile, type JobPaths } from './ledger.ts';
import type { JobCheck, ValidatedExtraction, ValidatedSynthesis } from '../types.ts';

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

// Absolute, forward slashes on every OS: the form the subagent's file tools take everywhere.
const absolute = (root: string, file: string): string => resolve(root, file).replaceAll('\\', '/');

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const REPLY = 'Reply with one short sentence and no email content.';

// "(fix round 2 of 3)": the job's counted dispatches, read from the ledger after dispatch.
function fixRound(root: string, id: string): string {
  const round = Math.max(1, countedDispatches(readBatchState(root, id)) - 1);
  return `fix round ${round}${round <= MAX_DISPATCHES - 1 ? ` of ${MAX_DISPATCHES - 1}` : ''}`;
}

// How many problems a fix round names: the recorded count, else the fix file's lines.
const problemCount = (root: string, id: string, fix: readonly string[]): number => readBatchState(root, id).problems ?? fix.length;

// The prompt an extractor gets. The agent definition holds the instructions; this names the files.
// On a fix round (`fix` = the lines of the batch's fix file) it also names the previous output and
// the problems file, and says how many problems there are. The problems themselves go only through
// that file, never through this prompt, which the orchestrator passes on and so reads.
export function extractorPrompt(root: string, batchId: string, fix: string[] | null): string {
  const paths = jobPaths(root, batchId);
  const batch = `Batch file: ${absolute(root, paths.input)}`;
  const taxonomy = existsSync(taxonomyFile(root))
    ? `Taxonomy file: ${absolute(root, taxonomyFile(root))}`
    : 'Taxonomy file: none yet. Every process key must be new:<slug>, each defined in new_processes.';
  const output = `Output file: ${absolute(root, paths.output)}`;
  if (fix === null) return [`Extract batch ${batchId}.`, batch, taxonomy, output, REPLY].join('\n');
  return [
    `Extract batch ${batchId} (${fixRound(root, batchId)}).`,
    batch,
    taxonomy,
    `Previous output: ${absolute(root, paths.output)}`,
    `Problems file: ${absolute(root, paths.fix)}`,
    `The pipeline checked the previous output and found ${plural(problemCount(root, batchId, fix), 'problem')}, listed in the problems file. ` +
      'Read the batch file, the previous output and the problems file, fix only those problems, keep every other entry exactly as it was, and Write the whole file to:',
    output,
    REPLY,
  ].join('\n');
}

// The prompt a synthesizer gets (ARCHITECTURE.md 14.3): the group input and the output file; on a
// fix round also the previous output and the problems file, problems again only through the file.
export function synthesizerPrompt(root: string, groupId: string, fix: string[] | null): string {
  const paths = jobPaths(root, groupId);
  const input = `Input file: ${absolute(root, paths.input)}`;
  const output = `Output file: ${absolute(root, paths.output)}`;
  if (fix === null) return [`Synthesize group ${groupId}.`, input, output, REPLY].join('\n');
  return [
    `Synthesize group ${groupId} (${fixRound(root, groupId)}).`,
    input,
    `Previous output: ${absolute(root, paths.output)}`,
    `Problems file: ${absolute(root, paths.fix)}`,
    `The pipeline checked the previous output and found ${plural(problemCount(root, groupId, fix), 'problem')}, listed in the problems file. ` +
      'Read the input file, the previous output and the problems file, fix only those problems, keep every other entry exactly as it was, and Write the whole file to:',
    output,
    REPLY,
  ].join('\n');
}

// The prompt for a job of either kind.
export function jobPrompt(root: string, id: string, fix: string[] | null): string {
  return kindOf(id) === 'batch' ? extractorPrompt(root, id, fix) : synthesizerPrompt(root, id, fix);
}
