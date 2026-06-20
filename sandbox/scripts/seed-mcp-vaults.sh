#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

agent_vault_addr="${AGENT_VAULT_ADDR:-http://127.0.0.1:${AGENT_VAULT_API_PORT:-14321}}"

cat <<EOF
Create these Agent Vault resources with the Agent Vault CLI or UI at $agent_vault_addr:

Vaults:
- local-ai-dev-sandbox (already used by the sandbox; add Datadog here)
- local-ai-dev-sandbox-mcp-jira
- local-ai-dev-sandbox-mcp-confluence

Services:
- Main sandbox vault: host mcp.datadoghq.com, bearer credential DD_ACCESS_TOKEN
- Jira vault: host mcp.atlassian.com, custom header Authorization={{ ATLASSIAN_AUTHORIZATION }}
- Confluence vault: host mcp.atlassian.com, custom header Authorization={{ ATLASSIAN_AUTHORIZATION }}

Credentials to seed:
- Datadog: DD_ACCESS_TOKEN personal access token, injected as Authorization: Bearer <token>
- Atlassian personal token: ATLASSIAN_AUTHORIZATION="Basic <base64(email:api_token)>"
- Atlassian service account key: ATLASSIAN_AUTHORIZATION="Bearer <api_key>"

Grant the sandbox agent proxy access to each shim vault, then set AGENT_VAULT_TOKEN in .env.
The shim uses AGENT_VAULT_TOKEN plus the per-server vault hint; no provider credential is passed to the agent container or shim environment.
EOF
