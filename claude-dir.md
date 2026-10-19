# The Claude Code layer, exactly as used

Everything Claude Code reads to run the pipeline is in [`.claude/`](https://github.com/Schom975-coder/observation-agent-assignment/tree/main/.claude), submitted as it was used for the run. The tables on this page are built from those files each time the site is built, so they cannot drift from them. The project rules every session follows are in [`CLAUDE.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/CLAUDE.md) at the repository root.

## Every file

| File | Size | Role |
|---|---:|---|
| [`.claude/agents/drafter.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/agents/drafter.md) | 10.5 KB | The drafter subagent: for one recurring process, writes the body of one working document (an SOP, a checklist, an email template or a template) from the brief code prepared, under the headings of its type; writes out/artifacts/raw/\<draft\_id\>.md. |
| [`.claude/agents/extractor.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/agents/extractor.md) | 13.9 KB | The extractor subagent: classifies every message in one prepared batch file into recurring business processes with verbatim evidence, and writes out/extract/\<batch\_id\>.json. |
| [`.claude/agents/merger.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/agents/merger.md) | 13.8 KB | The merger subagent: reads the process keys the extractors proposed (new:\<slug\>), with the counts code made for each, and decides for every one whether its messages count under a taxonomy key, under a new process it promotes, or nowhere; writes out/merge-proposed.json. |
| [`.claude/agents/synthesizer.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/agents/synthesizer.md) | 14.7 KB | The synthesizer subagent: for one synthesis group of recurring processes, describes each process from the facts and quotes code prepared and estimates the hands-on work behind one round of it, citing the quotes it relied on; writes out/synthesis/raw/\<group\_id\>.json. |
| [`.claude/agents/taxonomist.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/agents/taxonomist.md) | 11.7 KB | The taxonomist subagent: reads the taxonomy digest of the company's archived email and proposes the list of recurring business processes every extractor then tags messages with; writes out/taxonomy-proposed.json. |
| [`.claude/hooks/gate-run.ts`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/hooks/gate-run.ts) | 16.6 KB | Stop: keep the orchestrator in the loop while a pipeline run is active, stage by stage (ARCHITECTURE.md 6.7, 7.4). |
| [`.claude/hooks/gate-subagent.ts`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/hooks/gate-subagent.ts) | 4.9 KB | SubagentStop (matcher: extractor\|synthesizer\|drafter): check a finished agent's output and record the result in the ledger. |
| [`.claude/hooks/guard-corpus.ts`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/hooks/guard-corpus.ts) | 20.2 KB | PreToolUse (every tool): keep pipeline agents to their own files, and keep every tool call during a pipeline run away from the raw corpus. |
| [`.claude/hooks/lib.ts`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/hooks/lib.ts) | 4.7 KB | Shared by the hook scripts in this folder. |
| [`.claude/hooks/log-event.ts`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/hooks/log-event.ts) | 0.9 KB | SubagentStart and SubagentStop (extractor, taxonomist, merger, synthesizer, drafter; the matchers in .claude/settings.json choose which agents): one line per event in the run log, out/runs/\<run\_id\>.jsonl (out/runs/adhoc.jsonl outside a run), so subagent launches and their agent\_ids can be read back next to the guard's bindings and the gate's records. |
| [`.claude/notes/DECISIONS.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/notes/DECISIONS.md) | 60.9 KB | One line per non-obvious choice: what was chosen, what was rejected, and why. |
| [`.claude/notes/NOTES-LOG.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/notes/NOTES-LOG.md) | 52.2 KB | The running log NOTES.md was written from. |
| [`.claude/plan/ARCHITECTURE.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/plan/ARCHITECTURE.md) | 300.1 KB | The design: stages, data contracts, decisions, the Claude Code layer, tests and the build order. |
| [`.claude/settings.json`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/settings.json) | 1.4 KB | Permissions and the hook wiring. |
| [`.claude/skills/extract-batch/SKILL.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/skills/extract-batch/SKILL.md) | 2.8 KB | The /extract-batch skill: run the extractor subagent on named batches, the synthesizer subagent on named synthesis groups, or the drafter subagent on named artifact drafts, and report their ledger status. |
| [`.claude/skills/observe/SKILL.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/skills/observe/SKILL.md) | 4.9 KB | The /observe skill: run the observation pipeline over the email archive. |
| [`.claude/skills/serve/SKILL.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/skills/serve/SKILL.md) | 1.0 KB | The /serve skill: open the dashboard of the last complete run on 127.0.0.1 without running the pipeline; reuses a server that is already up. |

## The agents

Each pipeline stage that needs judgement is a subagent type with Read and Write as its only tools and a check in code after it. Each file pins its own model and effort, so a run does not depend on the reader's settings. Their configuration, read from each file's frontmatter:

| Agent | Model | Effort | Tools | Max turns | Permission mode |
|---|---|---|---|---:|---|
| [`taxonomist`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/agents/taxonomist.md) | `opus` | `medium` | Read, Write | 6 | `acceptEdits` |
| [`extractor`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/agents/extractor.md) | `sonnet` | `medium` | Read, Write | 16 | `acceptEdits` |
| [`merger`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/agents/merger.md) | `opus` | `medium` | Read, Write | 8 | `acceptEdits` |
| [`synthesizer`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/agents/synthesizer.md) | `opus` | `medium` | Read, Write | 8 | `acceptEdits` |
| [`drafter`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/agents/drafter.md) | `sonnet` | `medium` | Read, Write | 6 | `acceptEdits` |

### taxonomist

Reads the taxonomy digest of the company's archived email and proposes the list of recurring business processes every extractor then tags messages with; writes out/taxonomy-proposed.json.

> You are the taxonomist stage of an email-analysis pipeline. Your task is to read one digest of a company's archived email: subject statistics, a sample of messages and the most frequent senders, gathered by code from every mailbox in the archive. From it you propose the company's recurring business processes as a fixed list of keys. Later, many extractors each read one slice of the mail and tag every message with your keys, so the list must be clear enough to apply message by message and must not overlap. Code checks your file before anything uses it, then counts and prices the work itself. Your part is judgement and exact copying.

### extractor

Classifies every message in one prepared batch file into recurring business processes with verbatim evidence, and writes out/extract/\<batch\_id\>.json.

> You are the extractor stage of an email-analysis pipeline. Your task names one batch of archived company email. You classify every message in it into the recurring business processes it is part of, back every classification with text copied exactly from the message, and write the result as one JSON file. Code downstream checks every quote against the original message, counts the work, and does all the arithmetic. Your part is judgement and exact copying.

### merger

Reads the process keys the extractors proposed (new:\<slug\>), with the counts code made for each, and decides for every one whether its messages count under a taxonomy key, under a new process it promotes, or nowhere; writes out/merge-proposed.json.

> You are the merger stage of an email-analysis pipeline. Earlier, a taxonomist fixed the list of the company's recurring business processes (the taxonomy), and many extractors each tagged one slice of the archived mail with those keys. Where an extractor found no key that fit, it proposed one of its own, `new:<slug>`, with a name and a definition. Each extractor saw only its own slice, so the same work was often proposed under several slugs, and a new key was often proposed where a taxonomy key fit. You decide, for every proposed key, where its messages are counted: under a taxonomy key, under a process you promote, or nowhere. Code checks your file, sizes every process you promote on the messages behind it, and does all the counting and pricing. Your part is judgement.

### synthesizer

For one synthesis group of recurring processes, describes each process from the facts and quotes code prepared and estimates the hands-on work behind one round of it, citing the quotes it relied on; writes out/synthesis/raw/\<group\_id\>.json.

> You are the synthesizer stage of an email-analysis pipeline. Code has already found every recurring process in a company's archived email and counted its trail: how many times each process came round, in which months, who took part, and every email written, forwarded, chased and read. Your task names one synthesis group, whose input holds up to four processes: for each, the facts code counted and a sample of verbatim quotes from its messages. For each process you write what the work is, the steps the mail shows, where it stalls, where the mail contradicts itself, how it could be automated, and one estimate: the hands-on work one round of the process takes, and how much of that work could be automated. Code checks every id you cite and every bound, and multiplies your estimate by the rounds it counted. Your part is judgement, grounded in the quotes.

### drafter

For one recurring process, writes the body of one working document (an SOP, a checklist, an email template or a template) from the brief code prepared, under the headings of its type; writes out/artifacts/raw/\<draft\_id\>.md.

> You are the drafter stage of an email-analysis pipeline. Code has already found a recurring process in a company's archived email, counted it, and had it described. Your task names one draft: a brief holding what is known about that process and the type of document chosen for it. You write that document, the one the people who do this work would pick up tomorrow morning and use. Code checks your file, then adds the title, a line saying the draft is for the process owner to review, and the evidence: email passages about the process, quoted exactly.

## The skills

`/observe` is the one command. `/extract-batch` reruns named jobs by hand for debugging; `/serve` opens the dashboard of the last run without running anything.

| Skill | Allowed tools | Model can invoke it | Effort | What it does |
|---|---|---|---|---|
| [`/extract-batch`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/skills/extract-batch/SKILL.md) | `Bash(node obs.mjs *)` `Agent(extractor)` `Agent(synthesizer)` `Agent(drafter)` | no | the session’s | Run the extractor subagent on named batches, the synthesizer subagent on named synthesis groups, or the drafter subagent on named artifact drafts, and report their ledger status. |
| [`/observe`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/skills/observe/SKILL.md) | `Bash(node obs.mjs *)` `Agent(extractor)` `Agent(taxonomist)` `Agent(merger)` `Agent(synthesizer)` `Agent(drafter)` | no | `medium` | Run the observation pipeline over the email archive. |
| [`/serve`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/skills/serve/SKILL.md) | `Bash(node obs.mjs *)` | no | the session’s | Open the dashboard of the last complete run on 127.0.0.1 without running the pipeline; reuses a server that is already up. |

## The hooks

All hooks run as `node <file>.ts` in exec form, the same on every OS, and live in `settings.json` so they also run under `claude -p`. Outside a run they leave everything but the pipeline's own agents alone, so development work in the same folder is untouched; during a run the Stop hook steers only the session that started it.

| Hook | Fires on | What it does |
|---|---|---|
| [`gate-run.ts`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/hooks/gate-run.ts) | Stop | Stop: keep the orchestrator in the loop while a pipeline run is active, stage by stage (ARCHITECTURE.md 6.7, 7.4). |
| [`gate-subagent.ts`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/hooks/gate-subagent.ts) | SubagentStop (extractor, synthesizer, drafter) | SubagentStop (matcher: extractor\|synthesizer\|drafter): check a finished agent's output and record the result in the ledger. |
| [`guard-corpus.ts`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/hooks/guard-corpus.ts) | PreToolUse (every tool) | PreToolUse (every tool): keep pipeline agents to their own files, and keep every tool call during a pipeline run away from the raw corpus. |
| [`lib.ts`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/hooks/lib.ts) | not wired: shared code | Shared by the hook scripts in this folder. |
| [`log-event.ts`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/hooks/log-event.ts) | SubagentStart (extractor, taxonomist, merger, synthesizer, drafter); SubagentStop (extractor, synthesizer, drafter); SubagentStop (taxonomist, merger) | SubagentStart and SubagentStop (extractor, taxonomist, merger, synthesizer, drafter; the matchers in .claude/settings.json choose which agents): one line per event in the run log, out/runs/\<run\_id\>.jsonl (out/runs/adhoc.jsonl outside a run), so subagent launches and their agent\_ids can be read back next to the guard's bindings and the gate's records. |

## settings.json

The static rules are deliberately few: the run's commands are pre-approved by the `/observe` skill itself, and the corpus guard enforces the rest during a run.

- Allowed without asking: `Bash(node obs.mjs *)`.
- Denied in every mode: `Edit(./corpus/**)`.

| Event | Matcher | Runs | Timeout (s) |
|---|---|---|---:|
| PreToolUse | `*` | `node guard-corpus.ts` | 10 |
| SubagentStart | `extractor\|taxonomist\|merger\|synthesizer\|drafter` | `node log-event.ts` | 10 |
| SubagentStop | `extractor\|synthesizer\|drafter` | `node gate-subagent.ts` | 120 |
| SubagentStop | `extractor\|synthesizer\|drafter` | `node log-event.ts` | 10 |
| SubagentStop | `taxonomist\|merger` | `node log-event.ts` | 10 |
| Stop | every stop | `node gate-run.ts` | 30 |

## The plan and the decision log

Three files under `.claude/` are records rather than configuration: the design, [`.claude/plan/ARCHITECTURE.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/plan/ARCHITECTURE.md); the decision log, [`.claude/notes/DECISIONS.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/notes/DECISIONS.md); and the running log `NOTES.md` was written from, [`.claude/notes/NOTES-LOG.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/notes/NOTES-LOG.md). [Design choices, and why](https://schom975-coder.github.io/observation-agent-assignment/design.md) is a guided path through the first two.
