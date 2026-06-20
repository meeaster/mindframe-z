## 1. Bedrock signing proxy for Claude Code

- [x] 1.1 Create an AWS profile (e.g. `bedrock-sandbox`) wired with `credential_process` for the Bedrock credential-process distribution
- [x] 1.2 Verify direct Bedrock Converse succeeds with `bedrock-sandbox` credentials; STS is not required because these Cognito credentials are scoped for Bedrock runtime access
- [x] 1.3 Add a dedicated Bedrock SigV4 proxy host script outside the agent container, bound to a fixed local port
- [x] 1.4 Verify from an AWS-credential-scrubbed caller that an unsigned Converse request through the proxy returns 200
- [x] 1.5 Decide and implement durable signer refresh strategy: use the host/WSL Bedrock credential-process environment so browser callback and existing credential/session storage work outside the agent container
- [x] 1.6 Re-run forced-expiry/refresh validation if durable refresh is implemented; accepted host/WSL credential-process refresh behavior based on observed browser re-auth flow

## 2. Containerized Agent Vault broker

- [x] 2.1 Move Agent Vault server from WSL daemon usage to a containerized local service with persistent `/data` volume
- [x] 2.2 Publish/configure API and MITM proxy endpoints for the host launch wrapper and agent containers
- [x] 2.3 Create a named Agent Vault agent with instance role `no-access` and vault grant `local-ai-dev-sandbox:proxy`
- [x] 2.4 Configure ChatGPT OAuth auth for opencode in Agent Vault, using a custom `chatgpt.com/backend-api/codex/*` service that injects OAuth bearer and account headers
- [x] 2.5 Configure optional non-model upstreams as needed: GitHub, generic APIs, HTTP/SSE MCP servers, telemetry passthrough; strict deny is not required
- [x] 2.6 Verify opencode OpenAI request succeeds while the agent container holds only placeholder OpenAI auth
- [x] 2.7 Verify unmatched hosts can pass through without stored credential injection

## 3. Sandbox agent container runtime

- [x] 3.1 Define the agent container image with Claude Code, opencode, and required tooling
- [x] 3.2 Use WSL-compatible named Agent Vault agent token, then launch Docker with Agent Vault proxy/CA env
- [x] 3.3 Update the launch wrapper to target the containerized Agent Vault server via `AGENT_VAULT_ADDR`
- [x] 3.4 Split launch behavior by agent: Claude Code gets Bedrock env, opencode gets OpenAI placeholder auth and no Anthropic-direct auth
- [x] 3.5 Implement workspace mount and read-only reference mounts
- [x] 3.6 Reject mounts pointing into host/broker credential stores
- [x] 3.7 Ensure placeholder credential files/env are agent-specific and contain no real secrets
- [x] 3.8 Create one supported launch command for `claude` and `opencode`

## 4. End-to-end verification

- [x] 4.1 Launch Claude Code in the sandbox and confirm Bedrock inference works through the SigV4 proxy
- [x] 4.2 Launch opencode in the sandbox and confirm OpenAI requests work through Agent Vault
- [x] 4.3 Decide and verify a separate direct-egress lockdown layer, or document direct egress as deferred for the WSL-compatible mode
- [x] 4.4 Confirm no real AWS, OpenAI, GitHub, OAuth, or broker-storage credentials are present in the agent container filesystem, environment, or mounts
- [x] 4.5 Document setup, run commands, supported auth modes, and deferred items in the repo README
