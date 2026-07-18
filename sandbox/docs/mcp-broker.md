# MCP Broker

The sandbox handles MCP servers by category:

| Server type                         | Example                               | Handling rule                                                                                  |
| ----------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Local CLI                           | `fff`                                 | Run inside the agent container; no broker, shim, or external credential.                       |
| Anonymous public                    | DeepWiki-style public docs            | Connect directly without credential injection.                                                 |
| Single-identity credentialed remote | Datadog                               | Use the normal Agent Vault proxy and the main sandbox vault.                                   |
| Same-host multi-identity remote     | Jira and Confluence on Atlassian Rovo | Route through one local egress shim per logical server and one Agent Vault vault per site/org. |

## Shim Model

`scripts/run-sandbox.sh` starts `scripts/run-with-mcp-shims.mjs` inside the agent container before launching the requested agent. The wrapper reads `mcp-broker.json`, finds matching MCP server names in the agent config, and starts one `scripts/mcp-egress-shim.mjs` process for each mapped server.

| Logical server         | Local URL                                 | Upstream                    | Default vault hint                       |
| ---------------------- | ----------------------------------------- | --------------------------- | ---------------------------------------- |
| Any mapped server name | `http://127.0.0.1:<port>/<upstream-path>` | The server's configured URL | `local-ai-dev-sandbox-mcp-<server-name>` |

Each shim is a streaming reverse proxy. It preserves MCP request/response headers, status codes, Streamable HTTP bodies, and long-lived SSE streams. It does not parse JSON-RPC, translate session IDs, or store provider credentials.

Agent Vault sees the shim egress through its MITM proxy with `AGENT_VAULT_TOKEN:<vault-hint>` proxy auth. That lets any two same-host servers target the same upstream host while selecting different vaults.

Set `SANDBOX_MCP_BROKER_ENABLED=0` to launch without these shims.

## Shim Mapping

`mcp-broker.json` is intentionally small. It only lists MCP server names that need a shim:

```json
{
  "basePort": 17301,
  "shims": {
    "jira": {
      "oauth": {
        "key": "JIRA_OAUTH",
        "tokenUrl": "https://cf.mcp.atlassian.com/v1/token",
        "accessTokenOnly": true
      }
    },
    "confluence": {
      "oauth": {
        "key": "CONFLUENCE_OAUTH",
        "tokenUrl": "https://cf.mcp.atlassian.com/v1/token",
        "accessTokenOnly": true
      }
    }
  }
}
```

Each entry may override `port`, `vault`, `upstream`, or `oauth.key`; otherwise the wrapper uses the server URL from `opencode.json`, allocates a port from `basePort`, infers the vault as `local-ai-dev-sandbox-mcp-<server-name>`, and infers the OAuth credential key as `<SERVER_NAME>_OAUTH`.

## OpenCode Config

The checked-in `opencode.json` keeps normal upstream MCP URLs so host-side OAuth setup remains natural. On sandbox launch, the wrapper writes `/tmp/sandbox-opencode.json` and sets `OPENCODE_CONFIG` for the `opencode` process. Only mapped shim entries are rewritten to local authless shim URLs. The source config is not mutated. The wrapper supports both OpenCode's documented flat `mcp.<serverName>` shape and newer nested `mcp.servers.<serverName>` configs.

## Vault Layout

Create one vault per shim identity and keep single-identity services in the main sandbox vault:

- Main sandbox vault: Datadog service host `mcp.datadoghq.com`.
- Jira site vault: service host `mcp.atlassian.com`.
- Confluence site vault: service host `mcp.atlassian.com`.

Datadog static auth uses a personal access token (PAT) as bearer auth:

- `Authorization: Bearer {{ DD_ACCESS_TOKEN }}`

Datadog PATs authenticate API calls with a single short-lived scoped credential and do not need an API key/application-key pair. The credential key is `DD_ACCESS_TOKEN` so it can be reused by PUP/DataDog CLI flows and the MCP server.

Atlassian Rovo static auth uses one custom header:

- Personal API token: `Authorization: Basic <base64(email:api_token)>`
- Service account key: `Authorization: Bearer <api_key>`

Atlassian API-token auth only works after an organization admin enables API-token authentication for the Rovo MCP server.

Run `./scripts/seed-mcp-vaults.sh` for a checklist of vaults, services, and credentials to create. The script prints instructions rather than accepting secrets, so provider credentials do not enter this repository.

## OAuth Seeding

For OAuth-backed shim credentials, complete an MCP OAuth login in a real OpenCode client, then upload the saved access/refresh token pair into the matching Agent Vault vault:

```bash
node scripts/broker-mcp-oauth.mjs --source opencode
```

Use `--server jira` to upload one mapped server, or `--dry-run` to validate mapping without uploading. By default the bridge reads OpenCode's `~/.local/share/opencode/mcp-auth.json`. Override with `OPENCODE_MCP_AUTH_PATH` or `--token-file` if needed. The bridge uploads to Agent Vault's `/v1/credentials/oauth/tokens` endpoint. Set `oauth.accessTokenOnly` when the provider's refresh flow is not compatible with Agent Vault's generic refresh upload; Agent Vault will inject the captured access token but will not auto-refresh it.

Claude Code supports OAuth for remote MCP servers, but its local OAuth token storage is not documented as a stable interface. To seed Agent Vault from Claude Code today, export tokens into normalized JSON and run:

```bash
node scripts/broker-mcp-oauth.mjs --source json --token-file /path/to/mcp-tokens.json
```

The normalized shape is:

```json
{
  "servers": {
    "jira": {
      "accessToken": "...",
      "refreshToken": "...",
      "clientId": "..."
    }
  }
}
```

## Executor Boundary

The host Executor runtime is a separate credential boundary from the sandbox. A profile that routes an MCP server through Executor is rejected by sandbox startup until a dedicated host-to-sandbox design exists. Do not mount the native `~/.executor` store (or an intentionally configured `EXECUTOR_DATA_DIR`), control-manifest tokens, OAuth state, or generated Executor snapshots into the sandbox. Existing profile-scoped MFZ Executor directories are legacy state and are not migrated or deleted automatically. Direct MCP and the existing Agent Vault shim model remain the supported sandbox paths; their credential handoffs must not be reused as Executor connection input.

## Spike Findings

- Agent Vault MITM streams long-lived responses with `io.Copy` and supports long-running CONNECT transfers, so MCP Streamable HTTP and SSE should pass without response buffering.
- Agent Vault selects vault identity from proxy auth, not destination host. The Basic proxy-auth hint form is `token:vault`, which is why each shim carries its own vault hint.
- OpenCode and Claude Code both support per-server headers but rely on process/global proxy behavior, so neither can express different Agent Vault identities for two same-host MCP servers without a shim.
- One process per logical server keeps the no-secrets boundary clearest. The shim receives upstream URL, vault hint, listen port, Agent Vault proxy host/port, and the existing Agent Vault proxy token; it receives no provider API key, OAuth token, or refresh token.
