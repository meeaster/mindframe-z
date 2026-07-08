## ADDED Requirements

### Requirement: Single per-machine override store keyed by project path

Project-scoped overrides for MCP servers and skills SHALL be stored in one mfz-owned JSON file (`~/.mindframe-z/overrides.json`), keyed by absolute project root path, with a per-harness section per project holding `mcp` and `skills` intent maps (name to boolean). No project-scoped override SHALL be written into files inside the project directory.

#### Scenario: Toggle writes to the store, not the repo

- **WHEN** `mfz mcp enable jira` runs inside a git repo at `/work/repo` and jira is codex-available
- **THEN** `~/.mindframe-z/overrides.json` SHALL contain `projects["/work/repo"].codex.mcp.jira: true`
- **AND** no file under `/work/repo` SHALL be created or modified

### Requirement: Overrides are deltas from profile defaults

An override SHALL only be stored when it differs from the resolved profile default for that harness. Setting an override equal to the profile default SHALL remove the stored entry, and a project/harness section with no remaining entries SHALL be removed.

#### Scenario: Toggling back to default removes the override

- **WHEN** the profile default for jira on codex is `false`, an override `jira: true` exists for the project, and the user toggles jira off
- **THEN** the store SHALL contain no jira entry for that project and harness

### Requirement: Store holds pre-rendered launch payloads

Alongside intent, the store SHALL hold per-harness launch payloads rendered by mfz: `argv` (codex `-c` arguments), `config` (opencode JSON for `OPENCODE_CONFIG_CONTENT`), and `settings` (claude settings JSON). Payloads SHALL be re-rendered whenever an override changes and on every `mfz apply`, so payloads always reflect current profile defaults plus stored intent. Codex skill overrides SHALL render the complete `skills.config` array value, since codex config layering replaces arrays wholesale.

#### Scenario: Apply re-renders payloads after profile change

- **WHEN** a project has override `codex.mcp.jira: true`, the profile later changes jira's codex default, and `mfz apply` runs
- **THEN** the stored codex `argv` payload SHALL be re-rendered against the new resolved defaults

### Requirement: Store reads are validated and writes are atomic

Every read of the override store SHALL validate the file against a schema; a file that fails to parse or validate SHALL abort the operation with an error and SHALL NOT be overwritten or truncated. Writes SHALL be atomic (write to a temporary file, then rename).

#### Scenario: Corrupt store aborts a toggle

- **WHEN** `~/.mindframe-z/overrides.json` contains invalid JSON and `mfz mcp enable jira` runs
- **THEN** the command SHALL exit non-zero naming the file
- **AND** the file content SHALL be unchanged
