# session-backup Specification

## Purpose
TBD - created by archiving change session-backup-hydration. Update Purpose after archive.
## Requirements
### Requirement: Archives machine-config concept

The system SHALL support an `archives` list in machine-local configuration (`~/.mindframe-z/config.yml`), each entry `{ name, bucket, region, prefix?, profile? }`. Exactly one archive SHALL be resolved as the writable `default` (the last entry flagged `default`, else the first configured); every other archive is read-only. Archives SHALL be resolved and validated at command time via a schema, alongside the existing thread `destinations`, and SHALL never be written to the committed profile repository.

#### Scenario: Default archive resolved for writes

- **WHEN** the machine config declares one or more archives and one is flagged `default: true`
- **THEN** that archive is the single writable target and is used as the upload destination

#### Scenario: No archive configured

- **WHEN** `mfz sessions backup` runs with no `archives` entry in machine config
- **THEN** it fails with an actionable error naming `~/.mindframe-z/config.yml`, and uploads nothing

#### Scenario: Profile-pinned archive is rejected in this change

- **WHEN** the resolved archive sets a `profile`
- **THEN** the command fails with a clear "not supported" error rather than silently using default credentials

### Requirement: Session backup command

The system SHALL provide `mfz sessions backup` that enumerates every local session for each supported harness and uploads a full-fidelity per-session artifact to the default archive, keyed by session id under `<prefix>/<harness>/<id>`. Credentials SHALL resolve through the AWS SDK default provider chain; the system SHALL NOT store, print, or persist any credential. The command SHALL back up unsanitized, full-fidelity content, and every upload SHALL explicitly request server-side encryption (`ServerSideEncryption: AES256`) rather than relying on bucket-default encryption.

#### Scenario: Claude sessions backed up verbatim

- **WHEN** `mfz sessions backup` runs and local Claude transcripts exist at `~/.claude/projects/*/<id>.jsonl`
- **THEN** each transcript is uploaded verbatim to key `<prefix>/claude-code/<id>.jsonl`

#### Scenario: Subagent transcripts stored under the session prefix

- **WHEN** a Claude session has subagent transcripts at `<id>/subagents/agent-*.jsonl`
- **THEN** each is uploaded under the session's own prefix at `<prefix>/claude-code/<id>/subagents/agent-*.jsonl`, never as a standalone ledger entry

#### Scenario: OpenCode sessions extracted via export

- **WHEN** `mfz sessions backup` runs and local OpenCode sessions exist
- **THEN** each session is extracted via `opencode export <id>` and its `{ info, messages }` JSON is uploaded to key `<prefix>/opencode/<id>.json`

### Requirement: Bucket-hardening preflight

Because backups are full-fidelity and unsanitized, before uploading anything the system SHALL verify that the resolved default archive's bucket has S3 Block Public Access fully enabled (`GetPublicAccessBlock` reports all four flags true). If the check fails — public access is not fully blocked, or the caller lacks permission to read the configuration — the command SHALL abort with an actionable error and upload nothing. The preflight SHALL run once per invocation, before the freshness sweep.

#### Scenario: Upload refused when public access is not blocked

- **WHEN** `mfz sessions backup` resolves a default archive whose bucket does not have all four Block Public Access flags enabled
- **THEN** the command aborts with an actionable error naming the bucket and uploads nothing

#### Scenario: Public-access-block status unreadable

- **WHEN** the caller cannot read the bucket's public-access-block configuration (missing permission or no configuration set)
- **THEN** the command aborts rather than uploading against an unverified bucket

#### Scenario: Hardened bucket passes the preflight

- **WHEN** the resolved bucket has all four Block Public Access flags enabled
- **THEN** the preflight passes and the backup sweep proceeds

### Requirement: Incremental freshness guard

Each run SHALL perform a single paginated `ListObjectsV2` sweep of the archive's `<harness>` prefix to build a map of object key to stored `LastModified`, and SHALL upload a session only when it is new or when its local source signal is newer than the stored `LastModified` **minus a fixed safety margin**. The margin is required because `LastModified` is upload time, which always postdates the write that triggered the upload: a write landing during or shortly after a sweep would otherwise compare older-than-stored and be skipped on every future run. A margin-triggered re-upload resets `LastModified` well past the frozen source signal, so the margin costs at most one redundant upload per session. The source signal SHALL be the transcript file's mtime for Claude sessions; for OpenCode it SHALL be derived entirely from `opencode.db` — the greater of the session row's `time_updated` and the session's latest message `time_created` — because message growth may not bump `time_updated`. OpenCode sessions SHALL be enumerated from `opencode.db` (`SELECT id FROM session`); current OpenCode keeps session info in that table rather than in `storage/session/info/<id>.json` files. There SHALL be no separate local index; the bucket is the catalog.

#### Scenario: Unchanged session skipped

- **WHEN** a session's local source signal is not newer than the archive's stored `LastModified` minus the safety margin
- **THEN** the session is not re-uploaded

#### Scenario: Only churned sessions uploaded on a repeat run

- **WHEN** `mfz sessions backup` is run a second time and only some sessions have changed since the first run
- **THEN** only the new or changed sessions are uploaded and the rest are skipped

#### Scenario: Write landing mid-sweep is not frozen out

- **WHEN** a session is modified during a backup sweep, so its new source signal still precedes the uploaded object's `LastModified`
- **THEN** the next run re-uploads it (the margin comparison treats it as changed) and the run after that skips it

#### Scenario: OpenCode message growth detected without a session-row update

- **WHEN** an OpenCode session gains messages without its `session` row's `time_updated` advancing
- **THEN** its source signal (the latest message `time_created` in `opencode.db`) is newer and the session is re-exported and uploaded

### Requirement: Origin-machine routing

A machine SHALL back up only to its own default archive. The system SHALL NOT route a session to an archive based on its intended thread or category; sensitivity is determined by the machine a session ran on. The read/write boundary between archives (e.g. work vs personal) SHALL be enforced by external IAM credentials, not by application logic.

#### Scenario: Backup writes only to the default archive

- **WHEN** `mfz sessions backup` runs on a machine whose default archive is `work`
- **THEN** all sessions are uploaded to the `work` archive regardless of any thread association

### Requirement: Skip-and-continue failure handling

A failure to read or upload a single session SHALL NOT abort the sweep. The run SHALL continue past the failing item and SHALL end with a summary reporting the counts of uploaded, skipped, and failed sessions.

#### Scenario: One failing session does not abort the run

- **WHEN** one session cannot be read or uploaded during a backup sweep
- **THEN** the remaining sessions are still processed and the command reports `N uploaded / M skipped / K failed`
