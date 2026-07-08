## ADDED Requirements

### Requirement: Home manifest file
A home SHALL be a git repository containing an `mfz_home.yml` manifest at its root. The manifest SHALL support an optional `description` string and an optional `extends` object `{ name: <alias>, repo: <git-url> }` declaring at most one upstream home. Homes SHALL NOT declare a self-identity name. The engine SHALL validate `mfz_home.yml` against its Zod schema when loading a home.

#### Scenario: Loading a valid home
- **WHEN** the engine loads a directory containing `mfz_home.yml`
- **THEN** the directory is treated as a home and its manifests are loaded relative to the home root

#### Scenario: Missing manifest
- **WHEN** the engine is pointed at a directory without `mfz_home.yml`
- **THEN** the engine fails with an error identifying the path and how to initialize a home

#### Scenario: Invalid extends declaration
- **WHEN** `mfz_home.yml` declares `extends` without both `name` and `repo`
- **THEN** validation fails with a schema error

### Requirement: Opinionated home layout
The engine SHALL resolve home content from fixed directories: `catalog/references.yml`, `catalog/skills.yml`, `catalog/mcp.yml` for the catalog; `instructions/` for instruction files; `profiles/<name>/` for profiles; `skills/` for local skill sources; `opencode/` for OpenCode plugins, commands, and agents; `sandbox/` for sandbox overlays (including `sandbox/agent-vault/`). The layout SHALL NOT be configurable.

#### Scenario: Catalog files resolve from catalog directory
- **WHEN** the engine loads a home's catalog
- **THEN** it reads `catalog/references.yml`, `catalog/skills.yml`, and `catalog/mcp.yml` from the home root

#### Scenario: Missing optional content directories
- **WHEN** a home has no `opencode/` or `sandbox/` directory
- **THEN** loading succeeds and the corresponding renderers treat the content as empty

### Requirement: Active home selection
A machine SHALL activate exactly one home. The active home root SHALL be resolved as `MFZ_ROOT` env > machine config `home_path` > current working directory. The machine config key SHALL be `home_path`; the previous `repo_path` key SHALL NOT be supported.

#### Scenario: Machine config selects the home
- **WHEN** `~/.mindframe-z/config.yml` sets `home_path` and `MFZ_ROOT` is unset
- **THEN** the engine loads the home at `home_path`

#### Scenario: Environment override
- **WHEN** `MFZ_ROOT` is set
- **THEN** the engine loads the home at `MFZ_ROOT` regardless of machine config

### Requirement: Rendered output is machine-local
The engine SHALL render profile output to `~/.mindframe-z/configs/<profile>/` and SHALL NOT write rendered output into the home repository. Symlink plans SHALL point global tool paths at the machine-local rendered files.

#### Scenario: Apply renders outside the home
- **WHEN** `mfz apply` runs for the active profile
- **THEN** rendered files are written under `~/.mindframe-z/configs/<profile>/` and no rendered files are created inside the home repository

#### Scenario: Symlinks target machine-local configs
- **WHEN** apply plans links for opencode, mise, or dotfiles targets
- **THEN** the link targets resolve under `~/.mindframe-z/configs/<profile>/`

### Requirement: Machine-local references default
The default references directory SHALL be `~/.mindframe-z/references/`. Machine config and `MFZ_REFERENCES_DIR` SHALL continue to override the default.

#### Scenario: Default references location
- **WHEN** no references override is configured
- **THEN** reference repositories are cloned under `~/.mindframe-z/references/`

### Requirement: Engine ships no content
The engine repository SHALL contain no profiles, catalogs, local skills, harness plugins, or personal sandbox overlays. All content SHALL live in homes.

#### Scenario: Fresh engine install
- **WHEN** the engine is installed on a machine with no home
- **THEN** no profile can be resolved and the engine directs the user to `mfz init`
