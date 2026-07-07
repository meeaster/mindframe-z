## ADDED Requirements

### Requirement: Codex plugins are a derived config surface
The Codex renderer SHALL treat the `plugins` table as an mfz-derived key so that Codex
sync does not report it as an unmanaged user key.

#### Scenario: Plugins table is excluded from top-level key adoption
- **WHEN** Codex sync scans `~/.codex/config.toml` for unmanaged top-level keys
- **THEN** it SHALL NOT report the `plugins` table as an unmanaged `codex.config` key

### Requirement: Codex local merge preserves additive keys while owning plugins
During a real linked apply, mfz SHALL continue to deep-merge the managed Codex config
snapshot into `~/.codex/config.toml` for all keys except `plugins`, which SHALL be
written as an authoritative replacement of the local `plugins` table.

#### Scenario: Additive keys merge while plugins are replaced
- **WHEN** `~/.codex/config.toml` contains an unrelated user key and enables an undeclared plugin, and the managed snapshot declares a different plugin plus a managed model key
- **THEN** the written local `~/.codex/config.toml` SHALL contain the unrelated user key and the managed model key
- **AND** the written local `[plugins]` table SHALL contain only the declared plugin
