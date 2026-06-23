## Why

Skills consume context window budget through their descriptions in every agent session, yet most skills are only useful for specific tasks. Today users have no way to disable skills per-project — skills are either installed globally (always visible) or not installed at all. This forces an all-or-nothing tradeoff between having tools available when needed and wasting context on unused skill descriptions.

## What Changes

- **BREAKING**: Skill entries in profile YAML change from `null | [targets]` to `{ enabled: boolean, targets?: [...] }`, mirroring the MCP config pattern
- **BREAKING**: The empty-array skill disable pattern (`skill: []`) is superseded by `enabled: false`
- `mfz skills tui` — interactive terminal UI for toggling skills per-project, per-target. Writes directly to local tool config files (`.opencode/opencode.jsonc` and `.claude/settings.local.json`)
- `mfz skills enable <name>` and `mfz skills disable <name>` — CLI shortcuts for the same toggling
- `mfz skills sync` now installs all profile skills regardless of `enabled` state (toggle is instant, no install step needed)
- `mfz apply` is NOT involved — skill toggling operates on local-only, per-project config files independently of the global config rendering pipeline

## Capabilities

### New Capabilities
- `skill-local-toggle`: TUI and CLI for per-project skill enable/disable via local tool config files. Toggle state persists in `.opencode/opencode.jsonc` (permission.skill deny/allow rules) and `.claude/settings.local.json` (skillOverrides). Profile defaults seed the initial state.
- `skill-profile-defaults`: Profile skill entries gain an `enabled` boolean field that sets the default toggle state. Most skills default to disabled.

### Modified Capabilities
- `skills-sync`: Sync must install all profile-declared skills regardless of `enabled` state, so toggling on is instant with no install delay.
- `skill-disable-inheritance`: The `[]` empty array disable pattern is superseded by `enabled: false`. Existing profiles using `[]` must be migrated.
- `yaml-schemas`: Profile schema changes to include `enabled` field in skill entries.

## Impact

- `src/core/manifests.ts` — profile skill schema (add `enabled`)
- `src/core/profile.ts` — resolved skill type, resolution, merge (add `enabled`, change to deep merge)
- `src/cli/mfz.ts` — new `skills tui`, `skills enable`, `skills disable` subcommands
- `src/tui/` — new TUI module using `@clack/core`
- `src/renderers/` — NOT touched (toggle writes directly, not through renderers)
- `src/skills/npx-skills.ts` — sync behavior change (install all, skip none)
- `profiles/*/profile.yml` — migrate existing skill entries to `{ enabled, targets }` format
- `schemas/` — regenerate after schema changes
- `openspec/specs/skill-disable-inheritance/spec.md` — update to reflect `enabled: false` as the canonical disable pattern
