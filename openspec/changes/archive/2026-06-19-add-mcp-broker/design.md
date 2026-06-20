## Context

The sandbox already brokers model-provider and CLI credentials through two patterns: a signing proxy (Bedrock) and Agent Vault's MITM credential-injection proxy (OpenAI OAuth, GitHub bearer). MCP is the next transport. The MCP servers we need are:

- **Datadog** — remote streamable-HTTP at `https://mcp.datadoghq.com/api/unstable/mcp-server/mcp`. OAuth 2.0 by default; supports headless Datadog personal access tokens as `Authorization: Bearer <token>`. The sandbox currently targets one Datadog organization, so it uses the main sandbox vault credential `DD_ACCESS_TOKEN` rather than a per-server shim vault.
- **Atlassian Rovo** — remote at `https://mcp.atlassian.com/v1/mcp`, serving both **Jira** and **Confluence**. OAuth 2.1 + Dynamic Client Registration by default; supports an admin-enabled, Rovo-scoped API token for headless auth. Jira and Confluence are separate Atlassian sites with different credentials but the same host.

Source-verified constraints that shape the design:

- **Agent Vault selects the vault by the proxy auth token, not the host** (`internal/brokercore/session.go` `ResolveForProxy`; injection scoped by `VaultID` at `internal/mitm/forward.go:241`). Two vaults can each define a service for the same host. There is **no agent-facing API to read a raw credential** — injection is proxy-only. OAuth is **paste + auto-refresh** (acquisition dropped in migration 041; refresh in `internal/brokercore/credential.go` `maybeRefreshOAuth`, 5-min buffer, 401-retry). Seeding via `POST /v1/oauth/token-upload`, `agent-vault vault credential set`, or proposals.
- **opencode's outbound proxy is global, not per-MCP-server** (`packages/opencode/src/mcp/index.ts:256-271` passes only `{ headers }`, never a custom `fetch`/dispatcher; Bun's fetch honors `HTTPS_PROXY`/`NO_PROXY` globally). opencode supports per-server static headers (`config/mcp.ts:28`) and per-server MCP OAuth with tokens at `~/.opencode/data/mcp-auth.json` shaped `{accessToken, refreshToken, expiresAt, scope}` (`mcp/auth.ts`).

The collision problem: with one global agent proxy, the Jira and Confluence MCP entries both hit `mcp.atlassian.com` presenting the same proxy identity, so Agent Vault cannot tell which vault/credential to inject.

## Goals / Non-Goals

**Goals:**
- Let the sandboxed agent use Datadog and Atlassian (Jira + Confluence) MCP servers with no real credentials in the container.
- Keep MCP egress transparent: the agent targets a local endpoint authlessly and behaves as if talking directly to the remote server, including long-lived SSE.
- Resolve the same-host / different-credential collision for Jira vs Confluence.
- Support both a static-token bootstrap and an OAuth path that shares the same injection layer, so OAuth can be the shareable long-term mode.

**Non-Goals:**
- No Agent Vault code changes — reuse existing injection, refresh, and token-upload.
- No browser-based OAuth acquisition inside the sandbox; acquisition happens via a real client login on a trusted host.
- No strict egress firewall (consistent with the existing deferred-hardening posture).
- Not addressing the mindframe-z personalization / mise dev-dependency layer.

## Decisions

**1. Per-server egress shim only where the agent proxy cannot express identity.**
The agent proxy is global, so it cannot present per-server identities for same-host servers. A thin per-server shim — one local listener per mapped logical MCP server — gives each mapped server its own egress identity by routing through Agent Vault with a distinct vault-hint (`http://<token>:<vault>@host.docker.internal:<mitm-port>`). The shim is a dumb HTTP/SSE pipe holding no secrets. Single-identity servers such as Datadog stay on the normal Agent Vault proxy path.
*Alternatives considered:* (a) one global proxy with host-based routing — rejected, Agent Vault routes by token not host, and the agent can't vary identity per server; (b) one opencode process per server with different env — rejected, heavyweight and breaks a single agent session; (c) patch opencode to pass a per-server `fetch` — rejected, upstream change we don't control and wouldn't help Claude Code.

**2. Transparency via authless local endpoints.**
The agent's MCP config points at `http://localhost:<port>` with no auth and no proxy directive. The shim forwards to the real upstream and Agent Vault injects on the shim's egress hop. This satisfies "the agent thinks it's working with it without going to a proxy" and keeps streaming behavior identical to a direct connection.

**3. One injection layer, two seeding paths.**
Static and OAuth credentials both end as Agent Vault injection on the egress hop; only seeding differs. Static (phase 1): paste provider keys/tokens via `agent-vault vault credential set`; agent sends placeholder headers. OAuth (phase 2): a bridge reads already-acquired client tokens after a real client login and `POST`s to `/v1/credentials/oauth/tokens`; Agent Vault injects + refreshes. The bridge is a thin upload adapter, not an OAuth implementation.
*Alternatives considered:* building PKCE/DCR acquisition into the shim — rejected, re-implements per-provider OAuth and re-introduces the DCR/callback grief that already failed; Agent Vault deliberately dropped acquisition.

**4. Per-vault identity keyed by site/org only for shimmed servers.**
Separate vaults for the Jira site and Confluence site each carry a service for `mcp.atlassian.com`. Datadog uses the main sandbox vault because there is one Datadog org today and the `DD_ACCESS_TOKEN` credential should be shared with PUP/CLI flows.

## Risks / Trade-offs

- **Long-lived SSE through the MITM may buffer or drop.** → Spike: verify streamable-HTTP and SSE pass cleanly through Agent Vault via the shim before building on it; if buffering occurs, ensure the shim and MITM stream without response buffering.
- **Atlassian static path depends on org-admin enablement and an unverified header format.** → Spike: confirm the Rovo scoped-API-token header shape (Bearer vs Basic vs custom) and document the admin-enable prerequisite; phase 1 can start with Datadog if Atlassian admin enablement lags.
- **Claude Code MCP proxy/header behavior is assumed parallel to opencode but unverified.** → Spike: confirm Claude Code's MCP transport honors a global proxy and per-server headers; the shim model is agent-agnostic, so the risk is config wiring, not architecture.
- **Shim is new attack surface on the host.** → Mitigation: shim holds no secrets, binds locally, and only forwards to one configured upstream via the broker; a compromised shim leaks no credential because injection happens in Agent Vault.
- **OAuth token capture can couple the bridge to a client-specific on-disk format.** → Mitigation: make OpenCode a concrete source adapter and support a normalized JSON source for clients whose token storage is undocumented or unstable.

## Implementation Notes

- Datadog static seeding uses `DD_ACCESS_TOKEN` as `Authorization: Bearer <token>` in the main sandbox vault. PATs authenticate API calls with one scoped credential and can be shared by PUP/CLI flows and the MCP server.

## Migration Plan

- **Phase 1 (static, bootstrap):** Build the shim; wire one shim for Datadog and one for a single Atlassian site; seed static credentials; verify end-to-end transparent access. Establishes the shim + per-vault model with the simplest credential path.
- **Phase 2 (OAuth, shareable):** Add the token-upload bridge; seed OAuth credentials from a real client login; add the second Atlassian site (Jira + Confluence) to prove same-host multi-vault resolution; confirm refresh.
- **Rollback:** Disabling a shim and removing its MCP entry from the agent config returns the agent to its prior state; no Agent Vault schema changes to revert.

## Open Questions

- Exact Atlassian Rovo scoped-API-token header format and the precise org-admin steps to enable it. Resolved: Atlassian supports `Authorization: Basic <base64(email:api_token)>` for personal API tokens and `Authorization: Bearer <api_key>` for service account keys, but an org admin must enable API-token auth for the Rovo MCP server.
- Whether Agent Vault's MITM streams SSE without buffering for the long-lived MCP case, and whether the shim needs explicit flush/stream handling. Resolved: Agent Vault streams CONNECT and plain HTTP responses without response buffering; the shim should avoid body rewriting and pipe streams directly.
- Claude Code's MCP proxy and per-server header behavior, to confirm the same wiring works for the second agent. Resolved: Claude Code supports per-server headers but relies on process/global proxy environment variables, so it has the same per-server identity limitation as opencode.
- Whether the shim should be one multiplexing process keyed by listen port or one process per server (favor whichever keeps "holds no secrets" and per-server identity clearest). Resolved: use one process per logical MCP server to keep vault identity and lifecycle explicit.
