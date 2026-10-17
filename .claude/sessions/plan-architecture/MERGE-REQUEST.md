# Merge request: plan/architecture -> main

## What changed
- `.claude/sessions/plan-architecture/ARCHITECTURE.md`: the build blueprint. Requirement traceability, Mermaid architecture diagram, pipeline stages with data contracts and cache keys, deterministic definitions (dates, dedup, occurrences, email-trail actions), the published effort rates, the Claude Code layer (skills, agents, hooks, settings), test plan, build order M0-M8 with M3 as a go/no-go gate, risks, and the decided list.
- `CLAUDE.md`: new sections for untrusted content and traps, hours and dollars (email trail only), and keeping the record.
- `.claude/notes/NOTES-LOG.md`: running source for NOTES.md, with the brief's deliverables checklist and entries so far.
- `.claude/sessions/plan-architecture/DECISIONS.md`: 17 decisions with alternatives.

No code. No corpus changes.

## Decisions
See `DECISIONS.md`. Headline: hours come only from counted email actions x published rates x $85; TypeScript with a strict date parser; Sonnet extractors; model-generated, human-reviewed taxonomy; observed-in-4-mailboxes scope; occurrences start at fresh sends; only company staff time priced.

## Verification
- No tests (planning only).
- Spot-checked against the corpus: the nine planted messages, the injection text, the Calpine recurring-subject pattern, sender domains (3,015 of 3,240 from `enron.com`).
- Checked against the installed Claude Code (2.1.302): `--permission-mode` values and `--permission-prompts none` exist.
- Not yet verified (M3 tests them first): background subagent completions re-waking the orchestrator, SubagentStop blocking, hook input `agent_type` for subagent tool calls, hooks under `claude -p`.

## Review carefully
- Section 4.1 and 4.2: the counting definitions and the default per-action minutes and automatable shares. These are the assumptions the headline rests on.
- The `read` automatable share (50%) is the softest default.
- Section 10, M3: if the agent loop fails there, the fallback weakens "runs inside Claude Code"; that decision comes back to you.
