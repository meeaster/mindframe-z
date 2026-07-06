# GPT Model Selection Skill Sources

## Source Inventory

| Source                                                        | Trust | Contribution                                                                                                                                         |
| ------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| https://developers.openai.com/api/docs/guides/latest-model.md | High  | Official latest-model guidance for GPT-5.5 defaults, migration posture, Responses API, prompt caching, verbosity, Structured Outputs, tool design, and benchmarking against cost/latency. |
| https://developers.openai.com/api/docs/guides/reasoning.md    | High  | Official reasoning guidance for effort levels, lower-cost `gpt-5.4`, lower-cost/lower-latency `gpt-5.4-mini`, reasoning tokens, `max_output_tokens`, and `phase`. |
| https://developers.openai.com/api/docs/guides/prompt-guidance | High  | Official OpenAI prompt guidance source for GPT-5.4, GPT-5.3 Codex, phase handling, migration discipline, and reasoning effort as a last-mile knob.     |
| https://developers.openai.com/tracks/building-agents#how-to-choose | Medium | Official track search result for starting with simpler/faster models when use cases are simple, delegating hard tasks to stronger models, and evaluating prompts by model family. |
| https://developers.openai.com/cookbook/examples/partners/model_selection_guide/model_selection_guide | Medium | OpenAI cookbook search result for model-selection process: success criteria, evals, observability, cost guardrails, model rationale, versioning, and rollback. |
| https://models.dev/api.json                                   | High  | Current model registry pricing for GPT-5.5, GPT-5.4, GPT-5.4-mini, and GPT-5.3 Codex.                                                                |
| User-provided GPT-5.5 prompting guide excerpt                 | High  | Primary guidance for GPT-5.5 defaults, outcome-first prompting, reasoning effort, preambles, retrieval budgets, validation, and `phase`.             |
| User-provided GPT-5.4 prompting guide excerpt                 | High  | Primary guidance for GPT-5.4 long-running workflows, explicit contracts, research/citation rules, reasoning effort, and separate mini behavior.      |
| User-provided GPT-5.3 Codex prompting guide excerpt           | High  | Primary guidance for Codex-style agentic coding, autonomy, apply-patch/shell/tool expectations, reasoning effort, compaction, and `phase`.           |
| Retired `skills/gpt-5-5-prompting/SKILL.md`                    | High  | Merged prior standalone GPT-5.5 prompt guidance into this skill's routed reference model.                                                            |
| `/home/mark/.agents/skills/skill-writer/SKILL.md`             | High  | Creation workflow and required output expectations.                                                                                                  |
| `skill-writer/references/mode-selection.md`                   | High  | Selected new-skill synthesis + authoring + description optimization + registration/validation path.                                                  |
| `skill-writer/references/execution-shapes.md`                 | High  | Selected `inline-guidance` as simplest adequate execution shape.                                                                                     |
| `skill-writer/references/layout-inline-skill.md`              | High  | Confirmed single-file runtime layout is appropriate.                                                                                                 |
| `skill-writer/references/authoring-path.md`                   | High  | Frontmatter, compact runtime guidance, and precision-pass requirements.                                                                              |
| `skill-writer/references/spec-template.md`                    | High  | `SPEC.md` structure.                                                                                                                                 |
| `skill-writer/references/registration-validation.md`          | High  | Skill root convention and validation command.                                                                                                        |

## Adaptation Notes

| Decision                                            | Status  | Rationale                                                                                                            |
| --------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| Name the skill `gpt-model-selection`                | adopted | Clear trigger language, ASCII-safe, and broader than one model family version.                                       |
| Maintain the skill in `skills/gpt-model-selection/` | adopted | The repo uses `skills/<name>/` for local skill sources.                                                              |
| Register in `shared/skills.yml`                     | adopted | Local skills intended for OpenCode are declared there.                                                               |
| Keep selection guidance inline                       | adopted | Model selection is a single coherent decision policy; detailed prompt patterns live in routed references.            |
| Separate GPT-5.4 and GPT-5.4-mini                   | adopted | User explicitly requested distinct guidance, and the supplied 5.4 guide treats mini as more literal and constrained. |
| Avoid unsupported benchmark/pricing claims          | adopted | Pricing should come from current registry data; benchmarks should come from docs or evals, not inference.            |
| Include pricing table                               | adopted | User requested pricing details and cost caution because GPT-5.5 is materially more expensive than alternatives.      |
| Include GPT-5.3 Codex                               | adopted | Needed for coding-agent model selection tradeoffs.                                                                   |
| Treat GPT-5.5 as premium escalation                 | adopted | Current OpenAI docs recommend GPT-5.5 for reasoning workloads but explicitly point to GPT-5.4 and GPT-5.4-mini for lower cost/latency. |
| Make GPT-5.4 first-class guidance                   | adopted | Prompt guidance describes GPT-5.4 as production-grade for agents, long-context analysis, explicit tool workflows, and evidence-rich synthesis. |
| Keep GPT-5.4-nano out of runtime guidance           | adopted | User explicitly requested not to include GPT-5.4-nano.                                                               |
| Treat reasoning effort as last-mile tuning          | adopted | Prompt guidance says effort is not one-size-fits-all and should follow clearer prompts, contracts, and verification. |
| Include API-level cost controls                     | adopted | Latest-model and reasoning docs recommend cost-sensitive use of verbosity, prompt caching, Structured Outputs, token caps, and usage tracking. |
| Merge GPT-5.5 prompting skill into model selection   | adopted | User requested a single skill with prompt-guide references for each model rather than a separate GPT-5.5 skill.      |
| Add routed model prompting references                | adopted | Detailed prompt blocks are useful but too bulky for always-loaded `SKILL.md`; references keep runtime routing compact. |

## Coverage Matrix

| Area                             | Status                |
| -------------------------------- | --------------------- |
| GPT-5.5 default guidance         | covered               |
| GPT-5.4 full model guidance      | covered               |
| GPT-5.4-mini guidance            | covered separately    |
| GPT-5.3 Codex guidance           | covered               |
| Reasoning effort recommendations | covered               |
| Pricing and cost posture         | covered               |
| Coding-agent routing             | covered               |
| Research/synthesis routing       | covered               |
| Structured extraction/routing    | covered               |
| Harness `phase` constraints      | covered               |
| Cost-control API posture         | covered               |
| Evaluation and observability     | covered               |
| GPT-5.5 prompting details        | covered in reference  |
| GPT-5.4 prompting details        | covered in reference  |
| GPT-5.4-mini prompting details   | covered in GPT-5.4 reference |
| GPT-5.3 Codex prompting details  | covered in reference  |
| Pricing/availability             | pricing covered, availability omitted |

## Precision Pass

- Added `SKILL.md` because the user requested a new runtime skill for model selection advice.
- Added `SPEC.md` because this is a new skill with a maintenance contract.
- Added `SOURCES.md` to keep provenance, adaptation decisions, and coverage notes out of runtime guidance.
- Runtime prompt references were added because model-specific prompt details are useful but too bulky for always-loaded guidance.
- Separated GPT-5.4 and GPT-5.4-mini sections rather than using a shared row to avoid the exact ambiguity the user called out.
- Added pricing guidance because model selection should account for GPT-5.5's premium cost when cheaper models are sufficient.
- Strengthened GPT-5.4 and GPT-5.4-mini guidance instead of adding GPT-5.4-nano because the user explicitly rejected nano scope.
- Added cost controls that affect model choice without turning `SKILL.md` into an API guide.
- Added routed references for model-specific prompting details so the standalone GPT-5.5 skill can be retired.

## Trigger Sets

Should trigger:

- "What GPT model should I use for this agent?"
- "Should this use GPT-5.5 or GPT-5.3 Codex?"
- "Pick a model and reasoning effort for a research assistant."
- "Can I use GPT-5.4 mini for this extraction workflow?"
- "Which model is best for a long-running coding agent?"
- "Rewrite this prompt for GPT-5.5."
- "Review my GPT-5.4 agent prompt."
- "Create a Codex prompt for an autonomous coding agent."

Should not trigger:

- "Implement this feature."
- "Review this code diff."
- "How do I call the Responses API?"
- "Summarize this document."

## Changelog

- 2026-05-13: Added current pricing from `https://models.dev/api.json` and revised GPT-5.5 guidance to be cost-aware.
- 2026-05-14: Rechecked OpenAI latest-model, reasoning, prompt-guidance, building-agents, and model-selection cookbook guidance; revised runtime guidance to prefer cheaper sufficient models before GPT-5.5 and to exclude GPT-5.4-nano.
- 2026-05-14: Added API-level cost controls for reasoning tokens, verbosity, prompt caching, Structured Outputs, and token caps.
- 2026-05-14: Merged `gpt-5-5-prompting` into `gpt-model-selection` and added routed prompt-guide references for GPT-5.5, GPT-5.4/GPT-5.4-mini, and GPT-5.3 Codex.
- 2026-05-13: Removed GPT-5.4-nano runtime guidance and added the official OpenAI prompt guidance URL as a source.
- 2026-05-13: Created initial `gpt-model-selection` skill from user-provided GPT-5.5, GPT-5.4, and GPT-5.3 Codex prompting guidance plus local skill-writer conventions.
