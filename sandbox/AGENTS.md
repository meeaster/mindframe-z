# Agent Instructions

## Diagnostics

- For MCP broker or Agent Vault issues, check logs before changing code, credentials, or config.
- First inspect shim logs under `.cache/mcp-shims/` to confirm the agent reached the expected local shim, upstream host, and vault hint.
- Then inspect Agent Vault request logs for the relevant vault to confirm `matched_service`, `credential_keys`, status, and ingress.
- Do not infer credential problems until logs prove the request reached Agent Vault and matched the intended service.
- Keep logs non-secret: record server names, methods, paths, hosts, vault hints, statuses, matched service names, and credential key names only.
