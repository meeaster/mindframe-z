## ADDED Requirements

### Requirement: Skills sync mirrors profile
`mfz skills sync` SHALL reconcile installed global agent skills with the resolved profile: install missing profile skills, and remove installed skills not present in the profile.

#### Scenario: Sync adds missing profile skills
- **WHEN** a skill is enabled in the profile for a target but not installed for that target
- **THEN** `mfz skills sync` installs the skill using `npx skills add`

#### Scenario: Sync removes extra installed skills
- **WHEN** a skill is installed for a target but not enabled in the resolved profile for that target
- **THEN** `mfz skills sync` removes the skill using `npx skills remove`

#### Scenario: Sync leaves matching skills unchanged
- **WHEN** a skill is installed for a target and also enabled in the resolved profile for that target
- **THEN** `mfz skills sync` does not add or remove the skill

### Requirement: Sync never updates
`mfz skills sync` SHALL NOT call `npx skills update` for any skill. Reconciliation is additive/removal only.

#### Scenario: Sync does not update git skills
- **WHEN** an existing git skill is installed and enabled in the profile
- **THEN** `mfz skills sync` reports the skill as "kept" and does not run `npx skills update`

### Requirement: Dry-run preview
`mfz skills sync --dry-run` SHALL print the planned add/remove operations without executing them.

#### Scenario: Dry-run shows planned operations
- **WHEN** `mfz skills sync --dry-run` is invoked
- **THEN** the output shows which skills would be added and removed per target, but no `npx skills` commands are executed

### Requirement: Per-target reconciliation
`mfz skills sync` SHALL reconcile skills separately per agent target (opencode, claude-code) based on each skill's resolved target list.

#### Scenario: Skill removed from one target stays on another
- **WHEN** a skill is installed for both opencode and claude-code, and the profile enables it only for opencode
- **THEN** `mfz skills sync` removes the skill from claude-code but keeps it installed for opencode
