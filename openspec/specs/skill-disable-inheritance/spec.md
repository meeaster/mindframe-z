## Purpose

Skill targets in profiles can be configured per-agent, and the resolution of inherited skill entries must handle empty target arrays correctly without treating them as a disable mechanism.

## Requirements

### Requirement: Schema allows empty target arrays

The `profileSkillTargetsSchema` SHALL continue to accept empty arrays as valid skill target configurations. The `enabled: false` field is the canonical disable mechanism; empty target arrays remain valid inputs but `enabled: false` is preferred.

#### Scenario: Profile with empty skill target passes validation

- **WHEN** a profile YAML contains `skillName: []`
- **THEN** `mfz doctor` reports the manifest as valid
- **AND** the skill SHALL resolve with `targets: []` and `enabled: true` (default, since `[]` is just the targets value, not the new object shape)
