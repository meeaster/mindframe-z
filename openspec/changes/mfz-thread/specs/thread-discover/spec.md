## ADDED Requirements

### Requirement: Prompt-driven session discovery

mindframe-z SHALL provide `mfz thread discover "<prompt>"` that takes a free-text
description of the work being looked for and returns candidate sessions that match it.
Discovery SHALL be a containerized agent dispatch that judges relevance against the
prompt, not a deterministic dump of all sessions, and SHALL NOT require an existing
thread.

#### Scenario: Discover returns prompt-matched candidates

- **WHEN** the operator runs `mfz thread discover "the design work on the thread system"`
- **THEN** mindframe-z dispatches an agent that searches sessions across sources and
  returns the candidates matching that description

#### Scenario: Discover needs no thread

- **WHEN** `mfz thread discover` runs before any thread exists
- **THEN** mindframe-z still returns candidates without requiring a thread or charter

### Requirement: Discovery model and effort resolution

`mfz thread discover` SHALL use the resolved discover model from the profile
`thread.defaults.discover`, overridable with `--model <harness:model@effort>`. Discovery
is a judgment step and SHALL use the capable (synthesis) model by default.

#### Scenario: Discover uses the capable model by default

- **WHEN** the operator runs `mfz thread discover "<prompt>"` with no model flag
- **THEN** the dispatch uses the profile's `thread.defaults.discover` model

### Requirement: Source filtering via session_sources and --sources

The discover dispatch SHALL search session stores controlled by the `session_sources`
profile default (`["claude-code", "opencode"]`), overridable with the `--sources
<comma-separated>` flag. The `resolveSessionSources` helper SHALL prefer the flag when
provided, otherwise use the profile default. The discover persona SHALL receive the
active source list in its prompt context and SHALL load the corresponding
`<source>-sessions` reader skills dynamically.

#### Scenario: Discover searches all configured sources by default

- **WHEN** the operator runs `mfz thread discover "<prompt>"` without `--sources`
- **THEN** the dispatch searches both claude-code and opencode session stores

#### Scenario: --sources narrows discover to specific stores

- **WHEN** the operator runs `mfz thread discover "<prompt>" --sources claude-code`
- **THEN** the dispatch searches only the claude-code session store

### Requirement: Discovery uses reader skills, not a thread skill

The discovery agent SHALL load the `agent-sessions` reader skill to enumerate and inspect
sessions, with provider branches selected based on the active session sources, and SHALL
NOT load any thread-specific synthesis skill. Its result SHALL be free text that identifies
each candidate by a qualified `source:id` (e.g. `claude-code:bb55cee5-...`) and a one-line
reason it matched the prompt.

#### Scenario: Candidate carries qualified source:id and match rationale

- **WHEN** discovery returns a candidate
- **THEN** the agent's text lists that candidate's qualified source:id (`source:bareId`)
  and a short reason it matched the prompt

### Requirement: Discovery honors the output convention

`mfz thread discover` SHALL default to the agent's condensed text and SHALL accept
`--json`. The `--json` form SHALL wrap the agent's text as `{ "candidates_text": … }`,
carrying the same information as the condensed form; TypeScript SHALL NOT parse
candidates into structured fields (the agent returns text and TS owns structured state).
The operator, or the driving agent using the `threads` skill, reads the text and passes the
chosen session ids to `mfz thread ingest`.

#### Scenario: JSON candidates are machine-consumable

- **WHEN** the operator runs `mfz thread discover "<prompt>" --json`
- **THEN** mindframe-z emits a `{ "candidates_text": … }` document whose text is the same
  candidate list the condensed form prints, suitable for an agent to read and pick ids
