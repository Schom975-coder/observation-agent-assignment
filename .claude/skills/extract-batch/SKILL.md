---
name: extract-batch
description: Run the extractor subagent on named batches and report their ledger status. For debugging one batch by hand, and for running a fix round on a failed batch.
argument-hint: <batch_id> [<batch_id> ...] [--force]
disable-model-invocation: true
allowed-tools: Bash(node obs.mjs *) Agent(extractor)
---

Run the extractor on these batches: $ARGUMENTS

You are the orchestrator. You never read batch files, extraction files or anything under `corpus/` yourself, and you never repeat email content into this conversation. The subagents read the batches; the pipeline's commands report on them.

Batch IDs may be given in full (`batch-074`) or as just the number (`74` or `074`); a bare number means `batch-` followed by the number padded to three digits, so `0` is `batch-000` and `74` is `batch-074`. Use the full form everywhere below. `--force` is not a batch ID: if it is among the arguments, add it to every dispatch command (`node obs.mjs dispatch <batch_id> --force`), which hands out again a batch that is already done.

1. For each batch ID above, run `node obs.mjs dispatch <batch_id>` (one Bash call per ID; they can all go in one message). Each prints the exact extractor prompt for that batch, and nothing else: for a batch that failed its last check, a fix prompt that names its problems file. If a dispatch fails, report its one-line error, drop that ID, and carry on with the others.
2. In a single message, call the Agent tool once per dispatched batch, all of them together: `subagent_type` `extractor`, `description` `Extract <batch_id>`, `run_in_background` true, and as `prompt` the full output of that batch's dispatch command, unchanged. Do not add to it, shorten it or reword it.
3. End your turn and wait. When an extractor finishes, a hook checks its output file and records the batch as done or failed. When notified of completions, run `node obs.mjs status`.
4. When every extractor you dispatched has completed, run `node obs.mjs validate <batch_id>` for each of their batches that still shows as running: that checks whatever file it left and records done or failed.
5. When every requested ID shows as done or failed, run `node obs.mjs status` once more, print its output, and stop. Do not dispatch anything again and do not open any output files. A failed batch gets its fix round when this skill is run on it again.
