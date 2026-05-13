# GPT-5.5 Prompting Skill Specification

## Intent

Provide compact runtime guidance for creating, reviewing, and migrating prompts for GPT-5.5. The skill should help agents preserve the OpenAI prompt guidance's practical behavior without copying the full guide into runtime context.

## Scope

In scope:

- outcome-first prompt structure
- personality and collaboration-style controls
- concise formatting and verbosity controls
- retrieval budgets, grounding, and citation behavior
- creative drafting guardrails
- preambles and Responses `phase` handling
- validation loops for coding, visual, and planning tasks
- migration away from legacy process-heavy prompt stacks

Out of scope:

- exhaustive OpenAI API documentation
- model capability comparisons beyond GPT-5.5 prompt behavior
- SDK or Responses API implementation code
- generic prompt engineering unrelated to GPT-5.5 guidance

## Users And Trigger Context

- Primary users: developers and prompt authors adapting prompts for GPT-5.5.
- Common user requests: create a GPT-5.5 prompt, migrate an old prompt, review a prompt for over-specification, add retrieval budgets, tune preambles or phase handling, add validation requirements.
- Should not trigger for: unrelated coding tasks, API usage questions without prompt design, or general writing requests that do not involve model instructions.

## Runtime Contract

- Required first actions: identify the user's prompt surface, preserve required product behavior, then apply only the GPT-5.5 guidance that changes outcomes.
- Required outputs: no fixed output contract; follow the user's requested artifact or review format.
- Non-negotiable constraints: do not invent API behavior; do not remove safety, privacy, citation, or side-effect constraints without an explicit replacement.
- Expected bundled files loaded at runtime: `SKILL.md` only.

## Source And Evidence Model

Authoritative sources:

- OpenAI Prompt guidance page for GPT-5.5
- Local `skill-writer` guidance for skill structure

Useful improvement sources:

- positive examples: GPT-5.5 prompts that pass product evals with less process overhead
- negative examples: over-specified prompts, missing stop rules, uncontrolled retrieval loops, missing validation instructions
- changelogs: OpenAI prompt guidance or latest-model guide changes
- validation results: structural skill validator output and prompt eval outcomes

Data that must not be stored:

- secrets
- private prompts unless explicitly intended as reusable examples
- customer data or proprietary eval traces

## Reference Architecture

- `SKILL.md` contains all runtime guidance.
- `references/` contains nothing by default.
- `scripts/` contains nothing by default.
- `assets/` contains nothing by default.

## Validation

- Lightweight validation: run the skill-writer quick validator against this skill directory.
- Deeper validation: compare future runtime guidance changes against the current OpenAI GPT-5.5 prompt guidance and prompt eval results.
- Acceptance gates: frontmatter is valid, runtime guidance is compact, provenance stays out of `SKILL.md`, and the skill does not become a full prompt-engineering encyclopedia.

## Known Limitations

- The skill intentionally summarizes the upstream guide instead of embedding the full source text.
- The OpenAI guide may change; re-check the source before making material changes.
- Product-specific evals still outrank generic prompt guidance when they reveal a measured behavior gap.

## Maintenance Notes

- Update `SKILL.md` when OpenAI changes GPT-5.5 prompt guidance or repeated use reveals a concrete missed behavior.
- Update `SOURCES.md` when docs are rechecked, decisions change, or new provenance is added.
- Prefer replacing or tightening existing bullets over adding broad new sections.
