## Why

Thread session files go stale: a session keeps growing after it was ingested, but the thread has no record of where it last read, so the only way to fold in new work is to re-ingest the id by hand — and `ingest` has no idea which already-ingested sessions have drifted. We want threads to stay current with minimal token spend by detecting growth deterministically and refreshing only what changed, in the same pass that already re-runs the digest.

## What Changes

- Record a per-session **watermark** (`message_count`, `last_message_id`, `last_activity_at`) on each manifest session-ledger entry, computed deterministically by TS reading the host session stores — a new capability, since TS currently delegates all session reading to sandboxed agents.
- On `ingest` and `refresh`, recompute the watermark for every existing thread session (free — no agent dispatch) before any dispatch, and **auto-refresh** the changed sessions before the single digest pass; the changed and vanished/shrank sets are reported in the command output.
- Split the two intents into distinct verbs: `ingest <ids...>` requires at least one named session (and still auto-refreshes drifted siblings), while a new `refresh` command is the no-id entry that folds in only drifted sessions and treats "nothing drifted" as a successful no-op. `refresh --all` forces a full re-gather and re-synthesis of every present session (skipping vanished ones) for rebuilds after a charter or model change.
- Add a global `update_strategy: "full" | "delta"` thread config selecting how a changed session is refreshed: `full` re-reads and re-synthesizes the whole session; `delta` reads only messages after the watermark and revises the existing session file. The field is optional (no parse-time default) so a child profile inherits the parent's value, and resolves to `full` when unset.
- A previously-ingested session that vanished or shrank in the store (lost cursor / lower count) is treated as not-stale: its session file is left untouched and noted.

## Capabilities

### New Capabilities
- `thread-session-watermarks`: deterministic per-session watermark capture, ingest/refresh-time staleness detection and auto-refresh of changed sessions, the dedicated `refresh` command (with `--all` force rebuild) split from an ids-required `ingest`, and the `full`/`delta` update-strategy config that governs how a changed session is re-synthesized.

### Modified Capabilities
<!-- The thread capability has no existing spec under openspec/specs/; nothing to modify. -->

## Impact

- **Config schema**: `src/core/manifests.ts` `profileThreadSchema` gains `update_strategy` as a sibling of `defaults`.
- **Manifest schema**: `schemas/thread-manifest.schema.json` and `src/thread/schema.ts` session entries gain three optional watermark fields (existing manifests must still parse).
- **New module**: host-side tail-signature reader for the claude-code (`~/.claude/projects/*/<id>.jsonl`) and opencode (`~/.local/share/opencode/opencode.db`) stores — couples TS to both store layouts.
- **Ingest flow**: `src/thread/ingest.ts` / `src/thread/storage.ts` gain staleness detection, watermark capture after synthesize, and auto-refresh of changed sessions; the digest still runs once.
- **CLI**: `mfz thread ingest` now requires `<ids...>`; a new `mfz thread refresh --thread <slug> [--all]` command shares the ingest core. The changed/vanished sets are reported in the command output (after the run) rather than pre-dispatch.
- No change to the digest, run-ledger, observability, or destination-sync paths.
