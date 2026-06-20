## Purpose

Define how sandboxed MCP servers are classified, routed, and credential-brokered without exposing real provider credentials to the agent.

## Requirements

### Requirement: MCP server taxonomy determines handling

The sandbox SHALL classify each MCP server by what it connects to and what credential it needs, and SHALL apply the matching handling rule. Local-CLI MCP servers SHALL run in-container with no proxy or credential. Anonymous public MCP servers SHALL be passed through without credential injection. Single-identity credentialed remote MCP servers SHALL use the normal Agent Vault proxy path. Same-host multi-identity credentialed remote MCP servers SHALL use the per-server egress shim with per-vault identity.

#### Scenario: Local-CLI MCP server needs no broker

- **WHEN** a local-CLI MCP server is configured
- **THEN** it runs in the agent container, reaches no external host, and uses neither the broker nor a shim

#### Scenario: Anonymous public MCP server is passed through

- **WHEN** the agent contacts an anonymous public MCP server
- **THEN** the request reaches the upstream without credential injection

#### Scenario: Single-identity credentialed MCP server uses normal broker path

- **WHEN** the agent contacts a single-identity credentialed remote MCP server
- **THEN** the normal Agent Vault proxy path injects the credential from the main sandbox vault, and no per-server shim is required

#### Scenario: Same-host credentialed remote MCP server uses shim and vault

- **WHEN** the agent contacts a same-host multi-identity credentialed remote MCP server
- **THEN** the agent targets a per-server shim that forwards through the broker with the server's own vault identity

### Requirement: Per-server MCP egress shim

The sandbox SHALL run one local egress shim per configured logical MCP server that needs a distinct identity for a shared upstream host. The agent SHALL target each shim at a distinct local endpoint in generated sandbox config only. Each shim SHALL forward agent requests to its configured upstream MCP host through Agent Vault using a vault-hint unique to that server. A shim SHALL NOT hold real credential material; it exists only to carry a distinct egress identity that the agent's single global proxy cannot express.

#### Scenario: Two same-host servers resolve to different vaults

- **WHEN** the Jira shim and the Confluence shim both forward to `mcp.atlassian.com`
- **THEN** the Jira shim presents the Jira-site vault-hint and the Confluence shim presents the Confluence-site vault-hint, so Agent Vault injects the correct per-site credential for each

#### Scenario: Shim holds no secrets

- **WHEN** a shim process and its environment are inspected
- **THEN** no real provider credential or refresh token is present; only the upstream host and the vault-hint routing it through the broker

#### Scenario: Single-org server does not require a shim

- **WHEN** the Datadog MCP server is used for a single organization
- **THEN** it uses the main sandbox vault credential and the normal Agent Vault proxy path rather than a per-server shim

### Requirement: MCP egress is transparent to the agent

For mapped shimmed servers, the generated sandbox MCP configuration SHALL target the local shim endpoint with no real authentication, and the shim SHALL behave as if it were the remote MCP server. Streamable-HTTP request/response and long-lived SSE streams SHALL pass through unchanged. The committed/source agent configuration SHALL remain pointed at the normal upstream URL so host-side OAuth setup remains natural.

#### Scenario: Agent config is authless and proxy-unaware

- **WHEN** the generated sandbox MCP configuration is inspected
- **THEN** mapped shim entries point at local shim endpoints with no real token, header secret, or proxy setting

#### Scenario: Streaming passes through unchanged

- **WHEN** the agent opens a long-lived SSE stream or a streamable-HTTP exchange to a credentialed remote MCP server through its shim
- **THEN** the stream behaves as a direct connection to the remote MCP server, with credential injection applied only on the shim's egress hop

### Requirement: Per-vault identity per site or organization

The sandbox SHALL define a separate Agent Vault vault for each shimmed MCP site or organization that needs distinct credentials for a shared upstream host, and each vault SHALL define a service for its upstream MCP host mapped to that vault's credential. Distinct vaults MAY define a service for the same upstream host. Single-identity MCP services MAY live in the main sandbox vault.

#### Scenario: Jira and Confluence are separate vaults on one host

- **WHEN** vaults are configured for the Jira site and the Confluence site
- **THEN** each vault defines a service for `mcp.atlassian.com` mapped to its own credential, and the two do not collide

#### Scenario: Datadog uses the main vault

- **WHEN** Datadog is configured for one organization
- **THEN** the main sandbox vault defines a service for `mcp.datadoghq.com` mapped to `DD_ACCESS_TOKEN`

### Requirement: Two seeding paths for MCP credentials

The sandbox SHALL support seeding an MCP server's vault credential by either a static path or an OAuth path, and the agent-facing behavior SHALL be identical regardless of which path seeded the credential. The static path SHALL store provider API keys/tokens as vault credentials. The OAuth path SHALL upload already-acquired OAuth tokens, captured from a real client login, into the vault for broker injection and refresh.

#### Scenario: Static seeding for headless access

- **WHEN** a provider API key or token is stored as a vault credential and the agent sends placeholder headers
- **THEN** the broker substitutes the real values on egress and the agent never holds them

#### Scenario: OAuth seeding from a real client login

- **WHEN** a user completes an MCP OAuth login in a real client and the resulting access and refresh tokens are uploaded to the matching vault
- **THEN** the broker injects the access token on egress and refreshes it from the stored refresh token without exposing either to the agent

#### Scenario: Agent behavior is identical across paths

- **WHEN** the same MCP server is served by a static-seeded vault and later by an OAuth-seeded vault
- **THEN** the agent's MCP configuration and observed behavior are unchanged
