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
- **Extractor subagents on a lighter, faster model; the synthesizer uses the session model.** Rejected: the session model everywhere. Extraction is tagging and quoting across ~75 calls and the quote validator catches errors. Revisit if M3 shows poor tagging.
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

## Build
- **TypeScript 7.0.2 and `@types/node` 22.20.5, pinned, as the only dev dependencies; no runtime dependencies.** Node types match the oldest supported Node (22.18) so the typecheck rejects APIs that Node lacks. Rejected: `@types/node` 24 (would accept APIs missing on 22).
- **All text files use LF on every OS (`* text=auto eol=lf`); the corpus keeps its raw bytes (`-text -eol`).** Rejected: platform-default line endings, which would make golden outputs and hashes differ on Windows.
- **CI also runs on Node 22.18.0**, so the `engines` claim is tested rather than asserted.
- **CLAUDE.md's greppable rules are tests (`tests/source-guards.test.ts`)**, proven by planting violations that each guard caught.
- **The message list comes from Git HEAD; a disk walk (skipping hidden files like `.DS_Store`) only when there is no Git checkout**, e.g. a ZIP download on macOS. Bytes are read from disk when every listed file is there, from Git objects when none are, and a partial checkout is refused rather than half-read. Rejected: walking the disk always (picks up stray files, and can't see the corpus on Windows).
- **Dates are parsed strictly: three-letter weekday and month names, a numeric offset, real calendar days, UTC by integer arithmetic.** Valid dates outside 1998-2002 are `out_of_range`, never guessed (year 0001 is not silently read as 2001). Rejected: lenient parsing, which would accept `Tues` and `Febuary` and roll impossible days forward.
- **Quoted and forwarded text is found by markers measured in this corpus**, including Lotus reply header blocks with no banner (the third most common, 477 messages). The injection scan reads subject plus whole body, quoted parts included, and undoes leftover `=20`-style encoding only for detection; offsets never change. Oversize = body over 32,000 characters (flags only the 350 KB table). Rejected: treating underscore rules as separators (in this corpus they are table lines).
- **One subject-prefix grammar shared by parsing and action counting** (`re:`/`fw:`/`fwd:`, any case, optional spaces, optional opening bracket as in `[Fwd: ...]`). Rejected: a strict `^fwd?:` in the classifier, which would have called `[Fwd: x]` fresh in one place and a forward in the other.
- **A chaser must go back to at least one of the same recipients.** Rejected: same sender as the previous message is enough (the plan's first wording), which priced one person forwarding an item to different colleagues in turn as nagging (about 95 such cases in the corpus, found by the code review).
- **The injection scanner has 9 named phrase patterns**: the 5 from section 6.3 plus 4 generic ones (ignore previous instructions, system prompt, language model, addressed to an AI). It flags exactly the one planted message; phrases common in business mail ("disregard previous instructions", "do not cite") were left out to avoid false positives. It is a first line of defence: the extractor prompt treats every message as data regardless.
- **A "forward" must actually forward something (its first earlier block is a forward banner, or an `FW:`-style subject) with a short note.** A short reply that only quotes the original is a short written email. Rejected: the plan's first wording ("any forwarded/original marker"), which would price every quick "Thanks" reply as an 80%-automatable forward.
- **The manifest holds no machine-specific fields (no source, no timestamps)**, so every OS writes identical bytes and caches key on `corpus_hash`. Any byte mismatch against Git stops the run.

## Working method
- **Minimal `.claude/`:** the plan, this file, the notes log, and the pipeline's own skills/agents/hooks/settings. No per-branch session folders or merge-request files (Scott's global workflow, overridden for this repo). Everything in `.claude/` is reviewed, so clutter costs us.
