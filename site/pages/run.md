# The submitted run

The outputs of one real run of `/observe` are committed in [`out/`](/out/): run `{{fig:run_id}}` of {{fig:run_date}}. Everything on this page is read from those files when the site is built.

## Run facts {#facts}

{{block:run_facts}}

The same facts print with `node obs.mjs summary`, and the dashboard's How we measured shows them beside the figures they explain.

## Rerunning it {#rerun}

Running `/observe` again reproduces these figures exactly: it finds every model output already done and starts no agent (the rerun after the submitted run took 19 s), and CI rebuilds every code step from the committed model outputs on macOS, Linux and Windows and fails if any committed output changes. A fresh run, `/observe --force`, asks the model again for its judgement: the list of processes, which messages belong to which, and the minutes one round of each takes. Like two analysts, two fresh runs do not judge identically, so the processes and the estimated dollars move with them. The counting and the arithmetic on any given judgement are exact. Every forced fresh run in the logs that reached scoring:

{{block:fresh_runs}}

The counted part, email actions priced at published minutes, moved little; most of the spread is in the estimated work. Part of the spread is ours rather than the model's: agent instructions and the scoring code changed between the earlier runs (they also rounded each part on its own, so their counted and estimated parts can miss the total by a few cents), and a process with no accepted estimate adds nothing to the estimated part. In a real engagement the client would approve the process list and the estimates once and lock them (an estimates file already replaces the model's figure for the processes it names: [How to use](how-to-use.html#rescore)), and later runs would move only when the mail does.

## Stage timeline {#timeline}

Each stage's time from the run log, with the jobs it handed out, the subagents it started and the fix rounds it needed.

{{block:timeline}}

## Run logs {#logs}

One JSON line per event: each subagent's start and stop, each gate's verdict, each stage step with its duration. They are committed in [`out/runs/`](/out/runs/); the submitted run comes first, then the earlier runs kept as timing evidence.

{{block:logs}}

## The drafted documents {#documents}

One document for each opportunity above the drafting threshold, in rank order. Each opens here rendered, with a Markdown copy beside it; [How to use](how-to-use.html#documents) explains the markers in them, and [Drafting](design.html#drafting) why these and not others.

{{block:documents}}

## What out/ holds {#out}

- The prepared corpus facts: the manifest of every message with its Git blob ID, the parsed messages, the duplicate groups, the threads and the people.
- Every model output and its check: the taxonomy, the extractions and their validated copies, the merge table, the syntheses, the drafting briefs and the drafts, each with a ledger file recording its cache key.
- What code made from them: the rollup, the scored opportunities, the drafted documents with their evidence, the dashboard data and the report.
- The run logs.

The dashboard runs on these files with no model call: `node obs.mjs serve`. Because the ledger is committed, the first `/observe` in a fresh clone finds every job current and starts no subagent; `/observe --force` runs cold. [Warm and cold runs](how-to-run.html#warm-and-cold-runs) has the detail.

## The dashboard copy on this site {#dashboard-copy}

The [dashboard here](dashboard/index.html) is the run's built dashboard copied as it is, with one change: its page is marked as the static copy, so the message viewer reads each message from a file beside the page instead of asking the local server. Every message of the manifest was written once through the same corpus reader the server uses, in the shape the server returns.

{{block:dashboard_copy}}
