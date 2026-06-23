## Purpose

Defines the profile `commands` field, command file collection and rendering for OpenCode, and related CLI behavior.

## Requirements

### Requirement: Profile commands field
The profile schema SHALL include a `commands` field of type `string[]` with a default of `[]`. This field lists command names that the profile enables.

#### Scenario: Base profile with commands
- **WHEN** a profile YAML contains `commands: [opsx-explore, opsx-propose]`
- **THEN** the resolved profile SHALL include both command names in its `commands` array

#### Scenario: Profile with no commands
- **WHEN** a profile YAML does not include a `commands` field
- **THEN** the resolved profile SHALL have an empty `commands` array

### Requirement: Commands merge additively
When a child profile extends a parent, the `commands` arrays SHALL be merged by concatenating the parent's commands before the child's commands and deduplicating. This is identical to how `skills` and `opencode_plugins` are merged.

#### Scenario: Child profile extends base commands
- **WHEN** base profile has `commands: [opsx-explore, opsx-propose]` and child profile has `commands: [opsx-apply, opsx-explore]`
- **THEN** the merged result SHALL be `commands: [opsx-explore, opsx-propose, opsx-apply]` (deduplicated, parent-first order)

#### Scenario: Child profile with no commands
- **WHEN** base profile has `commands: [opsx-explore]` and child profile has no `commands` field
- **THEN** the merged result SHALL be `commands: [opsx-explore]`

### Requirement: Command file collection
The OpenCode renderer SHALL collect command markdown files from `opencode/commands/` in the repo root. Files whose basename (without `.md` extension) matches an entry in the profile's `commands` array SHALL be included in the render output.

#### Scenario: Profile enables specific commands
- **WHEN** profile has `commands: [opsx-explore]` and `opencode/commands/` contains `opsx-explore.md` and `opsx-apply.md`
- **THEN** only `opsx-explore.md` SHALL be rendered to the runtime directory

#### Scenario: Missing command file
- **WHEN** profile lists a command name that has no corresponding `.md` file in `opencode/commands/`
- **THEN** the renderer SHALL throw an error identifying the missing command name

### Requirement: Command rendering path
Collected command files SHALL be rendered to `.runtime/<profile>/opencode/commands/<name>.md`. The renderer SHALL copy the file content verbatim.

#### Scenario: Command file content preserved
- **WHEN** `opencode/commands/opsx-explore.md` contains YAML frontmatter and markdown body
- **THEN** the rendered file at `.runtime/<profile>/opencode/commands/opsx-explore.md` SHALL contain the exact same content

### Requirement: Commands directory symlink
The renderer SHALL create a symlink from `<opencodeConfigDir>/commands` to `.runtime/<profile>/opencode/commands/`. If a non-symlink directory already exists at the link path, the existing backup mechanism SHALL apply (rename to `<path>.mindframe-z.bak-<timestamp>`, then symlink).

#### Scenario: Fresh symlink creation
- **WHEN** `apply` runs and `~/.config/opencode/commands/` does not exist
- **THEN** a symlink SHALL be created pointing `<opencodeConfigDir>/commands` to `.runtime/<profile>/opencode/commands/`

#### Scenario: Existing directory backup
- **WHEN** `apply` runs and `~/.config/opencode/commands/` exists as a real directory (not a symlink)
- **THEN** the existing directory SHALL be renamed to `commands.mindframe-z.bak-<timestamp>` before creating the symlink

#### Scenario: Existing valid symlink
- **WHEN** `apply` runs and `~/.config/opencode/commands/` is already a symlink pointing to the correct target
- **THEN** no action SHALL be taken (link is valid)

### Requirement: Commands excluded from non-OpenCode targets
Command rendering and symlinking SHALL only apply to the `opencode` target. The `claude-code`, `mise`, and `dotfiles` targets SHALL not include command files.

#### Scenario: Claude target render
- **WHEN** rendering for `claude-code` target
- **THEN** no command files or command symlinks SHALL be produced

### Requirement: Status command shows enabled commands
The `status` CLI command SHALL output the list of enabled command names.

#### Scenario: Status with commands
- **WHEN** `mindframe-z status` runs for a profile with `commands: [opsx-explore, opsx-apply]`
- **THEN** the output SHALL include a line `commands\topsx-explore, opsx-apply`

#### Scenario: Status with no commands
- **WHEN** `mindframe-z status` runs for a profile with no commands
- **THEN** the output SHALL include a line `commands\tnone`

### Requirement: Sync detects unmanaged command files
The `sync` command SHALL detect command markdown files in `opencode/commands/` whose basename (without `.md`) is not present in the active profile's `commands` list. It SHALL offer to add them to a chosen profile.

#### Scenario: Unmanaged command detected
- **WHEN** `opencode/commands/` contains `my-command.md` and the active profile's `commands` does not include `my-command`
- **THEN** sync SHALL report "Unmanaged command: my-command" and offer to add it to the selected profile

#### Scenario: All commands managed
- **WHEN** every `.md` file in `opencode/commands/` is listed in the active profile's `commands`
- **THEN** sync SHALL not report any unmanaged commands
