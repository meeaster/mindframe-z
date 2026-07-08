---
name: advisor
description: Consult a stronger advisor model that sees your full transcript, at key decision points. Use BEFORE substantive work (writing, editing, committing to an interpretation or approach), when you believe a task is complete, when stuck on a recurring error or non-converging approach, or when considering a change of approach. On tasks longer than a few steps, consult at least once before committing to an approach and once before declaring done. Backed by the `advisor` tool.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  invokes: advisor
---

# Advisor

You have access to an `advisor` tool backed by a stronger reviewer model. The
guidance below is reproduced verbatim from Claude Code's own advisor
instructions — follow it as written. When it says "call advisor()", call the
`advisor` tool (it takes no arguments; your full transcript is forwarded
automatically).

## When to call the advisor (verbatim)

Consult a stronger reviewer who sees your full conversation transcript.

No parameters. When you call advisor(), your entire history -- task, every tool call and result, your reasoning -- is automatically forwarded. The advisor sees exactly what you've done.

Call advisor BEFORE substantive work -- before writing, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, fetching a source, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.

Also call advisor:
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.
- When stuck -- errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.

On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling -- the advisor adds most of its value on the first call, before the approach crystallizes.

Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the paper states Y), adapt. A passing self-test is not evidence the advice is wrong -- it's evidence your test doesn't check what the advice is checking.

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call -- "I found X, you suggest Y, which constraint breaks the tie?" The advisor saw your evidence but may have underweighted it; a reconcile call is cheaper than committing to the wrong branch.

Before calling advisor(), write one sentence stating what the task asks and your initial read. The advisor reads your transcript; a one-line framing gives it something to respond to.

## How it works here

The `advisor` tool is provided by the `advisor` opencode plugin
(`opencode/plugins/advisor.ts`). On each call it forwards this session's full
transcript to a stronger model, which runs with no tools and returns advice
only. Set the advisor model with `OPENCODE_ADVISOR_MODEL="provider/model"`, or
`"provider/model@variant"` to pin a variant such as a reasoning-effort level
(default `anthropic/claude-opus-4-8`). For example, `openai/gpt-5.5@high`
selects GPT-5.5 at high reasoning effort (its variants are
`none`/`low`/`medium`/`high`/`xhigh`). The advisor should be at least as capable
as your main model. Each call re-reads the whole transcript, so it costs
advisor-model tokens on top of your own — which is why the guidance above
concentrates calls at decision points rather than every turn.
