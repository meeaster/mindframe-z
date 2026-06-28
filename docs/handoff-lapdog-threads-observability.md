# Handoff: lapdog (dd-apm-test-agent) observability for `mfz thread`

**Goal of next session:** implement the design below — wire DataDog's lapdog / dd-apm-test-agent
in as an optional, fail-open observability view of the `mfz thread` ingest pipeline.

**Status:** design fully grilled and converged (every fork resolved). No code written yet.
One genuine feasibility unknown remains (the "cost-span spike", below) — resolve it first.

---

## Repos & key files

**This repo:** `/home/mark/code/mindframe-z` (branch `master`).
- Thread module: `src/thread/` — read these first:
  - `src/thread/runner.ts` — `DockerAgentRunner.run` is the **single dispatch chokepoint**
    (all `docker run --rm -i` go through here). This is where probe-and-instrument logic lands.
  - `src/thread/ingest.ts` — pipeline orchestration (gather → synth → digest).
  - `src/thread/cli.ts` — CLI command surface (add `observe up/down/status` here).
  - `src/thread/observability.ts` — existing homegrown telemetry (`runs.json`, jsonl traces,
    `status.json`). **Stays untouched / source of truth.**
  - `src/thread/build.ts` — `ensureThreadToolsImage` pattern to mirror for the lapdog container
    and for baking hooks/plugin into the tools image.
  - `Dockerfile.tools` — the dispatch image; bake `hooks.json` + the opencode plugin here.
- Design context (do NOT duplicate; read): `openspec/changes/mfz-thread/design.md`,
  `openspec/changes/mfz-thread/proposal.md`, and `specs/thread-observability/spec.md`.

**lapdog upstream:** https://github.com/DataDog/dd-apm-test-agent
(was cloned to a session-scratchpad during design; **re-clone fresh** — that path is gone.)
Key files to read in it:
- `plugins/lapdog/hooks/hooks.json` — the Claude Code hook plugin: every event fires
  `curl -s --max-time 2 -X POST -d @- http://localhost:8126/claude/hooks ... || true`.
  The `--max-time 2 + || true` **is** the fail-open guarantee. URL is hardcoded — we override it.
- `ddapm_test_agent/claude_hooks.py` — the `/claude/hooks` handler. Reads a **flat field bag**
  off the POST body, dispatches on `hook_event_name`. Field map we reverse-engineered is below.
  Cost/tokens are summed from **LLM spans** (`_compute_token_usage`, ~line 1155), which only the
  BUN proxy produces — hooks alone carry NO cost.
- `ddapm_test_agent/agent.py` — `--web-ui-port` flag (~line 2528, e.g. `--web-ui-port=8080`),
  `--lapdog-mode`, per-source hook APIs wired in (`ClaudeHooksAPI`/`PiHooksAPI`/`CodexHooksAPI`),
  LLMObs intake at `/evp_proxy/v4/api/v2/llmobs`.
- `lapdog/pi_lapdog_extension.ts` (~line 19) — precedent for `LAPDOG_URL` env override:
  `process.env.LAPDOG_URL || "http://localhost:8126"`.
- `lapdog/cli.py` — `_ensure_lapdog_running` / liveness probe (`GET /info`) patterns.

**opencode reference (read-only):** `/home/mark/references/opencode`
- `packages/plugin/src/index.ts`, `interface Hooks` (~line 222) — the typed plugin API we map FROM:
  `tool.execute.before`/`.after` `{tool, args, callID}`→`{output, metadata}`, `chat.message`
  `{message, parts}`, `chat.params` `{model,…}`, `permission.ask`→`{status}`, `event` (lifecycle bus).

---

## Converged design (all decisions locked)

1. **Direction:** observe the thread pipeline with lapdog. **Purely additive, optional, fail-open.**
   `runs.json` stays the portable git-pushed ledger; lapdog never replaces it, never sits in the
   model path, ingest works unchanged whether or not lapdog runs.

2. **No proxy.** The BUN intercept (Claude/Bun-only, in the model path) is **parked** (Phase 3,
   maybe never). Dropping it made the whole design symmetric + fail-open for free.

3. **Two capture channels, both harness-symmetric:**
   - **Events → rich view.** Claude: bake lapdog's `hooks.json` into the tools image. OpenCode:
     bundle a plugin that translates its typed hooks into Claude's flat schema and POSTs to the
     same `/claude/hooks`. Scope = **full-ish**: tool calls, lifecycle, permissions, AND user+
     assistant text folded in from `chat.message` (lapdog's `transcript_path` enrichment doesn't
     port but degrades gracefully to empty).
   - **Cost → numbers.** TS posts the usage it **already parses for `runs.json`** as a span to
     lapdog. Identical for both harnesses (no proxy needed).

4. **OpenCode adapter = masquerade as `/claude/hooks`** (not LLMObs spans, not an upstream
   `/opencode/hooks` — both deferred). It's a near-1:1 field-rename + event-name map (table below)
   because OpenCode's typed hooks expose the same primitives. Reversible: lift the same mapping
   into an upstream `/opencode/hooks` later if labeling/schema-pinning bites.
   - Caveats accepted: opencode dispatches land in the claude-hooks pipeline (source reads as
     "claude"; model field still shows the opencode model); pinned to Claude's stable hook fields.

5. **Topology = lapdog in its own container** (container-native; the host's only dep is Docker):
   - User-defined network `mfz-net`. lapdog container named `lapdog`,
     `--lapdog-mode --web-ui-port=8080`, publish `-p 8126:8126 -p 8080:8080`, volume → `/snapshots`.
   - **Two vantage points, two URLs to the same lapdog:**
     - dispatch container (on `mfz-net`) → `http://lapdog:8126` (Docker DNS). This is the
       `LAPDOG_URL` injected into the container.
     - `mfz` host node process (posts cost span) → `http://localhost:8126` (published port).
   - Windows browser → `localhost:8080` (WSL2 localhost-forwards). No dependency on the hosted
     `lapdog.datadoghq.com` page.

6. **Lifecycle = explicit toggle + universal opportunistic probe:**
   - `mfz thread observe up` / `down` (+ `status`) own the lapdog container and `mfz-net`.
     These are the ONLY things that start/stop lapdog.
   - **Every** dispatch (discover, ingest, anything) probes `GET /info` in `DockerAgentRunner.run`:
     reachable → instrument (`--network mfz-net`, `-e LAPDOG_URL=http://lapdog:8126`, hooks/plugin
     + cost span); unreachable → run clean. Proceeds either way. Logic lives in **one place**.
   - **No separate "enabled" flag** — the running container *is* the enabled state; reachability is
     truth (avoids flag/state drift). Skip a "mute-while-running" state until actually wanted.

---

## OpenCode → Claude-hooks field map (the translation to implement)

| Claude `/claude/hooks` body | OpenCode source | Note |
|---|---|---|
| `hook_event_name` | which handler fired | constant: `PreToolUse`/`PostToolUse`/`PostToolUseFailure`/`UserPromptSubmit`/`Stop`/`SessionStart`/`SessionEnd`/`PermissionRequest` |
| `session_id` | `sessionID` | rename |
| `tool_name` / `tool_input` / `tool_use_id` | `tool.execute.before` `{tool, args, callID}` | 1:1 |
| `tool_response` (or `tool_output`) | `tool.execute.after` `{output, metadata}` | 1:1 |
| `user_prompt` (or `prompt`) | `chat.message` user parts | extract text |
| assistant text | `chat.message` assistant parts | fold into body (no transcript file) |
| `model` | `chat.message` `model.modelID` | rename |
| permission `status` | `permission.ask` `{status}` | rename |
| `error` / `is_interrupt` | `tool.execute.after` error/metadata | rename |

Lifecycle (`SessionStart`/`Stop`/`SessionEnd`) come from the `event` bus.

---

## Build order

1. **SPIKE FIRST — cost-span envelope.** Against a running `mfz thread observe up` lapdog:
   does a bare injected cost span render in the dashboard, or does lapdog need a minimal
   session/trace **envelope** around it? Check whether to POST to `/v0.4/traces`, OTLP `:4318`,
   or `/evp_proxy/v4/api/v2/llmobs`, and what minimal shape the web UI actually displays. This is
   the one unknown that can nudge the design.
2. `mfz thread observe up/down/status` + `mfz-net` + lapdog container (mirror `ensureThreadToolsImage`).
3. Bake Claude `hooks.json` (curl target `${LAPDOG_URL}/claude/hooks`) into `Dockerfile.tools`
   **offline** — do NOT run `claude plugin install` at dispatch time.
4. OpenCode translation plugin (the map above), bundled into the tools image, reads `LAPDOG_URL`.
5. Probe + instrument in `DockerAgentRunner.run`; cost-span emit in the TS dispatch path
   (reuse the usage already parsed for `runs.json`).

---

## Guardrails for the implementer

- Honour repo principles: YAGNI/KISS/DRY, one clear implementation, no parallel old/new paths.
  The probe/instrument belongs at the single chokepoint, not per-command.
- `src/thread/observability.ts` and `runs.json` semantics are **not** to change.
- Use Context7/DeepWiki for dd-apm-test-agent / opencode specifics rather than guessing schemas.
- Conventional Commits; branch off `master` (don't commit to it directly).
- Verify with the repo's focused test scripts (`package.json`: `test:thread`, etc.).

## Suggested skills

- `openspec-apply-change` / `openspec-propose` — this work already has an openspec change at
  `openspec/changes/mfz-thread/`; fold the lapdog observability in as a change/spec update rather
  than freehand. Check whether to extend `specs/thread-observability/spec.md` or add a new change.
- `threads` — to understand/operate the `mfz thread` CLI you're instrumenting.
- `grilling` — if any sub-decision reopens, re-grill before building.
- `verify` / `run` — to drive the cost-span spike and confirm the dashboard renders.
