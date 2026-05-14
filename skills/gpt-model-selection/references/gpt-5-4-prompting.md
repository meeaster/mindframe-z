# GPT-5.4 Prompting Guide

Open when creating, reviewing, migrating, or tightening prompts for `gpt-5.4` or `gpt-5.4-mini`.

## Use GPT-5.4 Prompting When

- The workload needs production-grade agents, long-running execution, long-context analysis, structured output contracts, tool persistence, or evidence-rich synthesis.
- You want a lower-cost alternative to `gpt-5.5` while preserving strong mainline-model behavior.
- You are migrating a prompt stack and need one-change-at-a-time discipline.

## Where GPT-5.4 Is Strong

- Strong personality and tone adherence with less drift over long answers.
- Agentic workflow robustness, including multi-step work, retries, and end-to-end completion.
- Evidence-rich synthesis across long-context or multi-tool workflows.
- Modular, skill-based, and block-structured prompts when the contract is explicit.
- Batched or parallel tool calling while maintaining tool-call accuracy.
- Spreadsheet, finance, and Excel workflows needing formatting fidelity and self-verification.

## Where Explicit Prompting Helps

- Low-context tool routing early in a session.
- Dependency-aware workflows with prerequisites and downstream checks.
- Research tasks requiring disciplined source collection and citations.
- Irreversible or high-impact actions requiring verification before execution.
- Terminal or coding-agent environments where tool boundaries must stay clear.

Start with the smallest prompt that passes evals; add blocks only for measured failure modes.

## Compact Structured Output

```xml
<output_contract>
- Return exactly the sections requested, in the requested order.
- If the prompt defines a preamble, analysis block, or working section, do not treat it as extra output.
- Apply length limits only to the section they are intended for.
- If a format is required (JSON, Markdown, SQL, XML), output only that format.
</output_contract>

<verbosity_controls>
- Prefer concise, information-dense writing.
- Avoid repeating the user's request.
- Keep progress updates brief.
- Do not shorten the answer so aggressively that required evidence, reasoning, or completion checks are omitted.
</verbosity_controls>
```

## Follow-Through And Instruction Updates

```xml
<default_follow_through_policy>
- If the user's intent is clear and the next step is reversible and low-risk, proceed without asking.
- Ask permission only if the next step is irreversible, has external side effects, or requires missing sensitive information or a choice that would materially change the outcome.
- If proceeding, briefly state what you did and what remains optional.
</default_follow_through_policy>
```

```xml
<instruction_priority>
- User instructions override default style, tone, formatting, and initiative preferences.
- Safety, honesty, privacy, and permission constraints do not yield.
- If a newer user instruction conflicts with an earlier one, follow the newer instruction.
- Preserve earlier instructions that do not conflict.
</instruction_priority>
```

For mid-conversation changes, state scope, override, and carry-forward behavior.

## Tool Persistence And Dependencies

```xml
<tool_persistence_rules>
- Use tools whenever they materially improve correctness, completeness, or grounding.
- Do not stop early when another tool call is likely to materially improve correctness or completeness.
- Keep calling tools until the task is complete and verification passes.
- If a tool returns empty or partial results, retry with a different strategy.
</tool_persistence_rules>
```

```xml
<dependency_checks>
- Before taking an action, check whether prerequisite discovery, lookup, or memory retrieval steps are required.
- Do not skip prerequisite steps just because the intended final action seems obvious.
- If the task depends on the output of a prior step, resolve that dependency first.
</dependency_checks>
```

```xml
<parallel_tool_calling>
- When multiple retrieval or lookup steps are independent, prefer parallel tool calls to reduce wall-clock time.
- Do not parallelize steps that have prerequisite dependencies or where one result determines the next action.
- After parallel retrieval, pause to synthesize the results before making more calls.
- Prefer selective parallelism: parallelize independent evidence gathering, not speculative or redundant tool use.
</parallel_tool_calling>
```

## Completeness And Recovery

```xml
<completeness_contract>
- Treat the task as incomplete until all requested items are covered or explicitly marked [blocked].
- Keep an internal checklist of required deliverables.
- For lists, batches, or paginated results, determine expected scope when possible, track processed items or pages, and confirm coverage before finalizing.
- If any item is blocked by missing data, mark it [blocked] and state exactly what is missing.
</completeness_contract>
```

```xml
<empty_result_recovery>
If a lookup returns empty, partial, or suspiciously narrow results:
- do not immediately conclude that no results exist,
- try one or two fallback strategies such as alternate query wording, broader filters, prerequisite lookup, or an alternate source/tool,
- only then report that no results were found, along with what you tried.
</empty_result_recovery>
```

## Verification And Action Safety

```xml
<verification_loop>
Before finalizing:
- Check correctness: does the output satisfy every requirement?
- Check grounding: are factual claims backed by the provided context or tool outputs?
- Check formatting: does the output match the requested schema or style?
- Check safety and irreversibility: if the next step has external side effects, ask permission first.
</verification_loop>
```

```xml
<missing_context_gating>
- If required context is missing, do NOT guess.
- Prefer the appropriate lookup tool when the missing context is retrievable; ask a minimal clarifying question only when it is not.
- If you must proceed, label assumptions explicitly and choose a reversible action.
</missing_context_gating>
```

```xml
<action_safety>
- Pre-flight: summarize the intended action and parameters in 1-2 lines.
- Execute via tool.
- Post-flight: confirm the outcome and any validation that was performed.
</action_safety>
```

## Grounding, Citations, And Research

```xml
<citation_rules>
- Only cite sources retrieved in the current workflow.
- Never fabricate citations, URLs, IDs, or quote spans.
- Use exactly the citation format required by the host application.
- Attach citations to the specific claims they support, not only at the end.
</citation_rules>
```

```xml
<grounding_rules>
- Base claims only on provided context or tool outputs.
- If sources conflict, state the conflict explicitly and attribute each side.
- If the context is insufficient or irrelevant, narrow the answer or say you cannot support the claim.
- If a statement is an inference rather than a directly supported fact, label it as an inference.
</grounding_rules>
```

```xml
<research_mode>
- Do research in 3 passes:
  1) Plan: list 3-6 sub-questions to answer.
  2) Retrieve: search each sub-question and follow 1-2 second-order leads.
  3) Synthesize: resolve contradictions and write the final answer with citations.
- Stop only when more searching is unlikely to change the conclusion.
</research_mode>
```

## Strict Output Formats

```text
<structured_output_contract>
- Output only the requested format.
- Do not add prose or markdown fences unless they were requested.
- Validate that parentheses and brackets are balanced.
- Do not invent tables or fields.
- If required schema information is missing, ask for it or return an explicit error object.
</structured_output_contract>
```

## Coding And Terminal Agents

- Keep shell access and file-editing boundaries unambiguous.
- Prefer sparse, outcome-based user updates.
- Pair updates with explicit completion and verification requirements.

```xml
<user_updates_spec>
- Only update the user when starting a new major phase or when something changes the plan.
- Each update: 1 sentence on outcome + 1 sentence on next step.
- Do not narrate routine tool calls.
- Keep the user-facing status short; keep the work exhaustive.
</user_updates_spec>
```

```xml
<terminal_tool_hygiene>
- Only run shell commands via the terminal tool.
- Never "run" tool names as shell commands.
- If a patch or edit tool exists, use it directly; do not attempt it in bash.
- After changes, run a lightweight verification step such as ls, tests, or a build before declaring the task done.
</terminal_tool_hygiene>
```

## GPT-5.4 Mini

- Use `gpt-5.4-mini` for clearly structured, bounded, cost-sensitive work.
- It is more literal, makes fewer assumptions, and is weaker on implicit workflows and ambiguity handling.
- Put critical rules first.
- Specify full execution order when tool use or side effects matter.
- Use numbered steps, decision rules, and explicit action definitions rather than relying on `MUST` alone.
- Separate "do the action" from "report the action."
- Define ambiguity behavior: when to ask, abstain, or proceed.
- Specify packaging: answer length, follow-up question behavior, citation style, and section order.
- Use scoped final-output rules like `after the final JSON, output nothing further` rather than broad `output nothing else` instructions.

Default mini pattern:

1. Task
2. Critical rule
3. Exact step order
4. Edge cases or clarification behavior
5. Output format
6. One correct example

Do not include `gpt-5.4-nano` guidance in this skill.

## Reasoning And Migration

- Treat reasoning effort as a last-mile knob, not the primary way to improve quality.
- Most teams should default to `none`, `low`, or `medium`.
- Start `none` for workflow steps, field extraction, support triage, and short structured transforms.
- Start `medium` or higher for long-context synthesis, multi-document review, conflict resolution, and strategy writing.
- Before increasing effort, add a completeness contract, verification loop, and tool persistence rules.

Migration discipline:

- Switch model first.
- Pin `reasoning_effort` to preserve the current latency and quality profile.
- Run evals.
- Iterate with one prompt or effort change at a time.

## Phase And Compaction

- Use `phase` for long-running or tool-heavy agents that emit commentary before tool calls or final answers.
- Preserve original assistant `phase` values when replaying history.
- Do not add `phase` to user messages.
- Prefer `previous_response_id` when possible.
- With compaction, compact after major milestones, treat compacted items as opaque state, and keep prompts functionally identical after compaction.
