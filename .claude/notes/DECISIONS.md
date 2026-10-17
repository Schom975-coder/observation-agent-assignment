# Decisions

One line per non-obvious choice: what we chose, what we rejected, why. Newest last within each group.

## Setup
- **Develop natively on Windows; keep the corpus in Git objects, off disk** (per-repo `core.protectNTFS false` + sparse checkout excluding `/corpus/`). Rejected: WSL or Docker (works, but doesn't make the deliverable portable); full checkout with `protectNTFS false` (Windows writes `1.` as `1`, Git shows 6,480 changes, a commit would rename the corpus); renaming the corpus (citations would stop matching the reviewer's files).
- **A message's identity is its exact Git path, trailing dot included** (`corpus/farmer-d/logistics/1.`). The reviewer checks citations against raw files, so the ID must be the name they see.
- **One corpus reader with two sources (disk, or `git cat-file --batch`), byte-identical by test.** Rejected: a renamed on-disk mirror as source of truth (Windows and macOS/Linux would cite different names).
- **`corpus-view/` (`1.` -> `1.eml`) is git-ignored and for humans only.** Browsing on Windows without it ever becoming a citation source.
- **`.gitattributes`: `corpus/** -text`.** 3,231 of 3,240 messages contain CRLF and Git for Windows defaults to `core.autocrlf=true`; pinned bytes keep hashes and quotes identical across OSes.
- **Prove portability with a CI matrix (Ubuntu, macOS, Windows)** on the model-free tests rather than owning Mac/Linux machines.

## Architecture
- **Headline hours come from the email trail, not model estimates.** Code counts actions per occurrence (written, read, forwarded, chased) x fixed published minutes and automatable shares x $85/h. Rejected: model-estimated minutes and automation fraction (a model would hold the key input to the hours arithmetic the brief says it checks; the headline would move between reruns; planted effort claims like `482.` could push it). Cost: a floor that misses off-email work; the model's off-email estimate is shown beside each opportunity, never added in.
- **An occurrence starts at each fresh send (no `re:`/`fw:`, no quoted text); a chaser must be a follow-up.** Rejected: occurrence = subject thread with 45-day split. The 18 "Calpine Daily Gas Nomination" emails would have collapsed into a few occurrences (tier C, out of the headline) and every daily send would have been priced as a chaser.
- **Only company staff time is priced (`priced_domains`, default `enron.com`).** Rejected: price every sender and recipient. $85/h is the blended cost of the company's staff; counterparty actions are counted and shown, not priced.
- **TypeScript on Node >= 22.18, zero runtime deps.** Rejected: Python 3.11 stdlib (better built-in email and date parsing). Hooks need one interpreter name on every OS (`node`; Python is `python3` on macOS, `python` on Windows), one language spans pipeline, hooks and dashboard, and Scott reads TypeScript daily. Install burden was not a factor. Consequence: strict hand-rolled date parser, never `new Date(string)`.
- **Extractor subagents on `sonnet`; synthesizer inherits the session model.** Rejected: session model everywhere. Extraction is tagging and quoting across ~75 calls and the quote validator catches errors. Revisit if M3 shows poor tagging.
- **Artifact threshold: tier A/B, top 8 by automatable $/mo, at least 3; dollar bar set after the first full run.** Rejected: fixing $1,000/mo now, blind to the real distribution.
- **Dollar scope: observed in 4 mailboxes, labelled.** Rejected: extrapolating to the company (an invented number). Logged as next-week work.
- **Commit model outputs (extractions, taxonomy, synthesis); not batch files.** The brief requires one real run's output and no repeated work; README explains the warm rerun and `--force`.
- **Injection message shown as a flagged finding with citation**, not handled silently.
- **Taxonomy generated once by the model, cached, reviewed by us, never hand-edited.** Rejected: a hand-written list (we would be doing the identifying the brief asks the system to do).
- **Personal/noise mail classified, excluded from processes, counted on the dashboard.**
- **Headline total = tiers A+B; "including low-confidence" beside it.** Tiers depend only on occurrences and participants.
- **Orchestration: `/observe` skill fans out subagents from a code-kept queue.** Rejected unless forced: a script spawning `claude -p` workers (weakens "runs inside Claude Code"). M-1 tests the mechanics before any pipeline code; M3 is the go/no-go gate on real batches.
- **Corpus guard enforced only during pipeline runs or inside pipeline subagents.** Rejected: static deny rules (they also block development sessions from `corpus-view/` and feature-branch pushes).
- **Batches capped at ~64 KB, tokens estimated as bytes/3.** Rejected: 90 KB (too close to the Read tool's 25,000-token cap on number-heavy text).
- **Trap detection is content-based only**, never keyed to the 16-digit Message-ID shape that identifies the planted messages.
- **Tagging accuracy measured against ~50 hand-confirmed labels.** Turns "where the system is most likely wrong" into a number.
- **Dashboard and report get a design pass Scott signs off before M7 is built.** The audience is a client president; plumbing alone doesn't meet the brief.
- **Cut line agreed in advance** (re-score CLI, off-email estimate, macOS CI, debugging skill); never cut coverage, quote validation, traps, drill-through, timing.

- **Keep the agent-loop orchestration (M-1 passed); the Stop gate uses the payload's `background_tasks`.** Rejected: the `claude -p` worker-pool fallback, no longer needed. Git Bash users prefix `MSYS_NO_PATHCONV=1` so `/observe` isn't rewritten into a path.

## Working method
- **Minimal `.claude/`:** the plan, this file, the notes log, and the pipeline's own skills/agents/hooks/settings. No per-branch session folders or merge-request files (Scott's global workflow, overridden for this repo). Everything in `.claude/` is reviewed, so clutter costs us.
