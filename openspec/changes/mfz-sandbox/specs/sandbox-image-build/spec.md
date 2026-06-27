## ADDED Requirements

### Requirement: Single Dockerfile with dynamically composed artifact

mindframe-z SHALL build the sandbox agent image from a single repository-maintained
Dockerfile whose built artifact is composed from resolved render output for the active
machine. The profile's resolved `mise.toml` tool list and active agent set SHALL be
fed as build inputs so the declared tools and agents are baked into the image. There
SHALL be no per-profile Dockerfile variants.

#### Scenario: Tools come from resolved render

- **WHEN** the active profile's resolved `mise.toml` declares a tool and the image is
  built
- **THEN** that tool is installed in the built image without editing the Dockerfile

#### Scenario: Single Dockerfile across profiles

- **WHEN** the image is built for different active profiles on different machines
- **THEN** the same Dockerfile produces each artifact, differing only by the resolved
  build inputs

### Requirement: Build hash determines staleness and triggers rebuild

mindframe-z SHALL compute a build hash over the full image build inputs — the
Dockerfile, the generated build context (including baked runtime helper scripts and any
placeholder auth/config files), the resolved `mise.toml`, the active agent set, and any
pinned agent installer versions — and SHALL associate it with the built image. A `mfz
sandbox` launch SHALL rebuild when the current build hash does not match the built
image, and SHALL otherwise launch the existing warm image. A force-rebuild option SHALL
be available.

#### Scenario: Tool change triggers rebuild

- **WHEN** the resolved `mise.toml` changes and the operator runs `mfz sandbox`
- **THEN** the build hash differs from the built image and mindframe-z rebuilds before
  launching

#### Scenario: Config-only change does not rebuild

- **WHEN** only mounted rendered config changes and the operator runs `mfz sandbox`
- **THEN** the build hash is unchanged and mindframe-z launches without rebuilding

#### Scenario: Forced rebuild

- **WHEN** the operator requests a forced rebuild
- **THEN** mindframe-z rebuilds the image even when the build hash matches
