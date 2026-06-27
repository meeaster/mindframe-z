## Why

The sandbox boundary (Agent Vault credential brokering, MITM egress, placeholder
creds, Bedrock signing, MCP egress shims) was proven in a standalone repo and its
capabilities now live in `openspec/specs/` and the `sandbox/` directory. Today it
runs through hand-written shell scripts with hardcoded host paths and disposable,
committed shell/mise/agent config that duplicates what mindframe-z already renders
per profile. This change folds the sandbox into mindframe-z as a first-class `mfz
sandbox` capability so an ephemeral, credential-brokered agent container is just
the resolved profile run through a security boundary — the same "who you are"
artifacts mindframe-z already renders, consumed a second way.

## What Changes

- Add `mfz sandbox [shell|cc|oc]` plus top-level `mfz cc` / `mfz oc` shortcuts that
  launch agents inside the sandbox, with `mfzcc` / `mfzoc` shell aliases rendered by
  the apply pipeline.
- Generate the container runtime (compose services + `docker run` args) from the
  resolved profile and machine config instead of committed shell scripts with
  hardcoded paths, so a future shareable-core / private-profile repo split stays cheap.
- Replace the disposable committed sandbox dotfiles/mise/agent config with the
  **mounted** rendered `configs/<profile>/{dotfiles,opencode,claude}`, so `mfz apply`
  changes appear in the sandbox with no rebuild.
- Build the agent image from a **single Dockerfile** whose artifact is composed
  dynamically per-machine from resolved render output (the profile's `mise.toml` tool
  list and agent set); a build hash drives auto-rebuild on stale images, otherwise a
  warm launch. Clone-and-run: the first `mfz sandbox` invocation auto-builds.
- Select the Claude credential broker leg from **machine config** (Bedrock vs Claude
  subscription), auto-detected from machine-local Claude settings where possible, so
  profiles stay byte-identical across work and personal computers. Add Claude
  subscription OAuth brokering (today only Bedrock + OpenAI are brokered).
- Orchestrate lifecycle: persistent broker services (Agent Vault, Bedrock signer via
  `compose up -d`) and persistent volumes, with an ephemeral `--rm` agent container.
- Add git config management to mindframe-z: render `~/.gitconfig` via the managed
  snapshot + machine-local merge pattern (same as Claude `settings.json`), with
  identity (`user.name`/`user.email`) sourced from `~/.mindframe-z/config.yml` and
  never committed; mount the rendered gitconfig and `~/.config/git/ignore` read-only
  into the sandbox so it has identical git setup. Git auth stays brokered via Agent
  Vault `GH_TOKEN`.

## Capabilities

### New Capabilities
- `sandbox-cli`: the `mfz sandbox` command surface (`shell`/`cc`/`oc`), top-level
  shortcuts, rendered shell aliases, clone-and-run auto-build trigger, and lifecycle
  orchestration of persistent services plus ephemeral agent container.
- `sandbox-image-build`: single-Dockerfile image whose built artifact is composed
  dynamically per-machine from resolved render output, with a build hash that
  determines staleness and triggers auto-rebuild.
- `sandbox-profile-render`: the sandbox consumes the rendered `configs/<profile>/`
  config layer (dotfiles, opencode, claude) by mount, making the container's
  environment a function of the same profile resolution the host uses.
- `git-config`: mindframe-z renders `~/.gitconfig` from machine-local identity using
  the managed-snapshot + machine-local-merge pattern, keeping identity out of the repo.

### Modified Capabilities
- `sandbox-runtime`: launch behavior, mounts, and credential boundary are generated
  from resolved profile + machine config (no hardcoded host paths); mounts now include
  the rendered config layer, references directory, and rendered gitconfig.
- `credential-broker`: broker leg selection (Bedrock vs subscription) is driven by
  machine config, and Claude subscription OAuth is brokered in addition to OpenAI.
- `bedrock-signing-proxy`: the signer runs only when machine config selects the Bedrock
  credential mode, and its lifecycle is managed by `mfz sandbox`.

## Impact

- New CLI surface in `src/cli/mfz.ts`; new sandbox orchestration module under `src/`.
- New renderer for git config (managed snapshot + machine-local merge) joining the
  existing opencode/claude/mise/dotfiles renderers.
- Machine config schema (`src/core/manifests.ts`, `schemas/machine.schema.json`,
  `machine-config.example.yml`) gains git identity and sandbox credential-mode fields.
- `sandbox/` Dockerfile, `compose.yaml`, and launch scripts are refactored to be
  profile/path-driven and generated rather than hardcoded.
- Affects apply flow (`src/core/`), dotfiles/zsh alias rendering, and the existing
  sandbox-related specs noted above.
