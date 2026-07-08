## ADDED Requirements

### Requirement: CLI toggles MCP servers per project with target expansion at write time

`mfz mcp enable <name>` and `mfz mcp disable <name>` SHALL write project-scoped overrides to the override store for every harness where the server is available per the resolved profile, or only for the harness given via `--agent`. The command SHALL error when the server is not available on any requested harness, and SHALL NOT write an override for a harness where the server is unavailable.

#### Scenario: Enable expands to available harnesses only

- **WHEN** jira is declared with `agents: { codex: true, opencode: false }` and `mfz mcp enable jira` runs inside a project
- **THEN** overrides SHALL be considered for codex and opencode only
- **AND** per delta semantics only the opencode override SHALL be stored (codex already defaults to enabled)

#### Scenario: Enable for an unavailable harness errors

- **WHEN** jira is not claude-code-available and `mfz mcp enable jira --agent claude-code` runs
- **THEN** the command SHALL exit non-zero stating jira is not available for claude-code

### Requirement: Status prints the merged per-harness view

`mfz mcp status` SHALL print, for the current project, each profile-declared MCP server with its effective state per harness (profile default plus project override), marking which entries are overridden.

#### Scenario: Overridden server is marked

- **WHEN** jira defaults to disabled on opencode and the project has an override enabling it
- **THEN** `mfz mcp status` SHALL show jira as enabled for opencode and marked as overridden

### Requirement: TUI toggles MCP servers alongside skills semantics

`mfz mcp tui` SHALL list profile-declared MCP servers with their effective toggle state for the selected harness, support the same keyboard interactions as the skills TUI, and on save write deltas to the override store for the current project.

#### Scenario: TUI save writes deltas to the store

- **WHEN** the user toggles jira on for codex in the TUI inside a project and saves
- **THEN** the override store SHALL contain the corresponding project-scoped codex entry
- **AND** no repo-local file SHALL be written
