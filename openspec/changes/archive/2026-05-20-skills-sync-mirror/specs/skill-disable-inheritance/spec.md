## ADDED Requirements

### Requirement: Empty target array disables skill
A profile SHALL be able to disable a skill inherited from a parent profile by overriding its target list to an empty array (`[]`).

#### Scenario: Child overrides inherited skill to disabled
- **WHEN** a parent profile enables a skill with `skillName: [all]` and the child profile overrides it with `skillName: []`
- **THEN** the resolved profile does not include the skill in `enabledSkills`

#### Scenario: Disabled skill not installed during sync
- **WHEN** a skill is disabled via empty target array
- **THEN** `mfz skills sync` does not install it for any target, and removes it if previously installed

### Requirement: Schema allows empty target arrays
The `profileSkillTargetsSchema` SHALL accept empty arrays as valid skill target configurations.

#### Scenario: Profile with empty skill target passes validation
- **WHEN** a profile YAML contains `skillName: []`
- **THEN** `mfz doctor` reports the manifest as valid
