---
name: gpt-model-selection
description: "Use when choosing which GPT model or reasoning effort to use, or when creating, reviewing, migrating, or tightening prompts for GPT-5.5, GPT-5.4, GPT-5.4-mini, or GPT-5.3 Codex. Covers cost/latency tradeoffs, agent workflows, coding rollouts, research, structured extraction, and model-specific prompting guidance."
---

# GPT Model Selection

Use this skill to recommend a GPT model, reasoning effort, cost posture, and prompting posture for a concrete problem or product surface. Also use it to create, review, migrate, or tighten prompts for GPT-5.5, GPT-5.4, GPT-5.4-mini, and GPT-5.3 Codex. Ask for one missing constraint only when model choice or prompt design would materially change based on it. Favor practical value: start with the least expensive model that can meet the task's quality bar, then escalate only when the task shape or evals justify it.

## Reference Routing

- Open `references/gpt-5-5-prompting.md` when the user asks for GPT-5.5 prompt creation, review, migration, outcome-first prompts, personality, retrieval budgets, preambles, `phase`, formatting, or validation loops.
- Open `references/gpt-5-4-prompting.md` when the user asks for GPT-5.4 or GPT-5.4-mini prompting, long-running tasks, tool persistence, structured output contracts, research/citation rules, compaction, or mini-specific prompt scaffolding.
- Open `references/gpt-5-3-codex-prompting.md` when the user asks for GPT-5.3 Codex prompting, Codex-style coding agents, agent harness design, `apply_patch`, shell/plan tools, parallel tool calls, compaction, preambles, or `phase` handling.
- Keep runtime recommendations in this file concise. Use references only when prompt details matter; do not load them for simple model-selection questions.

## Default Recommendation

- Prefer the least expensive model that is likely to satisfy the task; do not default to `gpt-5.5` when `gpt-5.4`, `gpt-5.4-mini`, or `gpt-5.3-codex` is sufficient.
- Use `gpt-5.4-mini` first for bounded, high-volume, structured work where ambiguity is low and the output contract is explicit.
- Use `gpt-5.4` before `gpt-5.5` for production agents, long-context synthesis, explicit tool workflows, research with clear grounding rules, or stable GPT-5.4 prompt stacks.
- Use `gpt-5.5` for high-judgment general assistants, ambiguous planning, reviews, synthesis, prompt work, complex tool workflows, and customer-facing polish where quality matters more than cost.
- Start `gpt-5.5` at `low` or `medium` reasoning unless the task is deeply research-heavy or failure is expensive; many workloads should try `low` before accepting `medium` cost.
- Use `gpt-5.3-codex` for long-running autonomous coding agents when the harness is Codex-style and preserves assistant `phase` values.
- Use `gpt-5.4` when the system already has stable GPT-5.4 prompts/evals or needs explicit long-workflow contracts with minimal migration risk.
- Use `gpt-5.4-mini` for cheaper, clearly structured tasks where the prompt can spell out the flow and ambiguity behavior.

## Pricing Reference

Use current pricing when model cost matters. These values come from `https://models.dev/api.json` and are USD per 1M tokens in the registry's pricing fields.

| Model           | Input | Output | Cache read | Over 200k input | Over 200k output | Over 200k cache read |
| --------------- | ----: | -----: | ---------: | --------------: | ---------------: | -------------------: |
| `gpt-5.5`       | $5.00 | $30.00 |      $0.50 |          $10.00 |           $45.00 |                $1.00 |
| `gpt-5.4`       | $2.50 | $15.00 |      $0.25 |           $5.00 |           $22.50 |                $0.50 |
| `gpt-5.4-mini`  | $0.75 |  $4.50 |     $0.075 |             n/a |              n/a |                  n/a |
| `gpt-5.3-codex` | $1.75 | $14.00 |     $0.175 |             n/a |              n/a |                  n/a |

Cost guidance:

- Treat `gpt-5.5` as a premium model: choose it when quality, ambiguity handling, synthesis, or customer experience justifies the higher token price.
- For repeatable structured workflows, extraction, routing, and narrow transforms, prefer `gpt-5.4-mini` first and escalate only after evals or failures show it is insufficient.
- For agent, research, or long-context workflows, try `gpt-5.4` before `gpt-5.5` unless ambiguity, polish, or failure cost clearly needs the premium model.
- For coding-agent rollouts, compare `gpt-5.3-codex` against `gpt-5.5`; Codex is often the better value when the task is primarily autonomous code editing.
- For long-context workloads over 200k, account for the higher `gpt-5.5` and `gpt-5.4` over-200k tier before recommending them.
- Reduce cost with API controls before changing task quality: cap `max_output_tokens`, use `text.verbosity` for final-answer length, keep cacheable prompt prefixes stable, and track reasoning tokens in usage.

## Decision Table

| Use case                                      | Preferred model             | Reasoning                          | Prompt posture                                                       |
| --------------------------------------------- | --------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| General assistant or support workflow         | `gpt-5.4` or `gpt-5.5`      | `low` or `medium`                  | outcome-first goals, short personality, clear stop rules             |
| Multi-document research or evidence synthesis | `gpt-5.4` first; `gpt-5.5` for hard ambiguity | `medium`; `high` only if evals justify | retrieval budget, citation rules, validation loop                    |
| Long-running coding agent                     | `gpt-5.3-codex`             | `medium`, `high` for hard rollouts | autonomy, codebase exploration, validation, minimal upfront ceremony |
| Coding review or implementation planning      | `gpt-5.3-codex` or `gpt-5.5` | `medium`                           | inspect context, identify risks, validate with tests/checks          |
| Existing GPT-5.4 agent migration              | `gpt-5.4`                   | match current effort first         | preserve prompt/eval behavior, tune one change at a time             |
| Structured extraction or workflow step        | `gpt-5.4-mini`              | `none` or `low`                    | exact steps, schema, edge cases, no implied next steps               |
| Prompt creation or migration to latest style  | `gpt-5.5`                   | `low` or `medium`                  | shorter outcome-first prompt, fewer process-heavy rules              |
| Latency-sensitive but nontrivial task         | `gpt-5.4-mini` or `gpt-5.4` | `none` or `low`                    | tight output contract, lightweight verification                      |

## Model Notes

### GPT-5.5

- Best premium default for new work that needs strong judgment without heavy process prompting.
- Premium-priced relative to the other listed models; use it deliberately when cheaper models are likely to fall short.
- Prefer concise, outcome-first prompts: goal, success criteria, constraints, output, stop rules.
- Add preambles for longer or tool-heavy tasks so users see progress quickly.
- Preserve assistant `phase` when replaying Responses items.
- Re-evaluate `low` and `medium` reasoning before escalating.
- Downgrade to `gpt-5.4` when evals show similar quality, or to `gpt-5.4-mini` when the task is structured and high-volume.

### GPT-5.4

- Best when a production workflow already relies on GPT-5.4 behavior or you need conservative migration.
- Costs about half of `gpt-5.5` at standard context tiers in the current registry.
- Strong for long-context analysis, structured contracts, research mode, and explicit tool persistence.
- Keep completion, dependency, citation, and verification rules explicit.
- Switch model first, pin reasoning effort, run evals, then simplify or tune prompts.
- Escalate to `gpt-5.5` when the workload needs better ambiguity handling, answer polish, broad synthesis, or more reliable tool choice across a large surface.

### GPT-5.4 Mini

- Use for cost-sensitive work with clear structure and bounded ambiguity.
- Much cheaper than `gpt-5.5`; prefer it for high-volume structured tasks when evals support the quality tradeoff.
- Be more explicit than with GPT-5.5: critical rules first, exact step order, edge cases, clarification behavior, output format, and one example when useful.
- Do not rely on implied next steps; separate doing the action from reporting the action.
- Route ambiguous planning-heavy tasks to a stronger model rather than over-prompting mini.
- Escalate to `gpt-5.4` for long-context, evidence-heavy, or multi-step agent workflows; escalate to `gpt-5.5` only when quality still falls short.

### GPT-5.3 Codex

- Use for agentic coding when the environment resembles Codex CLI: file tools, shell, apply patch, plan tool, and validation commands.
- Less expensive than `gpt-5.5` for input/output in the current registry and specialized for autonomous coding.
- Good for autonomous multi-hour coding rollouts with `medium` as a general default and `high` or `xhigh` for the hardest tasks.
- Ensure the harness preserves `phase`; dropping it can degrade long-running or preamble-heavy behavior.
- Avoid process-heavy upfront plans that interrupt rollout unless the user asked for planning.

## Reasoning Effort

- `none`: fast transforms, extraction, classification, routing, simple workflow steps.
- `low`: latency-sensitive tasks with some instruction complexity or light judgment.
- `medium`: default for coding, planning, reviews, synthesis, and most tool workflows.
- `high`: complex research, ambiguous architecture, security-sensitive reasoning, difficult debugging.
- `xhigh`: reserve for exceptional long-horizon work where evals show clear benefit.

Treat effort as a last-mile tuning knob, not the primary quality fix. Before raising effort, first improve the prompt with a clearer output contract, completion criteria, retrieval budget, validation loop, or tool persistence rules. For high-spend systems, measure accuracy, latency, total output tokens, reasoning tokens, and cache-read tokens before standardizing a setting.

## Cost And Quality Controls

- Use evals or representative golden examples before standardizing on `gpt-5.5` or `high` reasoning.
- Prefer Structured Outputs over prompt-only schema descriptions when a strict format matters.
- Use `text.verbosity` for answer length; do not raise reasoning effort just to get a longer or shorter final answer.
- Use `max_output_tokens` to bound worst-case reasoning plus final-output spend, but leave enough room for hard tasks to avoid incomplete responses.
- For repeated long prompts, keep stable instructions and reference material first, put dynamic user context last, and track cached-token usage.
- For tool-heavy agents, put most tool-specific guidance in tool descriptions and preserve Responses state with `previous_response_id` or original assistant items including `phase`.

## Answer Shape

When advising a user, give:

1. Recommended model and reasoning effort.
2. Cost posture: why the model is worth its price or why a cheaper model is sufficient.
3. Why it fits the task.
4. When to choose the runner-up instead.
5. Any prompt or harness requirement that matters.

Keep recommendations decisive. If the user gives only a broad category, choose a safe default and state the assumption.

When producing or reviewing a prompt, give the prompt or concrete edits first, then a brief rationale. Preserve the user's product contract, safety/privacy constraints, output schema, and known eval behavior unless explicitly asked to change them.
