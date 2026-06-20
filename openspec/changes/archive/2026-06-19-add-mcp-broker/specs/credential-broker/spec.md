## ADDED Requirements

### Requirement: Broker MCP credentials with per-vault selection for same-host upstreams

The vault SHALL support brokering credentials for MCP server upstreams. Because vault selection is determined by the proxy auth token's vault scope rather than by destination host, distinct vaults MAY each define a service for the same MCP upstream host mapped to different credentials. The real MCP credential material MUST remain in Agent Vault storage and be injected only by the broker; there SHALL be no agent-facing path to read a raw MCP credential.

#### Scenario: Same host resolves to different credentials by vault

- **WHEN** two vaults each define a service for `mcp.atlassian.com` with different credentials, and a request arrives with a vault-hint selecting one of them
- **THEN** the broker injects only that vault's credential and never the other's

#### Scenario: MCP credential is never returned to the agent

- **WHEN** the agent or its shim attempts to read a stored MCP credential value
- **THEN** no API returns the raw credential; it is only ever injected onto the outbound MCP request at the proxy layer

### Requirement: Static and OAuth injection for MCP servers

The broker SHALL inject MCP credentials as either static request headers or an OAuth bearer token. For static credentials the broker SHALL substitute placeholder header values with the real values. For OAuth credentials the broker SHALL inject the access token and SHALL refresh it from the stored refresh token as it nears expiry, without exposing tokens to the agent.

#### Scenario: Static header substitution for an MCP request

- **WHEN** an MCP request carries placeholder credential headers and the matched service defines static credentials
- **THEN** the broker replaces the placeholders with the real credential values before forwarding

#### Scenario: OAuth bearer injection and refresh for an MCP request

- **WHEN** an MCP request matches a service backed by an OAuth credential whose access token is near or past expiry
- **THEN** the broker refreshes the token using the stored refresh token and injects the fresh bearer before forwarding

### Requirement: OAuth token-upload bridge as a seeding path

The vault SHALL accept OAuth credentials seeded by uploading an already-acquired access token and refresh token together with the token endpoint and client identifier, so that OAuth credentials obtained by a real client login can be brokered without the vault performing browser-based acquisition.

#### Scenario: Tokens captured from a client login are uploaded

- **WHEN** access and refresh tokens captured from a real MCP client login are uploaded to a vault with the token URL and client ID
- **THEN** the vault validates and stores them, and thereafter injects and refreshes that credential for the matching MCP service
