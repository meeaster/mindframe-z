## Purpose

JSON Schema files are generated from Zod schemas at build time and placed in the `schemas/` directory for editor auto-completion and validation of YAML manifests.

## Requirements

### Requirement: JSON Schema generation from Zod schemas

The system SHALL provide a `mindframe-z schemas` CLI command that reads Zod schemas from `src/core/manifests.ts` and generates JSON Schema files to a `schemas/` directory at the engine project root. Generation SHALL use `z.toJSONSchema()` with `io: "input"` mode so that coerced fields appear as their input type for editor validation. Generated schemas SHALL include the home manifest (`mfz_home.schema.json`) and the references catalog schema SHALL be named `references.schema.json` (renamed from `refs.schema.json`). The profile schema SHALL include the `agents` field and SHALL NOT include the `targets` field. Skill config entries SHALL accept both the new object shape `{ enabled: boolean, targets?: [...] }` and the legacy `null` / array-only shapes. MCP config `targets` SHALL be optional (defaulting to profile agents). Generated schemas SHALL be committed in the engine repository so scaffolded homes can reference them by published URL in `yaml-language-server` modelines.

#### Scenario: Generating all schemas

- **WHEN** `mindframe-z schemas` is run
- **THEN** JSON Schema files SHALL be written to `schemas/` for each manifest type: `references.schema.json`, `skills.schema.json`, `mcp.schema.json`, `profile.schema.json`, `machine.schema.json`, `mfz_home.schema.json`
- **AND** `profile.schema.json` SHALL define `agents` as an array of `["opencode", "claude-code"]` enum values with default `["opencode", "claude-code"]`
- **AND** `profile.schema.json` SHALL NOT define a `targets` field at the top level
- **AND** `profile.schema.json` SHALL define skill config entries as objects with optional `enabled: boolean` and optional `targets` array
- **AND** `profile.schema.json` SHALL define MCP config `targets` as optional arrays with minimum 1 item
- **AND** `mfz_home.schema.json` SHALL define an optional `description` string and an optional `extends` object requiring `name` and `repo`

#### Scenario: Skill entry with enabled field generates valid schema

- **WHEN** the profile schema contains `skillName: { enabled: boolean, targets?: [...] }`
- **THEN** generated `profile.schema.json` SHALL include `enabled` as an optional boolean property in the skill entry definition
