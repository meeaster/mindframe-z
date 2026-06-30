## Why

Thread session files go stale: a session keeps growing after it was ingested, but the thread has no record of where it last read, so the only way to fold in new work is to re-ingest the id by hand — and `ingest` has no idea which already-ingested sessions have drifted. We want threads to stay current with minimal token spend by detecting growth deterministically and refreshing only what changed, in the same pass that already re-runs the digest.

## What Changes

- Record a per-session **watermark** (`message_count`, `last_message_id`, `last_activity_at`) on each manifest session-ledger entry, computed deterministically by TS reading the host session stores — a new capability, since TS currently delegates all session reading to sandboxed agents.
- On `ingest`, recompute the watermark for every existing thread session (free — no agent dispatch), print the set that changed, and **auto-refresh** the changed sessions alongside the explicitly-named ids before the single digest pass.
- Add a global `update_strategy: "full" | "delta"` thread config (default `full`) selecting how a changed session is refreshed: `full` re-reads and re-synthesizes the whole session; `delta` reads only messages after the watermark and revises the existing session file.
- A previously-ingested session that vanished or shrank in the store (lost cursor / lower count) is treated as not-stale: its session file is left untouched and noted.

## Capabilities

### New Capabilities
- `thread-session-watermarks`: deterministic per-session watermark capture, ingest-time staleness detection and auto-refresh of changed sessions, and the `full`/`delta` update-strategy config that governs how a changed session is re-synthesized.

### Modified Capabilities
<!-- The thread capability has no existing spec under openspec/specs/; nothing to modify. -->

## Impact

- **Config schema**: `src/core/manifests.ts` `profileThreadSchema` gains `update_strategy` as a sibling of `defaults`.
- **Manifest schema**: `schemas/thread-manifest.schema.json` and `src/thread/schema.ts` session entries gain three optional watermark fields (existing manifests must still parse).
- **New module**: host-side tail-signature reader for the claude-code (`~/.claude/projects/*/<id>.jsonl`) and opencode (`~/.local/share/opencode/opencode.db`) stores — couples TS to both store layouts.
- **Ingest flow**: `src/thread/ingest.ts` / `src/thread/storage.ts` gain staleness detection, watermark capture after synthesize, and auto-refresh of changed sessions; the digest still runs once.
- No change to the digest, run-ledger, observability, or destination-sync paths.
