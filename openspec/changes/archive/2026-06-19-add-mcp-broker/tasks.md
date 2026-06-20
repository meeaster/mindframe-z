## 1. Spikes (resolve before building on them)

- [x] 1.1 Verify streamable-HTTP and long-lived SSE pass cleanly through Agent Vault's MITM via a forwarding shim (no buffering, stream stays open); document findings
- [x] 1.2 Confirm the Atlassian Rovo scoped-API-token header format (Bearer vs Basic vs custom) and document the org-admin steps required to enable API-token auth
- [x] 1.3 Confirm Claude Code's MCP transport honors a global proxy and per-server static headers (parallel to opencode); document any wiring differences
- [x] 1.4 Decide shim shape: one multiplexing process keyed by listen port vs one process per server, keeping "holds no secrets" and per-server identity clearest

## 2. Per-server MCP egress shim

- [x] 2.1 Implement the shim: a local listener that forwards agent MCP requests to a configured upstream host through Agent Vault using a vault-hint, streaming bodies without buffering
- [x] 2.2 Configure each shim with only upstream host + vault-hint; assert no credential material in its config or environment
- [x] 2.3 Add a teardown/lifecycle so shims start with and stop with the agent launch

## 3. Agent Vault vaults and services

- [x] 3.1 Create per-site vaults for shimmed same-host servers: Jira site and Confluence site
- [x] 3.2 Define a service in each shim vault for `mcp.atlassian.com`; define Datadog MCP in the main sandbox vault with `DD_ACCESS_TOKEN`
- [x] 3.3 Seed static credentials: Datadog personal access token in the main sandbox vault; Atlassian uses OAuth-seeded shim vault credentials
- [x] 3.4 Mint per-server agent tokens / vault grants so each shim's vault-hint resolves to exactly one vault

## 4. Launcher and agent config wiring

- [x] 4.1 Wire `scripts/run-sandbox.sh` (and `compose.yaml` as needed) to launch the shims alongside the agent container at distinct local endpoints
- [x] 4.2 Generate the agent's MCP config (`opencode.json`) pointing at the local shim endpoints with no auth and no MCP proxy directive; placeholder headers only where a static server needs header shape
- [x] 4.3 Assert the container holds no real MCP credentials and the agent config is authless

## 5. Phase 1 end-to-end (static)

- [x] 5.1 Run the agent against the Datadog MCP server through the normal Agent Vault path and confirm a real tool call succeeds with `DD_ACCESS_TOKEN` injected only at the broker
- [x] 5.2 Run the agent against one Atlassian site through its shim and confirm a real tool call succeeds
- [x] 5.3 Verify from the agent's perspective the connection looks direct (authless, no proxy awareness, streaming intact)

## 6. Phase 2 (OAuth bridge + multi-site)

- [x] 6.1 Implement the bridge: read already-acquired tokens from a real client login (OpenCode token store or normalized exported JSON) and `POST /v1/credentials/oauth/tokens` into the matching vault
- [x] 6.2 Seed OAuth credentials for Atlassian via the bridge and confirm broker injection; Datadog uses `DD_ACCESS_TOKEN` in the main sandbox vault
- [x] 6.3 Add the second Atlassian site so Jira and Confluence both target `mcp.atlassian.com` through separate shims/vaults; confirm the same-host collision resolves to the correct credential per server
- [x] 6.4 Verify agent behavior is identical whether a server is main-vault seeded or shim/OAuth-seeded

## 7. Documentation

- [x] 7.1 Document the MCP server taxonomy (local-CLI, anonymous public, API-key, credentialed remote) and which handling rule each uses
- [x] 7.2 Update README with the MCP broker model, shim ports, vault layout, and the static and OAuth seeding procedures
