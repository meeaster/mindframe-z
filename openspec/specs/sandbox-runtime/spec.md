## Purpose

Define the sandbox container runtime, launch behavior, mounts, and credential boundary for local AI coding agents.

## Requirements

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

The sandbox SHALL prepare the agent container identically regardless of which
agent will run, injecting the union of provider environment so that Claude Code,
opencode, and the GitHub CLI are all usable from inside the container without
choosing an agent at launch. The launcher SHALL support entering the container
interactively as well as launching a named agent command directly. The Bedrock
signer environment and the GitHub placeholder environment SHALL both be present
in every launch.

#### Scenario: Container is prepared identically across agents

- **WHEN** the operator launches the sandbox
- **THEN** the container has `CLAUDE_CODE_USE_BEDROCK=1`, `ANTHROPIC_BEDROCK_BASE_URL`
  pointing at the reachable WSL signer endpoint, the signer host in `NO_PROXY`,
  the GitHub placeholder token, and Agent Vault proxy environment — independent
  of which agent is run

#### Scenario: Launch Claude Code with Bedrock

- **WHEN** the operator runs Claude Code, whether directly or from inside the
  interactive shell
- **THEN** Claude Code uses the Bedrock signer path with the signer host in
  `NO_PROXY` and no AWS credentials mounted

#### Scenario: Launch opencode with OpenAI

- **WHEN** the operator runs opencode, whether directly or from inside the
  interactive shell
- **THEN** opencode uses placeholder OpenAI auth and routes OpenAI traffic
  through Agent Vault

#### Scenario: Enter the container interactively

- **WHEN** the operator launches the sandbox without naming an agent command
- **THEN** the container drops the operator into an interactive shell with the
  full brokered environment in place

### Requirement: Per-server MCP shims run as a container-lifetime background service

The sandbox launch flow SHALL start one MCP egress shim per configured same-host
multi-identity MCP server as a background service that runs for the lifetime of
the container, reachable by in-container clients at distinct local endpoints.
Shims SHALL be started during container start before the interactive shell or
any agent is usable, and SHALL NOT be tied to the lifecycle of a single agent
process. Each shim SHALL be configured with its upstream MCP host and its
vault-hint, SHALL route egress through Agent Vault using that hint, and SHALL
receive no real credential material.

#### Scenario: Shims start with the container

- **WHEN** the container starts with credentialed MCP servers enabled
- **THEN** a shim is running for each such server at its own local endpoint, each
  routing through Agent Vault with its server's vault-hint, before the
  interactive shell or any agent is usable

#### Scenario: Clients start after shim readiness

- **WHEN** the sandbox wrapper starts local MCP shims
- **THEN** it waits for each shim endpoint to accept local connections before
  starting the interactive shell or named agent command

#### Scenario: Shims survive across agent invocations

- **WHEN** an agent process started inside the container exits
- **THEN** the MCP shims keep running and remain usable by the next agent started
  in the same container

#### Scenario: Wrapper owns shim cleanup

- **WHEN** the interactive shell or directly launched agent exits
- **THEN** the sandbox wrapper terminates the background shims before the
  temporary container exits

#### Scenario: Shim launch carries no secrets

- **WHEN** the launch wrapper configures a shim
- **THEN** it passes only the upstream host and vault-hint, and no provider API key, OAuth token, or refresh token

### Requirement: Sandbox-owned persisted agent state

The sandbox SHALL persist Claude Code and opencode state in repo-local sandbox
directories rather than mounting the operator's real host home or secret-bearing
dotfiles. Persisted state SHALL be seeded with sanitized defaults when absent.

#### Scenario: Claude Code state persists without host home mounts

- **WHEN** the sandbox launches
- **THEN** sandbox-owned Claude state is mounted at `/home/sandbox/.claude` and
  sandbox-owned `.claude.json` is mounted at `/home/sandbox/.claude.json`

#### Scenario: opencode state persists without host home mounts

- **WHEN** the sandbox launches
- **THEN** sandbox-rendered opencode config is mounted read-only under
  `/home/sandbox/.config/opencode`, sandbox-owned opencode data is mounted at
  `/home/sandbox/.local/share/opencode`, and sandbox-owned opencode state is mounted at
  `/home/sandbox/.local/state/opencode`

#### Scenario: Persisted state is seeded safely

- **WHEN** the sandbox-owned state files do not yet exist
- **THEN** the launcher creates the directories and seeds only sanitized Claude
  settings, opencode placeholder auth, and an empty `.claude.json`

### Requirement: Agent MCP config points at local shims without credentials

The sandbox SHALL generate agent MCP server entries for mapped shimmed servers that target the local shim endpoints with no real authentication and no proxy setting for MCP traffic. Placeholder credential headers MAY be present only where a static MCP server requires header shape; real values MUST NOT appear. Source agent configuration SHALL remain pointed at the upstream server.

#### Scenario: Agent MCP entry targets a shim authlessly

- **WHEN** the agent's MCP configuration is generated for a credentialed remote MCP server
- **THEN** the entry points at the server's local shim endpoint with no token and no proxy directive

#### Scenario: Only placeholders appear for static servers

- **WHEN** a static MCP server requires named credential headers
- **THEN** the agent config contains placeholder header values and the real values are injected only by the broker
