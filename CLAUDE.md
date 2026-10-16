# Observation agent: project rules

The assignment brief is `README.md`. The reviewer may run this on Windows, macOS or Linux, so everything below exists to make the system behave identically on all three.

## Corpus
- All 3,240 files under `corpus/` end in a trailing dot (maildir names like `1.`). Windows cannot create those names.
- Never rename, move, re-encode or rewrite anything under `corpus/`. `.gitattributes` marks it `-text` so Git never converts its line endings.
- A message's identity is its exact Git path, e.g. `corpus/farmer-d/logistics/1.`, trailing dot included, `/` separators on every OS. Citations, IDs and the dashboard all use that string.

## Reading messages
- All code gets message bytes through the one corpus reader. It reads from disk when the files exist (macOS, Linux) and from Git objects via `git cat-file --batch` when they don't (Windows). Both sources must return identical bytes; a test enforces it.
- Nothing else opens `corpus/...` paths directly: not the pipeline, not the dashboard, not subagents. Subagents read prepared batch files with Windows-safe names.
- `corpus-view/` is a git-ignored, read-only copy for browsing on Windows (`1.` becomes `1.eml`). Code never reads from it and nothing cites it.

## Same output on every OS
- Read bytes and decode as UTF-8 explicitly (all 3,240 messages decode cleanly). Never rely on the platform default encoding (cp1252 on Windows).
- Quote validation normalizes CRLF to LF on both sides the same way before matching. 3,231 of the 3,240 messages use CRLF.
- Dates are stored in UTC. Iterate in message-ID order, never directory-listing order.
- File names built from model output (SOP titles and the like) go through one slug function: no `\ / : * ? " < > |`, no trailing dot or space, no Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`).
- Hooks and scripts run on all three OSes: no bash-only tooling, no assumption about `python` vs `python3`.
- The dashboard server binds `127.0.0.1`.
- CI runs the model-free tests on Ubuntu, macOS and Windows. The Windows job uses the clone recipe below.

## Cloning on Windows
A plain `git clone` fails on Windows and checks out nothing, not even the code. Use this instead (PowerShell):

```
git clone --no-checkout <repo-url> obs
cd obs
git config core.protectNTFS false
git sparse-checkout set --no-cone '/*' '!/corpus/'
git checkout main
```

In Git Bash, prefix the sparse-checkout line with `MSYS_NO_PATHCONV=1`; otherwise Git Bash rewrites `/corpus/` into `C:/Program Files/Git/corpus/` and the exclusion silently fails. The final README must include this recipe.
