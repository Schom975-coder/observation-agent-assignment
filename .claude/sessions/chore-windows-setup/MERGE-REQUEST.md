# Merge request: chore/windows-setup -> main

## What changed
- `CLAUDE.md`: project rules for handling the corpus identically on Windows, macOS and Linux, plus the tested Windows clone recipe.
- `.gitattributes`: `corpus/** -text`, so Git never converts corpus line endings.
- `.gitignore`: ignores `corpus-view/`, the local read-only `.eml` copy of the corpus.
- `.claude/sessions/chore-windows-setup/`: this file and DECISIONS.md.

No corpus file is added, removed or modified. The corpus stays in the tree exactly as upstream has it.

## Decisions
See `DECISIONS.md` in this directory: corpus kept in Git objects on Windows via sparse checkout, message ID = exact Git path, one two-source reader, `.eml` view for humans only, `-text` on the corpus, CI matrix later.

## Verification
- No tests yet; this branch is configuration and rules only.
- On this machine: `git status` clean after setup; all 3,240 corpus entries are skip-worktree; `git check-attr text` reports `unset` for corpus files.
- The PowerShell clone recipe in CLAUDE.md was run end to end on a fresh clone: clean status, code on disk, corpus readable via `git cat-file`.
- `corpus-view/` export: 3,240 files, every one hash-identical to its Git blob.

## Review carefully
- `core.protectNTFS false` and the sparse-checkout patterns are local Git config, not committed. Anyone on Windows has to run the recipe; the final README must carry it.
- The Git Bash `MSYS_NO_PATHCONV=1` gotcha is real: without it the exclusion pattern is silently rewritten and the corpus gets written to disk with stripped names.
