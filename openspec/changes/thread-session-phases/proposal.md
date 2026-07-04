# Thread Session Phases + Irrelevant-Delta Short-Circuit + Refusal-Guard Fix

## Why

An audit of real thread runs and session transcripts showed three gaps in the ingest pipeline: (1) sessions routinely contain several distinct work phases (design, implementation, side quests) but the session file gives no map of them, (2) a tracked session that grows only with off-charter noise — most damagingly the self-refresh loop, where running `mfz thread` commands inside a tracked session ticks its own watermark — was re-synthesized 7× wastefully in the `release-versioning` thread, and (3) a fabricated "session not found" gather refusal can still be synthesized and watermarked as valid for a present OpenCode session, permanently freezing that session file under watermark gating.

## What Changes

- **Phases section in session files.** The gather persona segments a session into dynamic phases keyed off the user's prose prompts (topic/mode shifts), each with start→end timestamps, a turn/part range, a one-line description, and an on/off-charter marker. The thread-contract gains a `## Phases` framing section — same tier as `## Thread Relevance` and `## Gaps`, so it never reaches `log.md` or the digest. On delta refreshes, phases extend or append; prior phases are never rewritten (gather only sees past the cursor).
- **Irrelevant-delta short-circuit.** Under `update_strategy: delta`, when the gathered delta contains no charter-relevant activity, gather returns an explicit sentinel; ingest then skips synthesize, advances the watermark, and leaves the session file untouched. The sentinel must be distinguishable from a gather failure — today a near-empty delta dossier trips the empty-dossier abort guard (`src/thread/ingest.ts:169`).
- **OpenCode refusal-guard fix.** The `dossierReportsMissing` guard (`src/thread/ingest.ts:178`) currently fires only when a `transcriptPath` was host-resolved, which never happens for present OpenCode sessions (sqlite route). The guard keys instead on host-confirmed presence — the host read this session's watermark moments earlier — so a refusal dossier for any present session aborts before synthesis regardless of harness.

Out of scope: flipping the `update_strategy` default to `delta` (watch delta behave first), and any chunk/segment data model in the manifest (rejected after research — compaction boundaries are a weak proxy for topic pivots; phases are descriptive only).

## Capabilities

### New Capabilities

- `thread-session-phases`: the Phases contract for thread session files — how gather segments a session into phases, the `## Phases` section shape and placement, the on/off-charter marker, and the extend-or-append rule under delta refreshes.

### Modified Capabilities

- `thread-session-watermarks`: two requirement changes — (a) under `delta`, a charter-irrelevant delta advances the watermark without synthesis or a file write (new short-circuit behavior in the delta-strategy requirement), and (b) a gather dossier reporting a host-confirmed-present session as missing aborts ingest before synthesis for both harnesses (generalizes the current transcript-path-gated guard).

## Impact

- `src/thread/personas.ts` — gather persona: phase segmentation + irrelevant-delta sentinel; synthesize persona: render/extend `## Phases`.
- `src/thread/ingest.ts` — sentinel branch (skip synthesize, advance watermark, no write); refusal guard keyed on watermark-confirmed presence; prompt updates.
- `skills/thread-contract/SKILL.md` — `## Phases` framing-section contract.
- `src/thread/ingest.test.ts` and related tests.
- `openspec/specs/thread-session-watermarks/spec.md` via delta spec.
- No manifest/schema changes; no CLI surface changes.
