## Why

mindframe-z currently renders first-class runtime configuration for OpenCode and
Claude Code, but Codex now has comparable durable configuration surfaces: user
config, AGENTS guidance, MCP servers, skills, hooks, subagents, permissions, and
noninteractive execution. Adding Codex as a first-class target keeps the profile
model tool-neutral instead of forcing Codex setup to live outside mfz.

## What Changes

- Add `codex` as a profile agent target alongside `opencode` and `claude-code`.
- Add a Codex renderer that writes a managed profile snapshot under
  `configs/<profile>/codex/`.
- Render Codex `config.toml` from a new profile `codex.config` pass-through block.
- Render Codex global AGENTS guidance from the same generated mfz instruction source
  used by existing agent targets.
- Render profile-selected MCP servers into Codex `[mcp_servers]` TOML.
- Render references and machine-local extra folders into Codex filesystem permissions
  using a named permission profile.
- Apply Codex config with a managed-snapshot plus local merge pattern, rather than a
  symlink, so user-local Codex state is preserved.
- Add sync support for unmanaged top-level Codex config keys in the managed snapshot.
- Extend skill targeting and local skill toggles to include Codex where the installed
  skill path is known.
- Keep Codex cloud tasks, app settings, plugin marketplace management, import flows,
  project-local `.codex/` generation, and thread dispatch out of this change.

## Capabilities

### New Capabilities

- `codex-agent-config`: rendering, applying, merging, syncing, and diagnosing Codex
  local CLI/IDE configuration from resolved mfz profiles.

### Modified Capabilities

- `agent-resolution`: profile agent selection, CLI agent filtering, default skill
  targets, and default MCP targets include the new `codex` agent target.
- `skill-local-toggle`: repo/global skill toggle read and write behavior supports
  Codex skill visibility where mfz can resolve a Codex skill config entry.

## Impact

- Manifest schema and generated JSON schemas gain the `codex` agent target and a
  `codex` profile block.
- Profile resolution, render dispatch, status, doctor, apply, and sync flows gain a
  Codex target path.
- New renderer under `src/renderers/` for Codex TOML, AGENTS guidance, MCP, and
  permission profile generation.
- `src/sync/` gains Codex config drift detection.
- `src/tui/` and skill-toggle helpers gain Codex target support.
- Integration tests cover Codex apply/no-link, local merge, MCP rendering, extra
  folder permissions, sync, and skill targeting.
