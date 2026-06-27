## ADDED Requirements

### Requirement: Two-stage per-session ingestion

`mfz thread ingest <ids…> --thread <slug>` SHALL ingest each named session in two
dispatches: a Haiku **gather** dispatch that reads the full transcript and returns a
text dossier, followed by a capable **synthesize** dispatch that reads only that dossier
and returns the session-file body. The gather and synthesize steps SHALL NOT be folded
into a single dispatch, so the capable model never re-reads the raw transcript.

#### Scenario: Each session is gathered then synthesized

- **WHEN** the operator runs `mfz thread ingest A B --thread <slug>`
- **THEN** mindframe-z runs a Haiku gather and a capable synthesize dispatch for session A
  and for session B

#### Scenario: Synthesizer reads only the dossier

- **WHEN** the synthesize dispatch runs
- **THEN** it receives the dossier text and the charter, not the raw transcript

### Requirement: TypeScript owns all writes and watermarks

TypeScript SHALL write each `sessions/<source>-<bareId>.md` from the synthesize dispatch's
returned body as that session's gather+synthesize dispatch completes inside the parallel
fan-out, and dispatched agents SHALL NOT write to disk. Session filenames SHALL use the
`${source}-${bareId}.md` convention (e.g. `claude-code-bb55cee5-….md`) to avoid
filesystem issues with `:`. After the fan-out completes, TypeScript SHALL advance the
`high_water` of every ingested session in a single batched manifest write, so the parallel
per-session writes cannot race on read-modify-write and drop entries. `high_water` SHALL
be an ISO timestamp recording when the session was last ingested.

#### Scenario: Watermarks advance once the fan-out completes

- **WHEN** the parallel gather+synthesize fan-out finishes and TS has written each
  session file
- **THEN** TS advances every ingested session's `high_water` in one manifest write; if
  the run dies before that batched write, no watermarks advance and the in-flight
  sessions re-ingest (their partially-written session files overwritten) next run

### Requirement: Qualified session-id parsing on ingest

`mfz thread ingest` SHALL accept session ids in the qualified `source:id` format (from
discover output) or bare ids. `parseSessionId` SHALL extract `source` from the prefix
when present, or use the `ses_` heuristic fallback for bare ids. The manifest SHALL
store the bare store id in the `id` field and the source separately in the `source`
field.

#### Scenario: Qualified id is split into source and bare for the manifest

- **WHEN** the operator runs `mfz thread ingest claude-code:bb55cee5-… --thread foo`
- **THEN** the manifest session entry has `id: "bb55cee5-…"` and `source: "claude-code"`

### Requirement: Parallel session processing

`mfz thread ingest` SHALL process multiple sessions' gather+synthesize dispatches in
parallel rather than strictly serially.

#### Scenario: Multiple sessions ingest concurrently

- **WHEN** the operator ingests several sessions in one command
- **THEN** their per-session dispatches run concurrently

### Requirement: Deterministic log regeneration

After all sessions are synthesized, TypeScript SHALL regenerate `log.md` purely
deterministically by merging the event buckets from the session files and ordering them
by timestamp, with no LLM dispatch.

#### Scenario: log.md is rebuilt without a model

- **WHEN** ingestion finishes writing session files
- **THEN** TS rebuilds `log.md` from the session files by timestamp order, calling no model

### Requirement: Digest regenerated from session files

After `log.md` is regenerated, `mfz thread ingest` SHALL run exactly one capable
**digest** dispatch per run that reads the thread's session files and returns
`digest.md`. The digest SHALL be derived from the durable session files, not from the
transient dossiers, so it is reproducible across incremental runs.

#### Scenario: One digest dispatch per ingest run

- **WHEN** an ingest run processes any number of sessions
- **THEN** mindframe-z runs a single digest dispatch after the sessions, not one per session

#### Scenario: Digest sees session files, not dossiers

- **WHEN** the digest dispatch runs
- **THEN** it receives the thread's session files as input and does not depend on
  in-memory dossiers
