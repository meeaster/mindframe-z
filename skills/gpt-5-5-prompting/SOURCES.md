# GPT-5.5 Prompting Skill Sources

## Source Inventory

| Source                                                        | Trust | Contribution                                                                                                                                                            |
| ------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| https://developers.openai.com/api/docs/guides/prompt-guidance | High  | Primary source for GPT-5.5 prompt behavior: outcome-first prompts, personality, preambles, retrieval budgets, formatting, validation, `phase`, and suggested structure. |
| User-provided excerpt from OpenAI prompt guidance             | High  | Supplied the exact GPT-5.5 guidance to adapt and stated a preference to preserve it unless adjustment was needed.                                                       |
| `/home/mark/.agents/skills/skill-writer/SKILL.md`             | High  | Creation workflow and required output expectations.                                                                                                                     |
| `skill-writer/references/mode-selection.md`                   | High  | Selected new-skill synthesis + authoring + description optimization + registration/validation path.                                                                     |
| `skill-writer/references/execution-shapes.md`                 | High  | Selected `inline-guidance` as simplest adequate execution shape.                                                                                                        |
| `skill-writer/references/layout-inline-skill.md`              | High  | Confirmed single-file runtime layout is appropriate.                                                                                                                    |
| `skill-writer/references/authoring-path.md`                   | High  | Frontmatter, compact runtime guidance, and precision-pass requirements.                                                                                                 |
| `skill-writer/references/spec-template.md`                    | High  | `SPEC.md` structure.                                                                                                                                                    |
| `skill-writer/references/registration-validation.md`          | High  | Skill root convention and validation command.                                                                                                                           |

## Adaptation Notes

| Decision                                          | Status  | Rationale                                                                                           |
| ------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| Name the skill `gpt-5-5-prompting`                | adopted | Uses ASCII and avoids punctuation that can be awkward in skill identifiers.                         |
| Maintain the skill in `skills/gpt-5-5-prompting/` | adopted | The repo already uses `skills/<name>/` for local skills.                                            |
| Keep runtime guidance inline                      | adopted | The guide is one coherent set of prompt-writing rules; optional deep references are not needed yet. |
| Summarize rather than copy the full guide         | adopted | Runtime skills should change agent decisions, not embed full upstream documentation.                |
| Preserve source intent                            | adopted | The runtime bullets map directly to the OpenAI guide's recommendations.                             |
| Add `SPEC.md` and `SOURCES.md`                    | adopted | New skill requires a maintenance contract and provenance without bloating runtime context.          |

## Coverage Matrix

| Area                                | Status                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| Outcome-first prompting             | covered                                                                      |
| Avoiding legacy over-specification  | covered                                                                      |
| Personality and collaboration style | covered                                                                      |
| Preambles for tool-heavy work       | covered                                                                      |
| Responses `phase` preservation      | covered                                                                      |
| Formatting and `text.verbosity`     | covered                                                                      |
| Retrieval budgets and grounding     | covered                                                                      |
| Creative drafting guardrails        | covered                                                                      |
| Frontend prompt guidance            | deferred to existing frontend/design skills or current OpenAI frontend guide |
| Validation loops                    | covered                                                                      |
| Suggested prompt structure          | covered                                                                      |

## Precision Pass

- Added `SKILL.md` because the user requested a new runtime skill from the OpenAI guidance.
- Added `SPEC.md` because this is a new skill with a maintenance contract.
- Added `SOURCES.md` to keep provenance, adaptation decisions, and coverage notes out of runtime guidance.
- No runtime references were added because the selected execution shape is inline guidance and no routed lookup need exists yet.
- Frontend-specific details are intentionally summarized because this repo already has a dedicated frontend skill trigger and the OpenAI page points to a separate frontend guide.

## Changelog

- 2026-05-12: Created initial `gpt-5-5-prompting` skill from OpenAI GPT-5.5 prompt guidance and local skill-writer conventions.
