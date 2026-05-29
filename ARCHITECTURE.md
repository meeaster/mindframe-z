# Architecture

mindframe-z is a profile-aware AI tool configuration renderer. It manages global configuration for AI coding tools (OpenCode, Claude Code), tool versioning (mise), and dotfiles through layered YAML manifests, profile inheritance, and a bidirectional sync workflow.

## Core Principles

### Edit-First, Sync-Back

The CLI tools exist to orchestrate, not to gatekeep. AI agents should be able to edit rendered configuration files directly in `configs/<profile>/` — editing `opencode.jsonc`, `settings.json`, `mise/config.toml`, or any other rendered file — without being forced through a CLI wizard. The `sync` command then detects these unmanaged changes and promotes them back into the source profile YAMLs.

This is a core design choice: the natural workflow for an AI agent is to edit the config file it understands, then run `mfz sync` to persist the change upstream. The CLI does not try to intercept every modification.

```
edit configs/personal/opencode/opencode.jsonc  →  mfz sync  →  profiles/personal/profile.yml
```

### Profile Layering

Configuration is organized in three conceptual layers:

- **Catalog** (`shared/*.yml`) — what exists: available references, skills, and MCP servers.
- **Profile** (`profiles/*/profile.yml`) — what a context wants: which catalog items are enabled, plus tool-specific settings.
- **Machine** (`~/.mindframe-z/config.yml`) — what this computer actually enables: repo path, active profile, references directory, extra local folders, machine-specific overrides.

This separation prevents any single manifest from trying to encode every concern. The catalog is shared across all profiles; profiles select from it; the machine decides which profile is active.

### Agent-Gated Renderers

Each output target (opencode, claude-code, mise, dotfiles) has its own renderer in `src/renderers/`. Agent renderers (opencode and claude-code) are gated by the resolved profile's `agents` list, while infrastructure renderers (mise and dotfiles) always run by default. Renderers share the same resolved profile input but produce tool-specific output formats. New targets are added by writing a new renderer — no conditionals spread through the rest of the system.

### Manifests Are the Source of Truth

The YAML manifests in `shared/` and `profiles/` are the authoritative source of configuration state. Tool-level state — what `npx skills` has installed, what `~/.claude.json` contains, what mise has configured — is a _rendered output_, not the source of truth. The `sync` command bridges the gap by detecting drift between rendered output and manifests, but the manifests remain the canonical record.

Manifest schemas live in `src/core/manifests.ts` as Zod definitions. `mfz schemas` generates editor-facing JSON Schema files into `schemas/` from those same Zod definitions, so runtime validation and editor autocomplete share one source of truth.

## Architecture Overview

```
shared/refs.yml ──┐
shared/skills.yml ─┤
shared/mcp.yml ────┤
profiles/base/ ────┤    resolve     render       link
profiles/personal/─┼─► profile ──► renderers ──► configs/<profile>/ ──► ~/.config/opencode/
profiles/work/ ────┤              (opencode,     opencode/            ~/.claude/
machine config ────┤               claude,       claude/              ~/.config/mise/
                   │               mise,         mise/                ~/.*
                   │               dotfiles)     dotfiles/
```

## Data Flow

### Apply (profiles → tools)

1. **Load manifests** — parse `shared/refs.yml`, `shared/skills.yml`, `shared/mcp.yml`, all `profiles/*/profile.yml`, and `~/.mindframe-z/config.yml`.
2. **Resolve profile** — select profile via `--profile` > `MFZ_PROFILE` > machine config > default `personal`. The config root is selected via `--root` > `MFZ_ROOT` > machine `repo_path` > cwd. If the profile `extends` another, recursively merge (arrays are additive and deduplicated; maps are deep-merged with child overriding parent). MCP server definitions come from `shared/mcp.yml`; each profile decides which agents are active, and individual skill/MCP target lists default to those active agents when omitted.
3. **Render** — for each active agent and infrastructure target, the renderer produces files and link plans:
   - **opencode**: `opencode.jsonc` + plugin files + command files, linked to `~/.config/opencode/opencode.jsonc` and `~/.config/opencode/commands/`; folder permissions render to `permission.external_directory` and `permission.edit`
   - **claude-code**: `CLAUDE.md` linked to `~/.claude/`; `settings.json` rendered as a managed snapshot and merged into the machine-local `~/.claude/settings.json`; `mcp.json` rendered as a managed snapshot and merged into user-level `~/.claude.json#mcpServers`; folder permissions render to `permissions` and `additionalDirectories`
   - **mise**: `config.toml`, linked to `~/.config/mise/config.toml`
   - **dotfiles**: any files declared in the profile's `dotfiles` map, linked to `~/`; a managed `.zshrc` also sources local secret and machine-local customization files when they exist
4. **Write files** — rendered content is written to `configs/<profile>/`. `extra_folders` also writes the machine-local `~/.mindframe-z/extra_folders.md` index. If an agent is not in the profile's `agents` list, its rendered directory is not produced by a default apply.
5. **Write local merged files** — targets that preserve machine-local state write merged runtime files directly, without symlinks.
6. **Create symlinks** — global tool paths are symlinked to the rendered files, with backup-and-replace on conflict (after user confirmation).

Claude Code `settings.json` is intentionally not symlinked. The rendered `configs/<profile>/claude/settings.json` contains only profile-managed settings and generated machine-folder permissions. During apply, mindframe-z reads the existing machine-local `~/.claude/settings.json`, deep-merges managed settings on top, and writes the merged result back as a regular local file. This keeps machine- or employer-managed Bedrock/AWS/telemetry settings out of the repository while still letting profiles manage portable Claude preferences.

Claude MCP follows a similar snapshot-plus-merge model, but at user scope. The rendered `configs/<profile>/claude/mcp.json` contains only profile-managed Claude-targeted servers. During apply, mindframe-z merges that snapshot into the top-level `mcpServers` map in `~/.claude.json`, preserving unrelated user state such as project approvals, disabled server lists, and non-managed MCP entries.

Managed zsh config uses the existing dotfiles model with one convention: when profiles declare `.zshrc`, the dotfiles renderer wraps the profile content with guarded local includes. The rendered `~/.zshrc` sources `~/.mindframe-z/secrets/zsh.env` first for secrets and `~/.zshrc.local` last for non-secret machine overrides, ignoring both when absent. Agent renderers deny read and edit access to `~/.mindframe-z/secrets/**` so agents can safely edit managed zsh config without seeing secret values.

To migrate an existing `.zshrc`, move portable aliases, PATH setup, prompt selection, and shell framework configuration into `profiles/base/.zshrc` or a child profile `.zshrc`. Move secret exports such as API tokens to `~/.mindframe-z/secrets/zsh.env`, and move host-specific non-secret tweaks to `~/.zshrc.local`.

### Sync (tools → profiles)

1. **Read rendered configs** — parse `configs/<profile>/opencode/opencode.jsonc`, `claude/settings.json`, `mise/config.toml`. Claude sync reads the managed snapshot, not the machine-local merged settings file.
2. **Diff against profile** — identify keys present in the rendered config but not declared in the profile YAML (unmanaged keys).
3. **Prompt or assign** — for each unmanaged key, prompt the user to assign it to `base` or the current profile (or skip). Can be automated with `--profile`.
4. **Write back** — update the target `profile.yml` or `mise.toml` with the new key.

## Directory Structure

```
mindframe-z/
├── shared/                    # Catalog: what exists
│   ├── refs.yml               # Reference repositories (name, url, description)
│   ├── skills.yml             # Portable skill definitions (local/git source)
│   ├── mcp.yml                # MCP server definitions (remote/local, transports)
│   └── AGENTS.global.md       # Shared AI instructions (rendered into all profiles)
│
├── profiles/                  # Profile definitions
│   ├── base/                  # Shared foundation — all profiles extend this
│   │   ├── profile.yml        # Base references, agents, skills, MCP toggles, tool settings
│   │   ├── mise.toml          # Base tool versions and environment
│   │   └── .npmrc             # Base dotfile
│   ├── personal/              # Personal profile (extends base)
│   │   ├── profile.yml        # Personal overrides: extra skills, MCP toggles, models
│   │   └── mise.toml          # Personal tool additions
│   └── work/                  # Work profile (extends base)
│       └── profile.yml        # Work-specific MCP servers, models
│
├── configs/                   # Rendered runtime output (per-profile)
│   └── <profile>/
│       ├── AGENTS.md           # Copied from shared/AGENTS.global.md + profile instructions
│       ├── opencode/
│       │   └── opencode.jsonc  # Rendered OpenCode config
│       ├── claude/
│       │   ├── CLAUDE.md       # Imports AGENTS.md + references from ~/.mindframe-z/
│       │   ├── settings.json   # Rendered Claude settings snapshot
│       │   └── mcp.json        # Rendered Claude MCP snapshot
│       ├── mise/
│       │   └── config.toml     # Rendered mise config
│       └── dotfiles/
│           └── .npmrc          # Rendered dotfiles
│
├── schemas/                   # Generated JSON Schemas for YAML manifests
│   ├── refs.schema.json
│   ├── skills.schema.json
│   ├── mcp.schema.json
│   ├── profile.schema.json
│   └── machine.schema.json
│
├── src/
│   ├── core/                  # Manifest loading, profile resolution, rendering orchestration, symlinks
│   ├── renderers/             # Target-specific config generators (opencode, claude, mise, dotfiles)
│   ├── sync/                  # Bidirectional sync: detect drift and promote to profiles
│   ├── ref-store/             # Git clone/update references, write reference index
│   ├── skills/                # npx skills adapter
│   └── cli/mfz.ts             # CLI: apply, doctor, status, sync, skills, refs
│
├── opencode/
│   ├── plugins/               # OpenCode plugin source files
│   └── commands/              # OpenCode slash command markdown files
├── skills/                    # Local skill source directories
└── machine/                   # Per-machine overrides (gitignored)
```

## YAML Schema Workflow

`src/core/manifests.ts` defines the Zod schemas used to validate YAML manifests at runtime. `src/core/generate-schemas.ts` converts those schemas to JSON Schema with Zod's native `z.toJSONSchema()` using `io: "input"` and `unrepresentable: "any"`, then writes the generated artifacts to `schemas/`.

The generated schemas are committed artifacts so editors can validate manifests immediately after clone. When manifest Zod schemas change, run `npm run schemas` and commit the resulting `schemas/*.schema.json` changes with the source change.

Project editor settings map schemas to YAML files:

| Manifest file                | Schema file                   |
| ---------------------------- | ----------------------------- |
| `shared/refs.yml`            | `schemas/refs.schema.json`    |
| `shared/skills.yml`          | `schemas/skills.schema.json`  |
| `shared/mcp.yml`             | `schemas/mcp.schema.json`     |
| `profiles/*/profile.yml`     | `schemas/profile.schema.json` |
| `machine-config.example.yml` | `schemas/machine.schema.json` |

Zed uses `.zed/settings.json` to configure `yaml-language-server`; VS Code uses `.vscode/settings.json` with `yaml.schemas`.

## Repo-Scoped Skill Toggles

Profiles declare which skills exist for each agent target and each skill's default `enabled` state. `mfz skills sync` installs every profile-declared skill, including disabled skills, so enabling a skill later is an instant config write rather than an install operation.

Skill visibility is runtime tool state, not rendered profile state. `mfz skills tui`, `mfz skills enable`, and `mfz skills disable` detect the current git repository with `git rev-parse --show-toplevel`. Inside a repo they write to repo-local tool config at the git root; outside a repo they write to user-global tool config:

| Target        | Repo-local file               | Global file                         | Managed key        |
| ------------- | ----------------------------- | ----------------------------------- | ------------------ |
| `opencode`    | `.opencode/opencode.jsonc`    | `~/.config/opencode/opencode.jsonc` | `permission.skill` |
| `claude-code` | `.claude/settings.local.json` | `~/.claude/settings.json`           | `skillOverrides`   |

Read precedence is repo-local overrides, then global overrides, then profile defaults. Repo-local files are added to `.git/info/exclude`; global writes skip git exclusion. Global skill state is also recorded under `~/.mindframe-z/skill-overrides/` so `mfz apply` can explicitly overlay OpenCode skill preferences onto the linked runtime snapshot without scraping generated config. Claude Code global settings are merged as local state during apply. OpenCode reads these changes on restart; Claude Code hot-reloads local settings.

## Profile Inheritance and Merge Semantics

Profiles use `extends` to inherit from a parent. The merge rules are:

| Field               | Merge Behavior                                         |
| ------------------- | ------------------------------------------------------ |
| `instructions`      | Concatenate + deduplicate                              |
| `references`        | Concatenate + deduplicate                              |
| `agents`            | Child replaces parent if non-empty                     |
| `skills`            | Deep merge by skill name — child keys override parent  |
| `mcp`               | Deep merge by server name — child keys override parent |
| `opencode.config`   | Deep merge — child keys override parent                |
| `opencode.plugins`  | Concatenate + deduplicate                              |
| `opencode.commands` | Concatenate + deduplicate                              |
| `claude`            | Deep merge — child keys override parent                |
| `mise.tools`        | Deep merge                                             |
| `mise.env`          | Shallow merge — child overrides parent                 |
| `mise.tool_alias`   | Shallow merge — child overrides parent                 |
| `dotfiles`          | Concatenate with newline separator for same key        |

Resolution order: `base` → child profile (e.g., `personal` extends `base`). Machine-level config (`~/.mindframe-z/config.yml`) does not merge into the profile — it selects which profile is active and provides machine-specific inputs such as references directory, extra folders, and OpenCode permission overrides.

## Evolution from Original Design

The [initial prototype design](docs/initial-prototype-design.md) laid out a comprehensive vision. Here's how the as-built architecture differs:

| Design                        | Implementation                    | Rationale                                                                                         |
| ----------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `.runtime/` directory         | `configs/` directory              | More descriptive name; configs are profile-scoped rather than a single runtime tree               |
| Single `.runtime/opencode/`   | `configs/<profile>/opencode/`     | Per-profile rendering allows multiple profiles to coexist without re-rendering                    |
| Separate `refctl` binary      | `mindframe-z refs` subcommand     | Unified CLI reduces cognitive load; ref-store module handles the logic                            |
| Work overlay as separate repo | Single repo with `profiles/work/` | Work overlay repo concept is preserved in design but not yet implemented as a separate repository |
| TUI planned                   | CLI only                          | Deferred per YAGNI — CLI primitives must stabilize first                                          |
| Project-level config          | Machine/user-level only           | Projects live anywhere; no forced workspace structure                                             |

Features from the design that are not yet implemented:

- Work overlay as a separate company-owned repository
- `diff-runtime` command
- Project-level `.claude/` and `.mcp.json` generation

## Description Convention

Both `shared/refs.yml` entries and machine `extra_folders` entries include a `description` field rendered into agent-visible indexes (`~/.mindframe-z/references.md` and `~/.mindframe-z/extra_folders.md`). Descriptions must be LLM-actionable — they are the primary signal an agent uses to decide whether to consult a reference or whether a folder path is relevant.

### Reference Descriptions

Template:

```
<Lang/Stack> for <purpose>. <Key entrypoint or architecture note>. <LLM-useful detail: package names, config model, entrypoints, relevant tool paths>.
```

Rules:

- Start with the primary language or runtime (e.g. "TypeScript/Bun monorepo", "Rust-based CLI", "Python project (>=3.13, FastMCP-based)")
- State the project's purpose and what it does in one clause
- Include at least one LLM-relevant detail: where to find the main entrypoint, what package name to import, what file defines the config schema, etc.
- Keep to 1-3 sentences; the whole description renders inline in a bullet list
- Use backtick-free plain text — the renderer wraps the description in markdown inline code already
- No trailing punctuation on the last sentence (the renderer adds `.` after the path)

Examples:

```
TypeScript/Bun monorepo for the open-source AI coding agent (terminal, desktop, VS Code extension). Main CLI entrypoint at packages/opencode/src/index.ts. Supports MCP, custom tools, file editing, and agentic workflows.
```

```
Rust-based CLI (github.com/jdx/mise) combining dev tool version management, per-project environment variables, and task running into a single mise.toml. Installs and switches between hundreds of tools (node, python, terraform, etc.) without shims.
```

### Extra Folder Descriptions

Extra folder descriptions render as a suffix after the path in `~/.mindframe-z/extra_folders.md`. They should describe the purpose of the directory and what an agent would find there.

Template:

```
<what the directory contains> — <why an agent might need access>
```

Rules:

- Lead with the contents of the directory, then the use case
- Keep to one sentence (renderer appends it as a suffix)
- No trailing punctuation (renderer appends permissions after the description)

Examples:

```
Mindframe-z configuration and generated indexes (read: allow, edit: allow)
```

```
CI build artifacts — needed for inspecting test failures (read: allow, edit: deny)
```

## Key Decisions

- **Symlinks over copies**: Global tool paths are symlinks to rendered configs, making the source of truth visible and editable. Backups are created on conflict with timestamp suffixes. Claude Code `settings.json` is the exception: it is written locally as a merged file so external machine-specific setup can coexist with profile-managed settings.
- **`npx skills` as installer, not source**: Skills are declared in manifests and installed via `npx skills` adapter. The portable skill catalog lives in `shared/skills.yml`; profiles decide which agents each skill is installed for with `skills.<name>.targets`, and `skills.<name>.enabled` sets the default local visibility state.
- **MCP catalog vs profile targeting**: `shared/mcp.yml` defines how each MCP server connects. Profiles enable servers with `mcp.<name>.enabled`; optional `mcp.<name>.targets` narrows the agents for that server and otherwise defaults to the profile's `agents` list. OpenCode respects both resolved targets and `enabled`; Claude renders every Claude-targeted server into user-level `~/.claude.json#mcpServers`, and Claude itself manages per-project disable state.
- **References as git clones**: Reference repositories are cloned to `~/references/` (configurable via `MFZ_REFERENCES_DIR`). Generated `~/.mindframe-z/references.md` and `~/.mindframe-z/extra_folders.md` indexes provide agents with discoverability without loading full content into context; both are machine-local and not committed. Rendered agent configs grant read access to the references directory and deny edits by default.
- **Extra folders are machine-local**: `extra_folders` lives in `~/.mindframe-z/config.yml`, not profiles, because paths are host-specific. Apply writes `~/.mindframe-z/extra_folders.md`, imports it into agent instructions, and renders matching OpenCode and Claude Code folder permissions.
- **No backward compatibility**: This repo is in active development with no external users yet. Prefer the simplest direct design; do not add fallback behavior unless there is a concrete current need.
- **Generated files are inspectable**: All rendered output is human-readable (JSONC, TOML, Markdown). No binary formats or opaque state files.
- **OpenCode commands are profile-selected files**: Profiles list command names in `opencode.commands`; matching `opencode/commands/<name>.md` files render to `configs/<profile>/opencode/commands/` and are exposed through the global OpenCode commands directory symlink.

## Environment Variables

| Variable              | Purpose                    | Default                       |
| --------------------- | -------------------------- | ----------------------------- |
| `MFZ_ROOT`            | Config root directory      | machine `repo_path`, then cwd |
| `MFZ_HOME`            | Home directory             | `$HOME`                       |
| `MFZ_PROFILE`         | Active profile name        | machine profile or `personal` |
| `MFZ_REFERENCES_DIR`  | Reference clone directory  | `~/references`                |
| `OPENCODE_CONFIG_DIR` | OpenCode global config dir | `~/.config/opencode`          |
| `CLAUDE_CONFIG_DIR`   | Claude global config dir   | `~/.claude`                   |
| `MISE_CONFIG_DIR`     | Mise config dir            | `~/.config/mise`              |
