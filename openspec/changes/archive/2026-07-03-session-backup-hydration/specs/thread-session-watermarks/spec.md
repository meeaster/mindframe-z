## MODIFIED Requirements

### Requirement: Per-session watermark capture

The system SHALL record a watermark for each thread session on its manifest ledger entry, consisting of `message_count`, `last_message_id`, and `last_activity_at`. The watermark SHALL be computed deterministically by reading the host session store (not reported by an agent), and SHALL be captured after a session's synthesize step succeeds, reflecting the session state as of that synthesis. When a session is absent from its host store but a hydrated copy exists in the archive-cache, the watermark SHALL be computed from that cached copy — the only source change the archive fallback introduces. All three fields SHALL be optional in the manifest schema so that manifests written before this change continue to parse.

#### Scenario: Watermark written after successful synthesis

- **WHEN** a session is gathered and synthesized during ingest
- **THEN** its manifest ledger entry records `message_count`, `last_message_id`, and `last_activity_at` read from the host store at that time

#### Scenario: Existing manifest without watermarks still loads

- **WHEN** a manifest whose session entries predate this change is read
- **THEN** it parses successfully with the watermark fields absent

#### Scenario: Watermark computed from the host store

- **WHEN** a claude-code session watermark is computed
- **THEN** it is derived from the session transcript at `~/.claude/projects/*/<id>.jsonl` (last message id, line count, last activity)
- **WHEN** an opencode session watermark is computed
- **THEN** it is derived from `~/.local/share/opencode/opencode.db` (last message id, message count, max `time_created`) without dispatching an agent

#### Scenario: Watermark computed from a hydrated cache copy

- **WHEN** a session is absent from its host store but present in the archive-cache
- **THEN** its watermark is computed from the cached copy — a claude-code `.jsonl` via the transcript signature, and an opencode archived export JSON via `tailSignatureFromExport` (`message_count` from the message array, last id and time from the final message)

### Requirement: Stable handling of vanished or shrank sessions

When a previously-ingested session is absent from its host store entirely, the system SHALL attempt to hydrate it from a readable archive; if hydration yields a copy whose watermark matches or advances the stored cursor, the session is refreshed from the cached copy. If no archive copy is available, or the archive copy is older than the stored cursor (the `stale-recover` edge, which occurs when the session's final edits were never backed up before deletion), the system SHALL treat the session as not-stale, leave its session file untouched, and note the condition rather than re-synthesizing from a broken cursor or deleting the file. When a session is still present locally but can no longer be matched against its stored watermark — its `last_message_id` is absent from the transcript, or its current `message_count` is lower than the stored value — the system SHALL treat it as not-stale and leave it untouched with **no archive consult**; hydration is for absent sessions only. The `stale-recover` edge SHALL be accepted with no special-case code beyond an optional one-line "archived copy predates cursor" warning.

#### Scenario: Session deleted from the store but recoverable from archive

- **WHEN** a session in the manifest no longer exists in the host store and a readable archive holds a copy that matches or advances the stored cursor
- **THEN** it is hydrated into the archive-cache and refreshed from the cached copy

#### Scenario: Session deleted from the store and not in any archive

- **WHEN** a session in the manifest no longer exists in the host store and no readable archive holds it
- **THEN** its session file is left unchanged and the condition is noted, with no refresh dispatched

#### Scenario: Archived copy predates the stored cursor (stale-recover)

- **WHEN** a vanished session is hydrated but the archived copy's watermark is older than the stored ledger cursor
- **THEN** the session is treated as not-stale, its file is left unchanged, the condition is noted (optionally with a one-line warning), and no refresh is dispatched

#### Scenario: Session shrank below its stored count

- **WHEN** a session present in the host store has a current `message_count` lower than its stored watermark or its stored `last_message_id` is no longer present
- **THEN** the session is treated as not-stale, its file is left unchanged, the condition is noted, and no archive read is performed
