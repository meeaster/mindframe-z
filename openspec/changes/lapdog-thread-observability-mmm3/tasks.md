## 1. Dependency & cost-span builder

- [x] 1.1 Add `@msgpack/msgpack@3.1.2` (May 2025, >7 days old) to `package.json` and install
- [x] 1.2 Add a cost-span builder module that takes parsed dispatch usage + model/session ids and produces the `_llmobs` envelope, reading raw result usage so `non_cached_input_tokens`, `cache_read_input_tokens`, `cache_write_input_tokens` stay separate and cost fields are integer nanodollars
- [x] 1.3 Encode the envelope as a `/v0.4/traces` msgpack payload (`meta_struct._llmobs` as msgpack bytes) with correct headers (`Content-Type: application/msgpack`, `X-Datadog-Trace-Count: 1`)
- [x] 1.4 Unit-test the builder/encoder against the field shapes in `sandbox/lapdog-spike-NOTES.md` (token splits preserved, cost verbatim, span ids unique, zero-duration clamp)

## 2. Lapdog container & network lifecycle

- [x] 2.1 Add a lifecycle module mirroring `ensureThreadToolsImage` idempotency: ensure `mfz-net` network and a `lapdog` container (`--lapdog-mode --disable-llmobs-data-forwarding --web-ui-port=8080`, publish `8126`+`8080`, snapshots volume mounted at `/snapshots`)
- [x] 2.2 Implement a `GET /info` liveness probe with a short timeout and connect-refused classification (swallow as unreachable; no broker-style retry)
- [x] 2.3 Implement idempotent teardown (`docker rm -f` + network removal tolerating absence via `reject: false`)
- [x] 2.4 Image pinned to `ghcr.io/datadog/dd-apm-test-agent/ddapm-test-agent:latest`; snapshots persisted under `~/.mindframe-z/lapdog/snapshots`

## 3. Observe CLI surface

- [x] 3.1 Add `runThreadObserveUp/Down/Status` exports in `src/thread/cli.ts`
- [x] 3.2 Register `thread observe up/down/status` subcommands in `src/cli/mfz.ts` following the existing Commander pattern (`--json` on status)
- [x] 3.3 `observe up` reports the `http://localhost:8080` dashboard URL; `status` reports reachability from the `/info` probe with no persisted flag
- [x] 3.4 Test the CLI handlers with a fake docker-on-PATH pattern in `cli.test.ts` and `lapdog.test.ts`

## 4. Baked event hooks (Claude)

- [x] 4.1 Add a baked `hooks.json` variant with the curl target templated to `${LAPDOG_URL}/claude/hooks`, preserving `--max-time 2 ... || true`, registering the full event set (PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, SessionStart, SessionEnd, Notification, PreCompact, PermissionRequest, SubagentStart, SubagentStop)
- [x] 4.2 COPY `hooks.json` into `Dockerfile.tools` offline at the Claude config path; `threadToolsImageBuildPlan` includes the file in the build hash
- [ ] 4.3 Verify against a running `observe up` lapdog that an instrumented Claude dispatch's events render in the dashboard

## 5. OpenCode translation plugin

- [x] 5.1 Write an OpenCode plugin (`opencode/plugins/lapdog.ts`, baked to `/home/sandbox/.opencode/plugin/lapdog.ts`) that reads `LAPDOG_URL` from `process.env` and POSTs to `${LAPDOG_URL}/claude/hooks`. Mappings: `tool.execute.before` → PreToolUse; `tool.execute.after` → PostToolUse/PostToolUseFailure (when `metadata.error` is set); `chat.message` (user) → UserPromptSubmit; `permission.ask` → PermissionRequest; `experimental.session.compacting` → PreCompact; `event` bus → `session.created` → SessionStart, `session.deleted` → SessionEnd, `session.idle`/`session.next.text.ended` → Stop, `session.next.compaction.started`/`session.compacted` → PreCompact, `session.status` → Notification
- [x] 5.2 Make every POST fail-open (`AbortSignal.timeout(2000)`, swallow errors) so translation never affects the dispatch
- [x] 5.3 COPY the plugin into `Dockerfile.tools`; `threadToolsImageBuildPlan` includes the file in the build hash
- [x] 5.4 OpenCode has no dedicated `SubagentStart`/`SubagentStop` event type; any `subagent.*` event is forwarded best-effort as a `Notification` so the lapdog dashboard still sees subagent traffic
- [ ] 5.5 Verify against `observe up` lapdog that an instrumented OpenCode dispatch's events render in the dashboard

## 6. Probe & instrument at the dispatch chokepoint

- [x] 6.1 In `DockerAgentRunner.run`, probe lapdog once per dispatch and, when reachable, inject `--network mfz-net` and `-e LAPDOG_URL=http://lapdog:8126` before `this.image`; when unreachable, run clean
- [x] 6.2 After each dispatch, emit the cost span from the host process to `http://localhost:8126/v0.4/traces`, fail-open
- [x] 6.3 Confirm `src/thread/observability.ts` and `runs.json` are untouched and that ingest output is identical with lapdog down
- [x] 6.4 Runner test asserts clean (uninstrumented) docker args when the probe fails and instrumented args when it succeeds. Extracted to `lapdogDockerArgs(reachable)` and `emitLapdogCostSpan(reachable, request, result, startedMs)` so the chokepoint stays linear

## 7. Verification & docs

- [x] 7.1 `pnpm test:thread` and `pnpm check` (lint, fmt, build, test) green
- [ ] 7.2 End-to-end: `observe up`, run a real ingest, confirm events + cost render at `localhost:8080`, then `observe down` and confirm a clean ingest
- [x] 7.3 The spike code in `sandbox/lapdog-spike.ts` lags the validated NOTES; the NOTES remain the source of truth and the spike is preserved for reproducibility

## 8. -mmm3 refinements (delta over the dsv4pro attempt)

- [x] 8.1 Use the harness-reported `total_cost_usd` for the `_llmobs` cost metrics (convert USD → integer nanodollars) instead of hardcoding 0
- [x] 8.2 Place the OpenCode translation plugin at `opencode/plugins/lapdog.ts` (matches the existing `opencode/plugins/agent-task/` and `mindframe-z-example.ts` convention) rather than at `src/thread/opencode-lapdog-plugin.ts`
- [x] 8.3 Cover all 12 lapdog event types in the OpenCode plugin — the dsv4pro only covered 5
- [x] 8.4 Extract `lapdogDockerArgs` and `emitLapdogCostSpan` from `DockerAgentRunner.run` so the chokepoint stays linear and the two conditionals are pure helpers testable in isolation
- [x] 8.5 Add `src/thread/lapdog.test.ts` for the lifecycle + probe (the dsv4pro had no tests for `lapdog.ts`)
- [x] 8.6 Add `src/thread/cost-span.test.ts` covering builder field shapes, nanodollar conversion, payload encoding, span-id uniqueness, and the `/v0.4/traces` POST headers
- [x] 8.7 Hash `src/thread/hooks.json` and `opencode/plugins/lapdog.ts` into the `threadToolsImageBuildPlan` so the tools image rebuilds when either changes
- [x] 8.8 Update `build.test.ts` fixture to include the new files
