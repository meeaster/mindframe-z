## MODIFIED Requirements

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

- **WHEN** the launch flow configures a shim
- **THEN** it passes only the upstream host and vault-hint, and no provider API
  key, OAuth token, or refresh token

### Requirement: Sandbox-owned persisted agent state

The sandbox SHALL persist Claude Code and opencode state in repo-local sandbox
directories rather than mounting the operator's real host home or secret-bearing
dotfiles. Persisted state SHALL be seeded with sanitized defaults when absent.

#### Scenario: Claude Code state persists without host home mounts

- **WHEN** the sandbox launches
- **THEN** `.cache/sandbox-home/claude` is mounted at `/home/node/.claude` and
  `.cache/sandbox-home/claude.json` is mounted at `/home/node/.claude.json`

#### Scenario: opencode state persists without host home mounts

- **WHEN** the sandbox launches
- **THEN** `.cache/sandbox-home/opencode-config` is mounted at
  `/home/node/.config/opencode`, `.cache/sandbox-home/opencode-data` is mounted
  at `/home/node/.local/share/opencode`, and
  `.cache/sandbox-home/opencode-state` is mounted at
  `/home/node/.local/state/opencode`

#### Scenario: Persisted state is seeded safely

- **WHEN** the sandbox-owned state files do not yet exist
- **THEN** the launcher creates the directories and seeds only sanitized Claude
  settings, opencode placeholder auth, and an empty `.claude.json`
