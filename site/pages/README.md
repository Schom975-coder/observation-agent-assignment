# The site's pages

The Markdown sources of the project site's own pages. `node site/build.ts` renders each to HTML and keeps the source, filled in, as the page's Markdown twin. The page list, titles, descriptions and the ids each page must define are in `site/site.json`; README.md, NOTES.md and BRIEF.md are rendered from the repository root and are not here. This file is documentation, not a page.

## Links

- `run.html#facts`: a page of this site, with an anchor. `--strict` refuses an anchor no page defines.
- `/src/metrics/score.ts`: a file in the repository, written from its root with a leading slash; it becomes a GitHub link. `--strict` refuses a path that does not exist, and an anchor into a `.md` file that has no such heading.
- `commit:63ffa97`: a commit; `tests/site.test.ts` checks every one exists.
- `https://...`: as written.

## Tokens

Each token is replaced at build time from the run output (`--out`, default `out/`). Where the value is missing, the page shows a marker of the form `[to fill: ...]` and `--strict` refuses the build.

Figures, inline, written as `{{fig:` + name + `}}`:

| Name | Value | From |
|---|---|---|
| `messages_read` | every message read (the coverage buckets added) | `run-summary.json` |
| `unique`, `duplicates`, `counted_messages` | unique messages, duplicates, messages counted in a process | `run-summary.json` |
| `headline` | the automatable dollars a month, tiers A and B | `run-summary.json` |
| `headline_counted`, `headline_estimated` | its counted and estimated parts, in whole dollars that add up to it | `run-summary.json` |
| `headline_low`, `headline_high` | the estimates' range | `run-summary.json` |
| `hours` | the automatable hours a month | `run-summary.json` |
| `documents` | documents drafted | `run-summary.json` |
| `wall_minutes` | the run's minutes, to one decimal | `run-summary.json` |
| `agents`, `fix_rounds` | subagents started, fix rounds | `run-summary.json` |
| `quotes_exact`, `quotes_repaired`, `quotes_rejected` | quote checks | `run-summary.json` |
| `loops_recent`, `loops_all` | open loops in the last 90 days of their mailbox, and all | `run-summary.json` |
| `run_id`, `run_date` | the run's id, and its date read from the id | `run-summary.json` |
| `processes`, `processes_in_total` | processes found, and those in the total | `dashboard/data.json` |
| `scope` | the label beside every total | `dashboard/data.json` |
| `threshold_sentence` | the drafting rule, as the dashboard states it | `dashboard/data.json` |
| `gold_exact` | tagging accuracy, exact | `gold-score.json` |

Money is written by the dashboard's own formatter (`src/report/format.ts`), so the site shows the same text as the dashboard and the report.

Blocks, alone on a line, written as `{{block:` + name + `}}`: `figures` (the index's figures strip), `pages` (the other pages with their descriptions), `run_facts`, `timeline` (the stage timeline, from `src/run/summary.ts`), `logs`, `documents`, `dashboard_copy` (what the static dashboard copy holds), `claude_files`, `agents`, `skills`, `hooks`, `settings`.

Diagrams: a line `{{diagram:` + name + `}}` inlines `site/diagrams/<name>.svg`; the nested list that follows, up to a line `{{/diagram}}`, is the diagram in words, shown under it on the page and in its place in the twin.

Screenshots: a line `{{shot:` + name + `}}` places `site/assets/screenshots/<name>.png` with the alt text listed in `site/assets/screenshots/README.md`.

## Writing

The reader is the grader. Short, specific sentences; every claim true of the repository and linked to the file that shows it; no figure typed by hand; no model named in prose; no em or en dashes and no exclamation marks.
