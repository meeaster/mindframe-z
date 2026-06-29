## Why

The `mfz thread` ingest pipeline records cost and per-dispatch usage to a portable `runs.json` ledger, but offers no live, visual way to watch tool calls, lifecycle, permissions, and cost across a run. DataDog's lapdog (dd-apm-test-agent) provides exactly that dashboard locally, and the cost-injection feasibility unknown is now resolved (validated msgpack `/v0.4/traces` path). This adds that view as an **optional, fail-open** overlay without touching the ledger that is the source of truth.

## What Changes

- Add `mfz thread observe up` / `down` / `status` to own the lifecycle of a local lapdog container and a user-defined `mfz-net` Docker network. The running container *is* the enabled state — there is no separate persisted flag.
- Make every dispatch in `DockerAgentRunner.run` opportunistically probe lapdog (`GET /info`); when reachable, instrument the run (join `mfz-net`, inject `LAPDOG_URL`, route baked event hooks, emit a cost span); when unreachable, run clean. The dispatch proceeds either way. This logic lives at the single dispatch chokepoint, not per-command.
- Capture events via the `/claude/hooks` flat schema for both harnesses: bake lapdog's `hooks.json` into `Dockerfile.tools` (curl target templated to `${LAPDOG_URL}`), and bundle an OpenCode plugin that translates OpenCode's typed hooks into the same flat schema.
- Emit cost as a separate msgpack `_llmobs` span to lapdog's `/v0.4/traces`, reusing the usage already parsed for `runs.json` (read from the raw result event so cache/non-cache token splits are preserved).
- Add a msgpack encoding dependency (`@msgpack/msgpack`) for the cost-span payload.
- **Non-goal / explicitly unchanged:** `src/thread/observability.ts` and `runs.json` semantics. The BUN model-path proxy remains parked.

## Capabilities

### New Capabilities
- `thread-observe-lifecycle`: the `mfz thread observe up/down/status` operator surface, the lapdog container and `mfz-net` network it owns, the `GET /info` liveness model, and the reachability-as-truth (no persisted enabled flag) philosophy.
- `thread-observe-capture`: the opportunistic probe-and-instrument at the `DockerAgentRunner.run` chokepoint, the two harness-symmetric event channels into `/claude/hooks` (Claude baked `hooks.json`; OpenCode translation plugin), and the msgpack cost-span emit to `/v0.4/traces`. All fail-open and additive to `runs.json`.

### Modified Capabilities
<!-- None. `thread-observability` (the runs.json/status.json ledger) is owned by the active mfz-thread change and is intentionally left unchanged; this change is purely additive and never sits in the model path. -->

## Impact

- **Code:** `src/thread/runner.ts` (probe + instrument at the chokepoint; cost-span emit), `src/thread/cli.ts` + `src/cli/mfz.ts` (new `observe` subcommands), new container/network lifecycle module mirroring `src/thread/build.ts`'s `ensureThreadToolsImage` idempotency pattern, new OpenCode translation plugin baked into the tools image, `Dockerfile.tools` (bake `hooks.json` + plugin offline).
- **Dependencies:** add `@msgpack/msgpack`; runtime dependency on Docker (already required) and a pullable lapdog image. No new host process dependencies.
- **Unchanged:** `src/thread/observability.ts`, `runs.json` schema/semantics, the existing `mfz-thread` dispatch behavior when lapdog is not running.
- **External contract:** pins to lapdog's stable `/claude/hooks` flat fields, `/v0.4/traces` `meta_struct._llmobs` envelope, and `/info` liveness endpoint (all source-verified against the dd-apm-test-agent reference).
