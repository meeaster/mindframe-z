## ADDED Requirements

### Requirement: Codex plugins profile block
The profile manifest SHALL support a `codex.plugins` map keyed by a fully-qualified
plugin id of the form `<name>@<marketplace>`, whose values declare an `enabled` boolean
and an optional `toggleable` boolean.

#### Scenario: Profile declares an enabled plugin
- **WHEN** a profile declares `codex.plugins."github@openai-curated".enabled = true`
- **THEN** the resolved profile SHALL preserve that plugin entry for the Codex renderer

#### Scenario: Child profile adds plugins to base
- **WHEN** a base profile declares `codex.plugins."github@openai-curated".enabled = true` and a child profile declares `codex.plugins."teams@openai-curated".enabled = true`
- **THEN** the merged profile SHALL contain both plugin entries

#### Scenario: Child profile overrides a base plugin enablement
- **WHEN** a base profile declares `codex.plugins."github@openai-curated".enabled = true` and a child profile declares `codex.plugins."github@openai-curated".enabled = false`
- **THEN** the merged profile SHALL contain `codex.plugins."github@openai-curated".enabled = false`

### Requirement: Codex plugins rendering
The Codex renderer SHALL render declared plugins into `[plugins."<id>"]` blocks in the
managed `config.toml` snapshot, preserving the fully-qualified id as the block key.

#### Scenario: Render an enabled plugin block
- **WHEN** the resolved profile declares `codex.plugins."github@openai-curated".enabled = true`
- **THEN** the rendered `config.toml` SHALL contain a `[plugins."github@openai-curated"]` block with `enabled = true`

#### Scenario: Render a disabled plugin block
- **WHEN** the resolved profile declares `codex.plugins."github@openai-curated".enabled = false`
- **THEN** the rendered `config.toml` SHALL contain a `[plugins."github@openai-curated"]` block with `enabled = false`

#### Scenario: No plugins declared produces no plugins table
- **WHEN** the resolved profile declares no `codex.plugins` entries
- **THEN** the rendered `config.toml` SHALL NOT contain a `[plugins]` table

### Requirement: Codex plugins full ownership on apply
During a real linked apply, mfz SHALL make the local `[plugins]` table authoritative:
the table written to `~/.codex/config.toml` SHALL contain exactly the plugins declared
in the resolved profile, and plugins present locally but not declared SHALL be removed.

#### Scenario: Undeclared local plugin is pruned
- **WHEN** `~/.codex/config.toml` enables `[plugins."slack@openai-curated"]` and the resolved profile declares only `codex.plugins."github@openai-curated"`
- **THEN** the written local `~/.codex/config.toml` SHALL contain `[plugins."github@openai-curated"]`
- **AND** the written local `~/.codex/config.toml` SHALL NOT contain `[plugins."slack@openai-curated"]`

#### Scenario: Non-plugin local keys are preserved
- **WHEN** `~/.codex/config.toml` contains an unrelated top-level key and the resolved profile declares `codex.plugins."github@openai-curated"`
- **THEN** the written local `~/.codex/config.toml` SHALL retain the unrelated top-level key

#### Scenario: Empty declared set removes the local plugins table
- **WHEN** `~/.codex/config.toml` enables one or more plugins and the resolved profile declares no `codex.plugins` entries
- **THEN** the written local `~/.codex/config.toml` SHALL NOT contain a `[plugins]` table

#### Scenario: No-link apply does not write local plugins
- **WHEN** `mfz apply --agent codex --no-link` runs for a profile that declares `codex.plugins`
- **THEN** mfz SHALL render the plugins into `configs/<profile>/codex/config.toml`
- **AND** mfz SHALL NOT write `~/.codex/config.toml`

### Requirement: Codex plugin sync adoption
Codex sync SHALL surface plugins that are enabled in local `~/.codex/config.toml` but
not declared in the resolved profile as adoption candidates that write back into
`codex.plugins`.

#### Scenario: Locally-enabled undeclared plugin is offered for adoption
- **WHEN** `~/.codex/config.toml` enables `[plugins."teams@openai-curated"]` and the resolved profile does not declare it
- **THEN** Codex sync SHALL emit an adoption candidate targeting `codex.plugins."teams@openai-curated"`

#### Scenario: Declared plugin is not offered for adoption
- **WHEN** `~/.codex/config.toml` enables `[plugins."github@openai-curated"]` and the resolved profile declares `codex.plugins."github@openai-curated"`
- **THEN** Codex sync SHALL NOT emit an adoption candidate for that plugin
