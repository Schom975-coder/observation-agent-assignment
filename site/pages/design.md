# Design choices, and why

Eight choices shape what the numbers mean. Each is recorded with its alternatives in the decision log, [`.claude/notes/DECISIONS.md`](/.claude/notes/DECISIONS.md), one line per choice, and in the design, [`.claude/plan/ARCHITECTURE.md`](/.claude/plan/ARCHITECTURE.md).

## Pricing: counted rounds times estimated work, plus counted email time {#pricing}

Hours a month for a process are its rounds a month, counted from the mail, times the minutes of hands-on work one round takes, estimated once per process, plus the email time counted from the trail itself, all at the brief's $85 an hour. The first version priced email time alone. Run on real outputs, it priced the email about each task rather than the task, while the brief asks where the company loses time on its recurring work, and most of that work happens off email. So the count stays code and the work per round became the one estimated input, bounded, cited and shown apart.

**Rejected:** email time alone (it measures the wrong thing); one published work time for every process (it treats an expense report like a month-end close); showing the estimate beside the total without adding it in (the headline would answer a question the brief did not ask).

**Read more:** [DECISIONS, Architecture](/.claude/notes/DECISIONS.md#architecture); [ARCHITECTURE 6.2](/.claude/plan/ARCHITECTURE.md#62-hours--counted-occurrences-x-estimated-work-per-occurrence-plus-counted-email-time-decided-by-scott-2026-10-17-supersedes-the-email-only-rule); [`src/metrics/score.ts`](/src/metrics/score.ts); [`config/effort-rates.json`](/config/effort-rates.json).

## What is counted and what is estimated {#counted-vs-estimated}

Counted by code: rounds, the window they fall in, people, and every email action (written, forwarded, chased, read), each priced at published minutes and automatable shares. Estimated by a model: the minutes of work per round and the share of it that could be automated, once per process, from quoted evidence, inside bounds code sets (1 to 480 minutes, at most 80%), from at least three rounds and two senders, cached, and replaceable from a file with no model call. No model output sets a count, a tier, a rank, the threshold or any arithmetic: the synthesizer's schema refuses a number anywhere outside its one estimate field, and the formatter refuses to write a dollar figure without saying whether it is counted, estimated or a total. Every figure on the dashboard and in the report shows its two parts.

**Rejected:** model-estimated hours with no bounds or citations (a planted "eats half my week" email could set the headline); an estimate per round (thousands of model numbers nobody could check); varying the automatable share in the range as well as the minutes (two unknowns from one body of evidence).

**Read more:** [ARCHITECTURE 6.20](/.claude/plan/ARCHITECTURE.md#620-work-estimates-bounded-cited-cached-overridable-decided); [`src/model/synthesis.ts`](/src/model/synthesis.ts); [`src/report/format.ts`](/src/report/format.ts); [`tests/validate-synthesis.test.ts`](/tests/validate-synthesis.test.ts).

## Taxonomy first, then merge, with gates {#taxonomy-and-merge}

One taxonomist call reads a digest code builds from the whole archive (subject words, recurring subjects, a stratified sample of messages, the top senders) and proposes the list of recurring processes every extractor then tags with. So every extractor, each reading one slice of the mail, tags with the same keys. Where no key fits, an extractor proposes a new one, and one merger call folds those proposals into the taxonomy or promotes them before anything is counted. Code accepts each output only after checks: no catch-all keys, no instructions in definitions, example subjects that really exist, every proposed key placed once, and a promoted process big enough on its own messages to be recurring work.

**Rejected:** clustering the mail first and merging free-text labels afterwards (a large, fragile merge nobody can test); a hand-written list (the system would not be doing the identifying the brief asks for); merging after counting (much of the tagged mail would have been counted under keys only one extractor used); promoting on the merger's say-so.

**Read more:** [DECISIONS, Orchestration](/.claude/notes/DECISIONS.md#orchestration-m4); [ARCHITECTURE 6.4](/.claude/plan/ARCHITECTURE.md#64-process-identity-across-batches-decided-taxonomy-first-model-generated-once-from-a-deterministic-digest) and [6.19](/.claude/plan/ARCHITECTURE.md#619-merge-before-counting-decided-one-merger-call-on-a-code-built-input-promotion-sized-by-code); [`src/model/taxonomy.ts`](/src/model/taxonomy.ts); [`src/model/merge.ts`](/src/model/merge.ts).

## The archive is data, never instructions {#email-is-data}

At least one message is a prompt injection aimed at "the reviewing process". Every layer treats mail as data. Message bodies are framed by tags made from each message's own blob hash, so an email cannot fake the end of its body. A scanner flags injection by its wording, never by the Message-ID shape that happens to mark the planted messages, so a trap a reviewer adds with an ordinary ID is judged the same way. Pipeline agents run under allowlists enforced by a hook, bound to their own job's files. The taxonomy and merge gates scan every free-text field, and the draft gate refuses text addressed to an automated reader. The planted message is reported on the dashboard as a flagged finding with its citation, not hidden.

**Rejected:** dropping flagged messages before extraction (it would break "every message" and hide the finding); a deny-list for the corpus guard (review showed an extractor could have written over the guard hook itself).

**Read more:** [DECISIONS, Build](/.claude/notes/DECISIONS.md#build); [ARCHITECTURE 6.3](/.claude/plan/ARCHITECTURE.md#63-untrusted-content-and-trap-vigilance); [`.claude/hooks/guard-corpus.ts`](/.claude/hooks/guard-corpus.ts); [`src/parse/flags.ts`](/src/parse/flags.ts).

## One person, one identity, folded conservatively {#identity}

The archive writes one person under several addresses, and counting each as a separate member of staff inflates the people behind every process. Addresses fold together in `prepare` by display name and by address shape, only onto a unique candidate, and never when the two addresses appear in one message together. When a message names who owns a piece of work, that name is matched against the people who actually took part in the process, never the whole directory, and two claims naming different people within 60 days are shown as a conflict pair, with both quotes.

**Rejected:** edit distance, sound-alike or nickname matching (a guess with no header evidence); a fallback to the whole directory for owner claims (it matched one misspelled first name to four other people). The cost, stated in the notes: some real people stay split across addresses.

**Read more:** [ARCHITECTURE 6.24](/.claude/plan/ARCHITECTURE.md#624-participant-identity-decided-2026-10-18-before-the-m8-run) and [6.25](/.claude/plan/ARCHITECTURE.md#625-owner-claims-resolve-to-participants-decided-2026-10-18-before-the-m8-run); [`src/normalize/identity.ts`](/src/normalize/identity.ts).

## What gets a drafted document {#drafting}

The rule, word for word as the dashboard and the report state it: {{fig:threshold_sentence}} At most eight documents, and at least three. The bar is a rule a reader can check rather than a cut that fits one run, so the number of documents follows the estimates. The type (SOP, checklist, email template or template) is the synthesizer's judgement for that process, made with its evidence in view. Each document is the team's reusable working document for the recurring work, not a one-off email about a thread still open in a 2002 archive: a reusable one pays on every future round, and a one-off would need exact details a drafter is likely to get wrong. Open threads are shown instead as open loops on the dashboard. Code writes the title, the people line and the evidence; the draft gate refuses money, percentages and effort figures, invented quotations and text addressed to a machine.

**Rejected:** a fixed dollar bar chosen before any run; a bar set at the gap between two ranks of one run; a drafter-written owner line (it made whoever appeared in one email the owner).

**Read more:** [ARCHITECTURE 6.12](/.claude/plan/ARCHITECTURE.md#612-artifact-threshold-decided-bar-set-2026-10-18) and [6.23](/.claude/plan/ARCHITECTURE.md#623-the-drafting-gate-m6); [`config/scoring.json`](/config/scoring.json); [`src/model/artifacts.ts`](/src/model/artifacts.ts); [What we drafted, and why](notes.html#what-we-drafted-and-why).

## The dashboard computes nothing {#dashboard}

The build writes every figure ready to show, with its kind and a drill target from a closed list, and the browser only places strings. A walk over the built files proves every target resolves and every count equals the list it opens. Whole dollars are shared out by the largest remainder, so the parts shown always add up to the total shown. The report is rendered from the same model as the dashboard, and model or email text is escaped on every path: in the report's Markdown it is made inert, so a quoted link or tag cannot act.

**Rejected:** formatting in the browser (two formatters to keep in step); free-form links (nothing could prove them); rounding each figure on its own (parts a dollar off their total).

**Read more:** [DECISIONS, Dashboard and report](/.claude/notes/DECISIONS.md#dashboard-and-report-m7); [ARCHITECTURE 6.13](/.claude/plan/ARCHITECTURE.md#613-dashboard-technology); [`src/report/data.ts`](/src/report/data.ts); [`src/report/targets.ts`](/src/report/targets.ts).

## The 30-minute budget {#budget}

The first cold run, before drafting existed, took longer than the brief allows. Its log showed the extractors were not the bottleneck: the orchestrator was, typing every agent's prompt in full, so free slots sat empty while it wrote. Four changes followed, each measured in a timed rehearsal from a fresh clone: job prompts that carry only the job ID and the project folder; one `advance` command per turn that runs every ready step; one balanced wave of synthesizers; and a model and effort pinned in every agent file, with the orchestrator's effort pinned too, so a reviewer's own settings cannot slow the run or change its output. The submitted run took {{fig:wall_minutes}} minutes. The notes tell how the time came down ([What ran in parallel](notes.html#what-ran-in-parallel)), and the rehearsals' logs are kept in [`out/runs/`](/out/runs/) as timing evidence, listed on [the run page](run.html#logs).

**Rejected:** more than 20 subagents in flight (the slots were not full as it was); two batches per extractor job (little gain once prompts were short); a lighter extractor effort (held in reserve behind a check of tagging accuracy).

**Read more:** [DECISIONS, Architecture](/.claude/notes/DECISIONS.md#architecture); [ARCHITECTURE 6.6](/.claude/plan/ARCHITECTURE.md#66-parallelism-and-the-30-minute-budget); [`src/run/commands.ts`](/src/run/commands.ts); [What ran in parallel](notes.html#what-ran-in-parallel).
