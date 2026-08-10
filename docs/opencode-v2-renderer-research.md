# OpenCode V2 Renderer Research

Date: 2026-08-08

Status: research handoff; no implementation decisions have been approved beyond keeping V1 working and deferring plugin ports.

## Purpose

Provide enough context for a new agent to safely add side-by-side OpenCode V2 support and native V2 configuration rendering without relying on the originating conversation.

## Transfer Contract

- Primary consumer: an implementation agent working in this `mindframe-z` repository.
- Intended use: continue investigation, make a bounded design, implement, and verify.
- Guaranteed local references: this repository and the read-only OpenCode clone at `references/opencode` in the shared workspace.
- Machine-local observations below describe the current environment and must not be treated as portable product behavior.
- No credentials, tokens, auth files, or rendered secret-bearing configuration belong in this artifact.
- OpenCode V2 is a moving beta branch; re-check current source before implementing version-sensitive behavior.

## Branch Comparison

The comparison used the local read-only OpenCode reference clone:

- V1 line: `origin/dev` at `fe82a1b6ca` (`2026-08-08`)
- V2 line: `origin/v2` at `7afe537c69` (`2026-08-07`)
- Merge base: `0e2dd4ad15`
- V1-only commits after the fork: 860
- V2-only commits after the fork: 1,253
- Symmetric diff: about 3,854 files, with large generated and refactoring churn

`origin/2.0` and `origin/opencode-2-0` are older exploratory branches. Use `origin/v2` for current investigation.

V2 is an architectural rewrite rather than a cosmetic release:

- The old monolithic `packages/opencode` package was removed.
- Runtime responsibilities are split across `packages/core`, `packages/server`, `packages/cli`, `packages/tui`, `packages/plugin`, `packages/ai`, and `packages/util`.
- The TUI is a client of a background server that owns sessions, plugins, permissions, and application state.
- Sessions use durable pending input, projected history, session-scoped durable events, and a process-local execution coordinator.
- V2 has a V1 data importer, but beta data and contracts are not stable.

Primary OpenCode references:

- `references/opencode/packages/www/content/docs/migrate-v1.mdx`
- `references/opencode/specs/v2/README.md`
- `references/opencode/specs/v2/session.md`
- `references/opencode/specs/v2/tools.md`
- `references/opencode/packages/core/src/config/normalize.ts`
- `references/opencode/packages/core/src/database/v1-migration.ts`

## Current Machine Findings

These findings were observed on the current machine and are relevant to a safe trial:

- The installed V1 binary reports `1.18.15`.
- The running V1 server is a plain `opencode serve` process on `127.0.0.1:40963`.
- `opencode db path` resolves the V1 database to `~/.local/share/opencode/opencode.db`.
- The V1 database is large and live. Never let an experimental V2 process open it by default.
- No `opencode2` binary was present on `PATH` at research time.

The V2 branch documents side-by-side installation as `opencode` for V1 and `opencode2` for V2, installed from `@opencode-ai/cli@next`.

The V2 source has these relevant behaviors:

- `packages/cli/src/services/service-config.ts` uses a managed `service.json` registration file and defaults the `next` channel to port `0xc0de` (49374).
- `packages/cli/src/server-process.ts` reads `OPENCODE_DB`, `OPENCODE_CONFIG_DIR`, and XDG-derived paths.
- `packages/util/src/global.ts` derives data, config, state, cache, and log roots from the normal OpenCode XDG application paths.
- The current source resolves a relative V2 database name as `opencode.db` under the OpenCode data root for the `next` channel. The V2 troubleshooting docs refer to `opencode-next.db`; treat this source/docs mismatch as something to verify against the installed build.

Safe side-by-side operation therefore requires all of the following, not just a second binary:

- A distinct port, such as `40964`.
- Distinct `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` values, or an equivalent isolated service environment.
- An explicit `OPENCODE_DB` path under the V2 data root.
- A wrapper or persistent service environment so automatically spawned V2 server processes inherit the isolation variables.
- A separate V2 authentication setup unless credential sharing is deliberately designed and tested.

An initial local trial should use V2 standalone or a managed V2 service with the isolated environment. Do not start V2 with default paths while V1 is using the live database.

## Existing `mindframe-z` Design

The current renderer is V1-specific:

- `src/renderers/opencode.ts:178-372` builds `opencode.jsonc`, optional `package.json`, and `tui.json`.
- It emits V1 `permission` maps, direct `mcp` entries with `enabled`, V1 plugin entries, and V1 TUI plugin configuration.
- `src/core/manifests.ts:491-500` stores OpenCode config as an untyped record, plus separate plugin, TUI plugin, command, agent, dependency, and delegate-general fields.
- `src/core/render.ts:72-105` has one `opencode` render target.
- `src/core/paths.ts:12-15` models `opencode` as one logical agent and `src/core/paths.ts:198-210` hardcodes the V1 data/database convention.
- `src/core/override-store.ts:147-211` emits V1 project overrides such as `mcp.<name>.enabled` and `permission.skill`.
- `src/sync/index.ts:235-255` and `src/sync/opencode.ts` only know the V1 `opencode.jsonc` snapshot.
- `src/renderers/dotfiles.ts:29-41` wraps the V1 `opencode` command and injects V1-shaped `OPENCODE_CONFIG_CONTENT`.
- `src/sessions/opencode-source.ts` enumerates V1 `session` rows and shells out to `opencode export`.
- `src/thread/runner.ts` launches only the V1 `opencode run` command and assumes one OpenCode data store.
- `tests/integration/apply.test.ts` and related integration tests assert V1 paths and output shapes.

The current profile source also enables custom V1 plugins and TUI plugins. The repository's OpenCode assets use the V1 `@opencode-ai/plugin` API. V2 plugin configuration translation will not make those implementations work.

## V2 Configuration Differences

The V2 migration guide says supported V1 configuration is normalized in memory, so native conversion is not required merely to try V2. The intentional user-facing breaks are plugins, server API/clients, and TUI configuration.

Representative native V2 mappings:

- `permission` plus `tools` becomes an ordered `permissions` array.
- `bash` becomes `shell`; `task` becomes `subagent`; `write` and `patch` become `edit`.
- `agent` and `mode` become `agents`; agent `prompt` becomes `system`; `disable` becomes `disabled`.
- A separate model variant joins the model reference as `provider/model#variant`.
- `command` becomes `commands`; `reference` becomes `references`; `provider` becomes `providers`.
- `snapshot` becomes `snapshots`; `attachment` becomes `media`.
- Direct V1 MCP entries move under `mcp.servers`; `enabled` becomes `disabled`; timeout fields are separated.
- `skills.paths` and `skills.urls` become one ordered `skills` array.
- V1 `tui.json(c)` becomes global `cli.json`; project-local V1 TUI config is not migrated.
- V1 plugin entries can be translated syntactically, but V1 plugin implementations must be ported to the V2 API.

The V2 migration guide is the best user-facing source. Earlier documents such as `specs/v2/config.md` contain historical/proposed names that do not always match current code. Prefer current package code and `packages/www/content/docs/migrate-v1.mdx` when they disagree.

## Recommended Shape

Treat V2 as an OpenCode deployment channel or renderer variant, not as a second logical agent throughout the engine. A second top-level agent name would ripple through MCP routing, skills, context reporting, project overrides, thread storage, and session archiving.

Suggested direction:

- Keep the existing V1 `opencode` target unchanged.
- Add an explicit V2 channel/variant with its own binary, config directory, data directory, state directory, cache directory, database path, and port.
- Render V2 output under a separate snapshot directory, for example `configs/<profile>/opencode-v2/`.
- Preserve existing profile source fields initially and add a one-way native V1-to-V2 adapter at the renderer boundary.
- Add V2-only source overrides only where the adapter cannot preserve behavior safely.
- Do not silently render V1 plugins into V2. Initially either omit them with a clear diagnostic or fail the V2 render with an actionable message.
- Defer V2 session backup, thread dispatch, and project override support until the V2 runtime has been exercised; these are separate compatibility surfaces.
- Keep `mfz sync` V1-only initially if a safe reverse mapping is not available. Native V2 sync should be designed explicitly rather than accidentally writing V2 keys into the V1 profile model.

## Effort Estimate

| Scope | Rough effort | Result |
| --- | --- | --- |
| Isolated V2 installation and health check | 0.5-1 day | `opencode2` beside V1 with separate port, XDG roots, database, and auth |
| V2-compatible config snapshot | 1-2 days | Reuse existing source config, render a separate snapshot, exclude or diagnose V1 plugins, add smoke coverage |
| Native V2 renderer and TUI config | 3-5 additional days | Native permissions, MCP, agents, commands, providers, `cli.json`, paths, and focused tests |
| Sync, project overrides, backup, and thread support | 1-3 additional days | Channel-aware runtime integrations and migration-safe behavior |
| Current custom plugin parity | 4-10 additional days | Port and verify advisor, delegation, session, work-context, and TUI plugin behavior; likely more if V2 changes during implementation |

The smallest useful experiment is roughly one day. Native configuration rendering without plugin parity is roughly 4-6 engineering days including isolation. Full dual-track support for the current setup is roughly 1-2 weeks and should be treated as beta integration work.

## Initial Acceptance Criteria

The first implementation should satisfy these constraints:

- Starting V2 never opens, migrates, locks, or writes the V1 database.
- V1 behavior, paths, renderer output, and existing tests remain unchanged.
- V2 has an explicit port and independently discoverable service registration.
- A V2 render can be inspected without linking over the live V1 config.
- V1 plugins are not falsely reported as supported by V2.
- A dry-run or smoke test proves the generated V2 config parses and the V2 server reaches health readiness.
- No credentials or live auth state are copied into the repository or rendered snapshots.
- V2-specific assumptions are covered by focused tests and referenced to the current OpenCode branch.

## Verification Guidance

For `mindframe-z`, follow the repository instructions:

```bash
pnpm build
pnpm test:apply
pnpm test:integration
pnpm test:plugins
```

Use temporary homes and isolated XDG paths in tests. Existing test guidance is in `AGENTS.md`, especially the integration isolation rules and the `smoke-opencode` implementation in `src/cli/mfz.ts:321-353`. That smoke path currently invokes the literal `opencode` binary and will need parameterization for a V2 channel.

## Open Questions For The Implementing Agent

- Should V2 be selected through a new `opencode` channel field, a dedicated apply option, or a separate renderer target while remaining one logical harness?
- Is native V2 output required immediately, or is V1-shaped config accepted by V2 sufficient for the first trial?
- Should V2 rendering omit all plugins initially, or should it permit an explicit allowlist of already-ported V2 plugins?
- Should V2 session backup/thread features be included in the first change, or explicitly remain V1-only?
- Which V2 config fields should be canonical in profile source, and which should remain derived compatibility output?
