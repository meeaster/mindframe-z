## ADDED Requirements

### Requirement: Agent container egress routes through broker endpoints by default

The sandbox SHALL run the coding agent inside a Docker container with provider-specific proxy environment configured by the WSL launch wrapper. OpenAI traffic SHALL route through Agent Vault by default, and Claude Code SHALL use the Bedrock signing proxy path.

#### Scenario: Direct outbound lockdown is deferred

- **WHEN** a process inside the agent container attempts to connect directly to a public host with proxy env unset
- **THEN** the current WSL-compatible launch mode MAY allow the connection unless a separate egress lockdown layer has been added

#### Scenario: Agent reaches approved upstreams only through brokers

- **WHEN** Claude Code or opencode contacts a model provider
- **THEN** Claude Code uses the Bedrock signer path and opencode uses the Agent Vault/OpenAI path

#### Scenario: Bedrock signer bypasses Agent Vault proxy

- **WHEN** Claude Code contacts the local Bedrock signer endpoint
- **THEN** the signer host is included in `NO_PROXY` so the request is not routed through Agent Vault

### Requirement: Agent container holds no real credentials

The sandbox SHALL ensure that no real provider credential material or broker storage is present in the agent container filesystem or environment. Placeholder provider credentials MAY be present only to satisfy agent login/config checks. A scoped Agent Vault agent token MAY be present to authorize proxy use for the assigned vault.

#### Scenario: Credential files contain only placeholders

- **WHEN** the agent container filesystem and environment are inspected after launch
- **THEN** any provider credential-shaped values are placeholders and no AWS, OpenAI, GitHub, OAuth, or Agent Vault storage secret is present

#### Scenario: Broker credential stores are never mounted into the agent container

- **WHEN** agent container mounts are enumerated
- **THEN** host credential stores and broker data volumes such as `~/.aws`, `~/.agent-vault`, `~/.claude`, Agent Vault `/data`, and Bedrock signer AWS volumes are absent

### Requirement: Workspace and reference mounts

The sandbox SHALL mount the current project directory read-write at a known workspace path and SHALL support mounting additional reference folders read-only. Mounts that expose credential stores MUST be rejected.

#### Scenario: Project workspace is writable

- **WHEN** the agent reads and writes files under the workspace mount
- **THEN** the changes are reflected on the host project directory

#### Scenario: Reference folder is read-only

- **WHEN** the agent attempts to write to a folder mounted as a reference
- **THEN** the write fails because the mount is read-only

#### Scenario: Credential-store mounts are rejected

- **WHEN** a mount points into a known host or broker credential store
- **THEN** the sandbox refuses to start with that mount

### Requirement: Agent-specific launch flow

The sandbox SHALL provide one launch command that starts either Claude Code or opencode in the locked agent container with the correct provider-specific environment.

#### Scenario: Launch Claude Code with Bedrock

- **WHEN** the operator launches Claude Code
- **THEN** the agent container has `CLAUDE_CODE_USE_BEDROCK=1`, `ANTHROPIC_BEDROCK_BASE_URL` pointing at the reachable WSL signer endpoint, Claude debug logging enabled, the signer host in `NO_PROXY`, and no AWS credentials mounted

#### Scenario: Launch opencode with OpenAI

- **WHEN** the operator launches opencode
- **THEN** the agent container has placeholder OpenAI auth configured and routes OpenAI traffic through Agent Vault
