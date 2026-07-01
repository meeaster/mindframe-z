## Context

Threads fold sessions into `sessions/<source>-<id>.md` via gather → synthesize, then a single digest reconciles all session files (`src/thread/ingest.ts`). The manifest ledger entry is `{ id, source, title, extracted_by }` with no notion of read position. Sessions are append-only and grow after ingest, so a thread silently drifts out of date and there is no signal for which sessions changed.

A structural fact constrains the design: **TS never reads session contents.** It mounts the host stores read-only into a docker sandbox and delegates all reading to agents via the `claude-code-sessions` / `opencode-sessions` skills (`src/thread/runner.ts`). TS only owns ledger fields it derives from agent output (e.g. it regexes `title` from synth text). Adding watermarks requires TS to read the stores directly for the first time.

Cost shape today: gather runs on the cheap model (default `claude-code:haiku@low`) and is the only step that reads raw sessions; synthesize and digest run on the expensive model but read bounded dossiers/files, not raw transcripts. So refresh cost is dominated by the sonnet synth/digest, which do not scale with raw session size.

## Goals / Non-Goals

**Goals:**
- Deterministically detect, for free, which already-ingested sessions have grown.
- Keep threads current by refreshing only changed sessions, in the same `ingest` pass that already re-runs the digest.
- Make the refresh strategy configurable without adding operational ceremony.

**Non-Goals:**
- Real-time or scheduled background refresh — refresh happens on `ingest`.
- A standalone refresh command (intentionally avoided; see Decisions).
- Per-thread or per-run strategy overrides — global config only for now.
- Full delta-path optimization of the synthesize prompt beyond what the spec requires (delta is an opt-in escape hatch, not the default path).

## Decisions

### Watermark = deterministic TS-computed tail signature, not agent-reported

TS computes `{ message_count, last_message_id, last_activity_at }` host-side. Alternative considered: have the gather agent report where it read. Rejected — an agent-reported watermark is non-deterministic and only known *after* paying for that session's dispatch, so it cannot gate spend. The whole value of the watermark is deciding what to refresh *before* dispatching, which requires a free, deterministic, pre-dispatch read. Accepted cost: TS gains a store-format reader (claude-code transcript layout + opencode `message` schema) — bounded to a tail signature, but new coupling and test surface.

### Default `full` re-synthesis; `delta` is opt-in

Measured the worst cases faithfully (gather persona, read-only toolset, broad charter, real models):
- Largest claude session (~125k content tok): **$0.10**, 11 turns, 54s, no context blowup.
- Largest opencode session (~1.44M content tok): **$0.24**, 37 turns, 2.7 min, no context blowup — the agent chunk-reads via sqlite and caches.

Full re-synthesis is therefore cheap even worst-case, and gives best fidelity (the synthesizer sees the whole session as one coherent whole). `delta` revises a prior summary from only the new tail, risking lost cross-session connections — so it is reserved for a future genuinely-pathological session and gated behind config. Alternative considered: a size-threshold hybrid that auto-switches to delta. Rejected as premature — the data shows no session currently needs it, and it adds a branch for a problem that does not exist yet.

### Auto-refresh folded into `ingest`, not a separate command

The digest re-runs on every `ingest` regardless (it reads all session files). Refreshing stale sessions in the same invocation means the digest runs **once** over already-current files. A separate refresh command would re-pay the digest a second time. So integration is both the user's stated goal ("keep the thread updated") and strictly cheaper. Detection is free, so auto-refresh is never wasteful; the changed set is printed before any spend so the operator sees what an ingest will cost.

### Config as a sibling of `defaults`, global only

`update_strategy` is a behavior mode, not a model selection, so it sits beside `defaults` in `profileThreadSchema` rather than inside `threadDefaultsSchema`. Global-only (no flag, no per-thread manifest field) keeps a single source of truth, consistent with the repo's "one clear implementation" preference; a per-run override can be added later if a real need appears.

## Risks / Trade-offs

- **TS coupled to store layouts** → keep the reader minimal (tail signature only) in one module with focused tests; it reads the same bytes the sandboxed agent sees, so no drift between detection and gather.
- **Delta fidelity loss** → default is `full`; `delta` is opt-in and documented as a tradeoff. Delta synthesize must be given the prior file explicitly so it revises rather than regenerates.
- **Unexpectedly large ingest when many sessions drifted** → the changed set is printed before refresh dispatches, surfacing the spend.
- **Store quirks** (compaction rewriting a transcript, opencode reverse-chronological ids, sessions deleted from the store) → the vanished/shrank rule treats an unmatchable cursor as not-stale and leaves the file untouched, so the thread stays stable.
- **`sqlite3` availability** → the opencode reader needs sqlite access; TS already mounts the db for agents, and the host reader can use sqlite directly (the dev host required a mise-installed `sqlite3`).

## Migration Plan

- Watermark fields are optional, so existing manifests parse unchanged and simply have no watermark until their next ingest.
- First `ingest` after the change captures watermarks for the sessions it touches; previously-ingested sessions gain a watermark the first time they are detected/refreshed. No backfill migration required.
- Rollback is config/code removal; the extra manifest fields are inert to older code paths that ignore them.

## Open Questions

- **Delta synthesize contract**: exact prompt shape for "revise this file from prior content + a delta dossier", and whether the `*-sessions` skills already support a "messages after id" read or need a prompt addition. Deferred to implementation since `full` is the default.
- **Activity timestamp source for claude-code**: confirm the transcript line field used for `last_activity_at` is stable across versions.
