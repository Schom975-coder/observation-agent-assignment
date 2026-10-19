---
name: serve
description: Open the dashboard of the last complete run on 127.0.0.1 without running the pipeline; reuses a server that is already up.
argument-hint: "[--stop | --status]"
disable-model-invocation: true
allowed-tools: Bash(node obs.mjs *)
---

Open the dashboard. Run one command as its own Bash call, exactly as written, with nothing before it:

- If `$ARGUMENTS` is `--stop` or `--status`, run `node obs.mjs serve $ARGUMENTS` (`--stop` ends the server, `--status` prints its address).
- Otherwise run `node obs.mjs serve --background --open $ARGUMENTS`.

Print the command's output line as it stands and stop. If the command fails, print its one-line error and stop. Do not read any file and do not run anything else.

`serve --background` returns at once: it starts the dashboard server in the background (or reuses the one already running for this folder) and prints `Dashboard: http://127.0.0.1:<port>/`. `--open` also tries to open that address in the default browser; the printed address works either way.
