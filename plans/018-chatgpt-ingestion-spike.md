# Plan 018: Spike ChatGPT session ingestion — determine whether the watermark/sweep model can apply (design/spike)

> **Executor instructions**: This is a **spike plan** — the deliverable is a
> written design note with a recommendation, not production code. Follow the
> steps, honor the STOP conditions. When done, update the status row in
> `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `grep -rn "chatgpt" src/ --include='*.ts' -il`
> If ChatGPT support already exists in source, this plan is stale; STOP.

## Status

- **Priority**: P3
- **Effort**: M (coarse — investigation-bounded)
- **Risk**: MED (the open question is real: no live local store exists for ChatGPT)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `ba63dbf`, 2026-07-06

## Why this matters

The thread system's value proposition is cross-harness distillation, and `ARCHITECTURE.md` explicitly lists "ChatGPT ingestion" among not-yet-implemented thread features. The architecture accommodates a new source cheaply at the identity level — sessions are source-qualified `source:id` (`CONTEXT.md` glossary; `src/thread/verdicts.ts:44-56` hardcodes the current pair) — but the sweep/watermark model assumes a **live local host store** (files/sqlite readable at any time, cheap "source signals" from mtimes). ChatGPT has no such store; ingestion likely rides on exported archives. Whether that breaks sweep/triage (making ChatGPT import-only) or can be adapted is the design question to answer *before* building anything.

## Current state

What the current two sources provide, which a ChatGPT source must map onto or explicitly opt out of:

- **Identity**: `parseSourceQualifiedId` (`src/thread/verdicts.ts:48-56`) accepts only `"claude-code" | "opencode"`; the `ThreadHarness` type in `src/core/manifests.ts` gates schemas, personas, and dispatch.
- **Watermark** (`src/thread/watermark.ts:12-16`): `{ message_count, last_message_id, last_activity_at }` — a tail signature read cheaply from the host store; drives member drift detection and verdict pinning.
- **Source signal** (`CONTEXT.md`): per-session freshness (file mtime / store row times) used to pick sweep candidates without reading transcripts.
- **Statuses** (`watermark.ts:18-24`): `changed | unchanged | vanished | shrank` — `vanished` triggers hydration from the archive-cache; `shrank` is left untouched.
- **Reading**: dispatch agents read transcripts via read-only mounts (`/mnt/claude-sessions`, `/mnt/opencode-data` — `src/thread/runner.ts:369-392`); the `agent-sessions` skill resolves stores from those mounts. Hydrated (vanished) sessions are served from `~/.mindframe-z/archive-cache` (`src/thread/runner.ts:36-40`).
- **Backup precedent**: `src/sessions/` backs up both harnesses' raw stores to S3; `archives` (raw sessions) vs thread `destinations` (synthesized store) is a load-bearing distinction (`AGENTS.md`).
- **Glossary discipline**: `CONTEXT.md` defines Baseline/Quiescence/Triage/Refresh semantics — the design note must use these terms and state, per concept, whether it applies to an export-based source.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Confirm no existing support | `grep -rni "chatgpt" src/ shared/ profiles/` | no source hits |
| Build/tests (untouched) | `pnpm test` | all pass |

## Suggested executor toolkit

- If a ChatGPT data export is available locally (ask the operator; typical shape: `conversations.json` inside the export zip), examine it directly — the real schema beats recollection. If not available, document the expected export shape from public knowledge and mark every schema claim as "verify against a real export".

## Scope

**In scope**:
- `docs/chatgpt-ingestion-spike.md` (create — the design note)

**Out of scope** (do NOT touch):
- Any `src/**` change — no reader, no schema widening, no `ThreadHarness` change.
- OpenAI API integrations (live fetch of conversations) — the spike may *mention* it as an option with trade-offs, but its baseline assumption is exports.
- Building the openspec change — the note may end by recommending one.

## Git workflow

- Branch: `advisor/018-chatgpt-spike`
- Commit: `docs(thread): chatgpt ingestion design spike`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Characterize the source material

Document what a ChatGPT export provides: per-conversation id, title, message tree (ChatGPT exports store a node *mapping*, not a flat list — note the implications for `message_count` and "last message"), timestamps, and what is absent (no incremental export, no stable local store, no mtime-style source signal). If a real export is on hand, verify against it and quote field names.

**Verify**: the note has a "Source material" section with the id/count/last-activity mapping table.

### Step 2: Map onto the thread model, concept by concept

For each: Watermark, Source signal, Baseline, Quiescence gate, Triage, Refresh, `vanished`/`shrank`, archive-cache hydration, dispatch mounts — state how an export-based source satisfies it, degrades it, or cannot support it. Key questions to answer explicitly:

1. Can a watermark be computed from an export such that a *newer* export detects growth? (Likely yes: message count + last node timestamp per conversation.)
2. What plays the role of the source signal when there is no store to stat — is "a new export was dropped in a directory" the event? Where would that directory live (`~/.mindframe-z/chatgpt-exports/`? an `archives`-style S3 path?).
3. Does the quiescence gate even mean anything for an export (always quiet by construction)?
4. How does a dispatch agent read a ChatGPT conversation — a new read-only mount of the export dir, or pre-conversion into the archive-cache format that hydration already serves (`<id>.jsonl`/`<id>.json` per `runner.ts:36-40`)? The archive-cache route reuses existing plumbing; evaluate it first.

**Verify**: every listed concept has a verdict: works / adapted / not-applicable-for-this-source.

### Step 3: Recommend

End the note with one of:
- **Import-only**: ChatGPT sessions enter via explicit `thread ingest` from a dropped export; no sweep/triage participation. (State what small schema changes this needs: `ThreadHarness` widening, a reader, archive-cache conversion.)
- **Sweepable-on-export**: exports land in a watched directory; each drop acts as the source signal and sweeps run against export contents.
- **Not worth it**: if step 1/2 reveal the export format is too lossy or the maintainer's usage wouldn't justify it — say so plainly.

Include a coarse effort estimate per option and the single biggest risk of each. If the recommendation is to proceed, sketch the openspec change proposal outline (capabilities touched: `ThreadHarness`, watermark reader, archive-cache converter, agent-sessions skill awareness).

**Verify**: the recommendation section names one option and its first implementation step.

## Test plan

None — no production code. `pnpm test` at the end proves the tree is untouched.

## Done criteria

- [ ] `docs/chatgpt-ingestion-spike.md` exists with: source-material table, concept-by-concept mapping, and a single recommendation with effort + risk
- [ ] Every schema claim is either verified against a real export or explicitly marked unverified
- [ ] `git diff --stat -- src shared profiles` → empty
- [ ] `pnpm test` exits 0
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- You discover in-progress ChatGPT work (openspec change, branch, stub module) the audit missed.
- The investigation pulls toward implementing "just a small reader" — that is the next change, not this spike.

## Maintenance notes

- If the recommendation is adopted, `parseSourceQualifiedId`'s hardcoded source union (`verdicts.ts:52`) and the `ThreadHarness` manifest type are the first code touchpoints — whoever implements should re-run `pnpm schemas` after widening manifest enums (repo rule).
- CONTEXT.md's glossary must gain any new terms the design introduces (e.g. "export drop") — same-change documentation per `AGENTS.md`.
