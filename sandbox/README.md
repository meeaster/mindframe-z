# Local AI Dev Sandbox

This repository is a work-in-progress development sandbox for running AI coding tools in a container while keeping real provider credentials outside the agent container. The setup is intentionally evolving; commands, images, services, and security boundaries may change.

## Current Model

- Agent tools run in `local-ai-dev-sandbox-agent:latest` as the non-root `node` user, from an interactive zsh/oh-my-zsh/mise environment.
- Agent Vault runs outside the agent container and brokers credential injection through its local HTTPS MITM proxy.
- The agent container receives placeholder provider credentials plus Agent Vault proxy/CA settings.
- Claude Code uses a host/WSL Bedrock SigV4 signer and receives Bedrock/AWS placeholder env in every sandbox launch.
- opencode uses placeholder OpenAI OAuth auth so it follows its ChatGPT/Codex request path, while Agent Vault injects the real ChatGPT OAuth bearer token and account header.
- GitHub CLI uses `GH_TOKEN=PLACEHOLDER`; Agent Vault injects the real GitHub bearer token for `api.github.com`.
- Same-host MCP servers that need distinct identities use local per-server egress shims generated from `mcp-broker.json`; single-identity services such as Datadog use the normal Agent Vault path.
- Launching without an agent enters an interactive zsh shell; `bash` mode remains available for inspection and tool testing inside the same sandbox environment.

## Commands

Build the sandbox image:

```bash
./scripts/build-sandbox-image.sh
```

Run Claude Code through Bedrock:

```bash
./scripts/run-sandbox.sh claude --bare -p 'Reply with ok only.'
```

Run opencode through Agent Vault-backed ChatGPT OAuth:

```bash
./scripts/run-sandbox.sh opencode run -m openai/gpt-5.4-mini 'Reply with ok only.'
```

Enter the interactive zsh shell:

```bash
./scripts/run-sandbox.sh
```

Run bash in the sandbox:

```bash
./scripts/run-sandbox.sh bash
```

Test GitHub CLI through Agent Vault:

```bash
./scripts/run-sandbox.sh bash -lc 'gh api user --jq .login'
```

Review MCP broker setup and vault seeding:

```bash
./scripts/seed-mcp-vaults.sh
```

See `docs/mcp-broker.md` for the MCP server taxonomy, default shim ports, vault layout, and static/OAuth seeding procedures.

## Credential Boundary

The agent container should not mount host credential stores such as `~/.aws`, `~/.agent-vault`, `~/.claude`, or `~/.config/gh`. The launcher rejects configured reference mounts that point at known credential-store paths.

Expected sensitive-looking values inside the container are limited to:

- `AGENT_VAULT_TOKEN`, a scoped Agent Vault agent token for proxy access.
- Agent Vault proxy URLs containing that scoped token.
- placeholder values such as `GH_TOKEN=PLACEHOLDER` or dummy opencode OAuth tokens.
- MCP placeholder headers such as `Authorization=PLACEHOLDER`.
- CA bundle paths pointing at the mounted Agent Vault MITM CA.

Current verification found no Docker socket mount, no AWS credential directory, no Agent Vault storage directory, no GitHub CLI credential store, and no real provider tokens in the inspected container filesystem or environment.

## Deferred Hardening

Direct egress lockdown is deferred for the WSL-compatible path. The current model proxies normal tool traffic through Agent Vault, but it is not a complete network firewall. Treat this as a development sandbox, not a final production isolation boundary.

Container escape prevention relies on standard Docker isolation plus the current launcher posture: non-root user, no privileged flag, no Docker socket mount, no broker storage mounts, and no host credential-store mounts. This reduces obvious breakout paths but does not prove that container escape is impossible.
