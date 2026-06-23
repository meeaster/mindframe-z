## REMOVED Requirements

### Requirement: Empty target array disables skill
**Reason**: Superseded by the `enabled: false` field in profile skill entries. The `enabled` boolean provides a clearer, more intentional disable mechanism than an empty array.
**Migration**: Replace `skillName: []` with `skillName: { enabled: false }` in all profile YAMLs.

## MODIFIED Requirements

### Requirement: Schema allows empty target arrays
The `profileSkillTargetsSchema` SHALL continue to accept empty arrays as valid skill target configurations. The `enabled: false` field is the canonical disable mechanism; empty target arrays remain valid inputs but `enabled: false` is preferred.

#### Scenario: Profile with empty skill target passes validation
- **WHEN** a profile YAML contains `skillName: []`
- **THEN** `mfz doctor` reports the manifest as valid
- **AND** the skill SHALL resolve with `targets: []` and `enabled: true` (default, since `[]` is just the targets value, not the new object shape)
