# The submitted run

The outputs of one real run of `/observe` are committed in [`out/`](/out/): run `{{fig:run_id}}` of {{fig:run_date}}. Everything on this page is read from those files when the site is built.

## Run facts {#facts}

{{block:run_facts}}

The same facts print with `node obs.mjs summary`, and the dashboard's How we measured shows them beside the figures they explain.

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
