# agent-sessions Skill — Design Spec

> Design/build notes for the `skills/active/agent-sessions` skill. Not bundled with the skill; not loaded at runtime.

## Intent

Help agents safely inspect OpenCode and Claude Code session stores while keeping reads predictable, token-conscious, and evidence-driven. The skill's leading process is **session archaeology**: identify the artifact, outline first, then drill into only the evidence needed to reconstruct or audit what happened.

## Scope

In scope:

- Locating OpenCode SQLite databases, Claude Code JSONL stores, and exported session artifacts.
- Read-only SQL and `jq` patterns for session discovery, tool traces, subagents, skill usage, failures, and compact boundaries.
- A shared analysis/reporting workflow for prior-session reconstruction, improvement review, and user perspective mining.

Out of scope:

- Writing, editing, migrating, vacuuming, or deleting session stores.
- Replacing either tool as the authority for changing storage layouts.
- Persisting private transcript content or secrets as examples.

## Invocation

Model-invoked. The agent should load this skill autonomously when the user asks to find, read, reconstruct, or audit prior OpenCode or Claude Code sessions. OpenCode vs Claude Code is a branch inside one skill, not separate invocation concepts.

## Runtime Contract

- Required first action: identify the source and artifact, then choose the OpenCode, Claude Code, or direct-export branch.
- Required reading discipline: confirm schema/layout live; outline before reading full transcript content; expand only where the question requires evidence.
- Required outputs: describe inspected scope, summarize evidence-backed findings, and state sampling/full-read status plus gaps; for perspective mining, include the session locator, message shape, reusable perspective, and admission rationale.
- Non-negotiable constraints: never mutate stores; never surface secrets; prefer SQL/`jq` structured extraction over raw transcript dumps.
- Files loaded at runtime: `SKILL.md` always; `OPENCODE.md` or `CLAUDE.md` for provider mechanics; `ANALYSIS.md` when reconstructing behavior, recommending improvements, or mining durable user perspective.

## Reference Architecture

- `SKILL.md` contains the model-facing description, shared steps, completion criteria, safety rules, and branch pointers.
- `OPENCODE.md` owns OpenCode-specific storage knowledge: `opencode db`, read-only `sqlite3`, schema map, discovery queries, drill-down recipes, and exported JSON artifacts.
- `CLAUDE.md` owns Claude-specific storage knowledge: store root resolution, project encoding, transcript discovery, `jq` recipes, failure classification, and subagent sidecars.
- `ANALYSIS.md` owns shared timeline reconstruction, user perspective mining, and reporting patterns.

## Validation

- Lightweight validation: structural skill validation plus manual checks that examples are read-only (`SELECT`, read-only `sqlite3`, `jq`) and branch pointers are clear.
- Deeper validation: run locate, identify, tool-summary, failure, and subagent-trace reads against live OpenCode and Claude stores.
- Acceptance gates: source/artifact is explicit, outline-first reading is visible, full-read escalation is bounded and justified, and reports separate evidence from gaps.

## Maintenance Notes

- Update provider files when store layouts, record types, or CLI behavior changes.
- Keep shared analysis guidance in `ANALYSIS.md`; do not duplicate it under provider branches.
- If a future provider is added, add a provider file and branch pointer rather than creating another model-invoked session skill unless it needs a distinct invocation concept.
