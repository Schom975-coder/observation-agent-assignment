---
name: extract-batch
description: Run the extractor subagent on named batches, the synthesizer subagent on named synthesis groups, or the drafter subagent on named artifact drafts, and report their ledger status. For debugging one job by hand, and for running a fix round on a failed job.
argument-hint: <job_id> [<job_id> ...] [--force]
disable-model-invocation: true
allowed-tools: Bash(node obs.mjs *) Agent(extractor) Agent(synthesizer) Agent(drafter)
---

Run these jobs: $ARGUMENTS

You are the orchestrator. You never read batch files, extraction files, synthesis inputs or outputs, briefs, drafts or artifacts, or anything under `corpus/` yourself, and you never repeat email content into this conversation. The subagents read their inputs; the pipeline's commands report on them.

A job is a batch, a synthesis group or an artifact draft. Batch IDs may be given in full (`batch-074`) or as just the number (`74` or `074`); a bare number means `batch-` followed by the number padded to three digits, so `0` is `batch-000` and `74` is `batch-074`. Synthesis groups and drafts are always given in full (`synth-003`, `draft-002`). Use the full form everywhere below. `--force` is not a job ID: if it is among the arguments, add it to every dispatch command (`node obs.mjs dispatch <job_id> --force`), which hands out again a job that is already done.

1. For each job ID above, run `node obs.mjs dispatch <job_id>` (one Bash call per ID; they can all go in one message). Each prints the exact prompt for that job, two lines, and nothing else: for a job that failed its last check, the first line says it is a fix round. If a dispatch fails, report its one-line error, drop that ID, and carry on with the others.
2. In a single message, call the Agent tool once per dispatched job, all of them together, each with `run_in_background` true and as `prompt` the full output of that job's dispatch command, both lines, unchanged. Do not add to it, shorten it or reword it. For a batch: `subagent_type` `extractor`, `description` `Extract <job_id>`. For a synthesis group: `subagent_type` `synthesizer`, `description` `Synthesize <job_id>`. For a draft: `subagent_type` `drafter`, `description` `Draft <job_id>`.
3. End your turn and wait. When a subagent finishes, a hook checks its output file and records the job as done or failed. When notified of completions, run `node obs.mjs status`.
4. When every subagent you started has completed, run `node obs.mjs validate <job_id>` for each of their jobs that still shows as running: that checks whatever file it left and records done or failed.
5. When every requested ID shows as done or failed, run `node obs.mjs status` once more, print its output, and stop. Do not dispatch anything again and do not open any output files. A failed job gets its fix round when this skill is run on it again.
