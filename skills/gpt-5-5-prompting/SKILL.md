---
name: gpt-5-5-prompting
description: "Use when creating, reviewing, migrating, or tightening prompts for GPT-5.5, especially outcome-first goals, concise style controls, retrieval budgets, preambles, phase handling, validation loops, or prompt structure."
---

# GPT-5.5 Prompting

Use this skill to create or improve GPT-5.5 prompts. Preserve the user's requested artifact and product constraints first; apply these guidelines only where they improve the prompt's behavior.

## Core Rules

- Prefer outcome-first prompts: define the target outcome, success criteria, constraints, available evidence, output shape, and stop rules.
- Keep prompts shorter than older process-heavy stacks unless a longer block fixes a measured failure mode.
- Use `ALWAYS`, `NEVER`, `must`, and `only` for true invariants, required output fields, safety rules, and irreversible side-effect limits. Use decision rules for judgment calls.
- Re-evaluate `low` or `medium` reasoning effort before escalating when the task does not require deep search or complex planning.
- Add explicit personality and collaboration style for customer-facing, support, coaching, or other conversational products.
- For tool-heavy or longer tasks, ask for a brief preamble before tool calls so users see the first step quickly.
- For Responses workflows that replay assistant items, preserve `phase` values exactly: use `commentary` for intermediate updates and `final_answer` for completed answers.

## Prompt Components

Use this structure as a starting point for complex prompts. Omit sections that do not change behavior.

```text
Role: [1-2 sentences defining the model's function, context, and job]

# Personality
[tone, demeanor, and collaboration style]

# Goal
[user-visible outcome]

# Success criteria
[what must be true before the final answer]

# Constraints
[policy, safety, business, evidence, and side-effect limits]

# Output
[sections, length, and tone]

# Stop rules
[when to retry, fallback, abstain, ask, or stop]
```

## Grounding And Retrieval

- Define what needs citations, what counts as enough evidence, and what to do when evidence is missing.
- Treat absence of evidence as unknown unless the evidence base is sufficient to conclude a factual no.
- Add a retrieval budget: start with one broad, discriminative search for ordinary Q&A, then search again only when the top results do not answer the core request, a required fact is missing, the user asked for exhaustive coverage, a specific artifact must be read, or an important claim would be unsupported.
- Do not search again merely to improve phrasing, add nonessential examples, or cite details that can be safely generalized.
- For creative drafting, separate source-backed facts from creative wording. Use placeholders or labeled assumptions instead of inventing metrics, customer names, dates, roadmap status, outcomes, or capabilities.

## Formatting And Editing

- Let formatting serve comprehension. Prefer short paragraphs for normal explanations; use headers, bullets, tables, or numbered lists when they improve scanning or the user asks for them.
- Use `text.verbosity: low` for terse product surfaces and `medium` when the answer needs enough context to be trusted.
- For editing, rewriting, summaries, or customer-facing messages: preserve the requested artifact, length, structure, and genre first; quietly improve clarity, flow, and correctness; do not add unsupported claims or a more promotional tone.

## Validation Loops

- For coding agents, ask for the most relevant validation after changes: targeted tests, type checks, lint, build checks, or a minimal smoke test.
- For visual artifacts, require rendering and inspection for layout, clipping, spacing, missing content, and visual consistency before finalizing.
- For implementation plans, require traceability: requirements, named resources/files/APIs, state or data flow, validation checks, failure behavior, privacy/security considerations, and material open questions.

## Migration Checklist

- Replace legacy process-heavy prompt stacks with shorter outcome-first instructions where possible.
- Move provenance, rationale, and examples that do not affect runtime behavior out of the prompt.
- Keep explicit rules for preambles, `phase` replay, retrieval budgets, validation, citations, and irreversible actions when they are relevant.
- Run or define evals for the product surface before removing instructions that may encode known edge-case behavior.
