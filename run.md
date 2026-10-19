# The submitted run

The outputs of one real run of `/observe` are committed in [`out/`](https://github.com/Schom975-coder/observation-agent-assignment/tree/main/out): run `20261019T134634Z` of 19 Oct 2026. Everything on this page is read from those files when the site is built.

## Run facts

| Fact | Value |
|---|---|
| Run | `20261019T134634Z`, 19 Oct 2026 |
| Run time | 29.0 minutes: from each run’s first event to its last step of work, summed over the runs |
| Subagents started | 130: 1 taxonomist, 101 extractors, 1 merger, 21 synthesizers, 6 drafters |
| Fix rounds | 4 |
| Quotes checked against the raw bytes | 2,684 exact, 13 repaired, 0 rejected |
| Merge | 430 proposed keys; 81 mapped to a taxonomy key; 35 promoted processes; 266 aliases of promoted processes; 83 left unassigned; 0 demoted by the size check; 140 messages mapped; 475 messages in promoted processes; 115 messages left unassigned |
| Work estimates | 58 accepted, 2 missing, 0 overridden |
| Coverage | 3,240 files = 2,255 counted + 115 unassigned + 576 personal + 224 noise + 30 automated + 1 flagged + 39 duplicates |
| Headline (tiers A and B) | $2,231 a month = $526 counted + $1,705 estimated; the estimates put it between $1,243 and $4,989; 26.3 hours a month |
| Documents | 5 drafted, 0 exhausted, 0 skipped, 0 failed |
| Open loops | 169 threads end on a chase or a wait for an answer; 24 of them in the last 90 days of their mailbox |
| Identity folds | 57 addresses folded into another: 4 display name, 4 middle initial, 6 last name, 10 first last, 33 initial last |
| Contradictions dropped | 0 |
| Tagging accuracy (gold set) | 80.8% exact (42 of 52), 80.8% overlap, 73.1% role |

The same facts print with `node obs.mjs summary`, and the dashboard's How we measured shows them beside the figures they explain.

## Stage timeline

Each stage's time from the run log, with the jobs it handed out, the subagents it started and the fix rounds it needed.

| Stage | Time (m:ss) | Jobs | Subagents | Fix rounds |
|---|---:|---:|---:|---:|
| prepare | 0:02 | 1 | 0 | 0 |
| taxonomy | 1:39 | 1 | 1 | 0 |
| extraction | 15:58 | 99 | 101 | 2 |
| merge | 5:32 | 1 | 1 | 0 |
| rollup | 0:01 | 1 | 0 | 0 |
| synthesis | 4:05 | 20 | 21 | 1 |
| score | 0:00 | 1 | 0 | 0 |
| drafting | 1:28 | 5 | 6 | 1 |
| build | 0:01 | 1 | 0 | 0 |

## Run logs

One JSON line per event: each subagent's start and stop, each gate's verdict, each stage step with its duration. They are committed in [`out/runs/`](https://github.com/Schom975-coder/observation-agent-assignment/tree/main/out/runs); the submitted run comes first, then the earlier runs kept as timing evidence.

| Log | What it is | Size |
|---|---|---:|
| [`20261019T134634Z.jsonl`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/out/runs/20261019T134634Z.jsonl) | the submitted run | 96.6 KB |
| [`20261017T085852Z.jsonl`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/out/runs/20261017T085852Z.jsonl) | an earlier run, kept as timing evidence | 4.7 KB |
| [`20261017T103308Z.jsonl`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/out/runs/20261017T103308Z.jsonl) | an earlier run, kept as timing evidence | 65.6 KB |
| [`20261017T203518Z.jsonl`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/out/runs/20261017T203518Z.jsonl) | an earlier run, kept as timing evidence | 16.7 KB |
| [`20261018T042856Z.jsonl`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/out/runs/20261018T042856Z.jsonl) | an earlier run, kept as timing evidence | 19.6 KB |
| [`20261019T143301Z.jsonl`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/out/runs/20261019T143301Z.jsonl) | an earlier run, kept as timing evidence | 0.5 KB |
| [`cold-clone-20261018T044152Z.jsonl`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/out/runs/cold-clone-20261018T044152Z.jsonl) | an earlier timed rehearsal in a fresh clone | 85.6 KB |
| [`cold-clone-20261018T170417Z.jsonl`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/out/runs/cold-clone-20261018T170417Z.jsonl) | an earlier timed rehearsal in a fresh clone | 96.1 KB |
| [`cold-clone-20261018T184200Z.jsonl`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/out/runs/cold-clone-20261018T184200Z.jsonl) | an earlier timed rehearsal in a fresh clone | 94.0 KB |
| [`cold-clone-20261018T191015Z.jsonl`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/out/runs/cold-clone-20261018T191015Z.jsonl) | an earlier timed rehearsal in a fresh clone | 94.5 KB |

## The drafted documents

One document for each opportunity above the drafting threshold, in rank order. Each opens here rendered, with a Markdown copy beside it; [How to use](https://schom975-coder.github.io/observation-agent-assignment/how-to-use.md#documents) explains the markers in them, and [Drafting](https://schom975-coder.github.io/observation-agent-assignment/design.md#drafting) why these and not others.

| Rank | Document | Type | Status |
|---:|---|---|---|
| 1 | [Real-time power scheduling: SOP](https://schom975-coder.github.io/observation-agent-assignment/documents/real-time-power-scheduling.md) | SOP | drafted |
| 3 | [Meter flow discrepancy resolution: template](https://schom975-coder.github.io/observation-agent-assignment/documents/meter-flow-resolution.md) | template | drafted |
| 4 | [Settlement and invoice resolution: email template](https://schom975-coder.github.io/observation-agent-assignment/documents/settlement-resolution.md) | email template | drafted |
| 5 | [Deal ticket and transport contract set-up: template](https://schom975-coder.github.io/observation-agent-assignment/documents/deal-ticket-setup.md) | template | drafted |
| 6 | [Deal transfer between books: template](https://schom975-coder.github.io/observation-agent-assignment/documents/deal-book-transfer.md) | template | drafted |

## What out/ holds

- The prepared corpus facts: the manifest of every message with its Git blob ID, the parsed messages, the duplicate groups, the threads and the people.
- Every model output and its check: the taxonomy, the extractions and their validated copies, the merge table, the syntheses, the drafting briefs and the drafts, each with a ledger file recording its cache key.
- What code made from them: the rollup, the scored opportunities, the drafted documents with their evidence, the dashboard data and the report.
- The run logs.

The dashboard runs on these files with no model call: `node obs.mjs serve`. Because the ledger is committed, the first `/observe` in a fresh clone finds every job current and starts no subagent; `/observe --force` runs cold. [Warm and cold runs](https://schom975-coder.github.io/observation-agent-assignment/how-to-run.md#warm-and-cold-runs) has the detail.

## The dashboard copy on this site

The [dashboard here](https://schom975-coder.github.io/observation-agent-assignment/dashboard/index.html) is the run's built dashboard copied as it is, with one change: its page is marked as the static copy, so the message viewer reads each message from a file beside the page instead of asking the local server. Every message of the manifest was written once through the same corpus reader the server uses, in the shape the server returns.

The copy holds 3,240 messages, 3,316 files in all, 15.5 MB. [Open it](https://schom975-coder.github.io/observation-agent-assignment/dashboard/index.html).
