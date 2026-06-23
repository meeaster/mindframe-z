## Purpose

`mfz skills sync` installs and removes skills to match the resolved profile, regardless of each skill's `enabled` state. The `enabled` field affects only runtime toggle visibility, not installation.

## Requirements

### Requirement: Sync adds all profile skills including disabled ones

`mfz skills sync` SHALL install ALL skills declared in the resolved profile, including those with `enabled: false`. The `enabled` field affects only runtime visibility (rendered as permission/override rules), not installation.

#### Scenario: Sync adds missing profile skills

- **WHEN** a skill is declared in the profile (regardless of `enabled` value) for a target but not installed for that target
- **THEN** `mfz skills sync` installs the skill using `npx skills add`

#### Scenario: Sync installs disabled skills

- **WHEN** a skill has `enabled: false` in the profile for a target and is not installed
- **THEN** `mfz skills sync` installs the skill — the `enabled: false` only controls initial toggle state, not installation

#### Scenario: Sync removes extra installed skills

- **WHEN** a skill is installed for a target but not declared in the resolved profile for that target
- **THEN** `mfz skills sync` removes the skill using `npx skills remove`

#### Scenario: Sync leaves matching skills unchanged

- **WHEN** a skill is installed for a target and also declared in the resolved profile for that target (any enabled value)
- **THEN** `mfz skills sync` does not add or remove the skill
