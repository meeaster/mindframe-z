## MODIFIED Requirements

### Requirement: TUI toggles write to repo-local or global config based on git context

On save (`s` key), the TUI SHALL write enable/disable state to the appropriate config files based on whether the current working directory is inside a git repository:

| Context | Target | File | Key written |
|---------|--------|------|-------------|
| In a git repo | opencode | `<repo-root>/.opencode/opencode.jsonc` | `permission.skill.<name>: "deny"` / `"allow"` |
| In a git repo | claude-code | `<repo-root>/.claude/settings.local.json` | `skillOverrides.<name>: "off"` / `"on"` |
| Not in a repo | opencode | `~/.config/opencode/opencode.jsonc` | `permission.skill.<name>: "deny"` / `"allow"` |
| Not in a repo | claude-code | `~/.claude/settings.json` | `skillOverrides.<name>: "off"` / `"on"` |

The git repository SHALL be detected by running `git rev-parse --show-toplevel` from `process.cwd()`. If the command fails (git not installed or not in a repo), the global config path SHALL be used.

#### Scenario: TUI saves enabled skills to local config when in a repo

- **WHEN** user is inside a git repo at `/home/user/myproject` and toggles homeassistant to enabled for opencode and presses `s`
- **THEN** `/home/user/myproject/.opencode/opencode.jsonc` SHALL contain `"permission": { "skill": { "homeassistant": "allow" } }` (or omit the entry since allow is default)
- **AND** any existing permission rules in the file outside the `skill` block SHALL be preserved

#### Scenario: TUI saves disabled skills to global config when not in a repo

- **WHEN** user is in `/tmp` (not a git repo) and toggles openai-docs to disabled for opencode and presses `s`
- **THEN** `~/.config/opencode/opencode.jsonc` SHALL contain `"permission": { "skill": { "openai-docs": "deny" } }`
- **AND** all other keys in the global config (instructions, mcp, plugin, etc.) SHALL be preserved

#### Scenario: TUI saves disabled skills to global Claude config when not in a repo

- **WHEN** user is in `/tmp` (not a git repo) and toggles homeassistant to disabled for claude-code and presses `s`
- **THEN** `~/.claude/settings.json` SHALL contain `"skillOverrides": { "homeassistant": "off" }`
- **AND** all other keys in `settings.json` SHALL be preserved

#### Scenario: TUI creates local config file if missing (in repo)

- **WHEN** user is in a git repo and `.opencode/opencode.jsonc` does not exist and user saves toggle state
- **THEN** the file SHALL be created at the repo root with the permission.skill block

#### Scenario: TUI skips git exclusion for global config

- **WHEN** user is not in a git repo and saves toggle state
- **THEN** no `.git/info/exclude` modification SHALL be attempted

### Requirement: CLI commands for skill toggling use repo-scoped config

`mfz skills enable <name>` and `mfz skills disable <name>` SHALL toggle a skill's state for specified targets, writing to repo-local or global config files based on git context detection.

#### Scenario: CLI enables skill for OpenCode in a repo

- **WHEN** `mfz skills enable homeassistant --target opencode` is invoked from within a git repo
- **THEN** `.opencode/opencode.jsonc` at the repo root SHALL be updated to allow the homeassistant skill
- **AND** the command SHALL print `Enabled homeassistant for opencode`

#### Scenario: CLI disables skill for OpenCode outside a repo

- **WHEN** `mfz skills disable openai-docs --target opencode` is invoked from outside a git repo
- **THEN** `~/.config/opencode/opencode.jsonc` SHALL be updated with the deny entry for openai-docs
- **AND** all other keys in the global config SHALL be preserved
- **AND** the command SHALL print `Disabled openai-docs for opencode`

#### Scenario: CLI defaults to all profile targets if --target not specified

- **WHEN** `mfz skills disable homeassistant` is invoked without `--target`
- **THEN** the skill SHALL be disabled for all agent targets defined in the resolved profile

### Requirement: TUI reads profile defaults on first run

When no config overrides exist for a target (neither local nor global), the TUI SHALL read the resolved profile's `enabled` field per skill as the initial toggle state.

#### Scenario: First run uses profile defaults

- **WHEN** `mfz skills tui` is invoked and no `permission.skill` block exists in either local or global opencode config
- **THEN** the TUI SHALL read the resolved profile and seed toggle state from each skill's `enabled` field

#### Scenario: Global overrides take precedence over profile defaults

- **WHEN** `mfz skills tui` is invoked outside a repo and `~/.config/opencode/opencode.jsonc` contains a `permission.skill` block
- **THEN** skill toggle state SHALL reflect the global config state, not the profile default
- **AND** skills not mentioned in global overrides SHALL fall back to profile defaults

### Requirement: Skill toggle read resolution order

When resolving the current toggle state for a skill, the system SHALL use the following precedence (highest wins):

1. Local config (`.opencode/opencode.jsonc` or `.claude/settings.local.json` at repo root) — only when in a repo
2. Global config (`~/.config/opencode/opencode.jsonc` or `~/.claude/settings.json`)
3. Profile defaults from the resolved profile's `enabled` field

#### Scenario: Local overrides shadow global overrides in a repo

- **WHEN** user is in a repo, global config has `hunk: "deny"`, and local config has `hunk: "allow"`
- **THEN** the effective state for hunk SHALL be "allow" (local wins)

#### Scenario: Global overrides used when not in a repo

- **WHEN** user is not in a repo and global config has `hunk: "deny"`
- **THEN** the effective state for hunk SHALL be "deny"

#### Scenario: Profile defaults used when no overrides exist

- **WHEN** neither local nor global config has an entry for a skill
- **THEN** the effective state SHALL match the profile's `enabled` field for that skill
