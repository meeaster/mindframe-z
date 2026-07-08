## MODIFIED Requirements

### Requirement: TUI toggles write to repo-local or global tool config files

On save (`s` key), the TUI SHALL persist enable/disable state. The system SHALL detect a git repository by running `git rev-parse --show-toplevel` from `process.cwd()`. If git detection succeeds, project-scoped deltas SHALL be written to the override store keyed by the git root, and no file inside the repository SHALL be created or modified. If git detection fails, writes SHALL target user-global config files.

| Context | Target | Destination | Key written |
|---------|--------|------|-------------|
| In a git repo | any harness | `~/.mindframe-z/overrides.json` | `projects.<repo-root>.<harness>.skills.<name>: true/false` |
| Not in a repo | opencode | `~/.config/opencode/opencode.jsonc` | `permission.skill.<name>: "deny"` / `"allow"` |
| Not in a repo | claude-code | `~/.claude/settings.json` | `skillOverrides.<name>: "off"` / `"on"` |
| Not in a repo | codex | `~/.codex/config.toml` | `skills.config` entry `enabled` |

#### Scenario: TUI saves repo-scoped toggles to the override store

- **WHEN** user is inside a git repo, toggles homeassistant to disabled for opencode, and presses `s`
- **THEN** `~/.mindframe-z/overrides.json` SHALL contain the project-scoped opencode skill delta for homeassistant
- **AND** no file under the repository SHALL be created or modified
- **AND** no `.git/info/exclude` modification SHALL be attempted

#### Scenario: TUI saves disabled skills to global opencode config

- **WHEN** user is not inside a git repo, toggles openai-docs to disabled for opencode, and presses `s`
- **THEN** `~/.config/opencode/opencode.jsonc` SHALL contain `"permission": { "skill": { "openai-docs": "deny" } }`
- **AND** existing global OpenCode config keys outside `permission.skill` SHALL be preserved

#### Scenario: TUI saves disabled skills to global Claude Code config

- **WHEN** user is not inside a git repo, toggles homeassistant to disabled for claude-code, and presses `s`
- **THEN** `~/.claude/settings.json` SHALL contain `"skillOverrides": { "homeassistant": "off" }`
- **AND** any existing keys in the file outside `skillOverrides` SHALL be preserved

### Requirement: CLI commands for skill toggling

`mfz skills enable <name>` and `mfz skills disable <name>` SHALL toggle a skill's state for specified targets, writing project-scoped deltas to the override store when inside a git repo and to the same global config files as the TUI when outside one.

#### Scenario: CLI disables skill inside a repo

- **WHEN** `mfz skills disable homeassistant --target opencode` is invoked from inside a git repo
- **THEN** the override store SHALL contain the project-scoped opencode skill delta for homeassistant
- **AND** the command SHALL print `Disabled homeassistant for opencode`
- **AND** no file under the repository SHALL be modified

#### Scenario: CLI disables skill for Claude Code outside a repo

- **WHEN** `mfz skills disable openai-docs --target claude-code` is invoked from outside a git repo
- **THEN** `~/.claude/settings.json` SHALL be updated with `"skillOverrides": { "openai-docs": "off" }`
- **AND** the command SHALL print `Disabled openai-docs for claude-code`

#### Scenario: CLI defaults to all profile targets if --target not specified

- **WHEN** `mfz skills disable homeassistant` is invoked without `--target`
- **THEN** the skill SHALL be disabled for all agent targets defined in the resolved profile

### Requirement: Skill toggle read resolution order

When resolving the current toggle state for a skill, the system SHALL use the following precedence, with highest precedence first:

1. Project-scoped deltas from the override store for the current git root, only when in a repo
2. Global config (`~/.config/opencode/opencode.jsonc`, `~/.claude/settings.json`, or `~/.codex/config.toml`)
3. Profile defaults from the resolved profile's `enabled` field

#### Scenario: Store overrides shadow global overrides in a repo

- **WHEN** user is in a repo, global config disables hunk, and the override store enables hunk for this project
- **THEN** the effective state for hunk SHALL be enabled

#### Scenario: Global overrides are used when not in a repo

- **WHEN** user is not in a repo and global config has `hunk: "deny"`
- **THEN** the effective state for hunk SHALL be disabled
