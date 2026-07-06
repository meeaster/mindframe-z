## ADDED Requirements

### Requirement: Codex profile configuration
The profile manifest SHALL support a `codex` block with a `config` map whose values
are rendered as Codex TOML configuration.

#### Scenario: Profile declares Codex config
- **WHEN** a profile declares `codex.config.model = "gpt-5.5"`
- **THEN** the resolved profile SHALL preserve that setting for the Codex renderer

#### Scenario: Child profile overrides Codex config
- **WHEN** a base profile declares `codex.config.model = "gpt-5.5"` and a child profile declares `codex.config.model_reasoning_effort = "high"`
- **THEN** the merged profile SHALL contain both Codex config keys

### Requirement: Codex renderer output
The Codex renderer SHALL write managed Codex artifacts under
`configs/<profile>/codex/`.

#### Scenario: Render Codex config snapshot
- **WHEN** the Codex renderer runs for profile `personal`
- **THEN** it SHALL write `configs/personal/codex/config.toml`

#### Scenario: Render Codex AGENTS guidance
- **WHEN** the Codex renderer runs for profile `personal`
- **THEN** it SHALL write `configs/personal/codex/AGENTS.md` containing the generated mfz runtime guidance

### Requirement: Codex local apply merge
During a real linked apply, mfz SHALL merge the managed Codex config snapshot into
`~/.codex/config.toml` while preserving unrelated user-local keys.

#### Scenario: Merge managed config into existing Codex config
- **WHEN** `~/.codex/config.toml` already contains an unrelated user key and the managed snapshot contains `model = "gpt-5.5"`
- **THEN** the written local `~/.codex/config.toml` SHALL contain both the unrelated user key and the managed model key

#### Scenario: No-link apply does not write local Codex config
- **WHEN** `mfz apply --agent codex --no-link` runs
- **THEN** mfz SHALL render `configs/<profile>/codex/config.toml`
- **AND** mfz SHALL NOT write `~/.codex/config.toml`

### Requirement: Codex AGENTS installation
During a real linked apply, mfz SHALL install the managed Codex AGENTS guidance as
the user-level Codex guidance file without writing `AGENTS.override.md`.

#### Scenario: Install user-level Codex guidance
- **WHEN** `mfz apply --agent codex` runs
- **THEN** `~/.codex/AGENTS.md` SHALL point to or contain the rendered `configs/<profile>/codex/AGENTS.md` content

#### Scenario: Override file is not generated
- **WHEN** `mfz apply --agent codex` runs
- **THEN** mfz SHALL NOT create `~/.codex/AGENTS.override.md`

### Requirement: Codex MCP rendering
The Codex renderer SHALL render Codex-targeted profile MCP servers under
`[mcp_servers]` in `config.toml`.

#### Scenario: Render local MCP server
- **WHEN** a Codex-targeted local MCP server has command `[npx, -y, example-mcp]`
- **THEN** the Codex config SHALL contain a matching `mcp_servers.<name>` entry with `command = "npx"` and `args = ["-y", "example-mcp"]`

#### Scenario: Render remote MCP server
- **WHEN** a Codex-targeted remote MCP server has URL `https://mcp.example.com/mcp`
- **THEN** the Codex config SHALL contain a matching `mcp_servers.<name>` entry with that URL

#### Scenario: Exclude non-Codex MCP target
- **WHEN** an MCP server targets only `opencode`
- **THEN** the Codex config SHALL NOT include that MCP server

### Requirement: Codex filesystem permissions
The Codex renderer SHALL translate `references_dir` and machine-local
`extra_folders` into a named Codex filesystem permission profile.

#### Scenario: References are read-only
- **WHEN** the Codex renderer runs with `references_dir = "~/references"`
- **THEN** the generated Codex permission profile SHALL grant read access to the references directory
- **AND** it SHALL NOT grant write access to the references directory

#### Scenario: Writable extra folder
- **WHEN** an extra folder has `read: allow` and `edit: allow`
- **THEN** the generated Codex permission profile SHALL grant write access to that folder

#### Scenario: Denied extra folder
- **WHEN** an extra folder has `read: deny` and `edit: deny`
- **THEN** the generated Codex permission profile SHALL deny access to that folder

### Requirement: Codex sync detects unmanaged config
`mfz sync` SHALL detect top-level keys in the managed Codex config snapshot that are
not declared in the profile's `codex.config` and offer to promote them to a profile.

#### Scenario: Unmanaged Codex key detected
- **WHEN** `configs/personal/codex/config.toml` contains `model_verbosity = "low"` and `profiles/personal/profile.yml` does not declare it under `codex.config`
- **THEN** `mfz sync` SHALL report an unmanaged `codex.config.model_verbosity` candidate

#### Scenario: Derived Codex keys are not sync candidates
- **WHEN** `configs/personal/codex/config.toml` contains generated `mcp_servers` or `permissions` tables
- **THEN** `mfz sync` SHALL NOT report those generated tables as unmanaged profile config keys

### Requirement: Codex project-local config out of scope
mfz SHALL NOT generate project-local `.codex/config.toml` files as part of this
change.

#### Scenario: Apply does not create project-local Codex config
- **WHEN** `mfz apply --agent codex` runs from a repository root
- **THEN** mfz SHALL NOT create `.codex/config.toml` in that repository
