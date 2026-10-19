This is the repository's README, rendered.

# Observation agent

A system that reads a company's 3,240-message email archive inside Claude Code, finds its recurring work, and prices the automation opportunities at $85 an hour, with every claim cited to a message. It drafts working documents for the biggest opportunities and serves a dashboard on localhost.

[Project site](https://schom975-coder.github.io/observation-agent-assignment/) · [NOTES.md](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/NOTES.md) (the two-page notes the brief asks for) · [BRIEF.md](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/BRIEF.md) (the assignment) · [llms.txt](https://schom975-coder.github.io/observation-agent-assignment/llms.txt). The site is the one-stop reading copy; this repo is the thing itself.

## What this is

One command, `/observe`, runs the whole pipeline inside Claude Code. In order: prepare (read, parse, de-duplicate, thread and batch every message), taxonomy (one subagent proposes the recurring processes), extraction (many subagents in parallel tag every message with a process and a verbatim quote), merge, rollup (count rounds, people, email actions and stalls), synthesis (subagents describe each process and estimate its work), scoring, drafting (subagents write the documents), build (the dashboard data and the report) and serve. The model decides which messages belong to which process, and estimates the hands-on work per round from cited evidence, within bounds that code sets. Everything else is TypeScript: parsing, de-duplication, counting, the hours and dollars arithmetic, citation validation and the server.

## See the results without running anything

The outputs of the submitted run are committed in [`out/`](https://github.com/Schom975-coder/observation-agent-assignment/tree/main/out):

- [`out/report.html`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/out/report.html) and [`out/report.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/out/report.md): the report. `report.html` is self-contained and opens with a double-click.
- [`out/artifacts/`](https://github.com/Schom975-coder/observation-agent-assignment/tree/main/out/artifacts): the drafted documents.
- [`out/runs/`](https://github.com/Schom975-coder/observation-agent-assignment/tree/main/out/runs): the run logs.
- [`out/dashboard/`](https://github.com/Schom975-coder/observation-agent-assignment/tree/main/out/dashboard): the dashboard data.

`node obs.mjs serve` opens the dashboard on these files with no model call; `/serve` inside Claude Code does the same. The report has the same numbers as the dashboard. A copy of the report is on the site: [report.html](https://schom975-coder.github.io/observation-agent-assignment/report.html). The site also carries a copy of the dashboard with every message pre-written, so you can click from any number to its message there with nothing installed: https://schom975-coder.github.io/observation-agent-assignment/dashboard/. The dashboard served below, on localhost, is the one the brief asks for.

## Prerequisites

- Node.js 22.18 or newer. It runs the TypeScript sources directly, so there is no build step. Claude Code's installer does not install Node; get it from [nodejs.org](https://nodejs.org).
- Git.
- Claude Code, signed in on a subscription whose plan includes Opus and Sonnet: the agent definitions pin Opus for the taxonomist, merger and synthesizer and Sonnet for the extractors and drafters (each file in [`.claude/agents/`](https://github.com/Schom975-coder/observation-agent-assignment/tree/main/.claude/agents) names its model and effort). No API key and no API spend. The pipeline fetches nothing from the network; every model call goes through your Claude Code session.

`npm install` installs only the TypeScript compiler and Node's type definitions, for `npm run typecheck`. The pipeline, the server and the tests use nothing from `node_modules`.

## Get the code

### macOS and Linux

A plain `git clone` works. The corpus files' names end in a dot (`corpus/farmer-d/logistics/1.`) and check out as they are.

```sh
git clone https://github.com/Schom975-coder/observation-agent-assignment.git obs
cd obs
npm install
```

### Windows

A plain `git clone` checks out nothing on Windows, not even the code, because Windows cannot create file names that end in a dot. Use this instead (PowerShell):

```powershell
git clone --no-checkout https://github.com/Schom975-coder/observation-agent-assignment.git obs
cd obs
git config core.protectNTFS false
git sparse-checkout set --no-cone '/*' '!/corpus/'
git checkout main
```

In Git Bash, prefix the sparse-checkout line with `MSYS_NO_PATHCONV=1`; otherwise Git Bash rewrites `/corpus/` into `C:/Program Files/Git/corpus/` and the exclusion silently fails:

```sh
MSYS_NO_PATHCONV=1 git sparse-checkout set --no-cone '/*' '!/corpus/'
```

The corpus then stays in Git's objects, off disk. The code reads every message from there (`git cat-file --batch`) and gets the same bytes macOS and Linux read from disk; a test checks that the two agree. Nothing is lost. Then run `npm install`, as on macOS and Linux.

## Run it

Start Claude Code in the folder:

```sh
claude
```

At the Claude Code prompt, type the one command:

```text
/observe
```

When the run is done, it prints the stages it ran, starts the dashboard in the background and prints its address (`Dashboard: http://127.0.0.1:<port>/`), tries to open that address in your browser, and prints the run's status. The dashboard keeps running after you leave Claude Code; `node obs.mjs serve --stop` stops it. If a run stops part way (a crash, a closed window, a usage-limit pause), running `/observe` again resumes it from the run ledger.

### Warm and cold runs

The model outputs and the run ledger are committed, so the first run on a fresh clone is warm. It repeats no finished work and starts no subagent: it rebuilds the deterministic stages and ends with the dashboard.

To run cold, with every subagent again:

```text
/observe --force
```

`--force` clears the model outputs first. Every cold rehearsal since the drafting stage was added completed in under 30 minutes on our Windows machine, and so did the submitted run: 28 min 59 s, with 130 subagents started. A cold run asks the model again, so its process list, its merge and its work estimates can differ from the committed ones, and the dollar figures move with them. Counting and arithmetic are code and do not vary: the same model outputs give the same numbers on every rerun and every OS. If a cold run replaces the committed outputs, Git still holds the submitted run.

### Folder trust and permissions

The first time Claude Code opens a folder, it asks whether you trust it. Until the folder is trusted, Claude Code ignores the `permissions.allow` entry in the project's [`.claude/settings.json`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/settings.json). The run does not depend on it: the `/observe` skill's `allowed-tools` pre-approve its commands and its subagents while the skill runs, and the hooks apply either way. We checked this in a fresh, untrusted clone: the hooks all worked, and only that entry was ignored.

The hooks are in [`.claude/hooks/`](https://github.com/Schom975-coder/observation-agent-assignment/tree/main/.claude/hooks), wired up in `settings.json`:

- The corpus guard (`guard-corpus.ts`, before every tool call) keeps each pipeline subagent to its own job's files and, during a run, refuses any tool call that names `corpus/` and any subagent that is not one of the five pipeline agents.
- The gate (`gate-subagent.ts`, when an extractor, synthesizer or drafter finishes) checks the output it wrote (schema, coverage, quotes against the raw messages, estimate rules, draft rules) and records the job as done, or as failed with a list of problems that goes back to a subagent as a fix round.
- The Stop hook (`gate-run.ts`) keeps the orchestrator going: when it would end its turn with a step ready to run, the hook hands it the next command.
- `log-event.ts` writes each subagent's start and stop to the run log in `out/runs/`.

### Unattended

The rehearsals ran headless, with stdin closed and the permission prompts off. From a macOS or Linux shell:

```sh
claude -p "/observe" --permission-mode auto --permission-prompts none < /dev/null
```

For a cold run, pass `"/observe --force"` instead. On Windows, run it from Git Bash, the shell we tested there, with the prefix `MSYS_NO_PATHCONV=1`; without it, Git Bash rewrites `/observe` into a path under Program Files and the skill never runs:

```sh
MSYS_NO_PATHCONV=1 claude -p "/observe" --permission-mode auto --permission-prompts none < /dev/null
```

For a log of the orchestrator's turns, add `--output-format stream-json --verbose > ../observe-stream.jsonl`. Keep that file outside the repo: it carries the folder's absolute path. After a crash or a usage-limit pause, run the same command again; the run resumes from the ledger.

## Open the dashboard

```sh
node obs.mjs serve                        # foreground; Ctrl+C stops it
node obs.mjs serve --background --open    # returns at once, leaves it running, opens the browser
node obs.mjs serve --status               # prints the address of the running server
node obs.mjs serve --stop                 # stops the background server
```

`--port N` picks the port. `--background` reuses a server already running for this folder. The server binds 127.0.0.1 only. Inside Claude Code, `/serve` does the same as `--background --open`.

What you can do there:

- Click any number to see its formula and the messages behind it. Every figure shows which parts are counted and which are estimated.
- The message viewer shows the raw message with the cited quote marked, and a copy button with the ready `git show HEAD:"<id>"` command, so you can check the quote against the raw file yourself.
- The lookup box opens any message by its ID, which is its Git path with the trailing dot included (`corpus/farmer-d/logistics/1.`).

## Tests

```sh
npm test
npm run typecheck
```

No model is ever invoked: the tests stand in for the model stages with scripted fixtures. CI ([`.github/workflows/ci.yml`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.github/workflows/ci.yml)) runs both on Ubuntu, macOS and Windows (Windows with the clone recipe above), then rebuilds the deterministic stages and re-checks every committed model output against the corpus. You can run those two steps yourself:

```sh
node obs.mjs prepare --force
node obs.mjs verify
```

We developed on Windows. macOS and Linux behaviour is proven by CI, not by a Mac at hand.

## Where things are

| Path | What it holds |
|---|---|
| [`src/`](https://github.com/Schom975-coder/observation-agent-assignment/tree/main/src) | The pipeline, by stage: `corpus/` (the one corpus reader), `parse/`, `normalize/`, `batch/`, `model/` (the model stages' inputs and checks), `validate/` (quotes), `metrics/` (rollup and score), `report/` (build), `serve/`, and `run/` (the ledger and the commands behind [`obs.mjs`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/obs.mjs)) |
| [`config/`](https://github.com/Schom975-coder/observation-agent-assignment/tree/main/config) | Rates, scoring rules, gold labels |
| [`dashboard/`](https://github.com/Schom975-coder/observation-agent-assignment/tree/main/dashboard) | The dashboard's page sources |
| [`.claude/`](https://github.com/Schom975-coder/observation-agent-assignment/tree/main/.claude) | The Claude Code layer, submitted exactly as used: the skills, the five agent definitions, the hooks, `settings.json` |
| [`out/`](https://github.com/Schom975-coder/observation-agent-assignment/tree/main/out) | The submitted run |
| [`tests/`](https://github.com/Schom975-coder/observation-agent-assignment/tree/main/tests) | The model-free tests and their fixtures |
| [`site/`](https://github.com/Schom975-coder/observation-agent-assignment/tree/main/site) | The generator of the Pages site |
| [`NOTES.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/NOTES.md) | The notes the brief asks for |
| [`BRIEF.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/BRIEF.md) | The assignment, verbatim |
| [`.claude/plan/ARCHITECTURE.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/plan/ARCHITECTURE.md), [`.claude/notes/DECISIONS.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/.claude/notes/DECISIONS.md) | The design and the decision log |

## Reading this with an AI assistant

Reading this with an AI assistant? The project site is set up for Claude to read in full. Give it the site's address and ask it anything about the project.

- Site: https://schom975-coder.github.io/observation-agent-assignment/
- `llms.txt`: https://schom975-coder.github.io/observation-agent-assignment/llms.txt
- [`out/report.md`](https://github.com/Schom975-coder/observation-agent-assignment/blob/main/out/report.md) is the report in Markdown, for readers without a browser.
