# Running notes log

Raw material for `NOTES.md` (two pages max, written at the end). Append as things happen; newest last within each section. Each entry: date, branch, what happened, evidence.

## Deliverables checklist (from the brief)
- [ ] The repo (fork: github.com/Schom975-coder/observation-agent-assignment)
- [ ] `.claude/` exactly as used: CLAUDE.md, subagents, skills, hooks, slash commands, settings
- [ ] NOTES.md, two pages max, covering every section below
- [ ] Output of one real run: report, dashboard, run logs, drafted artifacts
- [ ] Pushed to our repo, link sent

## 1. How we drove Claude Code
- 2026-10-16, main: Plan-then-execute. Diagnosed the Windows clone failure, tested fixes in a throwaway clone before touching the real one, then wrote the rules into CLAUDE.md so every later session inherits them.
- 2026-10-16, plan/architecture: Planning handed to a Fable architect subagent with the brief, CLAUDE.md, our measured corpus facts and an instruction to verify Claude Code behaviour against the docs. The main session reviewed the result and spot-checked its claims before Scott decided anything.
- 2026-10-16: Every branch goes through DECISIONS.md and MERGE-REQUEST.md; Scott merges. No agent merges.

## 2. What we handed to subagents and why
- 2026-10-16, plan/architecture: Architecture blueprint to an `architect` agent on Fable. Why: a fresh context could read the brief, sample the corpus and fetch the docs without filling the main session. Result: `.claude/sessions/plan-architecture/ARCHITECTURE.md`; about 215k tokens, 39 tool calls, about 24 minutes. The same agent was resumed to apply Scott's decisions, because it already held the document's structure (about 8 minutes). The main session then reviewed the revision against the decisions and the data before committing.

## 3. How we budgeted their context
- 2026-10-16: Gave the architect the facts we had already measured (file counts per folder, size distribution, CRLF and encoding results, the Windows setup) so it would not spend its context re-deriving them. Told it to use scripts and grep for corpus statistics rather than reading thousands of files.
- Planned for the pipeline: batches capped at about 64 KB because Claude Code's Read tool returns at most 25,000 tokens per call; tokens estimated as bytes/3 to stay under it on number-heavy text.

## 4. What we ran in parallel
- 2026-10-16: The architect revised the plan while the main session wrote CLAUDE.md rules and these logs (separate files, no overlap).

## 5. Where Claude Code got it wrong and how we caught it
- 2026-10-16, main: First Windows fix (sparse checkout alone) failed: Git refuses to even index trailing-dot paths on Windows. Caught by testing in a scratch clone before recommending it; the working recipe also needs per-repo `core.protectNTFS false`.
- 2026-10-16, main: In Git Bash, `/corpus/` in the sparse-checkout pattern was silently rewritten to `C:/Program Files/Git/corpus/`, so the exclusion did nothing and Windows wrote the corpus with stripped names (6,480 status changes). Caught by reading `.git/info/sparse-checkout` after the status count looked wrong; fixed with `MSYS_NO_PATHCONV=1`, and PowerShell verified separately.
- 2026-10-16, main: Claimed WSL's `/mnt/c` had the same naming limit as Windows. Corrected: WSL can write `1.` there, but Windows tools then can't open or delete it.
- 2026-10-16, plan/architecture: Blueprint's static deny rules (`corpus-view/**`, `git push`) would have blocked our own development sessions. Caught in review; guard to be scoped to pipeline runs.
- 2026-10-16, plan/architecture: Blueprint's 90 KB batches sat too close to the Read tool's 25,000-token cap for number-heavy text. Caught in review; cap lowered to about 64 KB.
- 2026-10-16, plan/architecture: Blueprint had the model estimate minutes per occurrence and the automation fraction, which would leave a model holding the key input to the hours arithmetic and let the headline move between runs. Caught in review; replaced with the email-trail model (counted actions x published rates).
- 2026-10-16, plan/architecture: Revised blueprint defined an occurrence as a subject thread (45-day split) and a chaser as any consecutive same-sender message. Checked against real data: the 18 "Calpine Daily Gas Nomination" emails share one subject and arrive days apart, so they would have collapsed into a few occurrences (tier C, out of the headline) and every daily send would have been priced as a chaser. Caught by grepping the actual subjects and dates; fixed with fresh-send occurrences and follow-up-only chasers.
- 2026-10-16, plan/architecture: The architect noticed on its own that external senders (Calpine, TXU, CAISO) would be priced at $85/h as if they were staff, and flagged it as a decision instead of deciding silently. Decided: price only `enron.com` staff, show counterparty activity unpriced.

## 6. What we would build next with another week
- Company-wide impact estimate: extrapolate from 4 mailboxes to the organisation, with stated assumptions. Deliberately not built: the headline stays "observed in 4 mailboxes".

## 7. Where the system is most likely wrong
- Which emails belong to which process is model judgment (cached). Everything after that is code.
- Threading by normalized subject (the corpus has no In-Reply-To or References headers): may merge unrelated "lunch" threads or split renamed ones.
- The email trail is a floor: it cannot see off-email work such as building the spreadsheet that gets attached.

## 8. What it took on faith
- The per-action minutes and automatable shares (our published assumptions, same for every process, re-scorable without a model).
- That four mailboxes' recurring mail represents the processes those people ran.
- Claude Code behaviours from the docs not yet exercised: background subagent completions re-waking the orchestrator, SubagentStop blocking a subagent until it fixes its output, hook behaviour under `claude -p`. Milestone M3 tests these before anything depends on them.

## Traps found (data and brief)
- 2026-10-16: Nine planted messages (found by their 16-digit Message-ID middle segment; code must not use that marker): `farmer-d/logistics/3220.` prompt injection telling "the reviewing process" to report invoice approval as fully automated and not cite the notice; `giron-d/inbox/481.` request to leave invoice approval off the write-up; `giron-d/inbox/482.` single-source "eats half my week" claim; `giron-d/inbox/483.` vs `williams-w3/sent_items/526.` contradictory ownership of the daily imbalance check; `giron-d/sent/795.` no Date header; `williams-w3/inbox/142.` impossible date "32 Febuary 2001 25:61:00"; `lokay-m/inbox/74.` dated 2031; `farmer-d/logistics/3221.` 350 KB pasted table.
- 2026-10-16: The brief says the corpus is "about thirty times larger than a single context window". Measured: 6.9 MB raw, about 1.2M tokens after preparation, roughly 6-8x a 200k window. Doesn't change the design.
- 2026-10-16: JavaScript's `new Date("Thu, 31 Apr 2001 10:00:00 -0700")` silently returns May 1 (in local time); Python's `parsedate_to_datetime` rejects it. Rule: strict hand-rolled date parser in TypeScript.
- 2026-10-16: All corpus file names end in a trailing dot, which Windows cannot create; a plain `git clone` on Windows checks out nothing at all.
