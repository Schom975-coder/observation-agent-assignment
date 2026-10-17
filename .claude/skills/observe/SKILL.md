---
name: observe
description: Run the observation pipeline over the email archive. Prepares the batches, builds the process taxonomy, and extracts every batch with background extractor subagents, driven by the run ledger. Run it again to resume after a crash or a pause; add --force to start cold.
argument-hint: "[--force]"
disable-model-invocation: true
allowed-tools: Bash(node obs.mjs *) Agent(extractor) Agent(taxonomist)
---

Run the observation pipeline. You are the orchestrator. The pipeline's `node obs.mjs` commands keep the record of every batch (the run ledger) and print every prompt; the subagents read the email. You run the commands and start the subagents, following the steps below exactly.

Rules for the whole run:
- Use only `node obs.mjs` commands (Bash) and the Agent tool.
- Never Read a batch file, an extraction, the taxonomy digest or anything under `corpus/`, and never repeat email content into this conversation.
- Pass every printed prompt to its subagent unchanged: never add to it, shorten it or reword it.
- Never dispatch a batch ID that `next` did not list.
- If a command fails in a way these steps do not cover, print its one-line error and stop.
- If a stop hook keeps your turn going, its message names the next commands and the step they belong to. Run exactly those commands, then carry on from that step.

## 1. Start

Run `node obs.mjs run start $ARGUMENTS`, then `node obs.mjs prepare`.

`run start` marks the run active (the corpus guard then applies to every tool call), records the outcome of any batch an earlier session left running, and with `--force` clears every model output so the run starts cold.

## 2. Taxonomy

Run `node obs.mjs taxonomy`.
- If it prints `taxonomy: fresh`, go to step 3.
- If it prints a prompt, make one Agent call: `subagent_type` `taxonomist`, `description` `Build taxonomy`, in the foreground (not in the background), and as `prompt` the printed prompt, unchanged. When it returns, run `node obs.mjs taxonomy accept`.
- If `node obs.mjs taxonomy accept` lists problems, run `node obs.mjs taxonomy` again: it now prints a fix prompt. Repeat this step with it.
- If `node obs.mjs taxonomy` exits with an error saying why it stopped, print that and stop.

## 3. Dispatch

Run `node obs.mjs status --json` and act on it, in this order:
- If `halt` is true, print its `halt_reason` and stop. Do not run `node obs.mjs run end`: the run stays active, and running /observe again resumes it.
- If `extraction` is `complete`, go to step 5.
- If `extraction` is `blocked`, the taxonomy is not fresh: go back to step 2.
- Otherwise, for each ID in its `next` list, run `node obs.mjs dispatch <id>` (one Bash call per ID; they can all go in one message). Each prints the extractor prompt for that batch and nothing else. If a dispatch fails, print its one-line error and leave that ID out. Then, in one message, make one Agent call per dispatched ID, all together: `subagent_type` `extractor`, `description` `Extract <id>`, `run_in_background` true, and as `prompt` that ID's dispatch output, unchanged. Then end your turn and wait. If `next` is empty, just end your turn and wait for the running extractors.

## 4. On each completion

When one or more extractors complete, run `node obs.mjs status --json`. An Agent call that fails or is refused counts as a completion of its batch's extractor. For each batch named in a completion (`Extract <id>`) that is still in the `running` list, run `node obs.mjs validate <id>`: it records whatever output the extractor left, and a batch with no output as failed. If it answers that the batch is already done or failed, carry on. Then go back to step 3.

Repeat until `extraction` is `complete`. A batch that failed its check comes back in `next` with its problems (a fix round) until its attempts run out; a batch listed under `exhausted` is not retried.

## 5. Finish

Run `node obs.mjs run end`, then `node obs.mjs status`, and print its output.
