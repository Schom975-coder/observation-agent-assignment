# Observation agent: the project at a glance

A system that runs inside Claude Code, reads all {{fig:messages_read}} messages of an email archive from Enron, finds the work that recurs, prices what could be automated at the brief's $85 an hour, and ties every claim to a message and a verbatim quote. One command, `/observe`, runs it; the outputs of one real run are committed beside the code, and this site is a reading copy of both.

## What the brief asked for, and where it is {#asks}

One row per sentence of [the brief](brief.html) that can be checked, in the brief's order. Paths open the file on GitHub; pages are on this site.

| # | The brief asks | Where it is | How it is checked |
|---|---|---|---|
| {#ask-1} 1 | "Claude Code is the runtime here. The thing you deliver runs inside it and is driven by it." | [The Claude Code layer](claude-dir.html); [Inside Claude Code](architecture.html#diagram-claude-code) | [`tests/hooks.test.ts`](/tests/hooks.test.ts) holds the settings, skills and agent files to the code; the [run logs](run.html#logs) record every subagent start and stop |
| {#ask-2} 2 | "It is about thirty times larger than a single context window." | [How we budgeted their context](notes.html#how-we-budgeted-their-context); batches cut by [`src/batch/build.ts`](/src/batch/build.ts) | [`tests/batch.test.ts`](/tests/batch.test.ts) (byte and token caps); the claim itself was measured, see [What it took on faith](notes.html#what-it-took-on-faith) |
| {#ask-3} 3 | "Some messages have no usable date. Some are duplicated. One is enormous." | [`src/parse/dates.ts`](/src/parse/dates.ts), [`src/normalize/dedup.ts`](/src/normalize/dedup.ts), [`src/parse/flags.ts`](/src/parse/flags.ts); the dashboard's How we measured | [`tests/dates.test.ts`](/tests/dates.test.ts), [`tests/normalize.test.ts`](/tests/normalize.test.ts), [`tests/batch.test.ts`](/tests/batch.test.ts) |
| {#ask-4} 4 | "One command, and the system" | `/observe` ([How to run](how-to-run.html#run-it)); [`.claude/skills/observe/SKILL.md`](/.claude/skills/observe/SKILL.md) | [`tests/run-loop.test.ts`](/tests/run-loop.test.ts) drives the whole pipeline through `advance` with no model |
| {#ask-5} 5 | "Reads every message in the corpus. Not a sample." | {{fig:messages_read}} read; the coverage line in [the run's facts](run.html#facts) | [`tests/validate-extraction.test.ts`](/tests/validate-extraction.test.ts) fails a batch that skips a message; `node obs.mjs verify` in CI |
| {#ask-6} 6 | "The recurring processes: the work that happens over and over, who touches it, how often, and where it stalls." | Each process page of the [dashboard](dashboard/index.html); [`src/metrics/rollup.ts`](/src/metrics/rollup.ts) | [`tests/rollup.test.ts`](/tests/rollup.test.ts), [`tests/merge.test.ts`](/tests/merge.test.ts) |
| {#ask-7} 7 | "Ranks the automation opportunities ... hours per month and dollars per month at a blended $85/hour." | The [dashboard](dashboard/index.html) overview and the [report](report.html); [Pricing](design.html#pricing); [`src/metrics/score.ts`](/src/metrics/score.ts) | [`tests/score.test.ts`](/tests/score.test.ts) pins exact cents, counted and estimated parts apart |
| {#ask-8} 8 | "Cites everything ... each carrying a verbatim quote. A claim that cannot name its evidence does not ship." | Every figure opens down to its messages ([Every number lands on a message](architecture.html#diagram-drill)); [`src/validate/quotes.ts`](/src/validate/quotes.ts) | [`tests/quotes.test.ts`](/tests/quotes.test.ts); [`tests/targets.test.ts`](/tests/targets.test.ts) walks every figure to its list |
| {#ask-9} 9 | "I will pull claims at random and check them against the raw files." | [Check a claim yourself](how-to-use.html#check-a-claim) | `git show HEAD:"<id>"`, copied from the message viewer |
| {#ask-10} 10 | "Acts. For the opportunities above a threshold you choose, produce a drafted artifact ... defend that decision in your notes." | [The drafted documents](run.html#documents); [Drafting](design.html#drafting); [What we drafted, and why](notes.html#what-we-drafted-and-why) | [`tests/artifacts.test.ts`](/tests/artifacts.test.ts) (the draft gate); `node obs.mjs verify` re-checks every draft |
| {#ask-11} 11 | "Serves a dashboard on localhost. Ranked opportunities, the running dollar total, and drill-through on every claim." | `node obs.mjs serve` ([Open the dashboard](how-to-run.html#open-the-dashboard)); [the copy on this site](dashboard/index.html) | [`tests/server.test.ts`](/tests/server.test.ts) (binds 127.0.0.1); [`tests/targets.test.ts`](/tests/targets.test.ts); [`tests/dashboard.test.ts`](/tests/dashboard.test.ts) |
| {#ask-12} 12 | "It should look like something I would put in front of a client president." | The [dashboard](dashboard/index.html) and the [report](report.html) | A design signed off before it was built; checked by eye at three widths in both themes ([How it was built](process.html#m7)) |
| {#ask-13} 13 | "No paid API keys and no API spend." | Every model call is a Claude Code subagent ([Inside Claude Code](architecture.html#diagram-claude-code)) | [`tests/source-guards.test.ts`](/tests/source-guards.test.ts) refuses an SDK import or an API key anywhere |
| {#ask-14} 14 | "A full run completes unattended in under 30 minutes." | {{fig:wall_minutes}} minutes ([the run's facts](run.html#facts)); [The 30-minute budget](design.html#budget) | The run's own log, [listed with the run](run.html#logs) |
| {#ask-15} 15 | "Re-running against an unchanged corpus does not repeat finished work." | [Warm and cold runs](how-to-run.html#warm-and-cold-runs); [`src/run/ledger.ts`](/src/run/ledger.ts) | [`tests/ledger.test.ts`](/tests/ledger.test.ts), [`tests/run-loop.test.ts`](/tests/run-loop.test.ts), [`tests/prepare.test.ts`](/tests/prepare.test.ts) |
| {#ask-16} 16 | "Anything that has to be exactly right is deterministic code rather than a model call." | [The two places a model touches a number](architecture.html#model-edges); [Counted and estimated](design.html#counted-vs-estimated) | [`tests/validate-synthesis.test.ts`](/tests/validate-synthesis.test.ts) refuses any number outside the bounded estimate; [`tests/build.test.ts`](/tests/build.test.ts) builds twice, byte for byte |
| {#ask-17} 17 | "Tests pass without invoking a model at all." | [Tests](how-to-run.html#tests) | `npm test` in CI on Ubuntu, macOS and Windows ([`.github/workflows/ci.yml`](/.github/workflows/ci.yml)) |
| {#ask-18} 18 | "Python or TypeScript for the deterministic parts." | TypeScript on Node, no runtime dependency ([`package.json`](/package.json)) | `npm run typecheck` in CI |
| {#ask-19} 19 | "Everything runs locally." | The server binds 127.0.0.1; fonts are vendored ([`dashboard/fonts/SOURCES.md`](/dashboard/fonts/SOURCES.md)) | [`tests/server.test.ts`](/tests/server.test.ts); [`tests/dashboard.test.ts`](/tests/dashboard.test.ts) refuses any URL that leaves the page's origin |
| {#ask-20} 20 | "The repo." | [github.com/Schom975-coder/observation-agent-assignment](https://github.com/Schom975-coder/observation-agent-assignment) | CI on every push |
| {#ask-21} 21 | "Your `.claude/` directory exactly as you used it." | [The Claude Code layer, exactly as used](claude-dir.html); [`.claude/`](/.claude/) | Its tables are built from the files when this site is built |
| {#ask-22} 22 | "`NOTES.md`, two pages at most." | [Notes](notes.html), one anchor per question | Read it: its headings are the brief's questions |
| {#ask-23} 23 | "Tell me where your system is most likely to be wrong, and what it took on faith." | [Most likely wrong](notes.html#where-the-system-is-most-likely-wrong); [Taken on faith](notes.html#what-it-took-on-faith) | Each item names its file or its measurement |
| {#ask-24} 24 | "The output of one real run: the report, the dashboard, the run logs, and the drafted artifacts." | [Report](report.html), [dashboard](dashboard/index.html), [run logs](run.html#logs), [drafted documents](run.html#documents); [`out/`](/out/) in the repository | `node obs.mjs verify` re-checks every model output against the corpus, in CI |

## Start here {#start}

<div class="start">

- [Open the dashboard](dashboard/index.html)
  The brief's dashboard runs on localhost with `node obs.mjs serve`; this is a copy of it with the same pages, data and messages, pre-written so nothing needs installing. Every number still opens down to its message.
- [Read the report](report.html)
  The same figures as a printable report, from the same data. Also [in Markdown](report.md).
- [Read the notes](notes.html)
  `NOTES.md`: how Claude Code was driven, where it went wrong, where the system is most likely wrong.
- [See the drafted documents](run.html#documents)
  The working documents drafted for the opportunities above the threshold, with their evidence.
- [The run's facts and logs](run.html)
  Timings by stage, subagents, quote checks and coverage, read from the run's own output.
- [The `.claude/` directory as used](claude-dir.html)
  The agents, skills, hooks and settings the run used, with their configuration read from the files.

</div>

{{shot:overview}}

## The submitted run in figures {#figures}

{{block:figures}}

From run `{{fig:run_id}}` of {{fig:run_date}}. Every figure above is read from the run's output when this site is built; [the run's facts](run.html#facts) has the rest.

## Read on {#read-on}

{{block:pages}}
