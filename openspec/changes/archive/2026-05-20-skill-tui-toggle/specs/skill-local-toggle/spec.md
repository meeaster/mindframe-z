## ADDED Requirements

### Requirement: TUI lists installed skills with toggle state per target
`mfz skills tui` SHALL display all installed skills with their current enable/disable state for the selected agent target (opencode or claude-code), seeded from profile defaults on first run.

#### Scenario: TUI shows skills with profile defaults
- **WHEN** `mfz skills tui` is invoked in a project with no prior local toggle state
- **THEN** each skill SHALL display as enabled (◉) or disabled (○) matching the profile's `enabled` field for that skill and target
- **AND** the TUI SHALL display the target name (opencode or claude-code) in the header

#### Scenario: TUI shows local overrides over profile defaults
- **WHEN** `mfz skills tui` is invoked and `.opencode/opencode.jsonc` contains a `permission.skill` block
- **THEN** skill toggle state SHALL reflect the local file state, not the profile default
- **AND** skills not mentioned in local overrides SHALL fall back to profile defaults

#### Scenario: Tab switches between targets
- **WHEN** the user presses Tab in the TUI
- **THEN** the view SHALL toggle between opencode and claude-code targets
- **AND** the toggle state SHALL update to reflect that target's current state

### Requirement: TUI toggles write directly to local tool config files
On save (`s` key), the TUI SHALL write enable/disable state to the appropriate local config files:

| Target | File | Key written |
|--------|------|-------------|
| opencode | `.opencode/opencode.jsonc` | `permission.skill.<name>: "deny"` / `"allow"` |
| claude-code | `.claude/settings.local.json` | `skillOverrides.<name>: "off"` / `"on"` |

#### Scenario: TUI saves enabled skills to opencode config
- **WHEN** user toggles homeassistant to enabled for opencode and presses `s`
- **THEN** `.opencode/opencode.jsonc` SHALL contain `"permission": { "skill": { "homeassistant": "allow" } }` (or omit the entry since allow is default)
- **AND** any existing permission rules in the file outside the `skill` block SHALL be preserved

#### Scenario: TUI saves disabled skills to opencode config
- **WHEN** user toggles openai-docs to disabled for opencode and presses `s`
- **THEN** `.opencode/opencode.jsonc` SHALL contain `"permission": { "skill": { "openai-docs": "deny" } }`

#### Scenario: TUI saves disabled skills to Claude Code config
- **WHEN** user toggles homeassistant to disabled for claude-code and presses `s`
- **THEN** `.claude/settings.local.json` SHALL contain `"skillOverrides": { "homeassistant": "off" }`
- **AND** any existing keys in `settings.local.json` outside `skillOverrides` SHALL be preserved

#### Scenario: TUI creates config file if missing
- **WHEN** `.opencode/opencode.jsonc` does not exist and user saves toggle state
- **THEN** the file SHALL be created with the permission.skill block

### Requirement: CLI commands for skill toggling
`mfz skills enable <name>` and `mfz skills disable <name>` SHALL toggle a skill's state for specified targets, writing to the same local config files as the TUI.

#### Scenario: CLI enables skill for OpenCode
- **WHEN** `mfz skills enable homeassistant --target opencode` is invoked
- **THEN** `.opencode/opencode.jsonc` SHALL be updated to allow the homeassistant skill (or remove a deny entry)
- **AND** the command SHALL print `Enabled homeassistant for opencode`

#### Scenario: CLI disables skill for Claude Code
- **WHEN** `mfz skills disable openai-docs --target claude-code` is invoked
- **THEN** `.claude/settings.local.json` SHALL be updated with `"skillOverrides": { "openai-docs": "off" }`
- **AND** the command SHALL print `Disabled openai-docs for claude-code`

#### Scenario: CLI defaults to all profile targets if --target not specified
- **WHEN** `mfz skills disable homeassistant` is invoked without `--target`
- **THEN** the skill SHALL be disabled for all agent targets defined in the resolved profile

### Requirement: TUI reads profile defaults on first run
When no local config overrides exist for a target, the TUI SHALL read the resolved profile's `enabled` field per skill as the initial toggle state.

#### Scenario: First run uses profile defaults
- **WHEN** `mfz skills tui` is invoked in a project with no `.opencode/opencode.jsonc` permission.skill block
- **THEN** the TUI SHALL read the resolved profile and seed toggle state from each skill's `enabled` field

### Requirement: TUI keyboard interactions
The TUI SHALL support the following keyboard bindings:

| Key | Action |
|-----|--------|
| ↑ / ↓ / j / k | Move cursor |
| Space | Toggle current skill |
| a | Toggle all skills |
| i | Invert selection |
| Tab | Switch target (opencode ↔ claude-code) |
| s | Save to local config files |
| q / Esc | Quit without saving |

#### Scenario: Space toggles skill state
- **WHEN** cursor is on a skill and user presses Space
- **THEN** the toggle indicator SHALL flip between ◉ (enabled) and ○ (disabled)

#### Scenario: Tab switches target view
- **WHEN** user presses Tab and current target is opencode
- **THEN** the target indicator SHALL change to claude-code
- **AND** toggle states SHALL update to reflect claude-code's current state
