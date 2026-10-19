# Architecture

One TypeScript pipeline with no runtime dependency, run from inside Claude Code by one skill. Code does everything that has to be exact; subagents do the judgement; code checks every model output before anything uses it. The full design, with every contract and decision, is [`.claude/plan/ARCHITECTURE.md`](/.claude/plan/ARCHITECTURE.md).

## From the archive to the dashboard {#diagram-pipeline}

{{diagram:pipeline}}

- The orchestrator above every stage: the `/observe` skill, which runs one command per turn, `node obs.mjs advance`. Each call runs every code step that is ready and names the subagents to start next.
- The corpus, kept in Git objects on Windows and on disk on macOS and Linux, is opened only by the corpus reader, which returns the same bytes from either.
- prepare (code): ingest, parse, de-duplicate, thread and batch every message.
- taxonomist (model, one call): proposes the list of recurring processes; code accepts it or sends back the problems.
- extractors (model, 99 batch jobs, 20 in flight): tag every message with process keys and verbatim quotes. The gate checks that every message is classified and every quote is in the raw bytes.
- merger (model, one call): places every process key the extractors proposed. The gate checks each key is placed once and sizes every promoted process on the messages behind it.
- rollup (code): counts rounds, people, email actions, reply gaps and stalls on the merged membership.
- synthesizers (model, groups of up to 4 processes, one wave): describe each process and estimate its hands-on minutes per round. The gate checks the estimate's bounds and citations.
- score (code): counted email time at the published rates, plus counted rounds times the checked estimate, at $85 an hour; then tiers, ranks and the drafting threshold.
- drafters (model, up to 8): one working document per opportunity above the threshold. The draft gate checks headings, quotes and figures.
- build (code): the dashboard data and the report, every figure pre-formatted with its drill target.
- serve (code): the dashboard on 127.0.0.1, each message read through the corpus reader.
- Key: code steps are plain boxes, model steps tinted boxes, gates amber pills.

{{/diagram}}

### The stages {#stages}

Every stage is a command of [`obs.mjs`](/obs.mjs); during a run `advance` calls them in order. Condensed from [section 4 of the design](/.claude/plan/ARCHITECTURE.md#4-pipeline-stages).

| Stage | Done by | Input | Output | Cache key |
|---|---|---|---|---|
| [prepare](/src/pipeline/prepare.ts) | code | the corpus, through the [reader](/src/corpus/reader.ts) | the manifest, parsed messages, duplicates, threads, people, batch files | skipped when the corpus listing, the code and every output are unchanged |
| [taxonomy](/src/run/taxonomy.ts) | model, then the accept step | the taxonomy digest built by code | `out/taxonomy.json` | the digest and the taxonomist's definition |
| extract | model, then the [gate](/src/model/validate-extraction.ts) | one batch file and the taxonomy | `out/extract/`, `out/validated/` | the batch, the taxonomy and the extractor's definition |
| [merge](/src/run/merge.ts) | model, then the [accept step](/src/model/merge.ts) | the merge input built by code | `out/merge.json` | the extractions, the taxonomy and the merger's definition |
| [rollup](/src/metrics/rollup.ts) | code | validated extractions, the merge, threads, people | `out/rollup.json`, the synthesis inputs | reruns in seconds |
| synthesize | model, then the [gate](/src/model/synthesis.ts) | one group input | `out/synthesis/validated/` | the group input and the synthesizer's definition |
| [score](/src/metrics/score.ts) | code | rollup, syntheses, [`config/`](/config/) | `out/opportunities.json` | reruns |
| [artifacts prepare](/src/run/artifacts.ts) | code | opportunities, rollup, syntheses | one brief per document | reruns |
| draft | model, then the [draft gate](/src/model/artifacts.ts) | one brief | `out/artifacts/raw/`, `validated/` | the brief and the drafter's definition |
| artifacts collect | code | checked drafts and their briefs | `out/artifacts/<process>/<type>.md` | reruns |
| [build](/src/report/build.ts) | code | everything above | `out/dashboard/`, the report, `out/run-summary.json` | the hashes of its inputs, recorded in `data.json` |
| [serve](/src/serve/server.ts) | code | `out/dashboard/`, the corpus reader | the dashboard on 127.0.0.1 | nothing cached |

The ledger that records every job, its cache key and its state is [`src/run/ledger.ts`](/src/run/ledger.ts): one file per job, so a rerun on an unchanged corpus repeats nothing and a crash or a usage-limit pause resumes where it stopped.

### The two places a model touches a number {#model-edges}

1. **Membership.** Which messages belong to which process is judgement: the extractors tag each message, and the merger decides where each proposed key's messages count. Code then counts everything from that membership: rounds, people, email actions, windows. It checks first: every tag needs its own verbatim quote that passes validation, every proposed key is placed exactly once, and a promoted process must reach a minimum size on its own messages (`promote_min` in [`config/scoring.json`](/config/scoring.json)) or it is demoted and left unpriced.
2. **The work estimate.** For each process the synthesizer proposes the minutes of hands-on work one round takes (low, mid and high) and the share of that work that could be automated, citing the quotes it relied on. Code accepts it only inside fixed bounds (1 to 480 minutes, at most 80% automatable) and with evidence from at least three rounds and two senders, so one person's claim can never set a value. The mid value multiplies the counted rounds and nothing else; low and high give the range shown beside it; a file, `config/estimates.json`, can replace any estimate without a model call.

The extractors also label a quote as a stall (a chase, a wait, rework) or as someone named as owner; code counts those labels and checks their quotes and names, and they feed no dollar figure, tier or rank. Everything else that produces a number is code: counts, windows, rates, tiers, ranks, the threshold, the arithmetic at $85 an hour and the rounding. See [`src/metrics/score.ts`](/src/metrics/score.ts) and [Counted and estimated](design.html#counted-vs-estimated).

## Inside Claude Code {#diagram-claude-code}

{{diagram:claude-code}}

- The `/observe` skill is the orchestrator. It runs `node obs.mjs run start`, then `node obs.mjs prepare`, then `node obs.mjs advance --json`. Each `advance` returns the Agent calls to make; the orchestrator makes them in the background, and on each completion calls `advance` again with the finished job IDs. When `advance` says the run is done, the skill runs `node obs.mjs serve --background --open`.
- Five agent types do the model work: taxonomist, extractor, merger, synthesizer and drafter. Each file sets the agent's model, effort, tools and turn cap; [The Claude Code layer](claude-dir.html#agents) lists them as read from the files.
- Three hooks enforce the run. The PreToolUse hook on every tool keeps each pipeline agent to its own files and keeps every tool call during a run away from the corpus. The SubagentStop hook checks a finished job's output and records it done or failed. The Stop hook blocks the orchestrator from stopping while work remains, naming the next command.
- The ledger holds one state file per job (`out/ledger/<job>.json`); the run log (`out/runs/<run>.jsonl`) records every subagent start and stop, every gate verdict and every stage step.

{{/diagram}}

The orchestrator never reads email: `advance` hands it job IDs, and each job's prompt is two lines, the job ID and the project folder. Each agent derives its own file paths from those, reads only its own job's files, and writes one output. The hooks are where that is enforced, in every permission mode: an agent bound to batch 17 cannot read batch 18, and nothing in the run can open `corpus/` except the reader. The ledger, not the model's reply, decides whether a job is done; a job that fails its check comes back as a fix round, with the problems in a file only that job's agent may read. The skill and the agents are in [`.claude/`](/.claude/), and [The Claude Code layer](claude-dir.html) lists every file.

## Every number lands on a message {#diagram-drill}

{{diagram:drill}}

- A figure on the dashboard, for example a process's automatable dollars a month.
- Its formula: a counted part and an estimated part, added.
- The counted part: email actions counted from the trail, times published minutes. Each count opens the list of messages it was counted from.
- The estimated part: rounds counted from the trail, times the synthesizer's bounded estimate. The estimate opens the quotes it cites.
- The message viewer: one message fetched by its ID, from the local server (`/api/message?id=`) or, in the copy on this site, from that message's file written beside the page when the site was built; shown exactly as the file holds it, with the quote marked at its stored offsets.
- The corpus reader: the raw bytes, from disk on macOS and Linux or from Git objects on Windows.
- Your own check: `git show HEAD:"<id>"` prints the same bytes from the repository.

{{/diagram}}

The build ([`src/report/build.ts`](/src/report/build.ts)) writes every figure pre-formatted: its value, its text, its exact text, whether it is counted, estimated or a total, and a drill target from a closed list of kinds. The browser places those strings and computes nothing. Before anything ships, a walk over the built files ([`src/report/targets.ts`](/src/report/targets.ts)) checks that every figure's target resolves and that every count equals the length of the list it opens, so a number cannot claim more messages than it shows. The server ([`src/serve/server.ts`](/src/serve/server.ts)) reads each message through the one corpus reader, for any ID in the manifest and nothing else. The [copy on this site](dashboard/index.html) calls no server: when the site was built, every message of the manifest was read once through the same reader and written as a file beside the page, and its viewer reads that file ([`site/dashboard.ts`](/site/dashboard.ts)).

## Same result on every OS {#cross-os}

- Every corpus file name ends in a dot, which Windows cannot create. A Windows clone therefore keeps the corpus in Git objects ([the clone recipe](how-to-run.html#windows)), and the reader reads them with `git cat-file --batch`; on macOS and Linux it reads the files from disk ([`src/corpus/reader.ts`](/src/corpus/reader.ts)).
- Both sources must give the same bytes. [`tests/corpus.test.ts`](/tests/corpus.test.ts) hashes every message to its Git blob ID and, where the files are on disk, compares disk and Git byte for byte.
- Text is decoded as UTF-8 explicitly; quote checks treat CRLF and LF alike on both sides; dates go through a strict parser and are stored in UTC; file names made from model output go through one slug function.
- CI runs the type check and every model-free test on Ubuntu, macOS and Windows, and on the oldest supported Node, then rebuilds the deterministic stages and re-checks every committed model output ([`.github/workflows/ci.yml`](/.github/workflows/ci.yml)). This site's generator runs there too.
