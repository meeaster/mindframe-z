## 1. Dependency & cost-span builder

- [ ] 1.1 Add `@msgpack/msgpack` (exact pinned version, >7 days old) to `package.json` and install
- [ ] 1.2 Add a cost-span builder module that takes parsed dispatch usage + model/session ids and produces the `_llmobs` envelope, reading raw result usage so `non_cached_input_tokens`, `cache_read_input_tokens`, `cache_write_input_tokens` stay separate and cost fields are integer nanodollars
- [ ] 1.3 Encode the envelope as a `/v0.4/traces` msgpack payload (`meta_struct._llmobs` as msgpack bytes) with correct headers (`Content-Type: application/msgpack`, `X-Datadog-Trace-Count`)
- [ ] 1.4 Unit-test the builder/encoder against the field shapes in `sandbox/lapdog-spike-NOTES.md` (token splits preserved, cost verbatim)

## 2. Lapdog container & network lifecycle

- [ ] 2.1 Add a lifecycle module mirroring `ensureThreadToolsImage` idempotency: ensure `mfz-net` network and a `lapdog` container (`--lapdog-mode --web-ui-port=8080`, publish `8126`+`8080`, snapshots volume under `~/.mindframe-z`)
- [ ] 2.2 Implement a `GET /info` liveness probe with a short timeout and connect-refused classification (mirror `broker.ts` `isUnreachableError` retry style)
- [ ] 2.3 Implement idempotent teardown (`docker rm -f` + network removal tolerating absence)
- [ ] 2.4 Pin the lapdog image reference/tag to pull (resolve the open question in design.md) and document the snapshots path

## 3. Observe CLI surface

- [ ] 3.1 Add `runThreadObserveUp/Down/Status` exports in `src/thread/cli.ts`
- [ ] 3.2 Register `thread observe up/down/status` subcommands in `src/cli/mfz.ts` following the existing Commander pattern (`--json` on status)
- [ ] 3.3 `observe up` reports the `http://localhost:8080` dashboard URL; `status` reports reachability from the `/info` probe with no persisted flag
- [ ] 3.4 Test the CLI handlers with the docker-stub pattern used in `src/thread/*.test.ts`

## 4. Baked event hooks (Claude)

- [ ] 4.1 Add a baked `hooks.json` variant with the curl target templated to `${LAPDOG_URL}/claude/hooks`, preserving `--max-time 2 ... || true`, registering the full event set (PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, SessionStart, SessionEnd, Notification, PreCompact, PermissionRequest, SubagentStart, SubagentStop)
- [ ] 4.2 COPY `hooks.json` into `Dockerfile.tools` offline at the Claude config path; rebuild the tools image and confirm the build-hash label updates
- [ ] 4.3 Verify against a running `observe up` lapdog that an instrumented Claude dispatch's events render in the dashboard

## 5. OpenCode translation plugin

- [ ] 5.1 Write an OpenCode plugin (`.opencode/plugin/`) that reads `LAPDOG_URL` from `process.env` and POSTs to `${LAPDOG_URL}/claude/hooks`, mapping `tool.execute.before`/`after` → PreToolUse/PostToolUse/PostToolUseFailure, `chat.message` user parts → UserPromptSubmit, `event` bus → assistant text + SessionStart/Stop/SessionEnd, `permission.ask` → PermissionRequest, `sessionID` → `session_id`
- [ ] 5.2 Make every POST fail-open (bounded timeout, swallow errors) so translation never affects the dispatch
- [ ] 5.3 COPY the plugin into `Dockerfile.tools` at the auto-discovered opencode plugin path; rebuild the image
- [ ] 5.4 Verify against `observe up` lapdog that an instrumented OpenCode dispatch's events render in the dashboard

## 6. Probe & instrument at the dispatch chokepoint

- [ ] 6.1 In `DockerAgentRunner.run`, probe lapdog once per dispatch and, when reachable, inject `--network mfz-net` and `-e LAPDOG_URL=http://lapdog:8126` before `this.image`; when unreachable, run clean
- [ ] 6.2 After each dispatch, emit the cost span from the host process to `http://localhost:8126/v0.4/traces`, fail-open
- [ ] 6.3 Confirm `src/thread/observability.ts` and `runs.json` are untouched and that ingest output is identical with lapdog down
- [ ] 6.4 Add a test asserting clean (uninstrumented) docker args when the probe fails and instrumented args when it succeeds

## 7. Verification & docs

- [ ] 7.1 Run `npm run test:thread` and `npm run check` (lint, fmt, build, test) green
- [ ] 7.2 End-to-end: `observe up`, run a real ingest, confirm events + cost render at `localhost:8080`, then `observe down` and confirm a clean ingest
- [ ] 7.3 Flag/update any docs rendered obsolete (the lapdog handoff doc; note the spike code lags the validated NOTES)
