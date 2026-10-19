# Dashboard screenshots

Added after the submitted run, from that run's dashboard (`node obs.mjs serve --background`): Chromium at 1280 px wide, light theme, PNG. `node site/build.ts` places each file present on the How to use page (and the overview on the index), with the alt text below; `--strict` refuses the build while any is missing. The alt text names what is on the screen, never a figure.

| File | Alt text | What to capture |
|---|---|---|
| `overview.png` | The dashboard's first screen: the automatable value a month with its counted and estimated parts, the three biggest findings, and the step chart of every process with the running total and the drafting line. | The Overview at the top of the page. |
| `process.png` | A process page: how often it was seen and by whom, where it stalls with quotes, its open loops and its drafted document. | The top-ranked process, opened from its name in the ranked table. |
| `formula.png` | A figure's formula: the counted email actions at published minutes beside the estimated work per round, each part opening its messages. | A process's dollars, opened from the ranked table. |
| `viewer.png` | The message viewer: one email as the file holds it, the quoted span marked, with the buttons that copy the message ID and the git show command. | Any quote opened from a finding. |
| `open-loops.png` | The open loops view: threads whose last message is a chase or a wait for an answer, in the last 90 days of their mailbox. | The Open loops view. |
| `methodology.png` | How we measured: the published rates, the tiers, the drafting threshold and the counted and estimated parts of every figure. | The How we measured view, scrolled to its top. |
