# GPT Model Selection Skill Specification

## Intent

Provide concise guidance for choosing GPT models, reasoning effort, and prompt posture for a problem or use case. Also provide routed, model-specific prompt guidance for GPT-5.5, GPT-5.4, GPT-5.4-mini, and GPT-5.3 Codex. The skill should turn model guidance into practical recommendations and prompt edits rather than a full model documentation summary.

## Scope

In scope:

- model selection among GPT-5.5, GPT-5.4, GPT-5.4-mini, and GPT-5.3 Codex
- reasoning effort recommendations
- pricing-aware model recommendations using current registry data and cost-control API posture
- task-shape matching for coding, research, structured extraction, prompt migration, routing, and latency-sensitive workflows
- harness requirements such as Responses `phase` preservation for long-running workflows
- clear separation between GPT-5.4 and GPT-5.4-mini guidance
- eval-aware downgrade/escalation guidance so GPT-5.5 is not treated as the universal default
- prompt caching, token caps, verbosity, Structured Outputs, and usage tracking when cost matters
- model-specific prompt creation, review, migration, and tightening for GPT-5.5, GPT-5.4, GPT-5.4-mini, and GPT-5.3 Codex
- routed reference files for detailed prompting patterns that should not live in `SKILL.md`

Out of scope:

- exhaustive API documentation
- pricing or benchmark claims not supplied by current docs, model registry data, or evals
- non-GPT model families unless future sources justify expansion
- generic prompt engineering unrelated to the scoped GPT models

## Users And Trigger Context

- Primary users: developers, agent builders, and prompt authors deciding which GPT model to use.
- Common user requests: choose a model for a use case, compare GPT-5.5 vs GPT-5.4, decide whether to use mini, select reasoning effort, migrate a coding agent, tune cost/latency tradeoffs, create or review a model-specific prompt.
- Should not trigger for: ordinary coding tasks, prompt rewriting requests without model choice, or library/API usage questions unrelated to model selection.

## Runtime Contract

- Required first actions: identify the task shape, impact of mistakes, latency/cost sensitivity, expected volume, and harness constraints from the user's context.
- Required outputs: recommend one model and reasoning effort, include cost posture, name a runner-up when useful, and state the key prompt/harness requirement; for prompt-writing requests, provide concrete prompt text or edits before rationale.
- Non-negotiable constraints: do not invent unsupported benchmark, pricing, or availability claims; separate GPT-5.4 from GPT-5.4-mini behavior; do not add GPT-5.4-nano runtime guidance.
- Expected bundled files loaded at runtime: `SKILL.md` by default; routed reference files only when prompt detail is requested.

## Source And Evidence Model

Authoritative sources:

- https://developers.openai.com/api/docs/guides/latest-model.md
- https://developers.openai.com/api/docs/guides/reasoning.md
- https://developers.openai.com/api/docs/guides/prompt-guidance
- https://developers.openai.com/tracks/building-agents#how-to-choose
- https://developers.openai.com/cookbook/examples/partners/model_selection_guide/model_selection_guide
- https://models.dev/api.json
- user-provided GPT-5.5 prompting guide excerpt
- user-provided GPT-5.4 prompting guide excerpt
- user-provided GPT-5.3 Codex prompting guide excerpt
- local `skill-writer` guidance for skill structure

Useful improvement sources:

- positive examples: concise model recommendations that match task shape and constraints
- negative examples: model recommendations that collapse GPT-5.4 and GPT-5.4-mini or over-index on reasoning effort
- changelogs: OpenAI model and prompting guide updates
- validation results: structural skill validator output and future model-selection evals

Data that must not be stored:

- secrets
- customer data
- private prompts or eval traces unless explicitly intended as reusable examples

## Reference Architecture

- `SKILL.md` contains model-selection guidance and routes to details.
- `references/` contains model-specific prompt guides.
- `references/evidence/` contains nothing by default.
- `scripts/` contains nothing by default.
- `assets/` contains nothing by default.

## Validation

- Lightweight validation: run the skill-writer quick validator against this skill directory.
- Deeper validation: spot-check recommendations against current OpenAI model and prompting docs when guidance changes.
- Acceptance gates: frontmatter is valid, runtime guidance is compact, referenced files exist, GPT-5.4 and GPT-5.4-mini are distinct, GPT-5.5 is framed as premium escalation rather than default, GPT-5.4-nano is not included, and claims avoid unsupported benchmark/pricing detail.

## Known Limitations

- The skill summarizes the provided guides and should be refreshed when OpenAI model guidance changes.
- Product-specific evals outrank generic model-selection guidance.
- Pricing is point-in-time source data and should be refreshed from `https://models.dev/api.json` before high-spend or procurement-sensitive decisions.
- The skill gives a practical default; exact model choice can still depend on availability, latency SLOs, budget, and private eval results.
- Generic OpenAI model-selection docs may mention model families outside this skill; keep runtime guidance scoped to GPT-5.5, GPT-5.4, GPT-5.4-mini, and GPT-5.3 Codex unless the skill scope changes.

## Maintenance Notes

- Update `SKILL.md` when model guidance changes or repeated use reveals a missed task shape.
- Update `SOURCES.md` when docs are rechecked, new sources are used, or adaptation decisions change.
- Prefer replacing rows in the decision table over adding broad prose sections.
- Keep detailed model prompt patterns in routed references instead of expanding `SKILL.md`.
