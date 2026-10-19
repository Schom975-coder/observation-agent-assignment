# The Claude Code layer, exactly as used

Everything Claude Code reads to run the pipeline is in [`.claude/`](/.claude/), submitted as it was used for the run. The tables on this page are built from those files each time the site is built, so they cannot drift from them. The project rules every session follows are in [`CLAUDE.md`](/CLAUDE.md) at the repository root.

## Every file {#files}

{{block:claude_files}}

## The agents {#agents}

Each pipeline stage that needs judgement is a subagent type with Read and Write as its only tools and a check in code after it. Each file pins its own model and effort, so a run does not depend on the reader's settings. Their configuration, read from each file's frontmatter:

{{block:agents}}

## The skills {#skills}

`/observe` is the one command. `/extract-batch` reruns named jobs by hand for debugging; `/serve` opens the dashboard of the last run without running anything.

{{block:skills}}

## The hooks {#hooks}

All hooks run as `node <file>.ts` in exec form, the same on every OS, and live in `settings.json` so they also run under `claude -p`. Outside a run they leave everything but the pipeline's own agents alone, so development work in the same folder is untouched; during a run the Stop hook steers only the session that started it.

{{block:hooks}}

## settings.json {#settings}

The static rules are deliberately few: the run's commands are pre-approved by the `/observe` skill itself, and the corpus guard enforces the rest during a run.

{{block:settings}}

## The plan and the decision log {#plan}

Three files under `.claude/` are records rather than configuration: the design, [`.claude/plan/ARCHITECTURE.md`](/.claude/plan/ARCHITECTURE.md); the decision log, [`.claude/notes/DECISIONS.md`](/.claude/notes/DECISIONS.md); and the running log `NOTES.md` was written from, [`.claude/notes/NOTES-LOG.md`](/.claude/notes/NOTES-LOG.md). [Design choices, and why](design.html) is a guided path through the first two.
