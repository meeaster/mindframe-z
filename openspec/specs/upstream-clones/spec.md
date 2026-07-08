## Purpose

Define managed upstream home clones, update behavior, agent access, cross-home sync targets, and doctor checks.

## Requirements

### Requirement: Managed upstream clones
The engine SHALL clone each declared upstream home to `~/.mindframe-z/homes/<alias>/` as a full git working copy. Resolution SHALL read the clone's working tree as-is, including uncommitted changes.

#### Scenario: First resolution clones the upstream
- **WHEN** `mfz apply` runs and the declared upstream has no clone at `~/.mindframe-z/homes/<alias>/`
- **THEN** the engine clones the upstream repository to that path before resolving

#### Scenario: Working tree is authoritative
- **WHEN** the upstream clone contains uncommitted edits
- **THEN** rendering uses the edited working-tree content

### Requirement: Upstream update on apply
At the start of `mfz apply`, the engine SHALL update each upstream clone with `git pull --ff-only` when the working tree is clean and the pull is fast-forwardable. When the clone is dirty, ahead of its remote, or not fast-forwardable, the engine SHALL skip the update and warn, never discarding local state. When the remote is unreachable and a clone exists, the engine SHALL render from the existing clone with a staleness warning; when no clone exists, apply SHALL fail.

#### Scenario: Clean clone updates
- **WHEN** apply runs and the upstream clone is clean and behind its remote
- **THEN** the clone is fast-forwarded before resolution

#### Scenario: Dirty clone is preserved
- **WHEN** apply runs and the upstream clone has uncommitted changes
- **THEN** the update is skipped, a warning names the clone, and rendering proceeds from the working tree

#### Scenario: Offline with existing clone
- **WHEN** apply runs and the upstream remote is unreachable but a clone exists
- **THEN** rendering proceeds from the stale clone with a warning

#### Scenario: Offline without clone
- **WHEN** apply runs, an upstream is declared, no clone exists, and the remote is unreachable
- **THEN** apply fails with an error naming the upstream

### Requirement: Agent access to upstream clones
Applied configuration SHALL expose each upstream clone to agents as an extra folder with read and edit access, so agents can modify, commit, and push upstream home content from the downstream machine.

#### Scenario: Upstream clone in agent permissions
- **WHEN** apply renders agent configuration for a home with an upstream
- **THEN** `~/.mindframe-z/homes/<alias>/` appears in the rendered extra-folder permissions and index with read and edit allowed

### Requirement: Cross-home sync targets
`mfz sync` SHALL offer profiles in upstream clones as assignment targets when the clone's remote is pushable, writing assigned keys into the clone's working tree and reporting that the change is uncommitted. Upstream homes whose remote cannot be pushed to SHALL NOT be offered as sync targets.

#### Scenario: Assigning a key to an upstream profile
- **WHEN** sync finds an unmanaged key and the user assigns it to `personal/base`
- **THEN** the key is written to `profiles/base/profile.yml` inside `~/.mindframe-z/homes/personal/` and sync reports the write as uncommitted

#### Scenario: Read-only upstream
- **WHEN** sync runs and `git push --dry-run` fails for an upstream clone
- **THEN** that home's profiles are not offered as assignment targets

### Requirement: Doctor checks for upstream clones
`mfz doctor` SHALL report upstream clones that are dirty, have unpushed commits, or are stale relative to their remote.

#### Scenario: Unpushed sync write
- **WHEN** a sync-assigned change was committed or left uncommitted in an upstream clone without being pushed
- **THEN** doctor flags the clone as dirty or ahead of its remote
