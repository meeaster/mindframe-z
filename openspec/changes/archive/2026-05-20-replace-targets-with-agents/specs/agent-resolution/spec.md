## ADDED Requirements

### Requirement: Profile agents field
The profile manifest SHALL include an `agents` field with type `array of enum ["opencode", "claude-code"]`, defaulting to `["opencode", "claude-code"]` when omitted. The `agents` field replaces the previous `targets` field. During profile inheritance, a child's `agents` list replaces the parent's list if non-empty (same merge semantics as the old `targets` field).

#### Scenario: Default agents when omitted
- **WHEN** a profile YAML omits the `agents` field
- **THEN** the resolved profile SHALL have `agents: ["opencode", "claude-code"]`

#### Scenario: Explicit agents
- **WHEN** a profile declares `agents: [opencode]`
- **THEN** the resolved profile SHALL have `agents: ["opencode"]`

#### Scenario: Child profile overrides parent agents
- **WHEN** a base profile has `agents: [opencode, claude-code]` and a child profile has `agents: [opencode]`
- **THEN** the merged profile SHALL have `agents: ["opencode"]`

### Requirement: Agent-gated rendering
The render pipeline SHALL only run agent renderers (opencode, claude-code) for agents present in the resolved profile's `agents` list. Infrastructure renderers (mise, dotfiles) SHALL always run regardless of the agents list.

#### Scenario: Single agent profile
- **WHEN** a resolved profile has `agents: ["opencode"]`
- **THEN** `mfz apply` SHALL produce opencode config files, mise config, and dotfiles, but SHALL NOT produce any claude-code config files, symlinks, or local merged files

#### Scenario: Both agents
- **WHEN** a resolved profile has `agents: ["opencode", "claude-code"]`
- **THEN** `mfz apply` SHALL produce config for both agents plus mise and dotfiles

#### Scenario: CLI agent flag overrides profile
- **WHEN** `mfz apply --agent opencode` is run on a profile with `agents: ["opencode", "claude-code"]`
- **THEN** only the opencode renderer SHALL run (plus infrastructure)

#### Scenario: CLI agent not in profile agents
- **WHEN** `mfz apply --agent claude-code` is run on a profile with `agents: ["opencode"]`
- **THEN** only the claude-code renderer SHALL run (plus infrastructure), producing claude config even though the profile doesn't include claude by default

### Requirement: CLI agent and target flags
`mfz apply` SHALL accept `--agent <agent>` to filter which agent renderers run and `--target <target>` to filter which infrastructure renderers run. When neither flag is provided, all agents in the profile and all infrastructure targets SHALL run. The `--target` flag SHALL accept `mise`, `dotfiles`, or `all` (for infrastructure). The `--agent` flag SHALL accept `opencode`, `claude-code`, or `all`. `mfz apply` with no flags SHALL be equivalent to `--agent all --target all`.

#### Scenario: Apply with no flags
- **WHEN** `mfz apply` is run without `--agent` or `--target` flags
- **THEN** all agents in the profile's agents list SHALL render, plus mise and dotfiles

#### Scenario: Apply with agent filter
- **WHEN** `mfz apply --agent opencode` is run
- **THEN** only the opencode renderer SHALL run (plus infrastructure unless `--target` filters it)

### Requirement: Default skill targets resolve to profile agents
When a skill entry in a profile omits the targets list, the skill SHALL be installed for all agents in the profile's `agents` list. When a skill entry uses `[all]`, it SHALL resolve to the profile's `agents` list (not a hardcoded list).

#### Scenario: Skill with no targets
- **WHEN** a profile has `agents: [opencode]` and declares `skills: { hunk-review: }` (no targets)
- **THEN** the skill SHALL be installed for opencode only

#### Scenario: Skill with all
- **WHEN** a profile has `agents: [opencode]` and declares `skills: { hunk-review: [all] }`
- **THEN** the skill SHALL be installed for opencode only (all resolves to the profile's agents)

#### Scenario: Skill with explicit targets
- **WHEN** a profile has `agents: [opencode, claude-code]` and declares `skills: { opencode-db: [opencode] }`
- **THEN** the skill SHALL be installed for opencode only, regardless of the profile's agents

### Requirement: Default MCP targets resolve to profile agents
When an MCP config entry in a profile omits the `targets` field, the server SHALL be configured for all agents in the profile's `agents` list. The `targets` field on MCP config entries SHALL be optional (defaulting to the profile's agents list).

#### Scenario: MCP with no targets
- **WHEN** a profile has `agents: [opencode]` and declares `mcp: { context7: { enabled: true } }` (no targets)
- **THEN** the context7 server SHALL be rendered for opencode only

#### Scenario: MCP with explicit targets
- **WHEN** a profile has `agents: [opencode, claude-code]` and declares `mcp: { deepwiki: { targets: [opencode], enabled: true } }`
- **THEN** the deepwiki server SHALL be rendered for opencode only

#### Scenario: MCP with no targets in multi-agent profile
- **WHEN** a profile has `agents: [opencode, claude-code]` and declares `mcp: { context7: { enabled: true } }`
- **THEN** the context7 server SHALL be rendered for both opencode and claude-code

### Requirement: Removed targets field
The `targets` field on the profile schema SHALL be removed. Profiles SHALL use `agents` instead.

#### Scenario: Profile with targets field
- **WHEN** a profile YAML contains `targets: [opencode, claude-code]`
- **THEN** schema validation SHALL fail with an error indicating `targets` is not a valid field and `agents` should be used instead

### Requirement: Skills sync respects agents
`mfz skills sync` SHALL only install and remove skills for agents in the profile's `agents` list. The `--target` flag on skills commands SHALL be renamed to `--agent`.

#### Scenario: Skills sync with single agent profile
- **WHEN** a profile has `agents: [opencode]` and `mfz skills sync` is run
- **THEN** skills SHALL only be installed/removed for opencode; claude-code skills directories SHALL NOT be touched

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