## 1. Profile schema and resolution (mcp-profile-defaults)

- [x] 1.1 Replace `profileMcpConfigSchema` in `src/core/manifests.ts` with the `agents` map (`z.record(agentSchema, z.boolean())`, non-empty) and a refine rejecting `claude-code: false`; drop `enabled`/`targets`
- [x] 1.2 Update `ResolvedMcpServer` and `filterMcpForTarget` in `src/core/profile.ts` to carry per-harness defaults; availability = key present
- [x] 1.3 Migrate all `profiles/*/profile.yml` mcp entries to `agents` maps (preserve current effective states) and regenerate `schemas/profile.schema.json` via `pnpm schemas`
- [x] 1.4 Update opencode/codex renderers to emit per-harness default `enabled`; claude renderer to filter on claude availability (presence-only), preserving `mergeClaudeMcp` semantics
- [x] 1.5 Fix `renderCodexMcp`: `{env:VAR}` header values emit `env_http_headers` (header -> var name); literal values stay `http_headers`
- [x] 1.6 Update unit/integration tests covering schema validation (legacy fields rejected, claude-code false rejected for mcp, inheritance merge) and renderer output per harness
- [x] 1.7 Replace the skill entry schema with `{ agents: Record<harness, boolean>, toggleable?: boolean }` (drop `enabled`/`targets`/`all`/null entries); update `resolveSkillConfig` and `profileDefaults` to read per-harness defaults
- [x] 1.8 Migrate all `profiles/*/profile.yml` skill entries to `agents` maps (flow style, preserve current effective states) and update skill schema/inheritance tests

## 2. Override store (local-override-store)

- [x] 2.1 Create the override-store module: zod schema, validated reads (abort on corrupt, never truncate), atomic writes, keyed by git root
- [x] 2.2 Implement delta semantics against resolved profile defaults (store only drift; prune empty sections) reusing the `writeSkillOverrideDelta` approach
- [x] 2.3 Implement payload rendering per harness: codex `argv` (`-c mcp_servers.*.enabled=...`, full `skills.config` array), opencode `config` JSON, claude `settings` JSON (`skillOverrides`)
- [x] 2.4 Re-render all stored payloads during `mfz apply`
- [x] 2.5 Unit tests: delta add/remove/prune, corrupt-file abort, payload re-render after profile default change

## 3. MCP toggle surface (mcp-local-toggle)

- [x] 3.1 Add `mfz mcp enable|disable <name> [--agent <harness>]` with write-time target expansion and unavailable-harness errors
- [x] 3.2 Add `mfz mcp status` printing merged per-harness state with override markers
- [x] 3.3 Add `mfz mcp tui` sharing the skills TUI interactions, saving deltas to the store
- [x] 3.4 Integration tests: enable/disable inside and outside a repo, status output, no repo files written

## 4. Launchers (harness-launchers)

- [x] 4.1 Verify claude honors `skillOverrides` via `--settings` with a throwaway session; if not, record fallback (keep `.claude/settings.local.json` for claude project skills) in design.md and adjust specs
- [x] 4.2 Render `codex`/`opencode`/`claude` zsh functions into managed zsh config (jq-based payload read, `command` exec, silent degradation when store/jq/entry absent)
- [x] 4.3 Smoke-test each launcher: injection applied inside an overridden project, unmodified exec outside, `--help` passthrough

## 5. Skills migration (skill-local-toggle)

- [x] 5.1 Point repo-scope skill toggle writes at the override store; delete repo-file paths and `ensureActiveGitExcluded`/git-exclude machinery from `src/tui/skill-config-paths.ts` and `skill-toggle-state.ts`
- [x] 5.2 Update read resolution: store project deltas > global config > profile defaults
- [x] 5.3 Update skills TUI/CLI tests to assert store writes and absence of repo file writes
- [x] 5.4 Flag stale repo-local toggle files in `mfz doctor` (stop reading them; suggest cleanup)

## 6. Docs and verification

- [x] 6.1 Update ARCHITECTURE.md and README for the `agents` map, override store, and launchers; check AGENTS.md guidance still holds
- [x] 6.2 Run `pnpm check` and full `pnpm test`; run `mfz apply --no-link` dry paths in a temp home
- [x] 6.3 End-to-end verify on this machine: toggle jira on for codex in a repo, launch `codex`, confirm the server initializes; confirm bypass launch shows defaults
