## Why

The `targets` field in profiles is dead code — it's declared and merged through inheritance but never enforced. Meanwhile, every skill and MCP entry requires an explicit `targets` list even when the intent is "all agents I use," forcing repetitive `[opencode]` annotations in profiles that only use one agent. Users who don't use Claude Code at all still get Claude config files rendered and symlinked.

Introducing `agents` replaces the dead field with a meaningful one that gates rendering and provides a default for skill/MCP target resolution, eliminating repetition and ensuring only configured agents produce config output.

## What Changes

- **BREAKING**: Replace `targets` field in profile manifests with `agents` — a list of agent names (`opencode`, `claude-code`) that controls which renderers run and serves as the default target for skills and MCP servers
- **BREAKING**: Make `targets` optional on skill entries and MCP config — when omitted, defaults to the profile's `agents` list
- **BREAKING**: Make `all` in skill targets resolve to the profile's `agents` list instead of hardcoded `["opencode", "claude-code"]`
- **BREAKING**: Remove `targets` from the top-level profile schema entirely
- Gate renderers: only run the opencode renderer if `opencode` is in `agents`, only run the claude-code renderer if `claude-code` is in `agents`
- When an agent is not in the profile's `agents` list, no config files, symlinks, or local merged files are produced for that agent
- Remove the `claude` config section from the personal profile since it only uses opencode
- Update CLI: `--target` for agent renderers becomes `--agent`; `--target` still applies to mise and dotfiles
- Update all profile YAMLs, tests, and generated schemas

## Capabilities

### New Capabilities
- `agent-resolution`: Resolving which agents a profile targets, gating renderers, and expanding default targets for skills/MCP entries

### Modified Capabilities
- `yaml-schemas`: Profile schema changes from `targets` to `agents`, skill/MCP targets become optional

## Impact

- `src/core/manifests.ts` — Zod schema changes (targets→agents, optional skill/MCP targets)
- `src/core/profile.ts` — expandSkillTargets uses agents, merge uses agents, ResolvedProfile.agents
- `src/core/paths.ts` — add AgentName type, keep ToolTarget for render targets
- `src/core/render.ts` — gate rendering by profile agents
- `src/cli/mfz.ts` — apply/skills/doctor/status commands use agents; `--agent` flag
- `src/skills/npx-skills.ts` — skills sync respects agents
- `src/sync/` — agent-awareness for sync operations
- `profiles/base/profile.yml` — `targets` → `agents`, remove per-entry targets where default-all applies
- `profiles/personal/profile.yml` — `agents: [opencode]`, simplify skills/MCP, remove `claude` section
- `profiles/work/profile.yml` — `agents: [opencode, claude-code]`, simplify skills/MCP
- `tests/integration/` — update all test fixtures
- `schemas/profile.schema.json` — regenerated
- `ARCHITECTURE.md` — document agents concept, update merge semantics table