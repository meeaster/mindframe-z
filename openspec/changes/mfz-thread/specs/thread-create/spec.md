## ADDED Requirements

### Requirement: Deterministic thread creation

mindframe-z SHALL provide `mfz thread create <slug> [--dest <destination>] --charter
"<lens>"` that creates a new thread without any LLM dispatch. When `--dest` is omitted,
the destination marked `default: true` SHALL be selected (or the first resolved
destination if none is marked). It SHALL write a `manifest.json` containing the thread's
charter and pinned destination, and SHALL prepare the destination's local working copy.
Creation SHALL fail if the slug already exists.

#### Scenario: Create defaults to the default destination

- **WHEN** the operator runs `mfz thread create thread-x --charter "…"` without `--dest`
- **THEN** mindframe-z pins the destination marked default and writes it into the manifest

#### Scenario: Create writes a charter and pins a destination

- **WHEN** the operator runs `mfz thread create thread-x --dest personal --charter "…"`
- **THEN** mindframe-z writes `manifest.json` with the charter and `destination: personal`
  and prepares the local working copy under that destination

#### Scenario: Create performs no dispatch

- **WHEN** `mfz thread create` runs
- **THEN** mindframe-z launches no container and makes no LLM call

#### Scenario: Duplicate slug is refused

- **WHEN** the operator runs `mfz thread create <slug>` for an existing thread
- **THEN** mindframe-z refuses and reports the conflict

### Requirement: Per-thread synthesis config override

`mfz thread create` SHALL accept optional `--discover-model`, `--gather-model`, and
`--synthesize-model` flags that accept a unified `harness:model@effort` string (e.g.
`claude-code:sonnet@high`). When provided, they are frozen into the manifest's synthesis
config as overrides of the profile defaults. When omitted, the thread SHALL inherit the
profile defaults at ingest time rather than copying them into the manifest.

#### Scenario: Override is recorded in the manifest

- **WHEN** the operator runs `mfz thread create <slug> --dest personal --synthesize-model opencode:opus@high`
- **THEN** the manifest records `synthesis.synthesize: opencode:opus@high` and omits the
  unspecified knobs

#### Scenario: Omitted knobs inherit profile defaults

- **WHEN** a thread is created without synthesis flags and later ingested
- **THEN** ingestion resolves discover, gather, and synthesize models from the profile
  `thread.defaults`

### Requirement: Charter is the synthesis lens

The charter SHALL be stored in `manifest.json` and injected into every synthesize and
digest dispatch as the lens that scopes how sessions are read. `mfz thread ingest` SHALL
refuse to run against a thread that does not exist, directing the operator to create it
first.

#### Scenario: Ingest requires an existing charter

- **WHEN** the operator runs `mfz thread ingest <ids> --thread <slug>` for a thread that
  was never created
- **THEN** mindframe-z refuses and instructs the operator to run `mfz thread create` first
