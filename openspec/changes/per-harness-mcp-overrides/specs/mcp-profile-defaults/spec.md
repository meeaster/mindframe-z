## ADDED Requirements

### Requirement: Profile MCP entries declare per-harness availability and default state

A profile `mcp` entry SHALL consist of a single `agents` map from harness name (`opencode`, `claude-code`, `codex`) to boolean. A harness key being present means the server is available on that harness; the boolean value is its default enabled state. The legacy `enabled` and `targets` fields SHALL NOT be accepted.

#### Scenario: Server available with mixed defaults

- **WHEN** a profile declares `mcp.jira.agents: { codex: true, opencode: false }`
- **THEN** jira SHALL render for codex default-enabled and for opencode default-disabled
- **AND** jira SHALL NOT render for claude-code

#### Scenario: Legacy fields rejected

- **WHEN** a profile declares `mcp.jira.enabled: true` or `mcp.jira.targets: [codex]`
- **THEN** manifest validation SHALL fail with a schema error

#### Scenario: Profile inheritance merges per harness

- **WHEN** the base profile declares `mcp.jira.agents: { opencode: false }` and a child profile declares `mcp.jira.agents: { codex: true }`
- **THEN** the resolved entry SHALL be `{ opencode: false, codex: true }`

### Requirement: claude-code default-disabled is rejected

Validation SHALL reject `claude-code: false` in an `agents` map, because Claude Code has no config-level "installed but disabled" state for user-scope MCP servers; its expressible states are present (enabled) or absent.

#### Scenario: claude-code false fails validation

- **WHEN** a profile declares `mcp.jira.agents: { claude-code: false }`
- **THEN** manifest validation SHALL fail with an error naming the server and the reason

### Requirement: Renderers enforce per-harness defaults

On `mfz apply`, the codex renderer SHALL write every codex-available server into `~/.codex/config.toml` `[mcp_servers.*]` with `enabled` set to the profile default, and the opencode renderer SHALL write every opencode-available server into the managed opencode config with `enabled` set to the profile default. The claude renderer SHALL write only claude-available servers into `~/.claude.json` `mcpServers` (presence-only, no enabled flag) and SHALL continue to preserve harness-owned per-project toggle state.

#### Scenario: Codex apply re-asserts profile default

- **WHEN** `~/.codex/config.toml` has `mcp_servers.jira.enabled = true` from a hand-edit, the profile default is `codex: false`, and `mfz apply` runs
- **THEN** the merged `~/.codex/config.toml` SHALL contain `mcp_servers.jira.enabled = false`

#### Scenario: Claude preserves user toggle state across apply

- **WHEN** `~/.claude.json` contains `projects.<path>.disabledMcpServers: ["jira"]` and `mfz apply` runs
- **THEN** the `projects` entry SHALL be preserved unchanged

### Requirement: Codex secret headers render as env-var indirection

When a catalog MCP server header value is an `{env:VAR}` reference, the codex renderer SHALL emit it under `env_http_headers` mapping the header name to the env var name. Literal header values SHALL be emitted under `http_headers`. `{env:VAR}` references SHALL never be emitted as literal strings in codex config.

#### Scenario: env reference header

- **WHEN** the catalog defines a server with header `x-api-key: "{env:EXA_API_KEY}"` available on codex
- **THEN** the rendered codex entry SHALL contain `env_http_headers = { "x-api-key" = "EXA_API_KEY" }`
- **AND** SHALL NOT contain an `http_headers` entry for `x-api-key`
