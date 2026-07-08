## Purpose

Define machine initialization, home scaffolding, the curl installer, and the engine's node runtime guarantee.

## Requirements

### Requirement: mfz init machine bootstrap
The engine SHALL provide an `mfz init` command that creates `~/.mindframe-z/config.yml` and resolves the active home one of three ways: clone an existing home from a git URL (default destination `~/.mindframe-z/homes/<name>/`, custom path allowed), create a new home by scaffolding at a chosen path (including `git init` and an initial commit), or point at an existing local directory. The chosen home root SHALL be recorded as `home_path` in machine config.

#### Scenario: Cloning an existing home
- **WHEN** `mfz init` is given a git URL and the user accepts the default destination
- **THEN** the home is cloned under `~/.mindframe-z/homes/` and machine config records its path as `home_path`

#### Scenario: Creating a new home at a custom path
- **WHEN** the user chooses to create a new home at `~/code/my-home`
- **THEN** a scaffolded home is created there, committed, and recorded as `home_path`

#### Scenario: Pointing at an existing directory
- **WHEN** the user points init at a directory already containing `mfz_home.yml`
- **THEN** machine config records that path without modifying the home

### Requirement: Scaffolded home contents
A scaffolded home SHALL be minimal but valid — it renders successfully on first `mfz apply`. It SHALL contain: `mfz_home.yml` (no `extends` unless provided), empty `catalog/references.yml`, `catalog/skills.yml`, and `catalog/mcp.yml`, an `instructions/AGENTS.md` stub, a starter `profiles/base/profile.yml` with an `agents` list chosen at init, a `.gitignore`, the slim `mindframe-z` guidance skill under `skills/mindframe-z/` with its catalog entry enabled in the starter profile, and a one-paragraph README linking to the engine's agent setup doc. Scaffolded YAML files SHALL begin with `# yaml-language-server: $schema=<url>` modelines pointing at published engine schemas. The scaffold SHALL NOT create empty `opencode/` or `sandbox/` directories.

#### Scenario: Fresh scaffold applies cleanly
- **WHEN** a scaffolded home is activated and `mfz apply` runs
- **THEN** apply succeeds with no validation errors

#### Scenario: Schema modelines present
- **WHEN** a home is scaffolded
- **THEN** `mfz_home.yml`, catalog files, and the starter profile each start with a `yaml-language-server` schema modeline

### Requirement: Curl installer bootstrap
The engine SHALL ship an install script (fetched via curl from the engine repository) that: installs mise or self-updates an existing mise to latest; ensures node is available via mise (installing a default `node@24` when absent); downloads the engine release tarball from GitHub Releases into `~/.mindframe-z/engine/`; writes an `mfz` launcher into `~/.mindframe-z/bin/`; and ensures `~/.mindframe-z/bin` is on `PATH`, appending to the shell rc when missing. Re-running the script SHALL upgrade the engine in place.

#### Scenario: Fresh machine bootstrap
- **WHEN** the install script runs on a machine with no mise, node, or engine
- **THEN** mise is installed, node is installed via mise, the engine lands in `~/.mindframe-z/engine/`, and `mfz` resolves on `PATH` in a new shell

#### Scenario: Existing mise is updated
- **WHEN** the install script runs on a machine that already has mise
- **THEN** the script invokes mise self-update instead of reinstalling

#### Scenario: Re-run upgrades
- **WHEN** the install script runs on a machine with an older engine install
- **THEN** the engine tarball is replaced with the latest release and the launcher keeps working

### Requirement: Node guaranteed in rendered mise config
When the resolved profile's mise configuration declares no node tool, the mise renderer SHALL inject a default node entry (`node@24`) so applying configuration can never remove the engine's own runtime. A profile-declared node version SHALL win over the injected default.

#### Scenario: Profile without node
- **WHEN** the resolved mise tools contain no `node` entry
- **THEN** the rendered mise config contains `node = "24"`

#### Scenario: Profile pins node
- **WHEN** a profile declares `node = "22"`
- **THEN** the rendered mise config contains the profile's version and no injected default

### Requirement: Engine outside managed tooling
The engine SHALL NOT be declared as a mise-managed tool in rendered configuration, and installation SHALL NOT require npm registry access. The engine install location SHALL be independent of any node version prefix so node version switches cannot orphan the engine.

#### Scenario: Node version switch
- **WHEN** the active node version changes via mise
- **THEN** `mfz` continues to resolve from `~/.mindframe-z/bin/` and run
