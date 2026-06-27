## ADDED Requirements

### Requirement: mfz thread command surface

mindframe-z SHALL expose a `mfz thread` command with subcommands `create`, `discover`,
`ingest`, `list`, `show`, `runs`, `destinations`, `delete`, and `sync`. Each subcommand
SHALL resolve the active profile and machine config the same way the rest of `mfz` does.

#### Scenario: Top-level help lists thread operations

- **WHEN** the operator runs `mfz thread --help`
- **THEN** mindframe-z lists `create`, `discover`, `ingest`, `list`, `show`, `runs`,
  `destinations`, `delete`, and `sync` with one-line descriptions

#### Scenario: List enumerates known threads

- **WHEN** the operator runs `mfz thread list`
- **THEN** mindframe-z prints the threads reachable from the resolved destinations with
  their slug, destination, and session count

#### Scenario: Show outputs a thread digest

- **WHEN** the operator runs `mfz thread show <slug>`
- **THEN** mindframe-z outputs that thread's current `digest.md`

### Requirement: Thread deletion

mindframe-z SHALL provide `mfz thread delete <slug> [--no-push]` that removes the
thread's local directory and commits the deletion to its destination repository. When
the thread was never committed to the destination, mindframe-z SHALL skip destination
operations. `--no-push` SHALL commit the deletion locally without pushing.

#### Scenario: Delete removes the thread locally and from its destination

- **WHEN** the operator runs `mfz thread delete <slug>` for a thread that was ingested
- **THEN** mindframe-z removes the local thread directory, commits the deletion to the
  destination, and pushes

#### Scenario: Delete with --no-push keeps the remote copy

- **WHEN** the operator runs `mfz thread delete <slug> --no-push`
- **THEN** mindframe-z removes the local thread directory, commits the deletion locally,
  and does not push

### Requirement: Destination synchronization

mindframe-z SHALL provide `mfz thread sync [--all] [<slug>...]` that pulls the latest
state from configured thread destination remotes and copies committed thread data back to
the local store. `--all` (or calling with no slugs) SHALL sync every configured
destination. Specific slugs SHALL sync only the destinations those threads belong to. A
destination with no remote, or a remote with no branches yet, SHALL be skipped. Before
pulling, `sync` SHALL prepare the destination's local working copy if it does not yet
exist.

#### Scenario: Sync pulls thread data from a remote

- **WHEN** the operator runs `mfz thread sync <slug>` for a thread whose destination has
  a remote with new data
- **THEN** mindframe-z pulls the latest from the remote and copies committed thread
  directories into the local thread store

#### Scenario: Sync --all syncs every configured destination

- **WHEN** the operator runs `mfz thread sync --all` on a fresh machine with no local threads
- **THEN** mindframe-z prepares and syncs every destination, pulling down any committed
  thread data from their remotes

#### Scenario: Sync skips destinations without a remote

- **WHEN** a destination has no configured remote
- **THEN** mindframe-z reports it as up to date without attempting a pull

### Requirement: Condensed-default, JSON-optional output

Every read command (`discover`, `list`, `destinations`, `runs`) SHALL default to
condensed, agent-optimized text and SHALL accept a `--json` flag that instead emits
structured output suitable for `jq`. The condensed and JSON forms SHALL carry the same
information.

#### Scenario: Default output is condensed text

- **WHEN** the operator runs `mfz thread list` without `--json`
- **THEN** mindframe-z prints a compact table optimized for an agent to read

#### Scenario: JSON flag emits structured output

- **WHEN** the operator runs `mfz thread list --json`
- **THEN** mindframe-z prints a structured JSON document that round-trips the same
  information as the table
