## ADDED Requirements

### Requirement: Per-session watermark capture

The system SHALL record a watermark for each thread session on its manifest ledger entry, consisting of `message_count`, `last_message_id`, and `last_activity_at`. The watermark SHALL be computed deterministically by reading the host session store (not reported by an agent), and SHALL be captured after a session's synthesize step succeeds, reflecting the session state as of that synthesis. All three fields SHALL be optional in the manifest schema so that manifests written before this change continue to parse.

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

### Requirement: Ingest-time staleness detection

On `ingest`, the system SHALL recompute the current watermark for every session already in the thread, without dispatching any agent, and SHALL classify a session as changed when its current `message_count` or `last_message_id` differs from the stored watermark. The set of changed sessions SHALL be printed before any refresh work is dispatched.

#### Scenario: Unchanged session is skipped

- **WHEN** a session's current watermark matches its stored watermark
- **THEN** the session is not re-gathered, re-synthesized, or otherwise charged for

#### Scenario: Grown session is detected and reported

- **WHEN** a session's current `message_count` or `last_message_id` differs from its stored watermark
- **THEN** the session is included in the printed changed set before refresh dispatches begin

### Requirement: Auto-refresh changed sessions during ingest

The system SHALL refresh changed existing sessions within the same `ingest` invocation, alongside the explicitly named ids, and SHALL run the digest exactly once over the resulting session files. A separate refresh command SHALL NOT be required to fold in changed sessions.

#### Scenario: Changed sessions refreshed with named ids in one pass

- **WHEN** `ingest` is run with one or more named ids and the thread also has changed existing sessions
- **THEN** both the named ids and the changed sessions are re-synthesized, and the digest runs once over all current session files

#### Scenario: No named ids but existing sessions changed

- **WHEN** `ingest` is run and only existing sessions have changed
- **THEN** the changed sessions are refreshed and the digest runs once

### Requirement: Configurable update strategy

The thread configuration SHALL expose `update_strategy` with values `full` or `delta`, defaulting to `full`, located as a sibling of the thread `defaults` (not inside them). `full` SHALL re-read and re-synthesize the entire changed session. `delta` SHALL gather only the messages after the stored watermark and revise the existing session file from the prior file plus the delta.

#### Scenario: Default strategy is full

- **WHEN** no `update_strategy` is configured
- **THEN** changed sessions are refreshed by full re-read and re-synthesis

#### Scenario: Delta strategy reads only new messages

- **WHEN** `update_strategy` is `delta` and a changed session is refreshed
- **THEN** gather reads only messages after the stored `last_message_id`, and synthesize revises the existing session file rather than regenerating it from the whole transcript

### Requirement: Stable handling of vanished or shrank sessions

When a previously-ingested session can no longer be matched against its stored watermark — its `last_message_id` is absent from the store, or its current `message_count` is lower than the stored value — the system SHALL treat the session as not-stale, leave its session file untouched, and note the condition rather than re-synthesizing from a broken cursor or deleting the file.

#### Scenario: Session deleted from the store

- **WHEN** a session in the manifest no longer exists in the host store
- **THEN** its session file is left unchanged and the condition is noted, with no refresh dispatched

#### Scenario: Session shrank below its stored count

- **WHEN** a session's current `message_count` is lower than its stored watermark or its stored `last_message_id` is no longer present
- **THEN** the session is treated as not-stale, its file is left unchanged, and the condition is noted
