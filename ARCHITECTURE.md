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
4. If `mfz_home.yml#extends` is present, resolve its configured upstream checkout and recursively load it.
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
~/.mindframe-z/homes/<name>/       # `mfz init --clone` bootstrap only
~/.mindframe-z/overrides.json
~/.mindframe-z/work/v1/
~/.mindframe-z/cache/skills/
~/.mindframe-z/skill-candidates/
```

Rendered output goes to `~/.mindframe-z/configs/<profile>/`, not into homes. Skill source is copied into `configs/<profile>/skills/` and harness links point only at that snapshot. Vendored candidates and bare Git caches are machine-local quarantine state and never active.

Executor-enabled MCP entries use Executor's one native default runtime and store, normally `$HOME/.executor` or the user-selected `EXECUTOR_DATA_DIR`. MFZ never sets `EXECUTOR_DATA_DIR` or `EXECUTOR_SCOPE_DIR`, derives profile runtime data, starts a profile daemon, or passes `--scope`. Each profile may retain `configs/<profile>/executor/desired.json` and `managed.json` as non-secret inspectable desired/ownership snapshots; those snapshots do not become Executor scope input. MFZ owns integration inventory and connection-safe endpoint changes; Executor owns authentication methods, credentials, and connections. `mfz apply` reconciles the shared live state before committing harness changes, and `--dry-run` never starts Executor or writes runtime state.

Executor authentication has three ownership layers: the catalog may declare an integration's non-secret `authentication` methods, the profile selects exact named connections and method slugs, and Executor stores the resulting authentication templates and credentials. Omitted connections resolve to `main` only when one method is unambiguous. Apply configures method structure but never opens OAuth, accepts a secret, or creates credentialed connections. A `none` method may create its selected named connection automatically; OAuth and API-key connections must be added in the Executor app with the exact profile connection name before a direct-to-Executor cutover. Apply reconciles all declared integrations before reporting every missing credentialed connection together. Existing connection identities, OAuth clients, scopes, and refresh state are preserved independently. Removing or changing a method referenced by durable state blocks until the user disconnects that exact connection explicitly.

Normal MCP OAuth discovers metadata from the integration endpoint. Assisted OAuth is an explicit catalog exception: `discoveryUrl` points at a separate metadata endpoint, `registrationScopes` constrain registration, and the catalog endpoint remains the protected resource. OAuth authorization and API-key entry happen entirely in the Executor app; generated clients and credentials never pass through MFZ or enter home source, argv, logs, or rendered snapshots.

## Renderers

Renderers live in `src/renderers/` and consume a `ResolvedProfile`:

- `opencode`: `opencode.jsonc`, optional runtime `package.json`, `tui.json`, server and TUI plugins, commands, agents, permissions.
- `claude-code`: `CLAUDE.md`, settings snapshot, MCP snapshot, permissions.
- `codex`: `config.toml`, `AGENTS.md`, MCP/permission/plugin tables.
- `pi`: `settings.json`, `AGENTS.md`, and optional `extensions/subagent/config.json` snapshots; merges managed user files under `~/.pi/agent/` while preserving unrelated keys.
- `mise`: `config.toml`; renders tools, environment, aliases, settings, and bootstrap configuration, and injects `node = "24"` when no resolved node tool exists.
- `dotfiles`: profile dotfiles; managed shell files guarantee `~/.local/bin` is on `PATH`.
- `skills`: `src/skills/snapshot.ts` builds the complete profile skill snapshot and reconciles only owned universal and Claude skill links.

MCP profile entries independently declare native `agents` (`[opencode, claude-code, codex]` or grouped `enabled`/`disabled` arrays) and an optional `executor: { enabled: true, connections: ... }` selection. An entry may declare either capability or both. Direct entries retain per-harness behavior; OpenCode and Codex can retain a native disabled state, while Claude Code rejects a configured-but-disabled state. Executor entries are shared inventory visible through one local `executor mcp --elicitation-mode browser` bridge when profile-level `executor.bridge` is enabled, and are not project-toggleable per agent. Browser OAuth is parallel authorization, never credential import; direct and Executor configuration can be applied together.

### MCP Authoring And Migration

The independent MCP authoring model replaces route selection and boolean agent maps:

```yaml
mcp:
  fff:
    agents: [opencode, claude-code, codex]
  exa:
    agents:
      enabled: [claude-code]
      disabled: [opencode, codex]
  context7:
    executor:
      enabled: true
  sentry:
    agents: [opencode, claude-code, codex]
    executor:
      enabled: true
      connections:
        main: oauth
```

An old direct map with every value `true` becomes a concise list. A map with `false` values becomes grouped state. Do not place `claude-code` in `disabled`; omit that harness or enable it instead. Executor-enabled integrations remain configured in the shared inventory for every connected supported harness, so changing one harness's visibility affects only the `agents` selection and never the shared Executor inventory.

Renderer source files for inherited OpenCode plugins, commands, agents, and local skills come from the source home recorded during profile resolution. OpenCode commands may use a flat `opencode/commands/<name>.md` source or a packaged `opencode/commands/<name>/COMMAND.md` source; only `COMMAND.md` is rendered, leaving package-local development metadata out of runtime context.

## Sync

`mfz sync` reads managed snapshots from `~/.mindframe-z/configs/<profile>/` and promotes unmanaged keys back into profiles or `mise.toml`. It no longer imports external skill lock state or promotes unmanaged installed skills. `mfz skills sync` runs only the skill snapshot and owned-link reconciliation path. When an upstream checkout is pushable (`git push --dry-run` succeeds), its profiles are offered as qualified targets such as `personal/base`. Writes to upstream checkouts are reported as uncommitted.

Generated Executor snapshots and bridge entries are derived output and are not adopted by `mfz sync`. OAuth-backed Executor integrations and named connections are not removed automatically; apply blocks with a metadata-only remediation message naming the exact connection until the user disconnects it explicitly.

## Vendored Skills

Catalog entries use `source: local` or `source: vendored`. A vendored entry records an HTTPS repository, mutable tracked ref, and explicit upstream subtree. Its selected files live under `skills/vendor/<name>/`, while `skills/vendor.lock.yml` records the full commit and independent framed SHA-256 digest. Symlinks, gitlinks, special files, submodules, LFS objects, hooks, dependencies, and candidate execution are outside the model.

`mfz skills check` fetches only into a bare machine-local cache and reports selected-subtree changes. `mfz skills stage` extracts an exact revision into quarantine with provenance, inventory, findings, digest, and diff. The user-invoked engine review skill treats candidate text as hostile evidence and never executes it. `mfz skills promote` revalidates the candidate, asks for explicit human confirmation, and atomically updates home source plus lock without applying. A later `mfz apply` activates the committed source.

## Upstream Checkouts

`mfz_home.yml#extends.path` is required whenever `extends` exists and is the
authoritative upstream home root. It must be absolute or begin with `~/`; cwd-relative
paths are rejected during manifest validation. `extends.repo` remains the Git clone
source and is used only when the configured path is absent.

- If the configured path is absent, MFZ creates its parent and clones `repo` there.
- A clean Git worktree at the configured path is updated with `git pull --ff-only`.
- Dirty or ahead Git worktrees warn and are not clobbered.
- Pull failures warn and continue using the existing checkout.
- Existing non-Git paths are loaded as local homes without Git operations or `repo` validation.

Applied agent configs expose only explicitly declared profile and machine extra folders. A home that wants agents to patch an active or upstream checkout must declare that path itself. The separate `mfz init --clone` bootstrap command continues to use `~/.mindframe-z/homes/<name>/`.

## Bootstrap And Distribution

`mfz init` writes machine config and supports:

- `--create <path>`: scaffold a minimal valid home, initialize git, and record `home_path`.
- `--clone <repo>`: clone an existing home under `~/.mindframe-z/homes/<name>/` and record it.
- `--point <path>`: record an existing local home.

`mfz guide` prints version-local home conventions. Scaffolded homes include a slim `mindframe-z` skill that tells agents to run `mfz guide`.

The installer downloads a self-contained `bun --compile` binary for the host platform to `~/.local/bin/mfz`. MFZ state remains under `~/.mindframe-z/`; the executable uses the conventional per-user binary directory so interactive shells and noninteractive services can resolve it consistently. The per-platform binaries are built by `pnpm release`.

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

Threads live only in configured store checkouts. Each store's configured `path` is its authoritative thread root and carries a deterministic `index.md` generated from its accepted thread manifests; direct mutations update that checkout and publication commits those same files. Thread slugs are globally unique across all active stores, and commands fail clearly when duplicate slugs are found. `thread sync` fast-forwards clean configured Git checkouts only and never copies thread content into machine-local state. A pull-request store uses its canonical checkout as a read source and publishes mutations from a disposable machine-local worktree and review branch; it never changes the canonical checkout's files, index, or branch. Pull-request stores may opt into GitHub auto-merge after PR creation; otherwise publication stops at PR creation for separate acceptance. Run, lock, sweep, and CLI-log state remain machine-local under `~/.mindframe-z/threads/`, while shared session archives remain under their session subsystem path. Threads resolve profile and machine config at runtime but are separate from rendering.

Work units keep durable content under the machine-configured `work.units_root`, defaulting to
`~/.mindframe-z/work/v1/units/`. Machine-local bindings and delivery state remain under
`~/.mindframe-z/work/v1/`. Each unit records Personal project or global scope and keeps
agent-authored orientation, context routing, and checkpoints in Markdown. Validation parses and
hashes those files into a structured manifest used by adapters; a changed orientation hash advances
its revision and makes attached delivery state stale. Validated checkpoint hashes reject changes or
removal while new files remain appendable. A derived checkpoint index supports structured reads and
is the manifest's filename-to-hash map; reads parse only matching Markdown. Checkpoint identity is
explicit frontmatter and is used as the filename by convention. Legacy JSONL records migrate to immutable Markdown
and are removed only after successful validation. A source-qualified session can be
bound to at most one unit. Mutable manifests and bindings use atomic replacement; context-delivery
historical receipts remain append-only durable telemetry.

`mfz work create` scaffolds stable authored paths. `instructions`, `status`, and `validate` support
direct file authoring, while the CLI retains bindings, phases, revision calculation, validation, and
structured adapter reads.
OpenCode server and TUI adapters remain home-owned plugin content: they call this CLI, fail open when
runtime state is unavailable, and share no private in-process state. The server contributes a bounded
reminder on each request, delivers orientation at lifecycle boundaries, and writes persisted
compaction summaries as exclusive checkpoint files before validation. The TUI shows compact status
and exact receipt details on demand. Optional MFZ
thread links remain passive historical pointers and are never refreshed by work-unit operations.

Sandbox code remains engine-owned. Home-specific sandbox overlays belong in homes; engine sandbox files provide the shared image, broker, and runtime scaffolding.

Sandbox remains a separate credential boundary. Profiles containing Executor-enabled MCP entries are rejected by sandbox startup until a future design defines safe host-Executor access.

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
