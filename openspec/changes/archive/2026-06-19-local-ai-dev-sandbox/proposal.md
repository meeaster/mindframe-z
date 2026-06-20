## Why

Running AI coding agents directly on a developer machine exposes local credentials and network access to an agent process that can be steered by prompt injection or malicious tooling. The sandbox should make the **agent container** credential-free and network-constrained while still letting supported agents use the services they need.

Implementation discovery changed the boundary: credentials do not have to remain exclusively on the WSL host. They may live in dedicated broker/proxy containers, as long as the coding-agent container cannot read them and can reach the network only through approved broker endpoints.

## What Changes

- Run the coding agent inside a Docker container with kernel-enforced egress lockdown through `agent-vault run --isolation=container`.
- Run Agent Vault as a local containerized service with persistent `/data` storage, exposing the control API and MITM proxy to the host/agent launch wrapper.
- Route non-AWS agent egress through Agent Vault. Initial supported non-AWS model path is **opencode with OpenAI auth**; Anthropic-direct for opencode is out of scope.
- Route Claude Code model inference through Bedrock using a dedicated host/WSL `aws-sigv4-proxy` outside the agent container. A containerized signer may be revisited later, but the host/WSL signer is the default because the Bedrock credential process uses browser callback and local credential storage.
- Provide read-write workspace and read-only reference mounts while rejecting host credential-store mounts into the agent container.
- Keep general multi-profile AWS CLI access out of scope.

## Capabilities

### New Capabilities
- `sandbox-runtime`: isolated agent container, egress lockdown, workspace/reference mounts, agent-specific launch flow, and credential-store mount rejection.
- `credential-broker`: containerized Agent Vault server and MITM proxy for non-AWS credentials, including OpenAI auth for opencode and optional GitHub/generic/HTTP MCP credentials.
- `bedrock-signing-proxy`: dedicated Bedrock SigV4 signer for Claude Code, running outside the agent container and sourcing credentials through the Bedrock credential process.

### Modified Capabilities
<!-- None — greenfield repository. -->

## Impact

- Adds Docker Compose/runtime scaffolding for Agent Vault, Bedrock signing proxy, and the agent image/launcher.
- Requires Docker with host-gateway support and a Docker CLI available where `agent-vault run --isolation=container` is invoked.
- Requires the existing Bedrock credential-process distribution for Claude Code Bedrock access.
- Requires Agent Vault services/credentials for OpenAI auth used by opencode.
- Validated so far: direct Bedrock Converse works, and an unsigned Bedrock Converse request through the custom SigV4 proxy returns 200 from an AWS-credential-scrubbed caller.
