---
name: thread-contract
description: The artifact contract for thread synthesis — the bucket taxonomy, citation form, and the exact shape of a thread session file and of the current-state digest. Use when writing a thread session file from a dossier or regenerating a thread digest from session files.
---

# thread-contract

You produce one durable artifact for a thread and return it as **plain Markdown text** — the orchestrator writes the file, you never do. Two artifacts share this contract:

- **Session file** — one session distilled, built from the **dossier** you are handed (a gatherer's cited extraction of that session). You cannot see the raw transcript, so carry only what the dossier states and cite exactly what it cites; never invent to fill a gap.
- **Digest** — the thread's current state, reconciled from all its session files.

**Templates fix structure, not length.** Use the sections, ordering, and format shown, but let each run as long or short as the material genuinely warrants. Never pad a section, never cap one, and never add process or meta narration — no "regenerated from session files", no current-state headers or footers. The reader wants the substance, not a description of how the file was made.

## Buckets

Each carries a Title-Case header in the session file. Five are **events** — something that happened at a time; three are **state**.

| Header | Kind | What goes in — and the boundary |
| --- | --- | --- |
| `## Decisions` | event | A choice made *and its rationale*. For a contested one, capture the fork and **why the chosen path won**; the rejected alternative lives here. Boundary vs. Intent: a decision is *settled*. |
| `## Learnings` | event | A fact discovered — a doc finding, a how-it-works realization, a test result. Boundary: now *known*, not *chosen* (Decision) or still *open* (Open Question). |
| `## Mistakes Fixed` | event | Something done wrong then corrected — what was wrong *and* the fix. Boundary vs. Issue: a mistake was *resolved*. |
| `## Issues` | event | A problem or blocker, resolved or open. Boundary: a state of the *work*, not a *question* about direction. |
| `## Open Questions` | event | A question raised but unanswered — a lifecycle, so a later answer is a new event, not an edit. |
| `## Intent & Vision` | state | The user's own voice, **near-verbatim**: the *why* (the problem, the reasoning they want kept) and their aspirational *vision*. Keep it even when it rambles — that thinking-aloud is what gets lost otherwise. |
| `## Artifacts Touched` | state | Files, configs, docs, infra created or edited — the session's footprint. |
| `## Sources` | state | External references consulted: docs, URLs, library/reference docs, tickets. |

## Session file

Pure Markdown, no YAML frontmatter: an H1 naming the session, two framing sections, then the buckets. The orchestrator — not you — records the session's title, source, and the synthesizer that produced it (your model and effort) in the manifest; you never write provenance into the file.

```markdown
# Session <id> — <title>

## Thread Relevance

Does it belong, and which subtopic of the charter — one short paragraph.

## Gaps

What the dossier did not cover — offset cut-offs, approximations, anything you could not verify.

## Decisions

- [2026-06-25 06:53] Use the contract rate card over list pricing — the customer is billed at negotiated rates, so list pricing overstates cost. (32014030 · turn 4)

## Intent & Vision

- [2026-06-25 06:50] "We need to know what our cost usage is in the different areas…" — the user wants per-product attribution, not one aggregate number. (32014030 · turn 1)
```

- **Output discipline.** Emit the file exactly as shown and nothing else: begin at the `# Session` H1, end at the last bucket line. No code fences around it, no preamble, no "file generated" trailer, no narration about what you did.
- **`## Thread Relevance` and `## Gaps` come first**, as short prose — they frame the extraction, not the timeline, so they carry no timestamps or citations and never reach `log.md`.
- **Citation is mandatory** on every bucket bullet. `(<session-id> · turn N)` for Claude Code, `(<session-id> · <part-id>)` for OpenCode. The session id is never optional — a bare turn number is unresolvable once sessions merge. Every bullet, event or state, opens with a `[YYYY-MM-DD HH:MM]` timestamp.
- **Omit a bucket only if genuinely empty** — the session file is the raw extraction, and empty headers are clutter here.
- **Record only what this session knew.** You see one session's dossier, not the rest of the thread, so never reach across sessions or mark another's facts superseded — that reconciliation is the digest's job. Each session file is a faithful record of its own session.

## Digest

The current-state read model — the one file someone opens to pick the thread back up. Reconciled from the session files; it reconciles, it does not concatenate.

```markdown
# Digest — <slug>

## Current State
<where the thread stands now, in prose>

## Design
<ASCII diagram — only when the thread describes a structure; omit otherwise>

## Key Decisions
- <current decisions only>

## Open Questions
- <only those still open>
None.

## Intent
<the why, reconciled across sessions into one coherent account of the user's motivation>

## Vision
<where the user currently thinks this heads — their aspiration, not a commitment; note how it shifted>

## Direction
<concrete next steps>

## Sources
- <every external reference, collated from all Sources buckets and deduplicated>
```

- **Stable skeleton, explicit `None.`** Unlike the session file, the digest keeps every content section even when empty and writes `None.` — "no open questions" is itself informative, and a fixed section list keeps the digest scannable run to run. The one exception is `## Design`: the diagram is a *format*, not a bucket, so omit the whole section when there is nothing spatial to show.
- **Reconcile across sessions; newest wins.** Read the session files in time order. Where a later session overturns an earlier decision or answers an open question, the digest shows only the current state — the overturned decision drops from Key Decisions, the answered question drops from Open Questions. History is never lost: it stays in the session files; the digest is just the present.
- **Intent vs. Vision vs. Direction.** Intent is the *why* (the problem, the motivation). Vision is *where the user thinks this heads* — an aspiration that may shift as the work lands, and the digest notes that shift. Direction is the *concrete next steps*. Do not harden Vision into a plan or collapse it into Direction.
