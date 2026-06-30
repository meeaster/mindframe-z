## Context

`mfz thread` ingests sessions through `DockerAgentRunner.run` (`src/thread/runner.ts`), the single chokepoint through which every `docker run --rm -i` dispatch flows. Usage (cost, input/output/cache tokens) is parsed from each dispatch's JSONL result stream and written to a portable `runs.json` ledger plus machine-local `status.json` traces by `src/thread/observability.ts`. That ledger is the source of truth and is git-pushed with the thread.

What is missing is a live, visual view of a run. DataDog's lapdog (dd-apm-test-agent) renders tool calls, lifecycle, permissions, and cost in a local dashboard. The design was previously grilled to convergence (see `docs/handoff-lapdog-threads-observability.md`); the one feasibility unknown — how to inject cost so the dashboard renders it — was resolved by a validated spike (`sandbox/lapdog-spike-NOTES.md`). The wire contracts on both the lapdog side (`/claude/hooks`, `/v0.4/traces`, `/info`) and the OpenCode plugin side have since been verified directly against the reference repos at `/home/mark/references/dd-apm-test-agent` and `/home/mark/references/opencode`.

Constraints: honour repo principles (YAGNI/KISS/DRY, one clear implementation, no parallel old/new paths); never change `runs.json` semantics or `observability.ts`; the overlay must be optional and fail-open so ingest is identical whether or not lapdog runs.

## Goals / Non-Goals

**Goals:**
- A local lapdog dashboard view of thread runs, controlled by an explicit `mfz thread observe up/down/status` toggle.
- Harness-symmetric event capture (Claude + OpenCode) into lapdog's `/claude/hooks` flat schema.
- Cost/token metrics rendered in the dashboard, reusing the usage already parsed for `runs.json`.
- Fail-open: a missing/unreachable lapdog never alters or blocks a dispatch.
- All instrumentation decided in one place — the dispatch chokepoint.

**Non-Goals:**
- Replacing or changing `runs.json` / `observability.ts` (source of truth, untouched).
- The BUN model-path proxy (parked; would put lapdog in the inference path).
- Forwarding to the hosted `lapdog.datadoghq.com` backend or any `DD_API_KEY` flow.
- An upstream `/opencode/hooks` API or LLMObs-native OpenCode spans (deferred; the masquerade is reversible into these later).
- A persisted "enabled" flag or a mute-while-running state (YAGNI until wanted).

## Decisions

### 1. Reachability is the enabled state (no persisted flag)
`mfz thread observe up/down/status` own a lapdog container named `lapdog` and a user-defined `mfz-net` network. The running container *is* the enabled state; every dispatch probes `GET /info` and instruments only when reachable. **Why over a config flag:** eliminates flag/state drift — there is exactly one source of truth (the container), and the probe already needs to run for fail-open. Alternative (persisted `observe.enabled`) rejected: two states that can disagree.

### 2. Single probe-and-instrument site at `DockerAgentRunner.run`
The `GET /info` probe and all conditional flags (`--network mfz-net`, `-e LAPDOG_URL=http://lapdog:8126`) are injected at the one chokepoint, before `this.image` in the docker arg array. **Why:** every dispatch (discover, gather, synth, digest) flows through here; per-command instrumentation would duplicate the branch and violate DRY. Two vantage points to the same lapdog: the dispatch container uses Docker DNS `http://lapdog:8126`; the host `mfz` node process uses the published `http://localhost:8126`.

### 3. Two URLs, one container, published ports
lapdog runs `--lapdog-mode --web-ui-port=8080`, publishing `-p 8126:8126 -p 8080:8080`, with a volume for snapshots. Containers on `mfz-net` reach it by name; the host reaches it on localhost; the browser opens `localhost:8080` (WSL2 localhost-forwards). **Why a container, not the host:** the host's only dependency stays Docker; mirrors the existing `ensureThreadToolsImage` idempotency pattern (`src/thread/build.ts`) for image presence and a `broker.ts`-style retry loop for liveness.

### 4. Events via baked `/claude/hooks`, with a templated URL
For Claude, generate `~/.claude/settings.json` (where Claude Code actually reads hooks — standalone `~/.claude/hooks.json` is ignored, as confirmed by a container test) by `src/thread/claude-hooks.ts` from a canonical event list and command template. The settings are materialized to `.generated/thread-tools/claude-settings.json` at image-build time and `COPY`ed into `Dockerfile.tools` **offline** (no `claude plugin install` at dispatch time). The upstream curl target is hardcoded to `http://localhost:8126`; since the container reaches lapdog at `http://lapdog:8126`, the baked variant uses `${LAPDOG_URL}/claude/hooks` — the hook command runs in a shell, so it expands from the injected env var. The `--max-time 2 + || true` is preserved verbatim; **that is the fail-open guarantee** for events. Events registered: PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, SessionStart, SessionEnd, Notification, PreCompact, PermissionRequest, SubagentStart, SubagentStop.

### 5. OpenCode plugin masquerades as `/claude/hooks`
Bundle a plugin to `.opencode/plugin/` (auto-discovered) in the tools image that reads `LAPDOG_URL` from `process.env`, and POSTs OpenCode's typed hooks to `${LAPDOG_URL}/claude/hooks` after a near-1:1 field rename. **Why masquerade, not a native OpenCode API:** OpenCode's typed hooks expose the same primitives, so it is a field-rename + event-name map; dispatches land in the claude-hooks pipeline (source reads "claude"; model field still shows the opencode model). Reversible into an upstream `/opencode/hooks` later. Mapping corrected against the reference:
- PreToolUse/PostToolUse/PostToolUseFailure ← `tool.execute.before`/`after` (`{tool, sessionID, callID, args}` → `{output, metadata, error}`), 1:1.
- UserPromptSubmit ← `chat.message` user parts.
- Assistant text + lifecycle (SessionStart/Stop/SessionEnd) ← the `event` bus (`session.created`/`session.deleted`/`session.idle`/`session.compacted`/`session.status`/`session.updated`), **not** `chat.message` (whose `message` is the user message).
- PermissionRequest ← `permission.ask` `{status}`.
- `session_id` ← `event.properties.sessionID` (falling back to `event.properties.info.id` for SDK variants where `session.created`/`session.deleted` only carry `info`), carried on every hook/event. The SDK Event union is a discriminated union, but the plugin SDK does not re-export the type — the plugin reads with a narrow guard.

### 6. Cost via msgpack `/v0.4/traces`, supplied verbatim
Hooks carry no cost; lapdog's pricing computation only runs on the parked proxy path. The validated path is a separate `POST /v0.4/traces` (msgpack) carrying an `_llmobs` envelope inside `meta_struct` as msgpack bytes; lapdog passes `meta_struct._llmobs.metrics` through verbatim into the synthesized LLMObs span. The host `mfz` process emits this after each dispatch using a typed `TokenBreakdown` it already parsed. **Token-split correctness:** the parser preserves `nonCachedInput`, `cacheReadInput`, and `cacheWriteInput` separately — not the collapsed `input_tokens` that `runs.json` stores. Cost fields are integer nanodollars: `estimated_total_cost`, `estimated_input_cost`, `estimated_output_cost`. The cost-span emit is wrapped in a single try/catch so a throw from msgpack encode or fetch can never reject the dispatch.

### 7. Add `@msgpack/msgpack` (decided)
The repo has no msgpack library and no `python3` shell-out precedent. **Decision: add `@msgpack/msgpack`** rather than shelling to `python3 -c`. **Why:** stays in-idiom (native fetch + a TS dep), avoids introducing a Python runtime dependency and a new subprocess pattern, and keeps the cost-span emit a few lines of typed code. Pin an exact version older than 7 days per repo policy.

## Risks / Trade-offs

- **Baked hooks.json URL drift** (upstream changes its curl shape) → we own a small baked variant; pin to the referenced upstream and re-verify on bump. The `|| true` means even a malformed target degrades to no-op, not a failed dispatch.
- **OpenCode masquerade mislabels source as "claude"** → accepted caveat (documented); reversible into a real `/opencode/hooks` if labeling/schema-pinning bites.
- **Cost-span schema is lapdog-internal** (`meta_struct._llmobs`) and could shift → isolate encoding in one builder; it is purely additive, so a drift drops the cost span without affecting `runs.json` or events.
- **Probe latency on every dispatch** → `GET /info` with a short timeout; on connect-refused, classify and skip instantly (mirror `broker.ts` `isUnreachableError`). Never blocks the dispatch.
- **`mfz-net` / container left dangling** after a crash → `observe status` reports liveness from `GET /info`; `observe down` is idempotent (`docker rm -f` + network rm tolerate absence).

## Migration Plan

Additive only; no data migration. Rollout order mirrors the handoff build order:
1. Add `@msgpack/msgpack`; implement the cost-span builder + emit behind the reachability probe.
2. `observe up/down/status` + `mfz-net` + lapdog container (idempotent, mirroring `ensureThreadToolsImage`).
3. Bake `hooks.json` (templated `${LAPDOG_URL}`) into `Dockerfile.tools`.
4. OpenCode translation plugin baked into the tools image.
5. Probe + instrument at `DockerAgentRunner.run`.

Rollback: `mfz thread observe down` removes the container and network; with nothing reachable, every dispatch runs clean — the feature is fully inert when off.

## Open Questions

- Exact lapdog image reference/tag to pull (or whether to build from the dd-apm-test-agent reference) for `observe up` — to pin during implementation.
- Snapshot/volume directory location under `~/.mindframe-z` for lapdog persistence (default `snapshots/`/`volumes/` per upstream) — choose a path consistent with existing machine-local layout.
