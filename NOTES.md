# Notes

Figures are from the submitted run; the site expands each section: https://schom975-coder.github.io/observation-agent-assignment/.

## How we drove Claude Code

I ran Claude Code like a small team. One main session led each milestone: an architect agent planned it in a fresh context, I approved the design, implementer agents built it in parallel on separate files from written briefs, and a separate reviewer read every change before the lead tested it. Work stayed on feature branches until I reviewed and pushed it.

- **First,** a throwaway experiment proved what the design rests on: background agents wake the lead when they finish, hooks can block, all of it headless. Windows cannot check out the repo, since every email file name ends in a dot, so code reads mail from Git's storage, byte for byte what Mac and Linux read.
- **M0 to M2, all code:** reading, a strict date parser (JavaScript turns 31 April into 1 May), de-duplication, threads, batches.
- **M3 to M5:** a go/no-go on two batches, the full loop over 99, then counting, estimates and dollars. First timed cold run: 32 min 34 s.
- **M6 to M8:** drafted documents behind a checker; the dashboard, designed and signed off before it was built; the submitted run.

At run time `/observe` loops on `node obs.mjs advance`, which runs every step ready in code and hands back job IDs; hooks limit what each agent touches and check its result. A ledger keyed on content hashes repeats nothing: the warm rerun took 19 s with no agents.

## What we handed to subagents, and why

Judgement, never arithmetic. Five agents, each reading its input, writing one file and checked by code: one proposes the processes, 99 extractors tag every email with a process and a verbatim quote, one merges the names they invent, 20 describe processes and estimate minutes per round, one per document drafts. Every count and dollar is code.

## How we budgeted their context

Read returns at most 25,000 tokens, so a batch stops at 64 KB and about 22,000 tokens; a description agent gets at most four processes. The lead never sees an email, only IDs and short JSON.

## What ran in parallel

Up to 20 extractors, then every description in one wave, then every draft. Getting under 30 minutes was not about faster agents. The first cold run's logs showed the lead spending 3.5 seconds typing each agent's 700-character prompt, and an agent only starts once its prompt is written, so half the slots sat empty. We cut prompts to a job ID, let one command run every ready step and cut the merge from 12 minutes to 5. Rehearsals then took 25 to 30 minutes; the submitted run 28 min 59 s, with 130 agents.

## Where Claude Code got it wrong, and how we caught it

None of these reached the output:

- The hook that bounces a bad result could not reach an agent that had already handed back. Testing that undocumented case found it; retries now go out from the ledger.
- Review showed an extractor could overwrite the first guard itself; the guard now lists what each agent may touch.
- Implementers' tests passed while 77 of 974 forwards were misread and de-duplication chained daily reports together. A second reviewer caught both.
- Drafts turned one email into a standing rule and its sender into the owner; code now writes who does what.

In the submitted run 2,684 quotes matched exactly, 13 needed a small repair, none were rejected.

## What we would build next with another week

**Features a president would act on**

- **Company-wide numbers:** headcount by role turns four people's minutes into a company figure.
- **Owners and proven savings:** assign each opportunity, freeze today's figure, count again after the fix ships.
- **Trends and nudges:** growing work, worsening stalls, and a weekly list to each owner of threads waiting on them.
- **Key-person risk:** three of the five documented processes live almost entirely in one mailbox.
- **An expert in the loop:** an operations lead corrects labels on the dashboard, feeding the next run. We are not energy experts; this closes that gap.

**Architecture**

- **A container** with Node, Git and the Claude Code CLI: the same run on every OS, no Windows recipe.
- **A hosted, shared app** with single sign-on: one live dashboard for leadership, with comments and owners.
- **Postgres** for jobs, history across runs and a tenant per client; raw mail in encrypted object storage.
- **A job queue** (Redis) and workers instead of one lead session, so runs scale and survive restarts; Redis also caches the dashboard's busiest reads.
- **Live mail** from Exchange or Gmail, nightly and incremental, which the content-hash ledger already supports.

## Where the system is most likely wrong

By dollar impact:

1. **The work estimates.** The $2,231 a month has two parts, and the dashboard shows both on every figure.
   - **Counted, $526:** the email itself. Code counts every email written, forwarded, chased and read in each process and prices each action at a published rate (2 minutes for a short email, 1 minute per person who reads it) with a published share that could be automated.
   - **Estimated, $1,705:** the hands-on work behind each round that the email does not show, such as entering a deal or correcting a schedule. For each process the model proposes the minutes one round takes and the share that could be automated, citing the emails it relied on. Code rejects an estimate over 480 minutes or 80%, or one not cited from at least 3 rounds and 2 senders, then multiplies it by the rounds it counted.

   The estimate is judgement, so this is where the total is most likely off: with every estimate at the low or high end of its own range, it runs from $1,243 to $4,989. Any estimate can be overridden from a file without calling a model.
2. **The merge**, which places 26% of tagged mail.
3. **Rounds**, rebuilt from subjects and gaps; these emails carry no reply headers.
4. **Tagging:** 80.8% exact (84.6% after the merge) on 52 emails labelled blind by a separate agent.

## What it took on faith

- That email shows the work; calls and screen time leave no trace, so totals are floors.
- The brief's $85 an hour and our minutes per email action.
- The domain. I don't know energy trading. I approved the process list and the labeller's 8 least certain calls; code checked citations, not whether a gas scheduler would agree.
- That four mailboxes are representative.

Checked, not trusted: the brief's "thirty context windows" measured six to eight; the planted emails are caught by content, not by their IDs, so a reviewer's own traps get the same test.

## What we drafted, and why

A team should be able to use something the next morning. The rule, on the dashboard: a document for every process seen 10+ times over 3+ months by 2+ staff with $85 a month or more of automatable work, 3 to 8 in all; this run drafted 5. The model picks the type (SOP, checklist, email template, template); a checker refuses dollar figures, effort claims and text aimed at a machine; code appends the source emails.

## More detail

Two pages leave a lot out. The running log we kept while building, [`.claude/notes/NOTES-LOG.md`](.claude/notes/NOTES-LOG.md), has the fuller account behind each section with its evidence, and [`.claude/notes/DECISIONS.md`](.claude/notes/DECISIONS.md) records every decision made along the way with the alternatives we rejected and why.
