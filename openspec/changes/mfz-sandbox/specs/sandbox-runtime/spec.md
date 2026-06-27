## MODIFIED Requirements

### Requirement: Agent container egress routes through broker endpoints by default

The sandbox SHALL run the coding agent inside a Docker container with provider-specific proxy environment configured by the generated runtime. OpenAI traffic SHALL route through Agent Vault by default, and Claude Code SHALL use the credential leg selected by the machine's sandbox credential mode: the Bedrock signing proxy path when the mode is Bedrock, or the Agent Vault-brokered Claude subscription path when the mode is subscription.

#### Scenario: Direct outbound lockdown is deferred

- **WHEN** a process inside the agent container attempts to connect directly to a public host with proxy env unset
- **THEN** the current WSL-compatible launch mode MAY allow the connection unless a separate egress lockdown layer has been added

#### Scenario: Agent reaches approved upstreams only through brokers

- **WHEN** Claude Code or opencode contacts a model provider
- **THEN** opencode uses the Agent Vault/OpenAI path, and Claude Code uses the Bedrock signer path or the Agent Vault-brokered subscription path according to the machine credential mode

#### Scenario: Bedrock signer bypasses Agent Vault proxy

- **WHEN** the machine credential mode is Bedrock and Claude Code contacts the local Bedrock signer endpoint
- **THEN** the signer host is included in `NO_PROXY` so the request is not routed through Agent Vault

#### Scenario: Subscription path routes through Agent Vault

- **WHEN** the machine credential mode is subscription and Claude Code contacts its model provider
- **THEN** the request routes through Agent Vault, which injects the real Claude subscription credential, and no Bedrock signer is required

### Requirement: Agent-specific launch flow

The sandbox SHALL prepare the agent container from the resolved profile and machine
config, injecting the provider environment appropriate to the machine credential mode
so that Claude Code, opencode, and the GitHub CLI are usable from inside the container
without choosing an agent at launch. The runtime SHALL support entering the container
interactively as well as launching a named agent command directly. The GitHub
placeholder environment SHALL be present in every launch; the Claude credential
environment SHALL match the machine credential mode.

#### Scenario: Container is prepared from resolved config

- **WHEN** the operator launches the sandbox
- **THEN** the container has the GitHub placeholder token, Agent Vault proxy environment, and the Claude credential environment for the active machine credential mode — independent of which agent is run

#### Scenario: Launch Claude Code with Bedrock

- **WHEN** the machine credential mode is Bedrock and the operator runs Claude Code, whether directly or from inside the interactive shell
- **THEN** the container has `CLAUDE_CODE_USE_BEDROCK=1`, `ANTHROPIC_BEDROCK_BASE_URL` pointing at the reachable signer endpoint, and the signer host in `NO_PROXY`, with no AWS credentials mounted

#### Scenario: Launch Claude Code with subscription

- **WHEN** the machine credential mode is subscription and the operator runs Claude Code
- **THEN** Claude Code uses placeholder subscription auth and routes through Agent Vault, which injects the real subscription credential, with no Bedrock environment required

#### Scenario: Launch opencode with OpenAI

- **WHEN** the operator runs opencode, whether directly or from inside the interactive shell
- **THEN** opencode uses placeholder OpenAI auth and routes OpenAI traffic through Agent Vault

#### Scenario: Enter the container interactively

- **WHEN** the operator launches the sandbox without naming an agent command
- **THEN** the container drops the operator into an interactive shell with the full brokered environment in place

## ADDED Requirements

### Requirement: Runtime is generated from resolved config without hardcoded paths

The sandbox runtime SHALL be generated from the resolved profile and machine config,
covering broker service definitions and agent container run arguments. The runtime
SHALL NOT embed hardcoded host-specific absolute paths, so the runner stays portable
across machines and a future shareable-core / private-profile repo split needs no path
edits.

#### Scenario: Run arguments come from resolved config

- **WHEN** the sandbox launches
- **THEN** the mounts, environment, and service definitions are derived from the
  resolved profile and machine config rather than committed host-specific paths

#### Scenario: No hardcoded home paths in the runner

- **WHEN** the sandbox runner is inspected
- **THEN** it contains no hardcoded user-home absolute path and instead resolves such
  paths from configuration at runtime

### Requirement: Rendered config layer and git config are mounted

The sandbox SHALL mount the rendered `configs/<profile>/` config layer, the references
directory, and the rendered `~/.gitconfig` and global git ignore file read-only, in
addition to the read-write workspace mount, so the container environment matches the
host without copying.

#### Scenario: Rendered config and git config are present read-only

- **WHEN** the sandbox launches
- **THEN** the rendered profile config layer, references directory, and rendered git
  config are mounted read-only and the workspace is mounted read-write
