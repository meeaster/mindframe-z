# GPT-5.5 Prompting Guide

Open when creating, reviewing, migrating, or tightening prompts for `gpt-5.5`.

## Use GPT-5.5 Prompting When

- The workload needs high judgment, ambiguity handling, synthesis, broad tool choice, or customer-facing polish.
- You are migrating an older GPT prompt stack and want to reduce process-heavy scaffolding.
- The prompt needs outcome-first goals, concise style controls, retrieval budgets, preambles, `phase`, or validation loops.

## Core Posture

- Define the outcome and success criteria, then let the model choose the efficient path.
- Keep prompts shorter than older process-heavy stacks unless a longer block fixes a measured failure mode.
- Use absolute words like `ALWAYS`, `NEVER`, `must`, and `only` for true invariants: safety, required output fields, irreversible side-effect limits, or hard product contracts.
- Use decision rules for judgment calls: when to search, ask, use tools, continue, stop, or escalate.
- Re-evaluate `low` and `medium` reasoning before escalating; more effort is not automatically better.

## Suggested Prompt Structure

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

## Personality And Collaboration

- Separate personality from collaboration style.
- Personality controls tone, warmth, directness, formality, humor, empathy, and polish.
- Collaboration style controls when to ask, assume, proceed, verify, explain, or handle uncertainty.
- Keep both short; neither should replace goals, success criteria, tool rules, or stopping conditions.

Task-focused personality:

```text
# Personality
You are a capable collaborator: approachable, steady, and direct. Assume the user is competent and acting in good faith, and respond with patience, respect, and practical helpfulness.

Prefer making progress over stopping for clarification when the request is already clear enough to attempt. Ask for clarification only when the missing information would materially change the answer or create meaningful risk, and keep any question narrow.

Stay concise without becoming curt. Give enough context for the user to understand and trust the answer, then stop. When correcting the user or disagreeing, be candid but constructive.
```

Expressive personality:

```text
# Personality
Adopt a vivid conversational presence: intelligent, curious, playful when appropriate, and attentive to the user's thinking. Ask good questions when the problem is blurry, then become decisive once there is enough context.

Be warm, collaborative, and polished. Offer a real point of view rather than merely mirroring the user, while staying responsive to their goals and constraints.
```

## Preambles And Phase

- For longer or tool-heavy streaming tasks, prompt for a short visible preamble before tool calls.
- Keep preambles to one or two sentences: acknowledge the request and state the first step.
- If manually replaying assistant items, preserve `phase` exactly.
- Use `phase: "commentary"` for intermediate updates and `phase: "final_answer"` for completed answers.
- Do not add `phase` to user messages.

Preamble rule:

```text
Before any tool calls for a multi-step task, send a short user-visible update that acknowledges the request and states the first step. Keep it to one or two sentences.
```

## Outcome And Stop Rules

Prefer outcome-first task framing:

```text
Resolve the customer's issue end to end.

Success means:
- the eligibility decision is made from the available policy and account data
- any allowed action is completed before responding
- the final answer includes completed_actions, customer_message, and blockers
- if evidence is missing, ask for the smallest missing field
```

Add explicit stopping conditions:

```text
Resolve the user query in the fewest useful tool loops, but do not let loop minimization outrank correctness, accessible fallback evidence, calculations, or required citation tags for factual claims.

After each result, ask: "Can I answer the user's core request now with useful evidence and citations for the factual claims?" If yes, answer.
```

## Formatting And Editing

- Use `text.verbosity` to control final-answer length; default is `medium`, and `low` is better for concise product surfaces.
- Let formatting serve comprehension. Prefer plain paragraphs unless scanning, comparison, ranking, or user preference calls for structure.
- For editing, rewriting, summaries, or customer-facing messages, preserve the requested artifact, length, structure, and genre before improving style.

Editing instruction:

```text
Preserve the requested artifact, length, structure, and genre first. Quietly improve clarity, flow, and correctness. Do not add new claims, extra sections, or a more promotional tone unless explicitly requested.
```

## Grounding And Retrieval

- Define what needs citations, what counts as enough evidence, and what to do when evidence is missing.
- Absence of evidence is not automatically factual evidence for "no" unless the evidence base is sufficient.
- Add retrieval budgets as stopping rules for search.

Retrieval budget:

```text
For ordinary Q&A, start with one broad search using short, discriminative keywords. If the top results contain enough citable support for the core request, answer from those results instead of searching again.

Make another retrieval call only when:
- The top results do not answer the core question.
- A required fact, parameter, owner, date, ID, or source is missing.
- The user asked for exhaustive coverage, a comparison, or a comprehensive list.
- A specific document, URL, email, meeting, record, or code artifact must be read.
- The answer would otherwise contain an important unsupported factual claim.

Do not search again to improve phrasing, add examples, cite nonessential details, or support wording that can safely be made more generic.
```

## Creative Drafting Guardrails

```text
For creative or generative requests such as slides, leadership blurbs, outbound copy, summaries for sharing, talk tracks, or narrative framing, distinguish source-backed facts from creative wording.

- Use retrieved or provided facts for concrete product, customer, metric, roadmap, date, capability, and competitive claims, and cite those claims.
- Do not invent specific names, first-party data claims, metrics, roadmap status, customer outcomes, or product capabilities to make the draft sound stronger.
- If there is little or no citable support, write a useful generic draft with placeholders or clearly labeled assumptions rather than unsupported specifics.
```

## Validation Loops

- For coding agents, ask for targeted tests, type checks, lint, build checks, or a smoke test after changes.
- For visual artifacts, require rendering and inspection for layout, clipping, spacing, missing content, and visual consistency.
- For implementation plans, require traceability to requirements, files/APIs/systems, state/data flow, validation, failure behavior, privacy/security, and material open questions.

Validation clause:

```text
After making changes, run the most relevant validation available:
- targeted unit tests for changed behavior
- type checks or lint checks when applicable
- build checks for affected packages
- a minimal smoke test when full validation is too expensive

If validation cannot be run, explain why and describe the next best check.
```
