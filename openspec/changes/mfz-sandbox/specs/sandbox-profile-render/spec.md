## ADDED Requirements

### Requirement: Sandbox consumes the rendered profile config layer

The sandbox SHALL consume the rendered `configs/<profile>/` output for the active
profile as the source for a sandbox runtime config layer. Path-sensitive files such as
agent instructions, markdown indexes, opencode config, and Claude config SHALL be
rendered or copied into that runtime layer with container-native paths before being
mounted read-only. The sandbox SHALL NOT carry a separate, disposable copy of shell,
mise, or agent config.

#### Scenario: Rendered config is used in the container

- **WHEN** the sandbox launches for the active profile
- **THEN** the container uses a runtime config layer generated from the rendered
  `configs/<profile>/` dotfiles, opencode config, and claude config

#### Scenario: Apply changes appear without rebuild

- **WHEN** the operator runs `mfz apply` to change rendered profile config and then
  launches the sandbox
- **THEN** the container reflects the changed config without an image rebuild

### Requirement: Explicit read-only config vs writable state mapping

The sandbox SHALL map rendered configuration into the container as read-only individual
config files or directories, while agent state, data, auth, and cache locations SHALL
be writable and SHALL NOT be overlaid by read-only config mounts. For Claude Code, the
sandbox SHALL mount the managed `settings.json` snapshot (not the merged machine-local
`~/.claude/settings.json`), so machine-local Bedrock/AWS and other host secrets are
excluded from the container by construction. The specific mapping SHALL be:

- Read-only config: sandbox-rendered `CLAUDE.md`, the managed Claude `settings.json`
  snapshot rewritten for container paths, the sandbox Claude MCP snapshot,
  sandbox-rendered `opencode.jsonc`, opencode commands and plugins, `.zshrc`,
  `.p10k.zsh`, mise config, the composed git config, the generated markdown indexes,
  and the references directory.
- Writable state seeded with sanitized defaults: Claude local state and `.claude.json`,
  opencode data/state/auth.
- Read-write: the project workspace.

#### Scenario: Managed snapshot is used, not the merged host settings

- **WHEN** the sandbox mounts Claude configuration
- **THEN** it mounts the managed `configs/<profile>/claude/settings.json` snapshot and
  not the merged machine-local `~/.claude/settings.json`, so no host Bedrock/AWS secret
  is present

#### Scenario: State directories remain writable

- **WHEN** an agent writes to its state, data, auth, or cache location inside the
  container
- **THEN** the write succeeds because those locations are writable and are not overlaid
  by a read-only config mount

#### Scenario: Config files are read-only

- **WHEN** an agent attempts to write to a mounted rendered config file
- **THEN** the write fails because the config mount is read-only

### Requirement: References directory is mounted read-only

The sandbox SHALL mount the configured references directory (`MFZ_REFERENCES_DIR`) as a
single read-only bind mount at `/references` and SHALL render the generated reference
index with `/references/<name>` paths so the agent has the same reference repositories
and a container-valid reference index available without copying clone contents.

#### Scenario: References are available read-only

- **WHEN** the sandbox launches with a configured references directory
- **THEN** the container can read the reference repositories and the agent cannot write
  to them

#### Scenario: Reference index uses container paths

- **WHEN** the sandbox renders the reference index for the container
- **THEN** each reference path points under `/references` rather than the host reference
  directory

### Requirement: Extra folders are translated into container paths

The sandbox SHALL mount readable machine-local extra folders under deterministic
container paths beneath `/extra/` and SHALL render the generated extra-folder index with
those container paths. Edit permissions SHALL determine whether each extra-folder mount
is read-only or read-write.

#### Scenario: Extra folder index uses mounted paths

- **WHEN** a machine-local extra folder is mounted into the sandbox
- **THEN** the container's extra-folder index lists the `/extra/<slug>` path and the
  effective read/edit permissions

### Requirement: Sandbox is the active profile run through the boundary, not a separate profile

The sandbox SHALL run the active profile (the same one resolved for host apply) through
the security boundary, and SHALL NOT require a separate sandbox-specific profile. No
parallel `sandbox-<profile>` manifests SHALL be needed to run the sandbox.

#### Scenario: Same profile renders host and sandbox

- **WHEN** the active profile is resolved
- **THEN** the same resolved profile drives both the host apply and the sandbox launch

#### Scenario: No parallel sandbox profile required

- **WHEN** the operator launches the sandbox
- **THEN** mindframe-z does not require a `sandbox-<profile>` manifest distinct from the
  active profile
