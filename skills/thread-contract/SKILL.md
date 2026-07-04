---
name: thread-contract
description: The artifact contract for thread synthesis — the bucket taxonomy, citation form, and the exact shape of a thread session file and of the current-state digest. Use when writing a thread session file from a dossier or regenerating a thread digest from session files.
---

# thread-contract

You produce one durable artifact for a thread and return it as **plain Markdown text** — the orchestrator writes the file, you never do. Two artifacts share this contract:

- **Session file** — one session distilled, built from the **dossier** you are handed (a gatherer's cited extraction of that session). You cannot see the raw transcript, so carry only what the dossier states and cite exactly what it cites; never invent to fill a gap.
- **Digest** — the thread's current state, reconciled from all its session files.

**The charter is a topic hint, never a source.** You may also be handed the thread's charter — a one-line description of what the thread is about. It tells you *what to look for*; it is never a source of facts. Never lift a specific — a mechanism, field name, enum value, number, or decision — from the charter into the artifact. When your real source (the dossier for a session file, the session files for a digest) does not cover something the charter mentions, that is a Gap, not license to supply the charter's wording as if it were found. An empty or contentless source yields an artifact that says so, never one reconstructed from the charter.

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
| `## Intent & Vision` | state | The user's own voice, **near-verbatim** — the whole brain dump, not only the why and vision: the *why* (the problem, the reasoning they want kept), the aspirational *vision*, and their *opinions, theories, frustrations, and taste*. Keep it even when it rambles and the ideas are disjointed — that thinking-aloud is the first thing lost, and this session file is its one complete home. |
| `## Artifacts Touched` | state | Files, configs, docs, infra created or edited — the session's footprint. |
| `## Sources` | state | External references consulted: docs, URLs, library/reference docs, tickets. Carry each with its **address** — the URL, repo or file path, or ticket id the dossier recorded — so a future reader can reopen and re-evaluate it; a source the dossier named without an address is kept as the name alone, never a guessed link. Boundary vs. Artifacts Touched: *consulted*, not *produced* — a file or change directory this session created is an artifact, never a source. |

## Session file

Pure Markdown, no YAML frontmatter: an H1 naming the session, two framing sections, then the buckets. The orchestrator — not you — records the session's title, source, and the synthesizer that produced it (your model and effort) in the manifest; you never write provenance into the file.

```markdown
# Session <id> — <title>

## Thread Relevance

Does it belong, and which subtopic of the charter — one short paragraph.

## Gaps

What the dossier did not cover — offset cut-offs, approximations, anything you could not verify.

## Phases

- [2026-06-25 06:50 → 07:34] Watermark design — settled the deterministic TS-computed tail signature and the shrank/vanished split. (turns 1–18)
- [2026-06-25 07:34 → 07:52] CI flake triage (off-charter) — chased an unrelated flaky test before returning. (turns 19–24)

## Decisions

- [2026-06-25 06:53] Use the contract rate card over list pricing — the customer is billed at negotiated rates, so list pricing overstates cost. (32014030 · turn 4)

## Intent & Vision

- [2026-06-25 06:50] "We need to know what our cost usage is in the different areas…" — the user wants per-product attribution, not one aggregate number. (32014030 · turn 1)
```

- **Output discipline.** Emit the file exactly as shown and nothing else: begin at the `# Session` H1, end at the last bucket line. No code fences around it, no preamble, no "file generated" trailer, no narration about what you did.
- **`## Thread Relevance` and `## Gaps` come first**, as short prose — they frame the extraction, not the timeline, so they carry no timestamps or citations and never reach `log.md`.
- **`## Phases` maps the session's arc**, placed after `## Thread Relevance` / `## Gaps` and before the buckets. Like them it is a framing section — no per-bullet citations, and it never reaches `log.md` or the digest. One line per phase: `- [<start> → <end>] <Label> — <one-line description>. (turns N–M)` (part ids for OpenCode), with ` (off-charter)` appended to the label when the phase did not serve the charter. The dossier reports the phases with their boundary timestamps and turn/part ranges copied from the records — carry those verbatim, never invent a boundary. A single-focus session is one phase. On a **delta** revision you receive phases *of the delta*: when the delta's first phase continues the file's last phase, extend that last phase's end timestamp and range in place; otherwise append the new phase lines. Never rewrite or drop a phase already in the file — phases are append-only like the log.
- **Citation is mandatory** on every bucket bullet. `(<session-id> · turn N)` for Claude Code, `(<session-id> · <part-id>)` for OpenCode. The session id is never optional — a bare turn number is unresolvable once sessions merge. Every bullet, event or state, opens with a `[YYYY-MM-DD HH:MM]` timestamp.
- **Omit a bucket only if genuinely empty** — the session file is the raw extraction, and empty headers are clutter here.
- **Record only what this session knew.** You see one session's dossier, not the rest of the thread, so never reach across sessions or mark another's facts superseded — that reconciliation is the digest's job. Each session file is a faithful record of its own session.

## Digest

The current-state read model — the one file someone opens to pick the thread back up. Reconciled from the session files; it reconciles, it does not concatenate.

```markdown
# Digest — <slug>

## Current State
<where the thread stands now, in prose>

## Components
- **<work component>** — <what it is, in one line> · <where it stands>
- **Cross-cutting** — <stance or principle spanning every component>

## Direction
<concrete next steps>

## Open Questions
- <only those still open>
None.

## Key Decisions
- <current decisions only>

## Design
<ASCII diagram — only when the thread describes a structure; omit otherwise>

## Intent
<the why, reconciled across sessions into one coherent account of the user's motivation>

## Vision
<where the user currently thinks this heads — their aspiration, not a commitment; note how it shifted>

## Perspective
<the user's standing opinions, theories, frustrations, and taste — their scattered thinking reorganized into one cohesive account; note where a view shifted>
None.

## Sources
- <name> — <address: URL, repo or file path, or ticket id>
```

- **Prefer a reopenable address, and resolve local repos to their URL.** Each source carries the address the session files recorded — a URL, repo or file path, or ticket id — so a reader can reopen it; keep a source the sessions named without an address as the name alone, never a guessed link. When you are handed a local-repo lookup and a session cites one of those repos — by its name or by any path ending in that name, since a session may mount it at a different path than the lookup lists — record its upstream URL instead of the local path or bare name, the same source made reopenable.

- **Stable skeleton, explicit `None.`** Unlike the session file, the digest keeps every content section even when empty and writes `None.` — "no open questions" is itself informative, and a fixed section list keeps the digest scannable run to run. Two sections are exceptions, omitted entirely rather than written empty: `## Design` (the diagram is a *format*, not a bucket — drop it when nothing is spatial) and `## Components` (drop it only when the thread is genuinely single-concern — a thread with more than one distinct part, even a feature plus the bug fix found building it, still groups).
- **Action-first order, fixed every run.** The section order serves the reader picking the work back up: where it stands (Current State), how it breaks down (Components), what to do next (Direction), what is still unresolved (Open Questions), then the settled record (Key Decisions, Design) and the durable voice (Intent, Vision, Perspective), with Sources last. Hold this order every run — a predictable layout is what makes the digest scannable.
- **Components group the work; they don't re-list it.** When the initiative decomposes into parts, `## Components` clusters them — each one line: **name** — what it is · where it stands. It is a map, not a second copy of Key Decisions: name the piece and its essence, and leave the detailed decisions in Key Decisions, the next steps in Direction. Close with a single **Cross-cutting** entry for the principles that span every component (a fail-open stance, a single-source-of-truth rule) rather than force-fitting them into one. Each component's state reconciles newest-wins like everything else. A component is a thing being **built or designed** — never the scaffolding that files it: a spec or change directory is a `## Direction` pointer, not a component, and its files and artifact counts are never inventoried here.
- **Reconcile across sessions; newest wins.** Read the session files in time order. Where a later session overturns an earlier decision or answers an open question, the digest shows only the current state — the overturned decision drops from Key Decisions, the answered question drops from Open Questions. History is never lost: it stays in the session files; the digest is just the present.
- **The previous digest, when handed to you, anchors form — never facts.** It is a prior rendering, a non-source like the charter: reconcile the session files from scratch, then hold the render steady against it — keep its wording, section prose, bullet order, and its `## Design` diagram wherever the session files still support them, so an unchanged thread yields an unchanged digest. Where newer sessions add, overturn, or invalidate content, revise or drop it; never carry a fact the sessions no longer support. The diagram is not sacred — when newer sessions introduce structure a different diagram would capture better, redraw it.
- **Intent vs. Vision vs. Perspective vs. Direction.** Intent is the *why* (the problem, the motivation). Vision is *where the user thinks this heads* — an aspiration that may shift as the work lands, and the digest notes that shift. Perspective is *how the user sees the work* — their opinions, theories, frustrations, and taste. Direction is the *concrete next steps*. Do not harden Vision into a plan or collapse it into Direction.
- **Perspective reorganizes the ramble; it does not quote it.** Verbatim voice is the session file's job — the digest's `## Perspective` gathers the user's scattered, disjointed opinions, theories, frustrations, and taste across sessions and synthesizes them into one cohesive, readable account, grouped by theme where it helps. Accumulate rather than overturn — an opinion is not a decision; a genuinely changed view is a noted *shift*, not a deletion. Capture only what the sessions support; never invent a take to fill the section.
- **Scaffolding gets one durable pointer, never an inventory.** Process scaffolding — a change or spec directory (e.g. OpenSpec), an ADR, a handoff doc, a working branch, a ticket — is *where the work is filed*, not the work itself. Name it once, in `## Direction`, as the resume point, abstracted to the artifact (e.g. `tasks live in <the change>/tasks.md`) — never its file tree, an artifact count, or a non-durable path (`/tmp/…`, a throwaway handoff). It never repeats across sections, and a file the thread *produced* never appears in `## Sources` — not even when a later session consults that same artifact as its ground truth; a thread's own output is cited once as the resume pointer, never laundered into a source.
