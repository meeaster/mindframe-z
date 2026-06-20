## Purpose

Define how Agent Vault brokers credentials for sandboxed tools while keeping real provider credentials outside the agent container.

## Requirements

### Requirement: Containerized Agent Vault broker

The sandbox SHALL run Agent Vault as a local containerized service with persistent broker state under a Docker volume mounted at `/data`. The service SHALL expose the Agent Vault API and MITM proxy to the host-side launch wrapper and agent containers through configured local endpoints.

#### Scenario: Broker state persists across restarts

- **WHEN** the Agent Vault container is recreated
- **THEN** vault metadata, services, credentials, CA material, and server state persist in the configured Docker volume

#### Scenario: Launch wrapper targets containerized broker with agent token

- **WHEN** the sandbox launch wrapper starts an isolated agent
- **THEN** it uses a named Agent Vault agent token with instance role `no-access` and vault grant `local-ai-dev-sandbox:proxy` to authorize proxy use against the containerized Agent Vault server

#### Scenario: Broker proxy environment is built for Docker

- **WHEN** the sandbox container is launched
- **THEN** the launch wrapper passes Agent Vault proxy URLs using `host.docker.internal` into the sandbox container and mounts the Agent Vault MITM CA read-only

### Requirement: Broker OpenAI auth for opencode

The sandbox SHALL support opencode with OpenAI auth brokered by Agent Vault. The agent container MAY contain placeholder OpenAI auth values, but the real API key, OAuth access token, and OAuth refresh token MUST remain in Agent Vault storage and be injected/refreshed only by the broker.

#### Scenario: OpenAI API-key request is brokered

- **WHEN** opencode sends an OpenAI API request with a placeholder `OPENAI_API_KEY` or placeholder auth config
- **THEN** Agent Vault injects the real OpenAI credential before forwarding the request

#### Scenario: OpenAI OAuth credential is refreshed by broker

- **WHEN** the configured OpenAI credential is OAuth-managed and its access token nears expiry
- **THEN** Agent Vault refreshes the token and injects the fresh credential without exposing it to the agent container

### Requirement: Non-model upstreams may be proxied without strict deny

The vault SHALL support defining services for required non-model upstreams such as GitHub, generic APIs, HTTP/SSE MCP servers, and telemetry passthrough. The first-cut sandbox does not require strict denial for unmatched hosts because Agent Vault is being used primarily to protect credential material, not as a complete egress firewall.

#### Scenario: Unmatched host may pass without credential injection

- **WHEN** the agent requests a host with no matching credential-injection service
- **THEN** Agent Vault may forward or pass through the request without injecting stored credentials

#### Scenario: Anthropic-direct opencode is not configured

- **WHEN** opencode is launched in the first-cut sandbox
- **THEN** it uses OpenAI as its model provider and does not require an Anthropic-direct credential

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
