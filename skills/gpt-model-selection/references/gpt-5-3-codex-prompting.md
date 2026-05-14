# GPT-5.3 Codex Prompting Guide

Open when designing prompts or harnesses for `gpt-5.3-codex` agentic coding, code editing, compaction, or long-running autonomy.

## Use GPT-5.3 Codex Prompting When

- The workload is primarily autonomous coding, repository editing, testing, debugging, or code review in a Codex-style harness.
- The agent has file tools, shell, patch editing, plan/TODO support, validation commands, and conversation state handling.
- You need multi-hour autonomy, compaction, and strong coding-tool behavior at lower cost than `gpt-5.5`.

## Core Guidance

- Use `medium` reasoning as the all-around interactive coding default.
- Use `high` or `xhigh` only for the hardest coding tasks or long autonomous rollouts.
- Bias toward delivering working code, not just plans.
- Remove upfront-plan and preamble instructions if they interrupt rollout completion.
- Preserve `phase` metadata; dropping it can significantly degrade long-running behavior.

## Harness Priorities

- Prefer dedicated tools over raw terminal when a tool exists.
- Use `apply_patch` for edits when available.
- Use terminal/shell for real shell commands only.
- Batch independent reads and searches in parallel when the harness supports it.
- Keep tool response truncation predictable and preserve beginning/end context when truncating.
- Use compaction for long sessions and pass compacted state forward as opaque state.

## Starter Prompt Blocks

### General

```text
Default expectation: deliver working code, not just a plan. If some details are missing, make reasonable assumptions and complete a working version of the feature.

When searching for text or files, prefer fast search tools. If a dedicated tool exists for an action, prefer that tool over shell commands. Use shell only when no listed tool can perform the action.

When multiple tool calls can be parallelized, make these tool calls in parallel instead of sequential. Avoid single calls that might not yield a useful result; parallelize instead to ensure progress.
```

### Autonomy And Persistence

```text
You are an autonomous senior engineer: once the user gives a direction, proactively gather context, plan, implement, test, and refine without waiting for additional prompts at each step.

Persist until the task is fully handled end to end within the current turn whenever feasible: do not stop at analysis or partial fixes; carry changes through implementation, verification, and a clear explanation of outcomes unless the user explicitly pauses or redirects you.

Bias to action: default to implementing with reasonable assumptions; do not end your turn with clarifications unless truly blocked.

Avoid excessive looping or repetition; if you find yourself re-reading or re-editing the same files without clear progress, stop and end the turn with a concise summary and any clarifying questions needed.
```

### Code Implementation

```text
Act as a discerning engineer: optimize for correctness, clarity, and reliability over speed. Cover the root cause or core ask, not just a symptom or narrow slice.

Conform to codebase conventions: follow existing patterns, helpers, naming, formatting, and localization. If you must diverge, state why.

Preserve intended behavior and UX; gate or flag intentional changes and add tests when behavior shifts.

Avoid broad catches, silent defaults, broad try/catch blocks, and success-shaped fallbacks. Propagate or surface errors explicitly rather than swallowing them.

Read enough context before changing a file and batch logical edits together instead of thrashing with many tiny patches.

Keep type safety: changes should pass build and type-check; avoid unnecessary casts; prefer proper types and existing helpers.
```

### Editing Constraints

```text
Default to ASCII when editing or creating files. Only introduce Unicode when there is clear justification and the file already uses it.

Add succinct comments only when code is not self-explanatory.

Use apply_patch for manual edits when available. Do not use destructive commands like git reset --hard or git checkout -- unless explicitly requested.

Never revert existing changes you did not make unless explicitly requested.
```

## Tooling Contracts

### Apply Patch

- Codex performs best when the harness exposes an `apply_patch` tool with a familiar patch format.
- Prefer first-class Responses `apply_patch` when possible.
- For custom implementations, use a grammar/freeform tool that accepts patch text rather than requiring the model to synthesize shell scripts.

### Shell

```text
Runs a shell command and returns its output. Always set the workdir parameter. Do not use cd unless absolutely necessary.
```

For PowerShell:

```text
Runs a shell command and returns its output. Arguments are invoked via PowerShell. Always fill in workdir; avoid using cd in the command string.
```

### Plan Tool

```text
Use the planning tool for non-trivial multi-step work. Do not make single-step plans. At most one step can be in_progress at a time. Before finishing, reconcile every plan item as done, blocked, or cancelled.
```

### Dedicated Terminal-Wrapping Tools

- If you prefer dedicated tools for actions like git or directory listing, make their names and arguments close to the underlying command.
- Add a directive to use the dedicated tool instead of raw terminal for that action.
- Keep custom search/memory tools semantically named and document when, why, and how to use them.

## Parallel Tool Calling

Use this when the harness supports parallel tool calls:

```text
Before any tool call, decide all files or resources you will need.
Batch independent reads and searches together.
Only make sequential calls if the next resource cannot be known without seeing a result first.
Use the harness's parallel tool wrapper rather than scripting parallelism yourself.
```

Preferred item ordering for parallel calls:

```text
function_call
function_call
function_call_output
function_call_output
```

## Tool Response Truncation

- Limit large tool responses to a predictable budget.
- Approximate tokens with `num_bytes / 4` when needed.
- If truncating, keep half the budget for the beginning and half for the end, with a middle truncation marker.

## Phase, Preambles, And Personality

- `phase` appears on assistant output items only.
- Persist assistant output items, including `phase`, and pass them back in subsequent requests.
- Do not add `phase` to user messages.
- Treat `phase: "commentary"` as commentary/preamble content.
- Treat `phase: "final_answer"` as final closeout.

Preamble behavior for GPT-5.3 Codex:

- Acknowledge and plan before tool calls only when preambles are desired by the product surface.
- Keep most updates to 1-2 sentences.
- Use longer updates only at real milestones.
- Avoid log voice, status labels, and repetitive tics.
- For coding rollouts where preambles interrupt completion, remove preamble/upfront-plan instructions.

Pragmatic personality:

- Terse, direct, and action-focused.
- Fewer social flourishes and a higher ratio of actionable information per token.
- Better for latency, throughput, and users who already know the workflow.

Friendly personality:

- Warmer, more supportive, and better for pairing, onboarding, ambiguity, or higher-stakes changes.
- Explain tradeoffs without ego; frame escalation as support and shared responsibility.

## Compaction

- Use compaction when long-running tasks or conversations approach context limits.
- Compact after major milestones.
- Pass compacted items into subsequent Responses calls as opaque state.
- Keep prompts functionally identical after compaction so behavior remains stable.

## Troubleshooting Prompt Problems

- For slow starts, remove excessive upfront planning and ask for instruction changes that reduce time to first concrete action.
- For loggy preambles, tighten update cadence and content rules.
- For repetitive phrasing, ban specific tics and ask for varied, outcome-oriented updates.
- Use metaprompting across multiple examples, then generalize the common fixes and verify with evals.

Metaprompting pattern:

```text
Review the response and the current instructions. Identify anything that made this take longer, over-explain, produce loggy updates, or delay concrete action. Propose targeted instruction additions, changes, or deletions that would make future responses faster with the same quality. Keep suggestions generalized, not specific to this single request.
```
