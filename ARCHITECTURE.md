# Architecture

mindframe-z is a profile-aware AI tool configuration renderer. It manages global configuration for AI coding tools (OpenCode, Claude Code), tool versioning (mise), and dotfiles through layered YAML manifests, profile inheritance, and a bidirectional sync workflow.

## Core Principles

### Edit-First, Sync-Back

The CLI tools exist to orchestrate, not to gatekeep. AI agents should be able to edit rendered configuration files directly in `configs/<profile>/` — editing `opencode.jsonc`, `settings.json`, `mise/config.toml`, or any other rendered file — without being forced through a CLI wizard. The `sync` command then detects these unmanaged changes and promotes them back into the source profile YAMLs.

This is a core design choice: the natural workflow for an AI agent is to edit the config file it understands, then run `mindframe-z sync` to persist the change upstream. The CLI does not try to intercept every modification.

```
edit configs/personal/opencode/opencode.jsonc  →  mindframe-z sync  →  profiles/personal/profile.yml
```

### Profile Layering

Configuration is organized in three conceptual layers:

- **Catalog** (`shared/*.yml`) — what exists: available references, skills, and MCP servers.
- **Profile** (`profiles/*/profile.yml`) — what a context wants: which catalog items are enabled, plus tool-specific settings.
- **Machine** (`~/.mindframe-z/config.yml`) — what this computer actually enables: active profile, references directory, machine-specific overrides.

This separation prevents any single manifest from trying to encode every concern. The catalog is shared across all profiles; profiles select from it; the machine decides which profile is active.

### Target-Specific Renderers

Each output target (opencode, claude-code, mise, dotfiles) has its own renderer in `src/renderers/`. Renderers share the same resolved profile input but produce tool-specific output formats. New targets are added by writing a new renderer — no conditionals spread through the rest of the system.

### Manifests Are the Source of Truth

The YAML manifests in `shared/` and `profiles/` are the authoritative source of configuration state. Tool-level state — what `npx skills` has installed, what `~/.claude.json` contains, what mise has configured — is a _rendered output_, not the source of truth. The `sync` command bridges the gap by detecting drift between rendered output and manifests, but the manifests remain the canonical record.

Manifest schemas live in `src/core/manifests.ts` as Zod definitions. `mindframe-z schemas` generates editor-facing JSON Schema files into `schemas/` from those same Zod definitions, so runtime validation and editor autocomplete share one source of truth.

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
2. **Resolve profile** — select profile via `--profile` > `MFZ_PROFILE` > machine config > default `personal`. If the profile `extends` another, recursively merge (arrays are additive and deduplicated; maps are deep-merged with child overriding parent).
3. **Render** — for each target, the renderer produces files and link plans:
   - **opencode**: `opencode.jsonc` + plugin files + command files, linked to `~/.config/opencode/opencode.jsonc` and `~/.config/opencode/commands/`
   - **claude-code**: `CLAUDE.md` + `settings.json`, linked to `~/.claude/`
   - **mise**: `config.toml`, linked to `~/.config/mise/config.toml`
   - **dotfiles**: any files declared in the profile's `dotfiles` map, linked to `~/`
4. **Write files** — rendered content is written to `configs/<profile>/`.
5. **Create symlinks** — global tool paths are symlinked to the rendered files, with backup-and-replace on conflict (after user confirmation).

### Sync (tools → profiles)

1. **Read rendered configs** — parse `configs/<profile>/opencode/opencode.jsonc`, `claude/settings.json`, `mise/config.toml`.
2. **Diff against profile** — identify keys present in the rendered config but not declared in the profile YAML (unmanaged keys).
3. **Prompt or assign** — for each unmanaged key, prompt the user to assign it to `base` or the current profile (or skip). Can be automated with `--profile`.
4. **Write back** — update the target `profile.yml` or `mise.toml` with the new key.

## Directory Structure

```
mindframe-z/
├── shared/                    # Catalog: what exists
│   ├── refs.yml               # Reference repositories (name, url, description)
│   ├── skills.yml             # Skill definitions (local/git source, targets)
│   ├── mcp.yml                # MCP server definitions (remote/local, transports)
│   └── AGENTS.global.md       # Shared AI instructions (rendered into all profiles)
│
├── profiles/                  # Profile definitions
│   ├── base/                  # Shared foundation — all profiles extend this
│   │   ├── profile.yml        # Base references, skills, MCP, tool settings
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
│       ├── references.md       # Generated index of enabled references
│       ├── opencode/
│       │   └── opencode.jsonc  # Rendered OpenCode config
│       ├── claude/
│       │   ├── CLAUDE.md       # Imports AGENTS.md + references.md
│       │   └── settings.json   # Rendered Claude settings
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
│   └── cli/mindframe-z.ts     # CLI: apply, doctor, status, sync, skills, refs
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

## Profile Inheritance and Merge Semantics

Profiles use `extends` to inherit from a parent. The merge rules are:

| Field               | Merge Behavior                                  |
| ------------------- | ----------------------------------------------- |
| `instructions`      | Concatenate + deduplicate                       |
| `references`        | Concatenate + deduplicate                       |
| `skills`            | Concatenate + deduplicate                       |
| `mcp`               | Deep merge — child keys override parent         |
| `opencode.config`   | Deep merge — child keys override parent         |
| `opencode.plugins`  | Concatenate + deduplicate                       |
| `opencode.commands` | Concatenate + deduplicate                       |
| `claude`            | Deep merge — child keys override parent         |
| `mise.tools`        | Deep merge                                      |
| `mise.env`          | Shallow merge — child overrides parent          |
| `mise.tool_alias`   | Shallow merge — child overrides parent          |
| `dotfiles`          | Concatenate with newline separator for same key |
| `targets`           | Child replaces parent if non-empty              |

Resolution order: `base` → child profile (e.g., `personal` extends `base`). Machine-level config (`~/.mindframe-z/config.yml`) does not merge into the profile — it selects which profile is active and provides machine-specific overrides (references directory, OpenCode permissions).

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
- Claude Code MCP rendering (currently OpenCode-only for MCP)
- Project-level `.claude/` and `.mcp.json` generation

## Key Decisions

- **Symlinks over copies**: Global tool paths are symlinks to rendered configs, making the source of truth visible and editable. Backups are created on conflict with timestamp suffixes.
- **`npx skills` as installer, not source**: Skills are declared in manifests and installed via `npx skills` adapter. The skill catalog lives in `shared/skills.yml`, not in the installed location.
- **References as git clones**: Reference repositories are cloned to `~/references/` (configurable via `MFZ_REFERENCES_DIR`). A generated `references.md` index provides agents with discoverability without loading full content into context.
- **No backward compatibility**: This repo is in active development with no external users yet. Prefer the simplest direct design; do not add fallback behavior unless there is a concrete current need.
- **Generated files are inspectable**: All rendered output is human-readable (JSONC, TOML, Markdown). No binary formats or opaque state files.
- **OpenCode commands are profile-selected files**: Profiles list command names in `opencode.commands`; matching `opencode/commands/<name>.md` files render to `configs/<profile>/opencode/commands/` and are exposed through the global OpenCode commands directory symlink.

## Environment Variables

| Variable              | Purpose                    | Default                       |
| --------------------- | -------------------------- | ----------------------------- |
| `MFZ_ROOT`            | Config root directory      | cwd                           |
| `MFZ_HOME`            | Home directory             | `$HOME`                       |
| `MFZ_PROFILE`         | Active profile name        | machine profile or `personal` |
| `MFZ_REFERENCES_DIR`  | Reference clone directory  | `~/references`                |
| `OPENCODE_CONFIG_DIR` | OpenCode global config dir | `~/.config/opencode`          |
| `CLAUDE_CONFIG_DIR`   | Claude global config dir   | `~/.claude`                   |
| `MISE_CONFIG_DIR`     | Mise config dir            | `~/.config/mise`              |
