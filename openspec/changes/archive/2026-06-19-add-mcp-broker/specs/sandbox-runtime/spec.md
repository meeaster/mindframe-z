## ADDED Requirements

### Requirement: Per-server MCP shims launch alongside the agent container

The sandbox launch flow SHALL start one MCP egress shim per configured same-host multi-identity MCP server, reachable by the agent container at distinct local endpoints, before or alongside launching the agent. Each shim SHALL be configured with its upstream MCP host and its vault-hint, and SHALL route egress through Agent Vault using that hint. Shims SHALL receive no real credential material.

#### Scenario: Shims start with the agent

- **WHEN** the operator launches the agent with credentialed MCP servers enabled
- **THEN** a shim is running for each such server at its own local endpoint, each routing through Agent Vault with its server's vault-hint

#### Scenario: Shim launch carries no secrets

- **WHEN** the launch wrapper configures a shim
- **THEN** it passes only the upstream host and vault-hint, and no provider API key, OAuth token, or refresh token

### Requirement: Agent MCP config points at local shims without credentials

The sandbox SHALL generate agent MCP server entries for mapped shimmed servers that target the local shim endpoints with no real authentication and no proxy setting for MCP traffic. Placeholder credential headers MAY be present only where a static MCP server requires header shape; real values MUST NOT appear. Source agent configuration SHALL remain pointed at the upstream server.

#### Scenario: Agent MCP entry targets a shim authlessly

- **WHEN** the agent's MCP configuration is generated for a credentialed remote MCP server
- **THEN** the entry points at the server's local shim endpoint with no token and no proxy directive

#### Scenario: Only placeholders appear for static servers

- **WHEN** a static MCP server requires named credential headers
- **THEN** the agent config contains placeholder header values and the real values are injected only by the broker
