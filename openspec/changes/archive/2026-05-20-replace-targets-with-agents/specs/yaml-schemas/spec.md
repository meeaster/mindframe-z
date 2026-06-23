## MODIFIED Requirements

### Requirement: JSON Schema generation from Zod schemas
The system SHALL provide a `mindframe-z schemas` CLI command that reads Zod schemas from `src/core/manifests.ts` and generates JSON Schema files to a `schemas/` directory at the project root. Generation SHALL use `z.toJSONSchema()` with `io: "input"` mode so that coerced fields appear as their input type for editor validation. The profile schema SHALL include the `agents` field and SHALL NOT include the `targets` field. Skill target entries SHALL be optional (defaulting to profile agents). MCP config `targets` SHALL be optional (defaulting to profile agents).

#### Scenario: Generating all schemas
- **WHEN** `mindframe-z schemas` is run
- **THEN** JSON Schema files SHALL be written to `schemas/` for each manifest type: `refs.schema.json`, `skills.schema.json`, `mcp.schema.json`, `profile.schema.json`, `machine.schema.json`
- **AND** `profile.schema.json` SHALL define `agents` as an array of `["opencode", "claude-code"]` enum values with default `["opencode", "claude-code"]`
- **AND** `profile.schema.json` SHALL NOT define a `targets` field at the top level
- **AND** `profile.schema.json` SHALL define skill target entries as optional arrays
- **AND** `profile.schema.json` SHALL define MCP config `targets` as optional arrays with minimum 1 item

#### Scenario: Unrepresentable types handled gracefully
- **WHEN** a Zod schema contains types without JSON Schema equivalents (e.g., `z.unknown()`)
- **THEN** the generator SHALL use `unrepresentable: "any"` so these fields become `{}` (any) in the output schema instead of throwing

#### Scenario: Regenerating schemas
- **WHEN** `mindframe-z schemas` is run and schemas already exist
- **THEN** existing schema files SHALL be overwritten with fresh output

#### Scenario: Schema directory contents
- **WHEN** `mindframe-z schemas` is run
- **THEN** `schemas/` SHALL contain exactly five files: `refs.schema.json`, `skills.schema.json`, `mcp.schema.json`, `profile.schema.json`, `machine.schema.json`