# mise Skill Specification

## Intent

Provide lightweight mise hints for the LLM, not a complete tutorial or a prescribed response style. The skill should act as command memory for common `mise` operations, especially adding global tools, selecting backends, and managing global environment variables.

## Scope

In scope:

- global tool installation and removal
- default-first tool resolution guidance
- registry lookup before backend selection when the exact name is uncertain
- post-install verification when tools are not immediately on `PATH`
- backend choice heuristics
- global environment variables
- config/backend inspection commands
- documentation lookup fallback when the slim skill is insufficient

Out of scope:

- exhaustive mise reference material
- task runner workflows
- CI setup
- shell activation setup beyond quick command guidance

## Users And Trigger Context

- Primary users: developers who already use or want to use `mise` for tool/env management.
- Common user requests: add a global CLI, search mise registry for a default shorthand, decide whether to use the default tool name or an explicit backend, verify an installed tool, set a global env var, inspect global config, remove a tool.
- Should not trigger for: unrelated package manager questions unless `mise` is part of the requested workflow.

## Runtime Contract

- Required first actions: use `SKILL.md` as hints; fetch current mise docs when the hints are not enough.
- Required outputs: no special output contract. The model should answer naturally for the user's request.
- Non-negotiable constraints: keep runtime guidance minimal; do not invent unsupported flags/backends; avoid exposing secrets in literal commands.
- Expected bundled files loaded at runtime: `SKILL.md` only.

## Source And Evidence Model

Authoritative sources:

- official mise documentation surfaced through Context7
- local `skill-writer` guidance for skill structure

Useful improvement sources:

- positive examples: successful command-first answers
- negative examples: overlong docs summaries or incorrect backend choices
- changelogs: mise CLI flag or backend behavior changes
- validation results: structural skill validator output

Data that must not be stored:

- secrets
- private tokens
- user-specific environment variable values

## Reference Architecture

- `SKILL.md` contains all runtime guidance.
- `references/` contains nothing by default.
- `scripts/` contains nothing by default.
- `assets/` contains nothing by default.

## Validation

- Lightweight validation: run the skill-writer quick validator against this skill directory.
- Deeper validation: spot-check commands against current mise docs when CLI behavior changes.
- Acceptance gates: frontmatter is valid, guidance stays compact, docs fallback remains explicit, and `SKILL.md` reads like LLM nudges rather than user-facing documentation.

## Known Limitations

- The skill intentionally omits advanced mise features and must defer to current docs for those cases.
- Backend recommendations are heuristics: search `mise registry` when the bare name is uncertain; if found, use the bare shorthand without a backend prefix; if not found, choose and specify the appropriate backend.
- Newly installed tools may not be available through the raw shell command until mise shell activation/PATH integration is active; prefer `mise exec -- <cmd>` for immediate verification.

## Maintenance Notes

- Update `SKILL.md` when common command patterns or flags change, but prefer replacing or tightening hints over adding sections.
- Do not expand `SKILL.md` into exhaustive docs, workflows, or response formatting rules.
- Keep examples sparse and high-signal; a few representative commands are better than full coverage.
- Update `SOURCES.md` when docs are rechecked or new source-backed decisions are made.
