# Architecture

mindframe-z is a content-free engine that renders AI coding tool configuration from a machine-selected home repository.

## Concepts

- **Engine**: this repository. It contains the CLI, schemas, renderers, sync logic, sandbox/thread helpers, installer, and release packaging.
- **Home**: a separate git repository containing user/team content: catalogs, profiles, instructions, local skills, OpenCode plugins/commands/agents, and optional sandbox overlays.
- **Active home**: exactly one home selected per machine through `~/.mindframe-z/config.yml#home_path`, `MFZ_ROOT`, or `--root`.
- **Upstream home**: one optional parent declared by `mfz_home.yml#extends`. The downstream assigns the alias.
- **Qualified reference**: `<alias>/<name>` or a transitive path such as `personal/common/base`.

## Home Layout

```text
<home>/
├── mfz_home.yml
├── catalog/
│   ├── references.yml
│   ├── skills.yml
│   └── mcp.yml
├── instructions/
├── profiles/<name>/
├── skills/<local-name>/
├── skills/vendor/<name>/
├── skills/vendor.lock.yml
├── opencode/
└── sandbox/
```

The layout is not configurable. Missing optional content directories are allowed.

## Resolution

1. Resolve machine paths: `--root` > `MFZ_ROOT` > machine `home_path` > cwd.
2. Require `mfz_home.yml` in the active home.
3. Load local catalogs and profiles from `catalog/` and `profiles/`.
4. If `mfz_home.yml#extends` is present, resolve the upstream clone and recursively load it.
5. Resolve the requested profile: `--profile` > `MFZ_PROFILE` > machine profile > `personal`.
6. Apply existing profile merge semantics across home boundaries.

Unqualified names resolve only in the current home. If an unqualified name exists only upstream, resolution fails with a qualified suggestion. Qualified names resolve only through the declared alias path. Duplicate definitions across homes are legal at rest, but two active entries with the same terminal name for one resolved profile fail before rendering.

## Machine-Local Root

`~/.mindframe-z/` is the single machine-local root:

```text
~/.mindframe-z/config.yml
~/.mindframe-z/configs/<profile>/
~/.executor/ (Executor-owned native default, unless EXECUTOR_DATA_DIR is set)
~/.mindframe-z/references/
~/.mindframe-z/homes/<alias>/
~/.mindframe-z/overrides.json
~/.mindframe-z/threads/
~/.mindframe-z/cache/skills/
~/.mindframe-z/skill-candidates/
~/.mindframe-z/bin/
```

Rendered output goes to `~/.mindframe-z/configs/<profile>/`, not into homes. Skill source is copied into `configs/<profile>/skills/` and harness links point only at that snapshot. Vendored candidates and bare Git caches are machine-local quarantine state and never active.

Executor-routed MCP entries use Executor's one native default runtime and store, normally `$HOME/.executor` or the user-selected `EXECUTOR_DATA_DIR`. MFZ never sets `EXECUTOR_DATA_DIR` or `EXECUTOR_SCOPE_DIR`, derives profile runtime data, starts a profile daemon, or passes `--scope`. Each profile may retain `configs/<profile>/executor/desired.json` and `managed.json` as non-secret inspectable desired/ownership snapshots; those snapshots do not become Executor scope input. MFZ owns integration inventory and connection-safe endpoint changes; Executor owns authentication methods, credentials, and connections. `mfz apply` reconciles the shared live state before committing harness cutover, and `--dry-run` never starts Executor or writes runtime state.

Executor authentication has three ownership layers: the catalog may declare an integration's non-secret `authentication` methods, the profile selects exact named connections and method slugs, and Executor stores the resulting authentication templates and credentials. The explicit `mfz executor connect <integration> --connection <name>` command creates or repairs one connection only. Omitted connections resolve to `main` only when one method is unambiguous. Apply configures method structure but never opens OAuth or accepts a secret. A `none` method may create its selected named connection automatically; OAuth and API-key methods require connect before a direct-to-Executor cutover. Existing connection identities, OAuth clients, scopes, and refresh state are preserved independently. Removing or changing a method referenced by durable state blocks until the user disconnects that exact connection explicitly.

Normal MCP OAuth discovers metadata from the integration endpoint and derives registration scopes from that discovery. Assisted OAuth is an explicit catalog exception: `discoveryUrl` points at a separate metadata endpoint, `registrationScopes` are used only for dynamic client registration, and the catalog endpoint remains the protected resource. The daemon's current callback and Executor's effective returned client slug are used at runtime; generated clients and credentials never enter home source. API-key setup opens Executor's browser handoff so the value is entered there, not passed through MFZ, argv, logs, or rendered snapshots.

## Renderers

Renderers live in `src/renderers/` and consume a `ResolvedProfile`:

- `opencode`: `opencode.jsonc`, optional runtime `package.json`, `tui.json`, server and TUI plugins, commands, agents, permissions.
- `claude-code`: `CLAUDE.md`, settings snapshot, MCP snapshot, permissions.
- `codex`: `config.toml`, `AGENTS.md`, MCP/permission/plugin tables.
- `pi`: `settings.json`, `AGENTS.md`, and optional `extensions/subagent/config.json` snapshots; merges managed user files under `~/.pi/agent/` while preserving unrelated keys.
- `mise`: `config.toml`; injects `node = "24"` when no resolved node tool exists.
- `dotfiles`: profile dotfiles; managed `.zshrc` guarantees `~/.mindframe-z/bin` on `PATH`.
- `skills`: `src/skills/snapshot.ts` builds the complete profile skill snapshot and reconciles only owned universal and Claude skill links.

MCP profile entries are either direct (`agents: [opencode, claude-code, codex]` or grouped `enabled`/`disabled` arrays, with optional `route: direct`) or shared (`route: executor`). Omitting `route` defaults to direct. Direct entries retain per-harness behavior; OpenCode and Codex can retain a native disabled state, while Claude Code rejects a configured-but-disabled state. Executor entries are always-configured shared inventory visible through one local `executor mcp --elicitation-mode browser` bridge per selected supported harness and are not project-toggleable per agent. Browser OAuth is parallel authorization, never credential import; existing direct configuration remains installed until Executor connection metadata succeeds.

### MCP Authoring And Migration

The direct authoring model replaces boolean agent maps:

```yaml
mcp:
  fff:
    agents: [opencode, claude-code, codex]
  exa:
    agents:
      enabled: [claude-code]
      disabled: [opencode, codex]
  context7:
    route: executor
```

An old direct map with every value `true` becomes a concise list. A map with `false` values becomes grouped state. Do not place `claude-code` in `disabled`; omit that harness or enable it instead. Executor-routed integrations remain configured in the shared inventory for every connected supported harness, so changing one harness's visibility is a profile route change rather than a project override.

Renderer source files for inherited OpenCode plugins, commands, agents, and local skills come from the source home recorded during profile resolution.

## Sync

`mfz sync` reads managed snapshots from `~/.mindframe-z/configs/<profile>/` and promotes unmanaged keys back into profiles or `mise.toml`. It no longer imports external skill lock state or promotes unmanaged installed skills. `mfz skills sync` runs only the skill snapshot and owned-link reconciliation path. When an upstream clone is pushable (`git push --dry-run` succeeds), its profiles are offered as qualified targets such as `personal/base`. Writes to upstream clones are reported as uncommitted.

Generated Executor snapshots and bridge entries are derived output and are not adopted by `mfz sync`. OAuth-backed Executor integrations and named connections are not removed automatically; apply blocks with a metadata-only remediation message naming the exact connection until the user disconnects it explicitly.

## Vendored Skills

Catalog entries use `source: local` or `source: vendored`. A vendored entry records an HTTPS repository, mutable tracked ref, and explicit upstream subtree. Its selected files live under `skills/vendor/<name>/`, while `skills/vendor.lock.yml` records the full commit and independent framed SHA-256 digest. Symlinks, gitlinks, special files, submodules, LFS objects, hooks, dependencies, and candidate execution are outside the model.

`mfz skills check` fetches only into a bare machine-local cache and reports selected-subtree changes. `mfz skills stage` extracts an exact revision into quarantine with provenance, inventory, findings, digest, and diff. The user-invoked engine review skill treats candidate text as hostile evidence and never executes it. `mfz skills promote` revalidates the candidate, asks for explicit human confirmation, and atomically updates home source plus lock without applying. A later `mfz apply` activates the committed source.

## Upstream Clones

Non-local upstream repos are cloned to `~/.mindframe-z/homes/<alias>/`.

- First resolve clones the repo.
- Clean clones are updated with `git pull --ff-only`.
- Dirty or ahead clones warn and are not clobbered.
- Existing stale/offline clones are used with a warning.
- Missing offline clones fail.

Applied agent configs expose upstream clones as editable extra folders so agents can patch and commit upstream home content.

## Bootstrap And Distribution

`mfz init` writes machine config and supports:

- `--create <path>`: scaffold a minimal valid home, initialize git, and record `home_path`.
- `--clone <repo>`: clone an existing home under `~/.mindframe-z/homes/<name>/` and record it.
- `--point <path>`: record an existing local home.

`mfz guide` prints version-local home conventions. Scaffolded homes include a slim `mindframe-z` skill that tells agents to run `mfz guide`.

The installer downloads a self-contained `bun --compile` binary for the host platform to `~/.mindframe-z/bin/mfz`. The per-platform binaries are built by `pnpm release`.

## Schemas

Zod schemas live in `src/core/manifests.ts`. `pnpm schemas` writes committed JSON Schema files:

- `schemas/mfz_home.schema.json`
- `schemas/references.schema.json`
- `schemas/skills.schema.json`
- `schemas/mcp.schema.json`
- `schemas/profile.schema.json`
- `schemas/machine.schema.json`
- `schemas/skills-vendor-lock.schema.json`

Scaffolded YAML files use first-line YAML language server modelines pointing at published schema URLs.

## Threads And Sandbox

Threads are machine-local orchestration state under `~/.mindframe-z/threads/` with per-destination git working copies. They resolve profile and machine config at runtime but are separate from rendering.

Sandbox code remains engine-owned. Home-specific sandbox overlays belong in homes; engine sandbox files provide the shared image, broker, and runtime scaffolding.

Sandbox remains a separate credential boundary. Profiles containing Executor-routed MCP entries are rejected by sandbox startup until a future design defines safe host-Executor access.

Existing profile-scoped MFZ Executor directories are legacy state, not an input to the native store. MFZ does not migrate, merge, delete, or authorize that state automatically. An operator who needs it must stop relevant Executor processes, back up and inspect the old `~/.mindframe-z/executor/<profile>/data/` directory, then use an explicitly approved Executor-supported or manual migration/cleanup procedure; only after that deliberate review may the legacy directory be removed.

## Description Convention

Reference catalog entries and machine `extra_folders` descriptions are rendered into agent-visible indexes. Descriptions must be LLM-actionable: lead with stack/purpose, name useful entrypoints or packages, and keep them short.

Example reference description:

```text
TypeScript/Bun monorepo for the open-source AI coding agent. Main CLI entrypoint at packages/opencode/src/index.ts. Supports MCP, custom tools, file editing, and agentic workflows
```

Example extra folder description:

```text
CI build artifacts — needed for inspecting test failures
```

## Environment Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `MFZ_ROOT` | Active home root override | machine `home_path`, then cwd |
| `MFZ_HOME` | Machine home directory | `$HOME` |
| `MFZ_PROFILE` | Active profile name | machine profile or `personal` |
| `MFZ_REFERENCES_DIR` | Reference clone directory | `~/.mindframe-z/references` |
| `EXECUTOR_DATA_DIR` | Executor-owned native data-directory override | `~/.executor` |
| `OPENCODE_CONFIG_DIR` | OpenCode global config dir | `~/.config/opencode` |
| `CLAUDE_CONFIG_DIR` | Claude config dir | `~/.claude` |
| `CODEX_HOME` | Codex home/config dir | `~/.codex` |
| `PI_CODING_AGENT_DIR` | Pi user agent config dir | `~/.pi/agent` |
| `MISE_CONFIG_DIR` | mise config dir | `~/.config/mise` |
