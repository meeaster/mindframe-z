# thread-session-watermarks Specification

## Purpose
TBD - created by archiving change add-thread-session-watermarks. Update Purpose after archive.
## Requirements
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

On `ingest` and `refresh`, the system SHALL recompute the current watermark for every session already in the thread, without dispatching any agent, and SHALL classify a session as changed when its current `message_count` or `last_message_id` differs from the stored watermark. Detection SHALL run before any refresh work is dispatched, so unchanged sessions are never charged for. The resulting changed and vanished/shrank sets SHALL be reported in the command's output.

#### Scenario: Unchanged session is skipped

- **WHEN** a session's current watermark matches its stored watermark
- **THEN** the session is not re-gathered, re-synthesized, or otherwise charged for

#### Scenario: Grown session is detected and reported

- **WHEN** a session's current `message_count` or `last_message_id` differs from its stored watermark
- **THEN** the session is detected before any dispatch and included in the changed set reported in the command's output

### Requirement: Auto-refresh changed sessions

The system SHALL refresh changed existing sessions in the same invocation that folds them in — whether triggered by `ingest` (alongside explicitly named ids) or `refresh` (drift only) — and SHALL run the digest exactly once over the resulting session files.

#### Scenario: Changed sessions refreshed with named ids in one pass

- **WHEN** `ingest` is run with one or more named ids and the thread also has changed existing sessions
- **THEN** both the named ids and the changed sessions are re-synthesized, and the digest runs once over all current session files

### Requirement: Ingest requires a named session id

`ingest` SHALL require at least one named session id. Folding in drifted sessions with no id named is the responsibility of `refresh`, not a no-argument `ingest`.

#### Scenario: Ingest with no ids is rejected

- **WHEN** `ingest` is invoked with no session id
- **THEN** it fails with an error and dispatches nothing

### Requirement: Refresh command

The system SHALL provide `mfz thread refresh --thread <slug>` that recomputes every session's watermark, re-synthesizes only the drifted sessions, and runs the digest once — without requiring any named session id. When no session has drifted, `refresh` SHALL complete successfully as a no-op that dispatches nothing, rather than erroring. `refresh --all` SHALL force a full re-gather and re-synthesis of every present session regardless of watermark, skipping only sessions that have vanished from the store, and SHALL re-synthesize in full even when `update_strategy` is `delta`.

#### Scenario: Refresh folds in drifted sessions

- **WHEN** `refresh` is run and only existing sessions have changed
- **THEN** the changed sessions are refreshed and the digest runs once

#### Scenario: Refresh with nothing drifted is a no-op

- **WHEN** `refresh` is run and no session has drifted
- **THEN** it completes successfully without dispatching any agent and without erroring

#### Scenario: Force-refresh every session

- **WHEN** `refresh --all` is run
- **THEN** every present session is re-gathered and re-synthesized in full regardless of its watermark, sessions that vanished from the store are skipped, and the digest runs once

### Requirement: Configurable update strategy

The thread configuration SHALL expose `update_strategy` with values `full` or `delta`, located as a sibling of the thread `defaults` (not inside them). The field SHALL be optional with no parse-time default so that a child profile omitting it inherits the parent's value; when unset it SHALL resolve to `full` at the point of use. `full` SHALL re-read and re-synthesize the entire changed session. `delta` SHALL gather only the messages after the stored watermark and revise the existing session file from the prior file plus the delta.

#### Scenario: Default strategy is full

- **WHEN** no `update_strategy` is configured
- **THEN** changed sessions are refreshed by full re-read and re-synthesis

#### Scenario: Child profile inherits the parent's strategy

- **WHEN** a base profile sets `update_strategy` and a child profile that extends it omits the field
- **THEN** the merged profile retains the base's `update_strategy` rather than resetting it to the default

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

