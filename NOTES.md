# Notes

A Claude Code pipeline that reads all 3,240 messages, prices recurring work from cited evidence and drafts documents. Figures are from the submitted run (`node obs.mjs summary`); the site expands every section: https://schom975-coder.github.io/observation-agent-assignment/.

## How we drove Claude Code

The `/observe` skill orchestrates: each turn it runs `node obs.mjs advance`, which does every ready code step and returns job IDs for background subagents. Hooks: PreToolUse enforces per-agent allowlists, SubagentStop validates and records each job, Stop blocks an early stop with the next command. A content-hash ledger keeps reruns warm. A throwaway experiment first tested four Claude Code behaviours the loop needs. Cold `claude -p` runs: 32 min 34 s, then 25 min 01 s to 29 min 51 s after loop changes; the submitted run 28 min 59 s with 130 subagents, a warm rerun 19 s (57 s with start-up) with none. To build it, the main session chaired: architects and review panels in fresh contexts, implementers on disjoint files against written briefs, an independent lighter-model review before our own tests, browser click-throughs on real data. Scott approved designs and daytime commits; overnight work stayed on feature branches.

## What we handed to subagents, and why

Judgement, never counting. Five pipeline agents, each with Read and Write only and a code gate: the taxonomist once, an extractor per batch (99), the merger once, a synthesizer per group of processes, a drafter per document. They decide membership, aliasing, descriptions, one bounded work estimate per process, and prose; code does every count, tier and sum. Agent definitions pin each stage's model and effort (`.claude/agents/`).

## How we budgeted their context

Read returns at most 25,000 tokens and numbers each line, so a batch stays under 64,000 bytes and 22,000 tokens, estimated as (bytes + 8 x lines) / 3: 99 batches. Synthesis groups hold at most four processes and 24,000 tokens. The orchestrator sees IDs and JSON, never email; fix-round problems travel in files. Prompts carry only a job ID and folder: typing 672-776-character prompts cost the first cold run about 4 minutes.

## What ran in parallel

Up to 20 extractors at once. Occupancy was the lever: 6.5 of 12 slots busy on average in M4, 10.0 of 20 in the first cold run, 11.6 with ID-only prompts and one `advance` per cycle, 12.5 with the orchestrator's effort pinned and a short folder path. Synthesis and drafting each run as one wave.

## Where Claude Code got it wrong, and how we caught it

All caught before any output:

- The SubagentStop block cannot re-enter a subagent that ended through its hand-back tool (auto mode); a deliberately corrupted batch stayed `running` (M3). Fix rounds became ledger re-dispatches in every mode.
- Review showed the first corpus guard, a deny-list, let an extractor overwrite the guard hook (now an allowlist), and the taxonomy gate admitted instructions in definitions (now refused).
- Review found 77 of 974 forwards mislabelled from quoted banners (the implementers' tests had passed) and our de-duplication would chain daily sends into one.
- Drafts made one email a standing rule and its sender the owner; better instructions gained a point in ten, so code writes the people line.
- One person's four addresses counted as four staff; folding cut staff counts from 726 to 688, and an eye check caught a wrong fold (`m..presto`).
- M7 reviews caught email text forming live links in `report.md` and a regex older Safari cannot parse, which would have blanked the dashboard.

Submitted run: 2,684 quotes exact, 13 repaired, 0 rejected; 4 fix rounds.

## What we would build next with another week

A company-wide estimate from four mailboxes, assumptions stated; a hand check of the occurrences behind the top opportunities; nickname and sound-alike folds with evidence; per-sentence citations and worked examples in drafts; an injection check beyond phrases.

## Where the system is most likely wrong

By dollar impact:

1. Model-estimated hands-on minutes per round: $1,705 of the $2,231 a month ($526 counted). Bounded (1-480 minutes, at most 80% automatable), cited from 3+ rounds and 2+ senders, overridable. Range $1,243 to $4,989; forced reruns of the merge and estimates moved the headline 5% and 7.6%.
2. The merge, which placed 26% of tagged mail.
3. Occurrences: with no In-Reply-To headers, rounds come from subjects, 45-day gaps and fresh sends.
4. Tagging: 80.8% exact (84.6% after the merge) on 52 code-sampled messages, labelled blind by a fresh agent; Scott kept its calls on the 8 it was least sure of.
5. 13 forwarded reports with stripped headers, priced as long emails.
6. Unsourced draft details, marked `[proposed: ...]`.

## What it took on faith

That email shows the work: phone and screen work leave no trace, so totals are floors. The brief's $85 an hour and our per-action minutes (`config/effort-rates.json`). That each address fold is one person, and that four mailboxes' recurring mail represents those people's processes. Neither of us knows the energy business: the process list, gold labels and drafts' domain detail are the agents' calls, checked for citations and consistency, not expertise. Undocumented Claude Code details, each failing safe. macOS, seen only through CI. Checked, not trusted: the corpus is about 6-8 times a 200k window, not thirty; we found the nine planted messages by their ID shape; the pipeline detects them by content and never reads that shape.

## What we drafted, and why

The rule (dashboard and report; numbers in `config/scoring.json`): "We draft a working document for every process seen 10 or more times over 3 or more months by 2 or more staff whose automatable work is worth one hour a month ($85) or more." Capped at 8, floored at 3; 5 drafted. The synthesizer picks one of the brief's four types; a gate refuses money, percent and effort figures, citations and steering text. Emails are reusable templates, not replies to threads still open in a 2002 archive. Open work shows as 24 recent open loops. Citations are per document: validated facts in, verbatim evidence appended by code.
