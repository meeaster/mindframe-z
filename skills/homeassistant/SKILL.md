---
name: homeassistant
description: "Use when the user asks to inspect, script, test, or troubleshoot Home Assistant through CLI-accessible HTTP or WebSocket APIs, including curl, inline Python with uv, authentication, service calls, events, entity registry work, or voice-assistant exposure. Keep guidance concise and fetch current Home Assistant docs/source for exact routes and schemas."
---

# Home Assistant API CLI

Use this as lightweight guidance for interacting with Home Assistant from the CLI. Do not use this file as an API reference; check current Home Assistant docs or source before giving exact routes, command types, fields, or response shapes.

## Defaults

- Use `curl` for HTTP endpoints and inline Python with `uv run --with websockets --no-project` for WebSocket commands.
- Derive API endpoints from the user's Home Assistant base URL; use `https`/`wss` together and `http`/`ws` together.
- Prefer harmless read requests first when testing connectivity, auth, or a new command path.
- Avoid broad state dumps for single-entity work. Use targeted HTTP state endpoints for one/few entity states; reserve WebSocket state dumps for cases that truly need all states.
- For operations that are frontend-backed, registry/config-oriented, streaming, or not exposed through REST, expect WebSocket to be the right interface.

## Documentation Lookup

Before producing exact JSON or URLs:

- Check official Home Assistant REST API docs for HTTP endpoints.
- Check official Home Assistant WebSocket API docs for WebSocket flow and documented commands.
- Check Home Assistant Authentication API docs for token behavior.
- If docs omit a config/registry WebSocket command, inspect the relevant Home Assistant Core source for the registered schema.
- Say when a route/schema is source-derived instead of documented.

## CLI Patterns

Keep secrets in environment variables and avoid printing them.

HTTP:

```bash
curl -sS \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  "https://<host>/<verified_api_path>"
```

Specific entity state:

```bash
curl -sS \
  -H "Authorization: Bearer $HA_TOKEN" \
  "https://<host>/api/states/<entity_id>"
```

WebSocket:

```bash
uv run --with websockets --no-project python - <<'PY'
import asyncio, json, os
import websockets

async def main():
    async with websockets.connect("wss://<host>/api/websocket") as ws:
        await ws.recv()
        await ws.send(json.dumps({"type": "auth", "access_token": os.environ["HA_TOKEN"]}))
        await ws.recv()
        await ws.send(json.dumps({"id": 1, "type": "<verified_command_type>"}))
        print(await ws.recv())

asyncio.run(main())
PY
```

## Guardrails

- Redact `HA_TOKEN`, long-lived access tokens, refresh tokens, and auth payloads containing secrets.
- Ask before changing device state unless the user explicitly requested the action.
- Confirm target entity/device IDs and expected effect for mutations.
- Report transport status separately from Home Assistant API result status.
- Keep answers practical: command, auth pattern, verified route/schema source, and error interpretation.
