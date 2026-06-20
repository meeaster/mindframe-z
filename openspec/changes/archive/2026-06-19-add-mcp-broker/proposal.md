## Why

The sandbox proves out brokered model-provider and CLI credentials (Bedrock, OpenAI, GitHub) but has no story for MCP servers. The MCP servers we actually need — Datadog and Atlassian Rovo (Jira and Confluence) — are credentialed remote servers, and Atlassian routes both Jira and Confluence through the same host (`mcp.atlassian.com`) with different per-site credentials. The sandboxed agent must reach these servers without holding real credentials and without knowing a proxy is involved, so the same credential boundary we built for models and CLIs has to extend to MCP.

## What Changes

- Introduce a **per-server MCP egress shim for same-host multi-identity servers**: one local listener per logical MCP server that the agent points at directly (authless). Each shim forwards to Agent Vault with its own vault-hint so it carries a distinct egress identity. This is required because the agent's outbound proxy is global, not per-server, so two Atlassian sites on one host would otherwise collide. Single-identity servers such as Datadog use the normal sandbox vault/proxy path instead of a shim.
- Make MCP egress **transparent to the agent**: the agent's MCP config targets `http://localhost:<port>` with no auth and must behave exactly as if talking directly to the remote MCP server (streamable-HTTP and long-lived SSE pass through unchanged). All credential injection happens on the shim's egress hop via Agent Vault.
- Support **two credential-seeding paths over one injection layer**:
  - **Static (phase 1, bootstrap):** paste a Datadog personal access token and the Atlassian Rovo scoped API token into per-vault credentials; the agent sends placeholder headers and Agent Vault substitutes real values.
  - **OAuth (phase 2, shareable):** a bridge reads already-authenticated tokens from a real client's store (opencode's `~/.opencode/data/mcp-auth.json`) and uploads them to the right vault via `POST /v1/oauth/token-upload`; Agent Vault then injects and auto-refreshes. OAuth is the longer-term target because tokens are short-lived and teammates avoid minting API credentials by hand.
- Document an **MCP server taxonomy** so each server type maps to a handling rule: local-CLI MCP (e.g. fff) needs no proxy or credentials; anonymous public MCP (e.g. deepwiki) is passthrough; API-key MCP (e.g. Exa) uses static injection like GitHub; credentialed remote MCP (Datadog, Atlassian) uses the shim + per-vault model.
- Establish **per-vault identities** only where needed by same-host collisions: separate vaults for the Jira site and Confluence site, each defining a service for `mcp.atlassian.com`; Datadog uses the main sandbox vault with `DD_ACCESS_TOKEN` so the same credential can be reused by PUP and the MCP server.

## Capabilities

### New Capabilities
- `mcp-broker`: How the sandbox brokers credentials for MCP servers — the per-server egress shim, transparent passthrough requirement, per-vault identity model for same-host servers, static and OAuth seeding paths, and the MCP server taxonomy.

### Modified Capabilities
- `credential-broker`: Add requirements for brokering MCP credentials — per-vault selection for same-host MCP upstreams via distinct egress identities, static-header and OAuth injection for MCP servers, and the OAuth token-upload bridge as a seeding path.
- `sandbox-runtime`: Add requirements for launching the per-server MCP shims alongside the agent container and wiring the agent's MCP config to the local shim endpoints without credentials.

## Impact

- **Repo:** `/home/mark/work/local-ai-dev-sandbox` — new shim component, launcher wiring in `scripts/run-sandbox.sh`, `compose.yaml` services, agent MCP config (`opencode.json` and Claude Code equivalent), and a bridge script for the OAuth path.
- **Agent Vault:** new per-site vaults for same-host Atlassian services plus a Datadog MCP service in the main sandbox vault; static credentials now, OAuth credentials in phase 2. No Agent Vault code changes — uses existing injection, refresh, and token-upload.
- **External dependency:** Atlassian org-admin must enable Rovo scoped-API-token auth before the static Atlassian path works.
- **Out of scope:** the mindframe-z personalization / mise dev-dependency layer (separate future work).
