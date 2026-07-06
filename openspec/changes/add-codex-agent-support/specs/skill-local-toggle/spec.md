## MODIFIED Requirements

### Requirement: TUI lists installed skills with toggle state per target

`mfz skills tui` SHALL display all installed skills with their current enable/disable state for the selected agent target (opencode, claude-code, or codex), seeded from profile defaults on first run.

#### Scenario: TUI shows skills with profile defaults

- **WHEN** `mfz skills tui` is invoked in a project with no prior local toggle state
- **THEN** each skill SHALL display as enabled (◉) or disabled (○) matching the profile's `enabled` field for that skill and target
- **AND** the TUI SHALL display the target name (opencode, claude-code, or codex) in the header

#### Scenario: TUI shows config overrides over profile defaults

- **WHEN** `mfz skills tui` is invoked and applicable OpenCode config contains a `permission.skill` block
- **THEN** skill toggle state SHALL reflect the config override state, not the profile default
- **AND** skills not mentioned in config overrides SHALL fall back to profile defaults

#### Scenario: TUI shows Codex config overrides over profile defaults

- **WHEN** `mfz skills tui` is invoked for codex and applicable Codex config contains a `[[skills.config]]` entry for an installed skill path
- **THEN** skill toggle state SHALL reflect the Codex config override state, not the profile default

#### Scenario: Tab switches between targets

- **WHEN** the user presses Tab in the TUI
- **THEN** the view SHALL cycle between opencode, claude-code, and codex targets
- **AND** the toggle state SHALL update to reflect that target's current state

### Requirement: TUI toggles write to repo-local or global tool config files

On save (`s` key), the TUI SHALL write enable/disable state to the appropriate config files. The system SHALL detect a git repository by running `git rev-parse --show-toplevel` from `process.cwd()`. If git detection succeeds, writes SHALL target config files at the git root. If git detection fails, writes SHALL target user-global config files.

| Context | Target | File | Key written |
|---------|--------|------|-------------|
| In a git repo | opencode | `<repo-root>/.opencode/opencode.jsonc` | `permission.skill.<name>: "deny"` / `"allow"` |
| In a git repo | claude-code | `<repo-root>/.claude/settings.local.json` | `skillOverrides.<name>: "off"` / `"on"` |
| In a git repo | codex | `<repo-root>/.codex/config.toml` | `[[skills.config]]` entry for resolved `SKILL.md` path with `enabled = false` / `true` |
| Not in a repo | opencode | `~/.config/opencode/opencode.jsonc` | `permission.skill.<name>: "deny"` / `"allow"` |
| Not in a repo | claude-code | `~/.claude/settings.json` | `skillOverrides.<name>: "off"` / `"on"` |
| Not in a repo | codex | `~/.codex/config.toml` | `[[skills.config]]` entry for resolved `SKILL.md` path with `enabled = false` / `true` |

#### Scenario: TUI saves enabled skills to repo-local opencode config

- **WHEN** user is inside a git repo, toggles homeassistant to enabled for opencode, and presses `s`
- **THEN** `<repo-root>/.opencode/opencode.jsonc` SHALL contain `"permission": { "skill": { "homeassistant": "allow" } }` (or omit the entry since allow is default)
- **AND** any existing permission rules in the file outside the `skill` block SHALL be preserved

#### Scenario: TUI saves disabled skills to global opencode config

- **WHEN** user is not inside a git repo, toggles openai-docs to disabled for opencode, and presses `s`
- **THEN** `~/.config/opencode/opencode.jsonc` SHALL contain `"permission": { "skill": { "openai-docs": "deny" } }`
- **AND** existing global OpenCode config keys outside `permission.skill` SHALL be preserved

#### Scenario: TUI saves disabled skills to Claude Code config

- **WHEN** user is inside a git repo, toggles homeassistant to disabled for claude-code, and presses `s`
- **THEN** `<repo-root>/.claude/settings.local.json` SHALL contain `"skillOverrides": { "homeassistant": "off" }`
- **AND** any existing keys in `settings.local.json` outside `skillOverrides` SHALL be preserved

#### Scenario: TUI saves disabled skills to Codex config

- **WHEN** user is inside a git repo, toggles openai-docs to disabled for codex, and presses `s`
- **THEN** `<repo-root>/.codex/config.toml` SHALL contain a `[[skills.config]]` entry for the resolved openai-docs `SKILL.md` path with `enabled = false`
- **AND** any existing keys in `config.toml` outside that skill entry SHALL be preserved

#### Scenario: TUI creates repo-local config file if missing

- **WHEN** user is inside a git repo, `<repo-root>/.opencode/opencode.jsonc` does not exist, and user saves toggle state
- **THEN** the repo-local file SHALL be created with the permission.skill block

#### Scenario: TUI skips git exclusion for global config

- **WHEN** user is not inside a git repo and saves toggle state
- **THEN** no `.git/info/exclude` modification SHALL be attempted

### Requirement: CLI commands for skill toggling

`mfz skills enable <name>` and `mfz skills disable <name>` SHALL toggle a skill's state for specified targets, writing to the same repo-local or global config files as the TUI.

#### Scenario: CLI enables skill for OpenCode in a repo

- **WHEN** `mfz skills enable homeassistant --target opencode` is invoked from inside a git repo
- **THEN** `<repo-root>/.opencode/opencode.jsonc` SHALL be updated to allow the homeassistant skill (or remove a deny entry)
- **AND** the command SHALL print `Enabled homeassistant for opencode`

#### Scenario: CLI disables skill for Claude Code outside a repo

- **WHEN** `mfz skills disable openai-docs --target claude-code` is invoked from outside a git repo
- **THEN** `~/.claude/settings.json` SHALL be updated with `"skillOverrides": { "openai-docs": "off" }`
- **AND** the command SHALL print `Disabled openai-docs for claude-code`

#### Scenario: CLI disables skill for Codex outside a repo

- **WHEN** `mfz skills disable openai-docs --target codex` is invoked from outside a git repo
- **THEN** `~/.codex/config.toml` SHALL be updated with a `[[skills.config]]` entry for the resolved openai-docs `SKILL.md` path with `enabled = false`
- **AND** the command SHALL print `Disabled openai-docs for codex`

#### Scenario: CLI defaults to all profile targets if --target not specified

- **WHEN** `mfz skills disable homeassistant` is invoked without `--target`
- **THEN** the skill SHALL be disabled for all agent targets defined in the resolved profile

### Requirement: Skill toggle read resolution order

When resolving the current toggle state for a skill, the system SHALL use the following precedence, with highest precedence first:

1. Repo-local config (`.opencode/opencode.jsonc`, `.claude/settings.local.json`, or `.codex/config.toml` at repo root), only when in a repo
2. Global config (`~/.config/opencode/opencode.jsonc`, `~/.claude/settings.json`, or `~/.codex/config.toml`)
3. Profile defaults from the resolved profile's `enabled` field

#### Scenario: Local overrides shadow global overrides in a repo

- **WHEN** user is in a repo, global config has `hunk: "deny"`, and repo-local config has `hunk: "allow"`
- **THEN** the effective state for hunk SHALL be enabled

#### Scenario: Global overrides are used when not in a repo

- **WHEN** user is not in a repo and global config has `hunk: "deny"`
- **THEN** the effective state for hunk SHALL be disabled

#### Scenario: Codex local overrides shadow Codex global overrides in a repo

- **WHEN** user is in a repo, global Codex config disables a skill path, and repo-local Codex config enables the same skill path
- **THEN** the effective state for that skill SHALL be enabled

### Requirement: TUI keyboard interactions

The TUI SHALL support the following keyboard bindings:

| Key | Action |
|-----|--------|
| ↑ / ↓ / j / k | Move cursor |
| Space | Toggle current skill |
| a | Toggle all skills |
| i | Invert selection |
| Tab | Cycle target (opencode -> claude-code -> codex -> opencode) |
| s | Save to repo-local or global config files |
| q / Esc | Quit without saving |

#### Scenario: Space toggles skill state

- **WHEN** cursor is on a skill and user presses Space
- **THEN** the toggle indicator SHALL flip between ◉ (enabled) and ○ (disabled)

#### Scenario: Tab switches target view

- **WHEN** user presses Tab and current target is opencode
- **THEN** the target indicator SHALL change to claude-code
- **AND** toggle states SHALL update to reflect claude-code's current state

#### Scenario: Tab cycles from Claude Code to Codex

- **WHEN** user presses Tab and current target is claude-code
- **THEN** the target indicator SHALL change to codex
- **AND** toggle states SHALL update to reflect codex's current state
