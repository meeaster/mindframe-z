## 1. Schema and Type Changes

- [x] 1.1 In `src/core/manifests.ts`: Add `agentSchema = z.enum(["opencode", "claude-code"])`. Replace `targets` field in `profileSchema` with `agents: z.array(agentSchema).default(["opencode", "claude-code"])`. Remove `targets` from top-level profile schema.
- [x] 1.2 In `src/core/manifests.ts`: Make skill targets optional — change `profileSkillTargetsSchema` to allow `undefined` (empty/omitted means "use profile agents"). Keep `[all]` as a valid value.
- [x] 1.3 In `src/core/manifests.ts`: Make MCP config `targets` optional — change `profileMcpConfigSchema.targets` to `z.array(targetSchema).min(1).optional()`. When omitted, defaults to profile agents at resolution time.
- [x] 1.4 In `src/core/manifests.ts`: Update `ProfileManifest` type and `loadManifests` defaults to use `agents` instead of `targets`.
- [x] 1.5 In `src/core/paths.ts`: Add `AgentName` type (`"opencode" | "claude-code"). Keep `ToolTarget` and `ApplyTarget` unchanged (still needed for mise/dotfiles).
- [x] 1.6 Run `pnpm schemas` to regenerate `schemas/profile.schema.json` and verify the new schema.

## 2. Profile Resolution Changes

- [x] 2.1 In `src/core/profile.ts`: Add `agents: AgentName[]` to `ResolvedProfile` interface. Populate it from the merged profile's `agents` field.
- [x] 2.2 In `src/core/profile.ts`: Update `mergeProfiles` to merge `agents` instead of `targets` (child replaces parent if non-empty, same semantics).
- [x] 2.3 In `src/core/profile.ts`: Update `expandSkillTargets` to accept the profile's `agents` list. When targets is undefined/empty, use agents. When `[all]`, resolve to agents instead of hardcoded list.
- [x] 2.4 In `src/core/profile.ts`: Update MCP server resolution — when `targets` is omitted from an MCP config entry, default to the profile's `agents` list.
- [x] 2.5 In `src/core/profile.ts`: Update `filterMcpForTarget` to work with the new optional targets resolution.

## 3. Rendering Pipeline Changes

- [x] 3.1 In `src/core/render.ts`: Gate agent renderers by `profile.agents`. Only run opencode renderer if `"opencode"` is in agents; only run claude-code renderer if `"claude-code"` is in agents. Mise and dotfiles always render.
- [x] 3.2 In `src/cli/mfz.ts`: Update `applyConfig` to use the agents list for determining which renderers run by default. Add `--agent` flag. Keep `--target` for mise/dotfiles.
- [x] 3.3 In `src/cli/mfz.ts`: Update `doctor` command to respect agent gating — only check links for agents in the profile.
- [x] 3.4 In `src/cli/mfz.ts`: Update `status` command to display the resolved agents list.

## 4. Skills Changes

- [x] 4.1 In `src/cli/mfz.ts`: Update `skills sync` to use `--agent` instead of `--target`. Only sync skills for agents in the profile's agents list.
- [x] 4.2 In `src/skills/npx-skills.ts`: Ensure `targetSkillsDir` still works with the existing `ToolTarget` type (no change needed for install paths, but verify callers pass only agents in the profile).

## 5. Profile YAML Updates

- [x] 5.1 Update `profiles/base/profile.yml`: Replace `targets: [opencode, claude-code]` with `agents: [opencode, claude-code]`. Remove explicit `targets:` from skills and MCP entries where they mirror the default (all agents). Keep explicit targets for skills that are agent-specific (e.g., `opencode-db: [opencode]`, `claude-code-docs: [opencode]`).
- [x] 5.2 Update `profiles/personal/profile.yml`: Add `agents: [opencode]`. Remove `targets:` from all MCP entries. Remove `targets:` from skill entries (default to agents). Remove the `claude` config section entirely.
- [x] 5.3 Update `profiles/work/profile.yml`: Add `agents: [opencode, claude-code]`. Remove explicit `targets:` from MCP entries where they match both agents. Keep explicit targets where needed.
- [x] 5.4 Remove any stale `configs/personal/claude/` rendered files if they exist (they will no longer be generated).

## 6. Sync and Status Updates

- [x] 6.1 In `src/sync/opencode.ts` and `src/sync/claude.ts`: Verify these still work correctly — they read rendered config files, which may not exist if the agent isn't in the profile. Add graceful handling for missing rendered files.
- [x] 6.2 In `src/sync/skills.ts`: Update to use agents list for determining which skills to sync.

## 7. Tests

- [x] 7.1 Update all integration test fixtures that use `targets:` to use `agents:` instead. Update skill entries to use optional targets. Update MCP entries to use optional targets.
- [x] 7.2 Add integration test: profile with `agents: [opencode]` produces no claude rendered files.
- [x] 7.3 Add integration test: skill with no targets defaults to profile agents.
- [x] 7.4 Add integration test: MCP config with no targets defaults to profile agents.
- [x] 7.5 Add integration test: `mfz apply --agent opencode` on a dual-agent profile only renders opencode.
- [x] 7.6 Run full test suite (`pnpm check`) and fix any failures.

## 8. Documentation

- [x] 8.1 Update `ARCHITECTURE.md`: Replace all references to `targets` with `agents`. Update the merge semantics table. Document the agent-gating behavior for renderers.
- [x] 8.2 Regenerate schemas and commit updated `schemas/profile.schema.json`.
