---
name: observe
description: Run the observation pipeline over the email archive. Prepares the batches, builds the process taxonomy, extracts every batch with background extractor subagents, merges the proposed process keys, rolls up the counts, synthesizes every process with background synthesizer subagents and scores the opportunities, driven by the run ledger. Run it again to resume after a crash or a pause; add --force to start cold.
argument-hint: "[--force]"
disable-model-invocation: true
allowed-tools: Bash(node obs.mjs *) Agent(extractor) Agent(taxonomist) Agent(merger) Agent(synthesizer)
---

Run the observation pipeline. You are the orchestrator. The pipeline's `node obs.mjs` commands keep the record of every job (the run ledger) and print every prompt; the subagents read the email. You run the commands and start the subagents, following the steps below exactly.

Rules for the whole run:
- Use only `node obs.mjs` commands (Bash) and the Agent tool. Run each command as written, on its own: never put `cd` or anything else before it, and never join commands with `&&` or `;`.
- Never Read a batch file, an extraction, the taxonomy digest, the merge input or proposal, a synthesis input or output, or anything under `corpus/`, and never repeat email content into this conversation.
- Pass every printed prompt to its subagent unchanged: never add to it, shorten it or reword it.
- Never start a subagent for a job that a command did not just hand out.
- If a command fails in a way these steps do not cover, print its one-line error and stop.
- If a stop hook keeps your turn going, its message names the next commands and the step they belong to. Run exactly those commands, then carry on from that step.

There are two kinds of job. A batch (`batch-NNN`) is extracted by an `extractor`; a synthesis group (`synth-NNN`) is synthesized by a `synthesizer`. Every Agent call for a job is: `subagent_type` `extractor` for a `batch-` ID or `synthesizer` for a `synth-` ID, `description` the description the command gives (`Extract <id>` for a batch, `Synthesize <id>` for a group), `run_in_background` true, and as `prompt` the job's prompt, unchanged.

## 1. Start

Run `node obs.mjs run start $ARGUMENTS`, exactly so, as its own Bash call. Then run `node obs.mjs prepare`.

`run start` marks the run active (the corpus guard then applies to every tool call), makes this session the run's orchestrator, records the outcome of any job an earlier session left running, and with `--force` clears every model output so the run starts cold. `prepare` skips itself when nothing changed.

## 2. Taxonomy

Run `node obs.mjs taxonomy`.
- If it prints `taxonomy: fresh`, go to step 3.
- If it prints a prompt, make one Agent call: `subagent_type` `taxonomist`, `description` `Build taxonomy`, in the foreground (not in the background), and as `prompt` the printed prompt, unchanged. When it returns, run `node obs.mjs taxonomy accept`.
- If `node obs.mjs taxonomy accept` lists problems, run `node obs.mjs taxonomy` again: it now prints a fix prompt. Repeat this step with it.
- If `node obs.mjs taxonomy` exits with an error saying why it stopped, print that and stop.

## 3. Dispatch

Run `node obs.mjs refill --json`. It prints one JSON object; act on it in this order:
- If `halt` is true, print its `halt_reason` and stop. Do not run `node obs.mjs run end`: the run stays active, and running /observe again resumes it.
- If `jobs` is not empty, then in one message make one Agent call per entry of `jobs`, all together, as described above: the entry's `description` and its `prompt`, unchanged. If any of those Agent calls fails or is refused, report its job at once as in step 4. Then end your turn and wait.
- Otherwise, if `running` is not empty, end your turn and wait for the running subagents.
- Otherwise go by `stage`: `taxonomy`, go back to step 2; `merge`, go to step 5; `rollup`, go to step 6; `score`, go to step 8; `done`, go to step 9. With any other `stage`, print the `refused` list and stop.

`refill` hands out every job that is ready, up to the in-flight limit: failed jobs with attempts left first (fix rounds, whose prompts name the problems file), then new ones. Batches come first; synthesis groups only once the merge and the rollup are done.

## 4. On each completion

When one or more subagents complete, run `node obs.mjs refill <id> ... --json`, naming the job of every completion since your last refill (the ID in its description: `Extract <id>`, `Synthesize <id>`). `refill` records whatever output each named job's subagent left (a job with no output is recorded as failed), then hands out what is ready. Act on its output exactly as in step 3.

An Agent call that fails or is refused counts as a completion of its job, and no subagent will ever write that job's output: name such jobs after `--failed`, as in `node obs.mjs refill --failed <id> ... --json` (completions and failures can go in one call: `node obs.mjs refill <id> ... --failed <id> ... --json`). `refill` then records each of them as failed at once, instead of waiting for a subagent that is not there, and hands it out again if it has attempts left.

Repeat until `stage` moves on. A job that failed its check comes back as a fix round until its attempts run out; a job listed under `exhausted` is not retried.

A stop hook may name other commands instead: `node obs.mjs validate <id>` records the outcome of a job whose subagent has finished, as `refill` does; `node obs.mjs status --json` reports where the run is; `node obs.mjs dispatch <id>` hands out one job and prints its prompt and nothing else. Run exactly what it names, start one Agent call for each job you dispatched that way (as described above, with its dispatch output as the `prompt`), and carry on from the step it names.

## 5. Merge

Run `node obs.mjs merge`.
- If it prints `merge: fresh`, go to step 6.
- If it prints a prompt, make one Agent call: `subagent_type` `merger`, `description` `Merge process keys`, in the foreground (not in the background), and as `prompt` the printed prompt, unchanged. When it returns, run `node obs.mjs merge accept`.
- If `node obs.mjs merge accept` lists problems, run `node obs.mjs merge` again: it now prints a fix prompt. Repeat this step with it.
- If `node obs.mjs merge` exits with an error saying why it stopped, print that and stop. Do not run `node obs.mjs run end`.

## 6. Rollup

Run `node obs.mjs rollup`. It prints one line: the processes, the occurrences counted, the messages left unassigned and the synthesis groups. Go to step 7.

## 7. Synthesis

Run `node obs.mjs refill --json` and act on it exactly as in step 3: it now hands out the synthesis groups. On each completion, step 4. Repeat until its `stage` sends you on to step 8 (`score`) or step 9 (`done`).

## 8. Score

Run `node obs.mjs score`. It prints the headline: the total for tiers A and B with its counted and estimated parts, the number of opportunities, and the estimates missing. Go to step 9.

## 9. Finish

Run `node obs.mjs run end`, then `node obs.mjs status`, and print its output.
