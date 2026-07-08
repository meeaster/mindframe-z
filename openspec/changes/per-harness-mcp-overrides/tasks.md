## 1. Profile schema and resolution (mcp-profile-defaults)

- [ ] 1.1 Replace `profileMcpConfigSchema` in `src/core/manifests.ts` with the `agents` map (`z.record(agentSchema, z.boolean())`, non-empty) and a refine rejecting `claude-code: false`; drop `enabled`/`targets`
- [ ] 1.2 Update `ResolvedMcpServer` and `filterMcpForTarget` in `src/core/profile.ts` to carry per-harness defaults; availability = key present
- [ ] 1.3 Migrate all `profiles/*/profile.yml` mcp entries to `agents` maps (preserve current effective states) and regenerate `schemas/profile.schema.json` via `pnpm schemas`
- [ ] 1.4 Update opencode/codex renderers to emit per-harness default `enabled`; claude renderer to filter on claude availability (presence-only), preserving `mergeClaudeMcp` semantics
- [ ] 1.5 Fix `renderCodexMcp`: `{env:VAR}` header values emit `env_http_headers` (header -> var name); literal values stay `http_headers`
- [ ] 1.6 Update unit/integration tests covering schema validation (legacy fields rejected, claude-code false rejected for mcp, inheritance merge) and renderer output per harness
- [ ] 1.7 Replace the skill entry schema with `{ agents: Record<harness, boolean>, toggleable?: boolean }` (drop `enabled`/`targets`/`all`/null entries); update `resolveSkillConfig` and `profileDefaults` to read per-harness defaults
- [ ] 1.8 Migrate all `profiles/*/profile.yml` skill entries to `agents` maps (flow style, preserve current effective states) and update skill schema/inheritance tests

## 2. Override store (local-override-store)

- [ ] 2.1 Create the override-store module: zod schema, validated reads (abort on corrupt, never truncate), atomic writes, keyed by git root
- [ ] 2.2 Implement delta semantics against resolved profile defaults (store only drift; prune empty sections) reusing the `writeSkillOverrideDelta` approach
- [ ] 2.3 Implement payload rendering per harness: codex `argv` (`-c mcp_servers.*.enabled=...`, full `skills.config` array), opencode `config` JSON, claude `settings` JSON (`skillOverrides`)
- [ ] 2.4 Re-render all stored payloads during `mfz apply`
- [ ] 2.5 Unit tests: delta add/remove/prune, corrupt-file abort, payload re-render after profile default change

## 3. MCP toggle surface (mcp-local-toggle)

- [ ] 3.1 Add `mfz mcp enable|disable <name> [--agent <harness>]` with write-time target expansion and unavailable-harness errors
- [ ] 3.2 Add `mfz mcp status` printing merged per-harness state with override markers
- [ ] 3.3 Add `mfz mcp tui` sharing the skills TUI interactions, saving deltas to the store
- [ ] 3.4 Integration tests: enable/disable inside and outside a repo, status output, no repo files written

## 4. Launchers (harness-launchers)

- [ ] 4.1 Verify claude honors `skillOverrides` via `--settings` with a throwaway session; if not, record fallback (keep `.claude/settings.local.json` for claude project skills) in design.md and adjust specs
- [ ] 4.2 Render `codex`/`opencode`/`claude` zsh functions into managed zsh config (jq-based payload read, `command` exec, silent degradation when store/jq/entry absent)
- [ ] 4.3 Smoke-test each launcher: injection applied inside an overridden project, unmodified exec outside, `--help` passthrough

## 5. Skills migration (skill-local-toggle)

- [ ] 5.1 Point repo-scope skill toggle writes at the override store; delete repo-file paths and `ensureActiveGitExcluded`/git-exclude machinery from `src/tui/skill-config-paths.ts` and `skill-toggle-state.ts`
- [ ] 5.2 Update read resolution: store project deltas > global config > profile defaults
- [ ] 5.3 Update skills TUI/CLI tests to assert store writes and absence of repo file writes
- [ ] 5.4 Flag stale repo-local toggle files in `mfz doctor` (stop reading them; suggest cleanup)

## 6. Docs and verification

- [ ] 6.1 Update ARCHITECTURE.md and README for the `agents` map, override store, and launchers; check AGENTS.md guidance still holds
- [ ] 6.2 Run `pnpm check` and full `pnpm test`; run `mfz apply --no-link` dry paths in a temp home
- [ ] 6.3 End-to-end verify on this machine: toggle jira on for codex in a repo, launch `codex`, confirm the server initializes; confirm bypass launch shows defaults
