# session-hydration Specification

## Purpose
TBD - created by archiving change session-backup-hydration. Update Purpose after archive.
## Requirements
### Requirement: Hydrate vanished sessions from a readable archive

When a thread refresh or ingest encounters a ledger session that has vanished from its local host store, the system SHALL attempt to hydrate it from a readable archive (the default archive or any read-only source archive) before treating it as unrecoverable. Because a Claude session's subagent transcripts are stored under the session's own prefix, hydration SHALL pull the session by **prefix** (a `ListObjectsV2` on `<harness>/<id>` followed by `GetObject` of each object), not a single `GetObject` by key. When no archive is readable or reachable, the session SHALL remain vanished exactly as today, with no error.

#### Scenario: Vanished session hydrated by prefix

- **WHEN** a thread refresh encounters a session absent locally and a readable archive holds `<harness>/<id>`
- **THEN** every object under that prefix (the transcript and any subagent transcripts) is downloaded into the archive-cache

#### Scenario: No readable archive degrades gracefully

- **WHEN** a session is vanished locally and no configured archive is readable or reachable
- **THEN** the session is left vanished, its session file is untouched, and no error is raised

#### Scenario: Archive consulted only for vanished sessions

- **WHEN** a thread refresh processes sessions that are still present locally
- **THEN** no archive read is performed for those sessions

### Requirement: Read-only archive cache

Hydrated sessions SHALL be written to a machine-local cache directory `~/.mindframe-z/archive-cache/<harness>/<id>...`, which SHALL be gitignored and mounted read-only into the tools container. The system SHALL NOT write hydrated sessions back into the live harness store (`~/.claude/projects`, the OpenCode store), so the harness cannot re-delete or surface them and read-only archive provenance is preserved. The cache layout SHALL preserve the session's subtree, including subagent transcripts. The cache SHALL be write-once per session: when a session already has a cached copy, that copy is used without re-consulting the archive (refreshing an already-hydrated session from a newer archive copy is out of scope with cross-machine pull).

#### Scenario: Hydrated session lands in the cache, not the live store

- **WHEN** a vanished session is hydrated
- **THEN** its files are written under `~/.mindframe-z/archive-cache/` and the live harness store is not modified

#### Scenario: Cached session is not re-fetched

- **WHEN** a vanished session already has a hydrated copy in the archive-cache
- **THEN** the cached copy is used and no archive read is performed

### Requirement: Atomic per-session hydration

Downloading every object under a session's `<harness>/<id>` prefix SHALL be staged and committed atomically: a failure fetching any single object SHALL leave no partial copy in the archive-cache, and hydration SHALL report the session as not hydrated. The cache SHALL never hold a session with only some of its objects present.

#### Scenario: Partial download leaves no cache

- **WHEN** a multi-object session download fails partway through (e.g. a subagent transcript's `GetObject` errors)
- **THEN** no files for that session are left in the archive-cache and hydration reports `false`

#### Scenario: Successful multi-object download commits atomically

- **WHEN** every object under the session's prefix downloads successfully
- **THEN** all files are committed to the archive-cache together

### Requirement: Profile-pinned archives are skipped during hydration

Hydration SHALL only read from archives that do not set `profile`; a profile-pinned archive is skipped entirely on the read path — no S3 client is constructed for it, and it is never read with ambient default-provider-chain credentials — mirroring the write-side rejection of profile-pinned archives. Sibling non-pinned archives SHALL still be consulted.

#### Scenario: Profile-pinned archive never read

- **WHEN** hydration considers an archive that sets `profile`
- **THEN** that archive is skipped and no S3 client is constructed for it

#### Scenario: Sibling non-pinned archives still checked

- **WHEN** one configured archive is profile-pinned and another is not
- **THEN** the non-pinned archive is still queried and can satisfy hydration

### Requirement: Negative caching of confirmed-absent sessions

When every reachable, non-profile-pinned archive is queried for a session's prefix and none holds any object for it, the system SHALL write a sticky marker file (`<harness>/<id>.absent`) in the archive-cache so future hydration attempts for that session perform no archive read. The marker SHALL NOT be written when an archive is unreachable or a download otherwise fails partway — only a confirmed, fully-queried absence across every consulted archive qualifies — so a transient outage is never mistaken for permanent absence. When every configured archive is profile-pinned (so none was actually queried), no marker SHALL be written either.

#### Scenario: Confirmed-absent session is marked and not re-queried

- **WHEN** a session is queried against every reachable archive and none holds it
- **THEN** an absent marker is written, and a subsequent hydration attempt for the same session performs no archive read

#### Scenario: Unreachable archive does not trigger negative caching

- **WHEN** the only configured archive is unreachable
- **THEN** no absent marker is written, so the session can be retried once the archive is reachable again

#### Scenario: All-profile-pinned archives do not trigger negative caching

- **WHEN** every configured archive is profile-pinned and therefore skipped
- **THEN** no absent marker is written, since absence was never actually confirmed

### Requirement: Gather reads the cached artifact

Gather SHALL read a hydrated session from the archive-cache via the explicit-path seam rather than rediscovering it in the host store, for both harnesses. For OpenCode, the gather agent SHALL read the archived `opencode export` JSON (`{ info, messages }`) directly, per updated `opencode-sessions` skill guidance, because its format differs from the native store.

#### Scenario: Claude cached session gathered by path

- **WHEN** a hydrated Claude session is gathered
- **THEN** gather is handed the explicit cache path and reads the `.jsonl` directly

#### Scenario: OpenCode cached export gathered directly

- **WHEN** a hydrated OpenCode session is gathered
- **THEN** the gather agent reads the archived `opencode export` JSON directly following the `opencode-sessions` skill's archived-export guidance
