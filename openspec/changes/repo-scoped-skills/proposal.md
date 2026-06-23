## Why

Skill toggle state (`mfz skills enable/disable/tui`) always writes to project-local config files (`.opencode/opencode.jsonc`, `.claude/settings.local.json`), even when running outside a git repository. This means toggling skills outside a repo creates orphaned local config files in directories that aren't projects, and the toggles don't persist sensibly. When not in a repo, skill toggles should write to the global config so they apply across sessions.

## What Changes

- Detect whether the current working directory is inside a git repo using `git rev-parse --show-toplevel`
- When **in a repo**: write skill toggles to local config at the repo root (current behavior, but resolved from git root instead of `paths.root`)
- When **not in a repo**: write skill toggles to global config (`~/.config/opencode/opencode.jsonc` for opencode, `~/.claude/settings.json` for claude-code)
- Skip `ensureGitExcluded` when writing to global config (no repo to exclude from)
- Reading skill toggle state follows the same repo-scoped logic

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `skill-local-toggle`: Requirements change — the write/read target is now determined by git repo detection rather than always being project-local. The spec needs to document the repo-scoped vs global-scoped behavior.

## Impact

- `src/tui/config-io.ts`: Core change — `readLocalSkillOverrides`, `writeLocalSkillOverrides`, `setLocalSkillState`, `resolveSkillToggleState` all need repo-scoped path resolution
- `src/core/paths.ts`: May need a helper to find git root or global config path
- `src/cli/mfz.ts`: `setSkillEnabled` and TUI entry points pass `paths` through; may need adjustment
- `src/tui/skills-tui.ts`: Calls `writeLocalSkillOverrides` and `resolveSkillToggleState`
- Existing tests in `src/tui/config-io.test.ts` need updating for the new behavior
