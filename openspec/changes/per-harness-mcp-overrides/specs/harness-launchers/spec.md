## ADDED Requirements

### Requirement: Managed zsh launchers shadow harness commands

The managed zsh configuration SHALL define shell functions named `codex`, `opencode`, and `claude` that resolve the current project root (git toplevel, falling back to the working directory), read that project's payloads from the override store, inject them at launch, and exec the real binary via `command`. The user-facing command names SHALL be unchanged.

#### Scenario: Codex launch injects -c flags

- **WHEN** the store holds codex `argv` payload `["-c", "mcp_servers.jira.enabled=true"]` for the current project and the user runs `codex`
- **THEN** the launcher SHALL execute `command codex -c mcp_servers.jira.enabled=true` followed by the user's arguments

#### Scenario: Opencode launch injects config content

- **WHEN** the store holds an opencode `config` payload for the current project and the user runs `opencode`
- **THEN** the launcher SHALL execute `command opencode` with `OPENCODE_CONFIG_CONTENT` set to that payload JSON

#### Scenario: Claude launch injects settings only

- **WHEN** the store holds a claude `settings` payload for the current project and the user runs `claude`
- **THEN** the launcher SHALL execute `command claude --settings '<payload JSON>'` followed by the user's arguments
- **AND** the launcher SHALL NOT pass any MCP-related flags

### Requirement: Launchers degrade to the unmodified command

When the override store is absent, unreadable, has no entry for the current project, or `jq` is unavailable, the launcher SHALL execute the real binary with the user's arguments unmodified and SHALL NOT fail the launch.

#### Scenario: No overrides for the project

- **WHEN** the store has no entry for the current project and the user runs `codex --help`
- **THEN** the launcher SHALL execute `command codex --help` with no injected flags

#### Scenario: Sessions bypassing the launcher see defaults

- **WHEN** a harness is started without going through the zsh function (for example by an IDE)
- **THEN** the session SHALL see rendered profile defaults and global toggles only, with no project overrides applied
