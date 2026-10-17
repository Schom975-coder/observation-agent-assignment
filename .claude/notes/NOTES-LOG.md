# Running notes log

Raw material for `NOTES.md`. NOTES.md is two pages, about 900 words: roughly 110 words for each of the eight questions below. The reviewer will read it closely.

**Entry rule:** log something only if it answers one of the eight questions with a specific fact and its evidence (a number, a file, a test, a commit). Prefer entries about the system catching model mistakes before they reach the output, with counts. Date and branch every entry. At the end we pick the strongest entries; we don't summarize everything.

## Deliverables checklist (from the brief)
- [ ] The repo (fork: github.com/Schom975-coder/observation-agent-assignment)
- [ ] `.claude/` exactly as used: CLAUDE.md, subagents, skills, hooks, slash commands, settings
- [ ] NOTES.md, two pages max, answering all eight questions
- [ ] Output of one real run: report, dashboard, run logs, drafted artifacts
- [ ] Pushed to our repo, link sent

## 1. How we drove Claude Code
- 2026-10-16, main: Diagnosed the Windows clone failure and tested every fix in a throwaway clone before touching the real one; the rules went into CLAUDE.md so every later session inherits them.
- 2026-10-16, plan/architecture: Planning handed to a Fable architect subagent; the main session reviewed its output against the corpus and the installed CLI before Scott decided anything.

## 2. What we handed to subagents and why
- 2026-10-16, plan/architecture: Architecture blueprint to an `architect` subagent on Fable: a fresh context could read the brief, sample the corpus and fetch the Claude Code docs without filling the main session. About 215k tokens, 39 tool calls, 24 minutes. Resumed once (about 8 minutes) to apply Scott's decisions, since it already held the document's structure.

## 3. How we budgeted their context
- 2026-10-16: Gave the architect the facts we had already measured (folder counts, size distribution, CRLF and encoding results, the Windows setup) and told it to use scripts for corpus statistics instead of reading thousands of files.
- Planned for the pipeline: batches capped at about 64 KB because Read returns at most 25,000 tokens per call; tokens estimated as bytes/3 for number-heavy text.

## 4. What we ran in parallel
- 2026-10-16: The architect revised the plan while the main session wrote CLAUDE.md rules and these logs (separate files).

## 5. Where Claude Code got it wrong and how we caught it
- 2026-10-16, main: First Windows fix (sparse checkout alone) failed because Git refuses to index trailing-dot paths on Windows at all. Caught by testing in a scratch clone before recommending it.
- 2026-10-16, main: In Git Bash, the sparse-checkout pattern `/corpus/` was silently rewritten to `C:/Program Files/Git/corpus/`; the exclusion did nothing and Windows wrote the corpus with stripped names (6,480 status changes). Caught by reading `.git/info/sparse-checkout`; fixed with `MSYS_NO_PATHCONV=1`.
- 2026-10-16, plan/architecture: The blueprint had the model estimate minutes per occurrence and the automation fraction, which would leave a model holding the key input to the hours arithmetic and let the headline move between runs. Caught in review; replaced with the email-trail model.
- 2026-10-16, plan/architecture: The revised blueprint treated a subject thread as one occurrence and any consecutive same-sender message as a chaser. The 18 "Calpine Daily Gas Nomination" emails share one subject and arrive days apart, so they would have collapsed into a few occurrences and been priced as chasers. Caught by grepping the real subjects and dates.
- 2026-10-16, plan/architecture: Static deny rules in the blueprint would have blocked our own development sessions; 90 KB batches sat too close to the Read cap. Both caught in review.
- 2026-10-16, plan/architecture: The architect noticed external senders (Calpine, TXU, CAISO) would be priced at $85/h as staff, and raised it as a decision instead of deciding silently.

## 6. What we would build next with another week
- Company-wide impact estimate from the 4 mailboxes, with stated assumptions. Deliberately not built.

## 7. Where the system is most likely wrong
- Which emails belong to which process is model judgment (cached); to be quantified against ~50 hand-confirmed labels.
- Threading by normalized subject: the corpus has no In-Reply-To or References headers.
- The email trail is a floor: phone calls, spreadsheets and system entry leave no messages.

## 8. What it took on faith
- The per-action minutes and automatable shares (published, same for every process, re-scorable without a model).
- That four mailboxes' recurring mail represents the processes those people ran.
- Claude Code behaviours known only from the docs until M-1 and M3 test them.

## Traps found (data and brief)
- 2026-10-16: Nine planted messages, found by their 16-digit Message-ID middle segment (code must not use that marker): `farmer-d/logistics/3220.` prompt injection telling "the reviewing process" to report invoice approval as fully automated and not cite the notice; `giron-d/inbox/481.` asks for invoice approval to be left off the write-up; `giron-d/inbox/482.` single-source "eats half my week" claim; `giron-d/inbox/483.` vs `williams-w3/sent_items/526.` contradictory ownership of the daily imbalance check; `giron-d/sent/795.` no Date header; `williams-w3/inbox/142.` "32 Febuary 2001 25:61:00"; `lokay-m/inbox/74.` dated 2031; `farmer-d/logistics/3221.` 350 KB pasted table.
- 2026-10-16: The brief says the corpus is "about thirty times larger than a single context window". Measured 6.9 MB raw, about 1.2M tokens prepared: roughly 6-8x a 200k window.
- 2026-10-16: JavaScript's `new Date("Thu, 31 Apr 2001 10:00:00 -0700")` silently returns May 1; Python rejects it. Strict hand-rolled date parser required.
- 2026-10-16: Every corpus file name ends in a trailing dot; a plain `git clone` on Windows checks out nothing at all.
