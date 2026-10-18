---
name: observe
description: Run the observation pipeline over the email archive. Prepares the batches, builds the process taxonomy, extracts every batch with background extractor subagents, merges the proposed process keys, rolls up the counts, synthesizes every process with background synthesizer subagents, scores the opportunities and drafts an artifact for the top ones with background drafter subagents, driven by the run ledger through one command per turn. Run it again to resume after a crash or a pause; add --force to start cold.
argument-hint: "[--force]"
disable-model-invocation: true
allowed-tools: Bash(node obs.mjs *) Agent(extractor) Agent(taxonomist) Agent(merger) Agent(synthesizer) Agent(drafter)
---

Run the observation pipeline. You are the orchestrator. One command, `node obs.mjs advance`, keeps the record of every job (the run ledger), runs every step that needs no model, and says which subagents to start next; the subagents read the email. You run the commands and start the subagents, following the steps below exactly.

Rules for the whole run:
- Use only `node obs.mjs` commands (Bash) and the Agent tool. Run each command as written, on its own: never put `cd` or anything else before it, and never join commands with `&&` or `;`.
- Never Read a batch file, an extraction, the taxonomy digest, the merge input or proposal, a synthesis input or output, a brief, a draft or an artifact, or anything under `corpus/`, and never repeat email content into this conversation.
- Make every Agent call exactly as `advance` gives it: never change, shorten or add to a prompt or any other field.
- Never start a subagent for a job that `advance` did not just hand out.
- Act on each `advance` output at once, in the order below, without summarising or re-checking it: every field you need is already in it, under the Agent tool's own parameter names.
- If a command fails in a way these steps do not cover, print its one-line error and stop.
- If a stop hook keeps your turn going, its message names the command and the step it belongs to. Run exactly that command, then carry on from that step.

## 1. Start

Run `node obs.mjs run start $ARGUMENTS`, exactly so, as its own Bash call. Then run `node obs.mjs prepare`.

`run start` marks the run active (the corpus guard then applies to every tool call), makes this session the run's orchestrator, records the outcome of any job an earlier session left running, and with `--force` clears every model output so the run starts cold. `prepare` skips itself when nothing changed.

## 2. Advance

Run `node obs.mjs advance --json`. It prints one JSON object. Act on it in this order:
- If `halt` is true, print its `halt_reason` and stop. Do not run anything else: the run stays active, and running /observe again resumes it.
- If `done` is true, print its `steps`, then run `node obs.mjs status`, print its output, and stop.
- If `agents` is not empty, then in one message make one Agent call per entry of `agents`, all together, each with exactly that entry's four fields: `subagent_type`, `description`, `prompt` and `run_in_background`. If any of those Agent calls fails or is refused, report its job at once as in step 3. Then:
  - if an entry ran in the foreground (`run_in_background` false: the taxonomist and the merger), run step 2 again as soon as it returns;
  - otherwise end your turn and wait.
- Otherwise, if `wait` is true, end your turn and wait for the running subagents.
- Otherwise print the `refused` list and stop.

`advance` does every step that needs no model as soon as it is ready (accepting the taxonomy and the merge, the rollup, the score, the artifact briefs, collecting the drafts into artifacts, ending the run) and hands out every job that is ready, up to the in-flight limit: failed jobs with attempts left first (fix rounds), then new ones. A job that fails its check comes back as a fix round until its attempts run out; a job listed under `exhausted` is not retried.

## 3. On each completion

When one or more background subagents complete, run `node obs.mjs advance <id> ... --json`, naming the job of every completion since your last `advance` (the ID in its description: `Extract <id>`, `Synthesize <id>`, `Draft <id>`). `advance` records whatever output each named job's subagent left (a job with no output is recorded as failed), then does the next steps and hands out what is ready. Act on its output exactly as in step 2.

An Agent call that fails or is refused counts as a completion of its job, and no subagent will ever write that job's output: name such jobs after `--failed`, as in `node obs.mjs advance --failed <id> ... --json` (completions and failures can go in one call: `node obs.mjs advance <id> ... --failed <id> ... --json`). `advance` then records each of them as failed at once, instead of waiting for a subagent that is not there, and hands it out again if it has attempts left.
