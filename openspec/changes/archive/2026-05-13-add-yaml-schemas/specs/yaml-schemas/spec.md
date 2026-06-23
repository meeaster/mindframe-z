## ADDED Requirements

### Requirement: JSON Schema generation from Zod schemas
The system SHALL provide a `mindframe-z schemas` CLI command that reads Zod schemas from `src/core/manifests.ts` and generates JSON Schema files to a `schemas/` directory at the project root. Generation SHALL use `z.toJSONSchema()` with `io: "input"` mode so that coerced fields (e.g., `z.coerce.string()`) appear as their input type for editor validation.

#### Scenario: Generating all schemas
- **WHEN** `mindframe-z schemas` is run
- **THEN** JSON Schema files SHALL be written to `schemas/` for each manifest type: `refs.schema.json`, `skills.schema.json`, `mcp.schema.json`, `profile.schema.json`, `machine.schema.json`

#### Scenario: Unrepresentable types handled gracefully
- **WHEN** a Zod schema contains types without JSON Schema equivalents (e.g., `z.unknown()`)
- **THEN** the generator SHALL use `unrepresentable: "any"` so these fields become `{}` (any) in the output schema instead of throwing

#### Scenario: Regenerating schemas
- **WHEN** `mindframe-z schemas` is run and schemas already exist
- **THEN** existing schema files SHALL be overwritten with fresh output

### Requirement: npm script for schema generation
`package.json` SHALL include a `schemas` script that runs the schema generation, enabling `npm run schemas`.

#### Scenario: Running via npm
- **WHEN** `npm run schemas` is executed
- **THEN** it SHALL produce the same output as `mindframe-z schemas`

### Requirement: Generated schemas are committed artifacts
The `schemas/` directory and its JSON Schema files SHALL be committed to the repository. The schemas are small, stable artifacts derived from a single source of truth (Zod schemas in `manifests.ts`).

#### Scenario: Schemas present after clone
- **WHEN** the repository is cloned
- **THEN** `schemas/*.schema.json` files SHALL be present and usable by editors without running any build step

### Requirement: Zed editor schema mapping
A `.zed/settings.json` file SHALL map generated JSON Schemas to YAML file patterns using `yaml-language-server` configuration. Schema paths SHALL use `./schemas/` prefix (relative to worktree root).

#### Scenario: Zed provides YAML validation
- **WHEN** a user opens `shared/mcp.yml` in Zed
- **THEN** `yaml-language-server` SHALL validate the file against `./schemas/mcp.schema.json` and provide autocomplete

#### Scenario: Zed provides profile validation
- **WHEN** a user opens `profiles/personal/profile.yml` in Zed
- **THEN** `yaml-language-server` SHALL validate the file against `./schemas/profile.schema.json`

### Requirement: VS Code editor schema mapping
A `.vscode/settings.json` file SHALL map generated JSON Schemas to YAML file patterns using the `yaml.schemas` setting. This provides the same validation and autocomplete for VS Code users.

#### Scenario: VS Code provides YAML validation
- **WHEN** a user opens `shared/skills.yml` in VS Code with the YAML extension
- **THEN** the file SHALL be validated against `schemas/skills.schema.json`

### Requirement: Doctor validates manifest files
`mindframe-z doctor` SHALL validate each manifest YAML file individually against its Zod schema and report per-file status. Files that fail validation SHALL be reported with the Zod error details; files that pass SHALL show a checkmark.

#### Scenario: All manifests valid
- **WHEN** `mindframe-z doctor` is run and all YAML files are valid
- **THEN** each file SHALL be listed with a ✓ status indicator

#### Scenario: Invalid manifest detected
- **WHEN** `shared/mcp.yml` contains an MCP server with `type: "websocket"` (invalid enum value)
- **THEN** `doctor` SHALL report `shared/mcp.yml ✗` with the Zod validation error details

#### Scenario: Missing manifest file
- **WHEN** a manifest file does not exist (e.g., no machine config file)
- **THEN** `doctor` SHALL skip that file without error (consistent with current `readYaml` fallback behavior)

### Requirement: Schema output directory structure
The `schemas/` directory SHALL contain exactly one JSON Schema file per manifest type. File names SHALL use the pattern `<manifest-type>.schema.json`.

The mapping of manifest files to schemas SHALL be:

| Manifest file | Schema file |
|---|---|
| `shared/refs.yml` | `schemas/refs.schema.json` |
| `shared/skills.yml` | `schemas/skills.schema.json` |
| `shared/mcp.yml` | `schemas/mcp.schema.json` |
| `profiles/*/profile.yml` | `schemas/profile.schema.json` |
| `machine-config.example.yml` | `schemas/machine.schema.json` |

#### Scenario: Schema directory contents
- **WHEN** `mindframe-z schemas` is run
- **THEN** `schemas/` SHALL contain exactly five files: `refs.schema.json`, `skills.schema.json`, `mcp.schema.json`, `profile.schema.json`, `machine.schema.json`