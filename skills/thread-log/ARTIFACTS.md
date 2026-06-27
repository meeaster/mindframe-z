# Thread-log Artifacts — the file contract

The shape of every file a thread holds. INGEST.md is *how* the worker builds them; this is *what each one is*. **The worker reads this file in full before extracting** — it is the contract for every file written in steps 4–6. The plan phase, Read mode, and the gatherer do not read it (the worker hands the gatherer only the bucket shapes its dossier must feed).

**Templates fix structure, not length.** Use the sections, ordering, and format shown — bullets where bullets, a table where a table, an ASCII diagram where one is called for — but let content run as long or short as the material genuinely warrants. A thread with ten sessions has a longer Intent than one with two; that is correct. **Never pad a section to fill it, never cap one to be brief, and never add process or meta narration** — no "regenerated from session files", no "current-state view" headers or footers. The consumer wants the substance, not a description of how the file was made. Process facts about a run live in `manifest.json` `runs[]`, never in the content.

## The four files, and how they relate

```
manifest.json ──charter + ledger──> defines WHICH sessions belong
      │
      ▼
sessions/<id>.md   (authored, one per session)   ← the event store, single source of truth
      │  regenerated whole each run, never hand-edited
      ├──> log.md     events only, one flat timestamp-ordered stream
      └──> digest.md  current-state read model (the file you open to resume)
```

`manifest.json` rules membership and records run telemetry. Each `sessions/<id>.md` is the durable, full extraction for one session — **never reduced**. `log.md` and `digest.md` are cheap derived views: if a view ever drops something, the detail is still in the session file. The session file feeds *both* views; the log orders the events, the digest states the present.

## Buckets — the canonical names

Each bucket has one name in the session file (a Title-Case section header) and, for the five **event** buckets, one lowercase tag in the log line. Defined once here; both files draw from this table.

| Session-file header | Log tag | Kind | What goes in — and the boundary |
| --- | --- | --- | --- |
| `## Decisions` | `decision` | event | A choice made *and its stated rationale*. For a contested one, capture the fork posed and **why the chosen path won** — the rejected alternative lives here, not in its own bucket. Boundary vs. Intent & Vision: a decision is *settled*; intent is *motivation*, which need not be. |
| `## Learnings` | `learning` | event | A fact discovered — a doc finding, a how-it-works realization, a test result. Boundary: something now *known*, not something *chosen* (Decision) or still *open* (Open Question). |
| `## Mistakes Fixed` | `mistake_fixed` | event | Something done wrong then corrected — what was wrong *and* the fix. Boundary vs. Issue: a mistake was *resolved*; an issue may still be open. |
| `## Issues` | `issue` | event | A problem or blocker, resolved or open. Boundary: a state of the *work* (something broke), not a *question* about direction (Open Question). |
| `## Open Questions` | `open_question` | event | A question raised but unanswered. The log records *when* it was raised; the digest shows which are *still* open — a lifecycle, so a later answer is a new event, not an edit. |
| `## Intent & Vision` | — | state | The user's own voice, **near-verbatim**: the *why* (the problem, what they are after, reasoning they want kept) and the *vision* (their evolving, aspirational picture of where this heads). Keep it even when it rambles — that scattered thinking-aloud is what gets lost otherwise. Not an event: it has no single moment. |
| `## Artifacts Touched` | — | state | Files, configs, docs, infra created or edited. State — a session's footprint. |
| `## Sources` | — | state | External references consulted: docs, URLs, library docs (Context7/DeepWiki), reference repos, Jira/Confluence. State — what the work leaned on. |

**Events vs. state.** The five event buckets are things that happened at a time; they feed `log.md`. Intent & Vision, Artifacts Touched, and Sources are state; they stay in the session file and feed the digest, never the log. Every bullet still carries a timestamp regardless — the digest reads Intent & Vision in time order to show how intent *evolved*.

Omit a bucket from a session file **only if genuinely empty** — the session file is the raw extraction; empty headers are clutter. (The digest's rule is the opposite; see below.)

## Session file — `sessions/<id>.md`

The authored extraction for one session. Slim YAML frontmatter carrying only **this extraction's provenance**, then the buckets. Membership facts (id, source, project, time_range) live in the manifest, not here — the only deliberate duplicate is `title`, kept so the file reads on its own without round-tripping to the manifest. **Quote freeform values** so a colon cannot break the YAML.

```markdown
---
title: "Find Datadog contract pricing PDF, convert to markdown, add as source"
thread_relevance: "Core in-scope: fulfills the open pricing question."
gaps: "Turn numbers approximate; records past 102 not read."
extracted_by: "opus-4.8 high"
---

# Session 32014030 — Integrate Tyler contract pricing into the skill

## Decisions

- [2026-06-25 06:53] Use the contract PDF rate card over public list pricing — the customer is billed at negotiated rates, so list pricing overstates cost. (32014030 · turn 4)

## Learnings

- [2026-06-25 06:50] Datadog MCP exposes no usage/billing endpoint — cost must be derived from the metrics API plus the rate card. (32014030 · turn 1)

## Intent & Vision

- [2026-06-25 06:50] "We need to know what our cost usage is in the different areas…" — the user wants per-product, per-customer attribution, not one aggregate number. (32014030 · turn 1)
```

- **`thread_relevance`** — does it belong, and which subtopic. **`gaps`** — what was *not* read (offset cut-offs, approximations). **`extracted_by`** — the synthesizer that produced this file, format `<model>-<version> <effort>` (e.g. `opus-4.8 high`, `sonnet-4.6 high`); names the synthesizer only, since fidelity tracks its capability — the cheap gatherer is irrelevant here. Constrained on purpose: a fixed shape makes extractions comparable across runs. (Run-level telemetry — model, duration, tokens — is in `manifest.json` `runs[]`; this per-file stamp survives even when a later run re-extracts only some sessions.)
- **Citation form:** `(<session-id> · turn N)` for Claude Code, `(<session-id> · <part-id>)` for OpenCode. The session id is **not** optional — a bare turn number is unresolvable once sessions merge into the log.
- **Superseding:** never edit a prior session file to fold in a later realization — each file records what *that* session knew. When a later session overturns an earlier decision, append `superseded_by: <session-id> · <citation>` to the earlier entry. The digest reads these links to show only current state; the log keeps both.
- **On Update,** append new entries to the existing file rather than rewriting it.

## Log — `log.md`

One flat, timestamp-ordered stream of every **event** bucket across all sessions. Regenerated whole each run. Atomic references, not detail — the detail is in the session file.

```
- [2026-06-24 09:35] decision (abf4103c · turn 12): one pipeline, two processor-group branches — OP branches via group filters, one worker fleet.
- [2026-06-25 06:50] learning (8a1138d3 · turn 1): Datadog MCP has no usage/billing endpoint; derive cost from metrics API + rate card.
- [2026-06-25 06:53] open_question (32014030 · turn 4): do negotiated rates cover the new ingestion SKU, or is it list-priced?
```

- One line per event: `- [YYYY-MM-DD HH:MM] <tag> (<citation>): <content>`. The `<tag>` is the lowercase log tag from the bucket table.
- **Flat — no grouping headers** (`### decisions`), no per-session sections. Sessions overlap in time; order strictly by timestamp regardless of which session a line came from. Grouping breaks the chronology that is the log's whole point.
- No bold timestamps, no `§` markers — just the line above.

## Digest — `digest.md`

The current-state read model: the one file you open to pick the thread back up. Synthesized from the session files (not the log), regenerated whole each run.

```markdown
# Digest — <slug>

## Current State
<where the thread stands now, in prose>

## Design
<ASCII diagram — only when the thread describes a structure; omit otherwise>

## Key Decisions
- <current decisions; drop any carrying a superseded_by>

## Open Questions
- <only those still open>
None.

## Intent
<the why, reconciled across sessions into one coherent account of the user's motivation>

## Vision
<where the user currently thinks this is heading — their aspiration, read in time order so it reflects the latest thinking and notes how it shifted>

## Direction
<concrete next steps>

## Sources
- <external references, collated from all Sources buckets and deduplicated>
```

- **Stable skeleton, explicit "None".** Unlike the session file, the digest keeps its content sections **even when empty** and writes `None.` — "no open questions" is itself informative (the thread is settled) and a fixed section list keeps the digest scannable run to run. **The one exception is `## Design`:** the ASCII diagram is a *format*, not a content bucket, so when there is nothing spatial to show, omit the section entirely rather than leave an empty one.
- **Intent vs. Vision vs. Direction.** Intent is the *why* (the problem, the motivation). Vision is *where the user thinks this heads* — an aspiration, **not a commitment**; it may shift as research lands, and the digest notes that shift. Direction is the *concrete next steps*. Do not harden Vision into a plan or collapse it into Direction.
- **Key Decisions** drops any decision carrying a `superseded_by`. **Open Questions** shows only those still open. **Sources** is the single deduplicated place to find every external reference the thread leaned on.

## Manifest — `manifest.json`

Charter, membership ledger, and run telemetry. Shape and field docs are in [manifest.schema.json](manifest.schema.json) — the single source for the manifest's structure; this section does not restate it. In short: the **charter** rules scope and purpose, `sessions[]` / `excluded[]` are the membership ledger, and `runs[]` is the append-only telemetry record (one entry per worker invocation). Ownership of who writes what is in [SKILL.md](SKILL.md).
