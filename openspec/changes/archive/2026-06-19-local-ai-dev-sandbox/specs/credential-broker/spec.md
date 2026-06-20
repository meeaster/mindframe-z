## ADDED Requirements

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

The vault MAY define services for required non-model upstreams such as GitHub, generic APIs, HTTP/SSE MCP servers, and telemetry passthrough. The first-cut sandbox does not require strict denial for unmatched hosts because Agent Vault is being used primarily to protect credential material, not as a complete egress firewall.

#### Scenario: Unmatched host may pass without credential injection

- **WHEN** the agent requests a host with no matching credential-injection service
- **THEN** Agent Vault may forward or pass through the request without injecting stored credentials

#### Scenario: Anthropic-direct opencode is not configured

- **WHEN** opencode is launched in the first-cut sandbox
- **THEN** it uses OpenAI as its model provider and does not require an Anthropic-direct credential
