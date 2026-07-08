## ADDED Requirements

### Requirement: Profile skill entries declare per-harness availability and default state

A profile skill entry SHALL consist of an `agents` map from harness name (`opencode`, `claude-code`, `codex`) to boolean, with an optional sibling `toggleable` boolean (default `true`). A harness key being present means the skill is installed for that harness; the boolean value is its default enabled state. Unlike MCP entries, `claude-code: false` SHALL be accepted — every harness supports config-level skill disabling. The `all` target token SHALL NOT be accepted.

#### Scenario: Skill with mixed per-harness defaults

- **WHEN** a profile declares `skills.impeccable.agents: { opencode: true, codex: false }`
- **THEN** impeccable SHALL resolve enabled for opencode and disabled for codex
- **AND** impeccable SHALL NOT be registered for claude-code

#### Scenario: Non-toggleable skill

- **WHEN** a profile declares `skills.openspec-propose: { agents: { opencode: true, claude-code: true, codex: true }, toggleable: false }`
- **THEN** the resolved skill SHALL be enabled on all three harnesses and excluded from toggle surfaces

## MODIFIED Requirements

### Requirement: Deep merge for skill inheritance

When a child profile overrides a parent's skill entry, the merge SHALL use deep merge semantics — child `agents` keys override the same parent keys, parent keys not overridden remain intact, and a child `toggleable` overrides the parent's.

#### Scenario: Child overrides one harness, parent keys preserved

- **WHEN** parent profile has `skillName: { agents: { opencode: false, codex: false } }` and child profile has `skillName: { agents: { codex: true } }`
- **THEN** the resolved `agents` map SHALL be `{ opencode: false, codex: true }`

#### Scenario: Child overrides toggleable only, parent agents preserved

- **WHEN** parent profile has `skillName: { agents: { opencode: true }, toggleable: true }` and child profile has `skillName: { toggleable: false }`
- **THEN** resolved `toggleable` SHALL be `false` (from child)
- **AND** the resolved `agents` map SHALL be `{ opencode: true }` (from parent, preserved through deep merge)

## REMOVED Requirements

### Requirement: Profile skill entries accept enabled boolean

**Reason**: The `{ enabled, targets }` shape is replaced by the `agents` map — one field expressing availability and per-harness default state, aligned with MCP entries.
**Migration**: Rewrite each entry as `agents: { <harness>: <bool>, ... }`; `enabled: X` with no `targets` becomes every profile agent mapped to `X`.

### Requirement: Profile skill schema accepts legacy format

**Reason**: Pre-release clean cut — bare `skillName:` (null) entries are no longer accepted; every entry states its `agents` map explicitly.
**Migration**: Replace `skillName:` (null) with `skillName: { agents: { <each profile agent>: true } }`.

### Requirement: Schema validation for enabled field

**Reason**: The `enabled` field no longer exists; validation now covers the `agents` map (harness keys from the agent enum, boolean values) and the `toggleable` boolean.
**Migration**: Covered by the new per-harness requirement's schema validation.
