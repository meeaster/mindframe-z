## Purpose

Profile skill entries support an `enabled` boolean field to control whether a skill is active for a given agent target. The field supports deep merge semantics for profile inheritance and accepts legacy `null` entries for backward compatibility.

## Requirements

### Requirement: Profile skill entries accept enabled boolean

Profile YAML skill entries SHALL use the shape `{ enabled: boolean, targets?: [...] }` or `null` (legacy, treated as `{ enabled: true, targets: <profile agents> }`).

#### Scenario: Skill entry with enabled and targets

- **WHEN** a profile YAML contains `skillName: { enabled: false, targets: [opencode] }`
- **THEN** the resolved skill entry SHALL have `enabled: false` and `targets: ["opencode"]`
- **AND** the profile SHALL pass `mfz doctor` validation

#### Scenario: Skill entry with enabled only (targets default)

- **WHEN** a profile YAML contains `skillName: { enabled: true }` with no targets
- **THEN** `enabled` SHALL be `true` and targets SHALL default to the profile's agents array

### Requirement: Profile skill schema accepts legacy format

The profile schema SHALL continue to accept `null` (bare skill name with no config) as a valid entry, treating it as `{ enabled: true, targets: <profile agents> }` for backward compatibility.

#### Scenario: Legacy null skill entry

- **WHEN** a profile YAML contains `skillName:` (null) with no config
- **THEN** the resolved skill entry SHALL have `enabled: true` and targets from the profile's agents

### Requirement: Deep merge for skill inheritance

When a child profile overrides a parent's skill entry, the merge SHALL use deep merge semantics — child keys override parent keys, but parent keys not overridden remain intact.

#### Scenario: Child overrides only targets, parent enabled preserved

- **WHEN** parent profile has `skillName: { enabled: false, targets: [opencode] }` and child profile has `skillName: { targets: [claude-code] }`
- **THEN** resolved `enabled` SHALL be `false` (from parent, preserved through deep merge)
- **AND** resolved `targets` SHALL be `["claude-code"]` (from child, child overrides parent)

#### Scenario: Child overrides enabled only, parent targets preserved

- **WHEN** parent profile has `skillName: { enabled: false, targets: [opencode] }` and child profile has `skillName: { enabled: true }`
- **THEN** resolved `enabled` SHALL be `true` (from child)
- **AND** resolved `targets` SHALL be `["opencode"]` (from parent, preserved through deep merge)

### Requirement: Schema validation for enabled field

`mfz doctor` SHALL validate that skill entries with `enabled` have a boolean value.

#### Scenario: Invalid enabled value

- **WHEN** a profile YAML contains `skillName: { enabled: "yes" }`
- **THEN** `mfz doctor` SHALL report a validation error

#### Scenario: Missing enabled field

- **WHEN** a profile YAML contains `skillName: { targets: [opencode] }` without `enabled`
- **THEN** validation SHALL pass and `enabled` SHALL default to `true`
