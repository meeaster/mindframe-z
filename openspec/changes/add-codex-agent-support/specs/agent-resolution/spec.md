## MODIFIED Requirements

### Requirement: Profile agents field
The profile manifest SHALL include an `agents` field with type `array of enum ["opencode", "claude-code", "codex"]`, defaulting to `["opencode", "claude-code", "codex"]` when omitted. The `agents` field replaces the previous `targets` field. During profile inheritance, a child's `agents` list replaces the parent's list if non-empty (same merge semantics as the old `targets` field).

#### Scenario: Default agents when omitted
- **WHEN** a profile YAML omits the `agents` field
- **THEN** the resolved profile SHALL have `agents: ["opencode", "claude-code", "codex"]`

#### Scenario: Explicit agents
- **WHEN** a profile declares `agents: [opencode]`
- **THEN** the resolved profile SHALL have `agents: ["opencode"]`

#### Scenario: Explicit Codex agent
- **WHEN** a profile declares `agents: [codex]`
- **THEN** the resolved profile SHALL have `agents: ["codex"]`

#### Scenario: Child profile overrides parent agents
- **WHEN** a base profile has `agents: [opencode, claude-code, codex]` and a child profile has `agents: [opencode]`
- **THEN** the merged profile SHALL have `agents: ["opencode"]`

### Requirement: Agent-gated rendering
The render pipeline SHALL only run agent renderers (opencode, claude-code, codex) for agents present in the resolved profile's `agents` list. Infrastructure renderers (mise, dotfiles) SHALL always run regardless of the agents list.

#### Scenario: Single agent profile
- **WHEN** a resolved profile has `agents: ["opencode"]`
- **THEN** `mfz apply` SHALL produce opencode config files, mise config, and dotfiles, but SHALL NOT produce any claude-code or codex config files, symlinks, or local merged files

#### Scenario: All agents
- **WHEN** a resolved profile has `agents: ["opencode", "claude-code", "codex"]`
- **THEN** `mfz apply` SHALL produce config for all three agents plus mise and dotfiles

#### Scenario: CLI agent flag overrides profile
- **WHEN** `mfz apply --agent opencode` is run on a profile with `agents: ["opencode", "claude-code", "codex"]`
- **THEN** only the opencode renderer SHALL run (plus infrastructure)

#### Scenario: CLI agent not in profile agents
- **WHEN** `mfz apply --agent claude-code` is run on a profile with `agents: ["opencode"]`
- **THEN** only the claude-code renderer SHALL run (plus infrastructure), producing claude config even though the profile doesn't include claude by default

### Requirement: CLI agent and target flags
`mfz apply` SHALL accept `--agent <agent>` to filter which agent renderers run and `--target <target>` to filter which infrastructure renderers run. When neither flag is provided, all agents in the profile and all infrastructure targets SHALL run. The `--target` flag SHALL accept `mise`, `dotfiles`, or `all` (for infrastructure). The `--agent` flag SHALL accept `opencode`, `claude-code`, `codex`, or `all`. `mfz apply` with no flags SHALL be equivalent to `--agent all --target all`.

#### Scenario: Apply with no flags
- **WHEN** `mfz apply` is run without `--agent` or `--target` flags
- **THEN** all agents in the profile's agents list SHALL render, plus mise and dotfiles

#### Scenario: Apply with agent filter
- **WHEN** `mfz apply --agent opencode` is run
- **THEN** only the opencode renderer SHALL run (plus infrastructure unless `--target` filters it)

#### Scenario: Apply with Codex agent filter
- **WHEN** `mfz apply --agent codex` is run
- **THEN** only the Codex renderer SHALL run (plus infrastructure unless `--target` filters it)

### Requirement: Default skill targets resolve to profile agents
When a skill entry in a profile omits the targets list, the skill SHALL be installed for all agents in the profile's `agents` list. When a skill entry uses `[all]`, it SHALL resolve to the profile's `agents` list (not a hardcoded list).

#### Scenario: Skill with no targets
- **WHEN** a profile has `agents: [opencode]` and declares `skills: { hunk-review: }` (no targets)
- **THEN** the skill SHALL be installed for opencode only

#### Scenario: Skill with all
- **WHEN** a profile has `agents: [opencode]` and declares `skills: { hunk-review: [all] }`
- **THEN** the skill SHALL be installed for opencode only (all resolves to the profile's agents)

#### Scenario: Skill with explicit targets
- **WHEN** a profile has `agents: [opencode, claude-code, codex]` and declares `skills: { opencode-db: [opencode] }`
- **THEN** the skill SHALL be installed for opencode only, regardless of the profile's agents

#### Scenario: Skill targets Codex explicitly
- **WHEN** a profile has `agents: [opencode, claude-code, codex]` and declares `skills: { openai-docs: [codex] }`
- **THEN** the skill SHALL be installed for codex only

### Requirement: Default MCP targets resolve to profile agents
When an MCP config entry in a profile omits the `targets` field, the server SHALL be configured for all agents in the profile's `agents` list. The `targets` field on MCP config entries SHALL be optional (defaulting to the profile's agents list).

#### Scenario: MCP with no targets
- **WHEN** a profile has `agents: [opencode]` and declares `mcp: { context7: { enabled: true } }` (no targets)
- **THEN** the context7 server SHALL be rendered for opencode only

#### Scenario: MCP with explicit targets
- **WHEN** a profile has `agents: [opencode, claude-code, codex]` and declares `mcp: { deepwiki: { targets: [opencode], enabled: true } }`
- **THEN** the deepwiki server SHALL be rendered for opencode only

#### Scenario: MCP with no targets in multi-agent profile
- **WHEN** a profile has `agents: [opencode, claude-code, codex]` and declares `mcp: { context7: { enabled: true } }`
- **THEN** the context7 server SHALL be rendered for opencode, claude-code, and codex

#### Scenario: MCP targets Codex explicitly
- **WHEN** a profile has `agents: [opencode, claude-code, codex]` and declares `mcp: { openai-docs: { targets: [codex], enabled: true } }`
- **THEN** the openai-docs server SHALL be rendered for codex only

### Requirement: Skills sync respects agents
`mfz skills sync` SHALL only install and remove skills for agents in the profile's `agents` list. The `--target` flag on skills commands SHALL be renamed to `--agent`.

#### Scenario: Skills sync with single agent profile
- **WHEN** a profile has `agents: [opencode]` and `mfz skills sync` is run
- **THEN** skills SHALL only be installed/removed for opencode; claude-code and codex skills directories SHALL NOT be touched

#### Scenario: Skills sync with Codex profile
- **WHEN** a profile has `agents: [codex]` and `mfz skills sync` is run
- **THEN** skills SHALL only be installed/removed for codex
