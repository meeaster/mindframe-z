## Why

OpenCode custom commands (slash commands like `/opsx-explore`) are markdown files that live in `.opencode/commands/` or `~/.config/opencode/commands/`. Currently mindframe-z has no mechanism to manage which commands are active per profile — they're either all present (project-local) or manually placed (global). Commands should be profile-aware like skills, plugins, and MCP servers, so different profiles (personal, work) can enable different command sets.

## What Changes

- Add a `commands` field to the profile schema as a `string[]` (additive on merge, deduplicated, like `skills` and `opencode_plugins`)
- Add a `opencode/commands/` source directory at the repo root for command markdown files (parallel to `opencode/plugins/`)
- Render enabled commands from `opencode/commands/` into `.runtime/<profile>/opencode/commands/` during `apply`
- Symlink `~/.config/opencode/commands/` to the runtime commands directory
- Detect unmanaged command files in `opencode/commands/` (not referenced by any profile) via `sync`
- Display enabled commands in `status` output
- Update `ARCHITECTURE.md` to document commands

## Capabilities

### New Capabilities
- `profile-commands`: Profile-aware command selection, rendering, and symlink management for OpenCode custom commands

### Modified Capabilities
<!-- No existing specs to modify -->

## Impact

- `src/core/manifests.ts` — profile schema gains `commands` field
- `src/core/profile.ts` — merge logic for `commands`
- `src/renderers/opencode.ts` — command file collection and symlink
- `src/cli/mindframe-z.ts` — `status` and `sync` command updates
- Integration tests — add command fixtures and assertions
- `ARCHITECTURE.md` — document the new field and render path