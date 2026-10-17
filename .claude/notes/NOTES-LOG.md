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
- 2026-10-16, docs/m-1-results: Before writing pipeline code, ran a throwaway experiment (3 tiny background subagents, logging hooks, `claude -p` on Windows, 105 s) to test the four Claude Code behaviours the design depends on. All four held: completions re-woke the orchestrator, which dispatched the next job; a SubagentStop `block` made each subagent fix its file and resend (3 of 3); PreToolUse input carries `agent_id`/`agent_type` for subagent calls and neither for the main session; exec-form `node` hooks fired under `-p` in an untrusted folder. Also: the Stop payload includes `background_tasks`, and tools missing from the skill's `allowed-tools` were denied without stalling the run.
- 2026-10-16, main: Diagnosed the Windows clone failure and tested every fix in a throwaway clone before touching the real one; the rules went into CLAUDE.md so every later session inherits them.
- 2026-10-16, plan/architecture: Planning handed to a separate architect subagent; the main session reviewed its output against the corpus and the installed CLI before Scott decided anything.

## 2. What we handed to subagents and why
- 2026-10-16, plan/architecture: Architecture blueprint to an `architect` subagent: a fresh context could read the brief, sample the corpus and fetch the Claude Code docs without filling the main session. About 215k tokens, 39 tool calls, 24 minutes. Resumed once (about 8 minutes) to apply Scott's decisions, since it already held the document's structure.

- 2026-10-16, feat/m2-parse: M2 split across three implementation subagents running at once (strict date parser; header/body/flag parser; email-trail action classifier). The main session first wrote the shared record contract (`src/types.ts`) so all three built against one shape; each owned disjoint files and ran no state-changing git commands, keeping the commit gate with Scott. Git worktrees were not an option: a worktree checkout hits the trailing-dot corpus names on Windows.

## 3. How we budgeted their context
- 2026-10-16: Gave the architect the facts we had already measured (folder counts, size distribution, CRLF and encoding results, the Windows setup) and told it to use scripts for corpus statistics instead of reading thousands of files.
- Pipeline batches: capped at 64,000 bytes and 22,000 estimated tokens, because Read returns at most 25,000 tokens per call and numbers each line; tokens estimated as (bytes + 8 x lines) / 3. Measured in M2: 99 batches of 38.9-58.2 KB, median 33 messages.

## 4. What we ran in parallel
- 2026-10-16: The architect revised the plan while the main session wrote CLAUDE.md rules and these logs (separate files).

## 5. Where Claude Code got it wrong and how we caught it
- 2026-10-16, main: First Windows fix (sparse checkout alone) failed because Git refuses to index trailing-dot paths on Windows at all. Caught by testing in a scratch clone before recommending it.
- 2026-10-16, main: In Git Bash, the sparse-checkout pattern `/corpus/` was silently rewritten to `C:/Program Files/Git/corpus/`; the exclusion did nothing and Windows wrote the corpus with stripped names (6,480 status changes). Caught by reading `.git/info/sparse-checkout`; fixed with `MSYS_NO_PATHCONV=1`.
- 2026-10-16, plan/architecture: The blueprint had the model estimate minutes per occurrence and the automation fraction, which would leave a model holding the key input to the hours arithmetic and let the headline move between runs. Caught in review; replaced with the email-trail model.
- 2026-10-16, plan/architecture: The revised blueprint treated a subject thread as one occurrence and any consecutive same-sender message as a chaser. The 18 "Calpine Daily Gas Nomination" emails share one subject and arrive days apart, so they would have collapsed into a few occurrences and been priced as chasers. Caught by grepping the real subjects and dates.
- 2026-10-16, plan/architecture: Static deny rules in the blueprint would have blocked our own development sessions; 90 KB batches sat too close to the Read cap. Both caught in review.
- 2026-10-16, docs/m-1-results: Running `claude -p "/m1test"` from Git Bash, the slash command arrived as `C:/Program Files/Git/m1test` (Git Bash path conversion), so the skill never triggered; the orchestrator recovered only by searching the disk for it. Caught in the experiment's stream log before any real run depended on it; the plan now requires `MSYS_NO_PATHCONV=1` for Git Bash, and the README will say so.
- 2026-10-16, feat/m1-reader: The reader decided "is this folder a Git checkout?" by comparing path strings. It passed locally and on Ubuntu but failed on CI's macOS (`/var` is a symlink to `/private/var`) and Windows (`RUNNER~1` short names): the reader silently fell back to walking the disk and skipped the byte check against Git. Caught by the three-OS CI matrix on the first push; fixed by asking Git directly (`rev-parse --show-cdup`).
- 2026-10-16, feat/m2-parse: The independent code-review subagent (run before any of the main session's own testing) found that a reply whose quoted history contained an old "Forwarded by" banner was labelled a forward: 77 of 974 forwards in the corpus (e.g. `farmer-d/logistics/1046.`). The three implementers' tests had all passed, because the classifier's tests used hand-built segments and nothing ran real parser output through it. It also found a date assertion that could not fail and corpus-wide bounds too loose to catch regressions. Fixed with a parse-then-classify test on real emails, 7 hand-read golden segmentations, and exact regression pins.
- 2026-10-16, feat/m2-parse: While applying the review, a `sed` replacement of an invisible byte-order mark wrote `FEFF` instead of `﻿` (GNU sed reads `\u` as "uppercase next"); the code then stripped the literal text "FEFF" and the existing test still passed. Caught by reading the result back; fixed and a test added that ordinary text spelling FEFF survives.
- 2026-10-16, feat/m2-normalize: The main session's own de-duplication code chained copies: each joined if within 24 h of the previous copy, so a run of identical daily sends a few hours closer than a day apart would have collapsed into one email, and two daily sends exactly 24 h apart merged. The independent review caught it before any test ran (reproduced in memory), along with a renderer that showed short oversize bodies twice and a `prepare` that deleted old batches before knowing the new ones would pack. The real corpus was only lucky: one Calpine pair was 24.08 h apart. Fixed with anchored, strict clustering and tests at 23/24/25 h and on chains; a second review checked the rewrite.
- 2026-10-17, feat/m2-normalize: Three review rounds on the batching code, each finding a further way one planted email could abort the whole run: chained de-duplication, then bodies of thousands of blank lines, then enormous headers (4,000 recipients, a 70,000-character subject), plus two regexes that hang on long runs of newlines or dots. None affected the real corpus; each was reproduced by the reviewer before being fixed. To stop an open-ended loop, the main session set a bar before the last round: fix these, then block only on wrong results for the real corpus or a crash/hang on plausible planted input, and log the rest as known limitations.
- 2026-10-16, plan/architecture: The architect noticed external senders (Calpine, TXU, CAISO) would be priced at $85/h as staff, and raised it as a decision instead of deciding silently.

## 6. What we would build next with another week
- Company-wide impact estimate from the 4 mailboxes, with stated assumptions. Deliberately not built.

## 7. Where the system is most likely wrong
- Which emails belong to which process is model judgment (cached); to be quantified against ~50 hand-confirmed labels.
- Threading by normalized subject: the corpus has no In-Reply-To or References headers.
- The email trail is a floor: phone calls, spreadsheets and system entry leave no messages.
- Forwarded reports whose headers were stripped carry no marker, so their whole text counts as the sender's own and they are priced as long written emails (15 min, 30% automatable) instead of forwards (2 min, 80%). 13 messages: `williams-w3/inbox/23, 35, 49, 57, 62, 75, 86, 92`, `farmer-d/logistics/25`, `giron-d/inbox/127, 180, 468`, `lokay-m/sent_items/147`. The parser subagent found the shape; the code review counted all 13.
- De-duplication ignores recipients, as specified: 5 of the 39 merged copies went to different people (e.g. two all-staff lists 21 minutes apart, `giron-d/inbox/434.`/`435.`), so the dropped copy's reads are not counted. Each is marked `recipients_differ` in `out/dedup.json`.
- An address written as `jdoe@enron.com (Doe, John)` loses its display name: the comma inside the parentheses splits the list. The address itself is kept, so counts are unaffected; only a shown name is missing.
- The batch token estimate, (bytes + 8 x lines) / 3, is calibrated for this all-ASCII corpus; CJK or base64-like text could tokenize denser than estimated and exceed Read's real 25,000-token cap. Unmeasured.
- The injection scanner is phrase-based and tuned on the one planted example; a trap worded differently ("note to the LLM") would pass it. The extractor prompt is the second line of defence.

## 8. What it took on faith
- The per-action minutes and automatable shares (published, same for every process, re-scorable without a model).
- That four mailboxes' recurring mail represents the processes those people ran.
- Claude Code behaviours: M-1 confirmed the four the design depends on with trivial jobs; scale (12 in flight, ~75 batches) and rate limits stay unproven until M3/M4. Interactive-mode re-waking was not tested separately (this development session re-woke on background completions the same way).

## Traps found (data and brief)
- 2026-10-16: Nine planted messages, found by their 16-digit Message-ID middle segment (code must not use that marker): `farmer-d/logistics/3220.` prompt injection telling "the reviewing process" to report invoice approval as fully automated and not cite the notice; `giron-d/inbox/481.` asks for invoice approval to be left off the write-up; `giron-d/inbox/482.` single-source "eats half my week" claim; `giron-d/inbox/483.` vs `williams-w3/sent_items/526.` contradictory ownership of the daily imbalance check; `giron-d/sent/795.` no Date header; `williams-w3/inbox/142.` "32 Febuary 2001 25:61:00"; `lokay-m/inbox/74.` dated 2031; `farmer-d/logistics/3221.` 350 KB pasted table.
- 2026-10-16: The brief says the corpus is "about thirty times larger than a single context window". Measured 6.9 MB raw, about 1.2M tokens prepared: roughly 6-8x a 200k window.
- 2026-10-16: JavaScript's `new Date("Thu, 31 Apr 2001 10:00:00 -0700")` silently returns May 1; Python rejects it. Strict hand-rolled date parser required.
- 2026-10-16: Every corpus file name ends in a trailing dot; a plain `git clone` on Windows checks out nothing at all.
- 2026-10-16, feat/m2-parse: Not every fault is planted. `lokay-m/inbox/50.` (an ordinary Concur expense notice with a normal Message-ID) is dated `26 Nov 0001`. The plan, built from the architect's corpus census, expected one out-of-range date; the date-parser subagent measured two, traced the second to this message, and changed the expectation rather than bending the parser.
