---
name: extract-batch
description: Run the extractor subagent on named batches and report their ledger status. For the M3 live test and for debugging one batch by hand.
argument-hint: <batch_id> [<batch_id> ...]
disable-model-invocation: true
allowed-tools: Bash(node obs.mjs *) Agent
---

Run the extractor on these batches: $ARGUMENTS

You are the orchestrator. You never read batch files, extraction files or anything under `corpus/` yourself, and you never repeat email content into this conversation. The subagents read the batches; the pipeline's commands report on them.

Batch IDs may be given in full (`batch-074`) or as just the number (`74` or `074`); a bare number means `batch-` followed by the number padded to three digits, so `0` is `batch-000` and `74` is `batch-074`. Use the full form everywhere below.

1. For each batch ID above, run `node obs.mjs dispatch <batch_id>` (one Bash call per ID; they can all go in one message). Each prints the exact extractor prompt for that batch, and nothing else. If a dispatch fails, report its one-line error, drop that ID, and carry on with the others.
2. In a single message, call the Agent tool once per dispatched batch, all of them together: `subagent_type` `extractor`, `description` `Extract <batch_id>`, `run_in_background` true, and as `prompt` the full output of that batch's dispatch command, unchanged. Do not add to it, shorten it or reword it.
3. End your turn and wait. Each extractor's work is checked by a stop hook before it finishes, so a completion notice normally means its batch has been checked and recorded. When notified of completions, run `node obs.mjs status`.
4. If every extractor you dispatched has completed but one of their batches still shows as running, run `node obs.mjs validate <batch_id>` for it: that checks whatever file it left and records done or failed.
5. When every requested ID shows as done or failed, run `node obs.mjs status` once more, print its output, and stop. Do not dispatch anything again and do not open any output files.
