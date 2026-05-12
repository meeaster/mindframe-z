# mise Skill Sources

## Source Inventory

| Source                                                             | Trust | Contribution                                                                                            |
| ------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------- |
| Context7 `/jdx/mise` docs query for global tools/backends/env vars | High  | Confirmed `mise use --global`, backend prefixes, `mise backends ls`, env examples, and config commands. |
| `/home/mark/.agents/skills/skill-writer/SKILL.md`                  | High  | Creation workflow and required output expectations.                                                     |
| `skill-writer/references/mode-selection.md`                        | High  | Selected new-skill synthesis + authoring + validation path.                                             |
| `skill-writer/references/execution-shapes.md`                      | High  | Selected `inline-guidance` as simplest adequate shape.                                                  |
| `skill-writer/references/layout-inline-skill.md`                   | High  | Confirmed single-file runtime layout is appropriate.                                                    |
| `skill-writer/references/authoring-path.md`                        | High  | Frontmatter, compact runtime guidance, and precision-pass requirements.                                 |
| `skill-writer/references/spec-template.md`                         | High  | `SPEC.md` structure.                                                                                    |
| `skill-writer/references/registration-validation.md`               | High  | Skill root convention and validation command.                                                           |

## Decisions

| Decision                                                            | Status  | Rationale                                                                           |
| ------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| Name the skill `mise`                                               | adopted | User explicitly requested this name.                                                |
| Maintain the skill in this repo under `skills/mise/`                | adopted | The AI config repo is now the source of truth for this skill.                       |
| Install through skills.sh from the local `skills/` parent directory | adopted | `npx skills add <parent> --skill mise` discovers the skill reliably.                |
| Keep runtime guidance inline                                        | adopted | The requested behavior is slim command recall, not exhaustive documentation.        |
| Add docs fallback instruction                                       | adopted | User requested lookup when more information is needed than the slim skill includes. |
| Avoid bundled references                                            | adopted | No separate branch or lookup need exists yet.                                       |

## Coverage Matrix

| Area                                    | Status                                |
| --------------------------------------- | ------------------------------------- |
| Global tool install commands            | covered                               |
| Default-first tool resolution           | covered                               |
| Registry lookup before backend choice   | covered                               |
| Post-install verification through mise  | covered                               |
| Backend selection heuristics            | covered                               |
| Global env var commands                 | covered                               |
| Config and backend inspection           | covered                               |
| Removal and basic checks                | covered                               |
| Advanced mise tasks/CI/shell activation | intentionally deferred to docs lookup |

## Precision Pass

- Added `SKILL.md` because the user requested a new runtime skill.
- Added `SPEC.md` because this is a new skill with a new maintenance contract.
- Added `SOURCES.md` to keep provenance and synthesis notes out of runtime guidance.
- No runtime references were added because they would expand context against the user's stated goal.
- Quoted the frontmatter description because `: ` inside a plain YAML scalar prevented skills.sh from discovering the skill.

## Changelog

- 2026-05-10: Created initial minimal `mise` skill from current Context7 mise documentation and local skill-writer conventions.
- 2026-05-10: Added default-first guidance: try the bare mise tool name before choosing an explicit backend when appropriate.
- 2026-05-10: Added post-install verification hint to prefer `mise exec -- <cmd>` instead of assuming the command is immediately on `PATH`.
- 2026-05-10: Clarified registry rule: registry matches use bare shorthand; non-registry tools need an explicit backend.
- 2026-05-11: Moved source of truth into this repo and fixed frontmatter quoting for skills.sh discovery.
