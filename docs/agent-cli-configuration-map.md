# Agent CLI Configuration Map

This note maps Claude Code, OpenCode, and Codex configuration surfaces to the
mindframe-z manifest and renderer model.

Sources:

- Claude Code docs, read July 6, 2026:
  - https://code.claude.com/docs/en/settings
  - https://code.claude.com/docs/en/mcp
  - https://code.claude.com/docs/en/permissions
  - https://code.claude.com/docs/en/skills
  - https://code.claude.com/docs/en/sub-agents
  - https://code.claude.com/docs/en/plugins
  - https://code.claude.com/docs/en/cli-reference
- OpenCode local reference clone:
  - /home/mark/references/opencode
  - /home/mark/references/opencode/packages/opencode/src/config
  - /home/mark/references/opencode/packages/core/src/v1/config
- Codex manual, read July 6, 2026:
  - https://developers.openai.com/codex/codex-manual.md
- mindframe-z source:
  - ARCHITECTURE.md
  - src/core/manifests.ts
  - src/core/profile.ts
  - src/core/render.ts
  - src/renderers/claude.ts
  - src/renderers/opencode.ts

## Current mfz Model

mindframe-z separates configuration into three layers:

| Layer | Files | Purpose |
| --- | --- | --- |
| Catalog | shared/refs.yml, shared/skills.yml, shared/mcp.yml | Defines available references, skills, and MCP servers. |
| Profile | profiles/<name>/profile.yml, profiles/<name>/mise.toml | Selects agents, references, skills, MCP servers, and target-specific settings. |
| Machine | ~/.mindframe-z/config.yml | Selects profile and stores host-specific paths, extra folders, git identity, archives, and overrides. |

Existing agent renderers are gated by `profile.agents`:

| Agent | Rendered output | Runtime behavior |
| --- | --- | --- |
| OpenCode | configs/<profile>/opencode/opencode.jsonc plus commands, agents, plugins | Symlinked into ~/.config/opencode. Global skill state is overlaid during apply. |
| Claude Code | configs/<profile>/claude/CLAUDE.md, settings.json, mcp.json | CLAUDE.md is symlinked. settings.json and ~/.claude.json#mcpServers are merged into local user files. |
| Codex | configs/<profile>/codex/AGENTS.md, config.toml | AGENTS.md is copied into $CODEX_HOME. config.toml is merged into local user config. |

Codex follows the same renderer pattern: it is an agent target, renders a managed
snapshot under `configs/<profile>/codex/`, and applies it into the tool's real
runtime location without making profile manifests depend on user-local state.

## Configuration Loading By Tool

### Claude Code

Relevant documented locations:

| Surface | Location | Notes |
| --- | --- | --- |
| Settings | ~/.claude/settings.json, .claude/settings.json, .claude/settings.local.json, managed settings | Settings contain permissions, env, hooks, status line, skill overrides, and many runtime preferences. |
| Other state | ~/.claude.json | Contains OAuth session, user/local MCP server config, per-project state, allowed tools, trust settings, and caches. |
| Project MCP | .mcp.json | Versionable project-scoped MCP server configuration. |
| Instructions | CLAUDE.md | Project/user guidance loaded into context. |
| Skills | .claude/skills, ~/.claude/skills, plugin skills | Skills are Agent Skills folders and can replace older command files. |
| Commands | .claude/commands, ~/.claude/commands | Still supported, but Claude docs say custom commands have merged into skills. |
| Subagents | .claude/agents, ~/.claude/agents, managed settings, --agents JSON, plugin agents | Markdown files with YAML frontmatter plus body prompt. |
| Hooks | settings JSON under `hooks` | Hook handlers can be command, HTTP, prompt, or agent based depending on event. |
| Plugins | Installed marketplaces or `--plugin-dir` | Plugins can bundle skills, agents, hooks, MCP servers, monitors, LSP config, and limited default settings. |

mfz currently handles the portable parts:

| Claude Code feature | Current mfz mapping | Gap |
| --- | --- | --- |
| Global/project guidance | Render `configs/<profile>/AGENTS.md`; render `CLAUDE.md` importing AGENTS and machine indexes. | None for current model. |
| Settings | `profile.claude.settings` plus generated permissions, merged into ~/.claude/settings.json. | Schema is loose pass-through; no first-class hooks/subagents/plugins model. |
| MCP | `shared/mcp.yml` plus `profile.mcp`, rendered to `configs/<profile>/claude/mcp.json` and merged into ~/.claude.json. | Project-scoped `.mcp.json` is not generated. |
| Extra folders | `extra_folders` generates `permissions` and `additionalDirectories`. | None for current machine-local model. |
| Skills | Catalog/profile skills plus external `mfz skills` commands. | Claude skills are runtime state, not rendered profile files. |
| Subagents | Not first-class. | Could add a source directory and renderer if needed. |
| Hooks | Pass-through via `claude.settings.hooks`. | No reusable hook source file model. |
| Plugins | Not first-class. | Could support plugin source directories later. |

### OpenCode

Relevant code-backed locations from the local reference clone:

| Surface | Location or key | Notes |
| --- | --- | --- |
| Global config dir | XDG config path, normally ~/.config/opencode | OpenCode loads config.json, opencode.json, and opencode.jsonc. `OPENCODE_CONFIG_DIR` overrides this. |
| Project config files | opencode.jsonc or opencode.json walking up from cwd to worktree | Disabled by `OPENCODE_DISABLE_PROJECT_CONFIG`. |
| Project/global config dirs | .opencode directories plus global config dir | Scanned for config, command(s), agent(s), mode(s), and plugin(s). |
| Commands | command/**/*.md or commands/**/*.md | Markdown frontmatter plus body template. |
| Agents | agent/**/*.md, agents/**/*.md, mode/*.md, modes/*.md | Markdown frontmatter plus body prompt. |
| Plugins | plugin/*.{ts,js}, plugins/*.{ts,js}, or `plugin` config entries | Local file plugin specs are resolved relative to declaring config file. |
| MCP | `mcp` config object | Local servers use `type: "local"` with command array; remote servers use `type: "remote"` with URL and headers. |
| Permissions | `permission` config | Supports `ask`, `allow`, and `deny` for keys such as read, edit, bash, external_directory, skill, webfetch, websearch, lsp. |
| Instructions | `instructions` config array | OpenCode concatenates instruction arrays across config layers. |
| References | `references` or deprecated `reference` | Named git or local directory references with description and hidden flag. |
| Skills | `skills.paths` and `skills.urls` | Additional skill folder paths or well-known skill URLs. |
| Providers/models | `provider`, `model`, `small_model`, agent model fields | Model identifiers are provider/model strings. |

mfz currently maps OpenCode well:

| OpenCode feature | Current mfz mapping | Gap |
| --- | --- | --- |
| Config file | `opencode.config` renders into `opencode.jsonc`. | None for generic config pass-through. |
| Global runtime location | Symlink to ~/.config/opencode/opencode.jsonc. | Works, but direct symlink means non-mfz edits happen in rendered output. |
| Instructions | Generated `instructions` points to AGENTS and machine indexes. | None. |
| MCP | `shared/mcp.yml` plus `profile.mcp`, rendered to `mcp`. | mfz uses `env`; OpenCode schema currently calls local env `environment`. Renderer should verify compatibility before widening. |
| Permissions | `opencode.config.permission`, machine `opencode.permission`, references, and extra folders merge into `permission`. | Permission merge order should remain explicit because OpenCode preserves object order for precedence-sensitive rules. |
| Commands | Source files under `opencode/commands`, selected by `opencode.commands`. | OpenCode now scans both `command` and `commands`; mfz uses `commands`. |
| Agents | Source files under `opencode/agents`, selected by `opencode.agents`. | OpenCode also supports `agent` singular and `mode(s)`. |
| Plugins | Source files under `opencode/plugins`, selected by `opencode.plugins`. | mfz copies plugin files but does not model external package plugin specs separately. |
| Skills | `mfz skills` controls `permission.skill`; profile declares skill catalog. | mfz does not render OpenCode `skills.paths` or `skills.urls`. |
| References | `shared/refs.yml` is rendered into machine index and read permission, not OpenCode `references`. | Could render OpenCode native `references`, but current index approach is tool-neutral. |

### Codex

Relevant documented locations:

| Surface | Location | Notes |
| --- | --- | --- |
| User config | $CODEX_HOME/config.toml, default ~/.codex/config.toml | Shared by CLI and IDE extension. |
| Profile config | $CODEX_HOME/<profile>.config.toml selected with `codex --profile` | Profile file overlays base user config. This is separate from mfz profiles. |
| Project config | .codex/config.toml | Loaded only for trusted projects; relative paths resolve from the containing .codex directory. |
| Global instructions | $CODEX_HOME/AGENTS.md or AGENTS.override.md | Codex uses only the first non-empty global file at this level. |
| Project instructions | AGENTS.override.md, AGENTS.md, fallback names | Walked from project root to current directory. |
| MCP | `[mcp_servers.<name>]` in config.toml | Supports stdio and streamable HTTP with bearer/env headers and OAuth settings. |
| Skills | $HOME/.agents/skills, .agents/skills, /etc/codex/skills, system skills | Uses Agent Skills progressive disclosure. `[[skills.config]]` controls enable/disable by path. |
| Hooks | hooks.json or inline `[hooks]` tables beside config layers | Project hooks load only for trusted projects. |
| Subagents | ~/.codex/agents/*.toml or .codex/agents/*.toml | Agent TOML files are config layers for spawned sessions. |
| Plugins | Plugin directory and config `[plugins.*]` | Plugins can bundle skills, apps, MCP servers, hooks, and assets. |
| Permissions | `sandbox_mode`, `approval_policy`, `sandbox_workspace_write`, or named `[permissions.*]` profiles | Named permission profiles cover filesystem and network policy. |
| Noninteractive | `codex exec --json` | Useful for future `mfz thread` dispatch support. |

Codex has an mfz renderer:

| Codex feature | mfz mapping | Notes |
| --- | --- | --- |
| Agent target | `codex` in agent enums and profile `agents`. | Affects schema, profile resolution, MCP/skill target filtering, apply/status/doctor/sync. |
| User config | `profile.codex.config` renders to `configs/<profile>/codex/config.toml`. | TOML pass-through. |
| Local apply behavior | Managed snapshot merges into `$CODEX_HOME/config.toml`. | Claude-style merge avoids overwriting auth/plugin/project trust/user state. |
| Instructions | `configs/<profile>/codex/AGENTS.md` copies to `$CODEX_HOME/AGENTS.md`. | Does not create `AGENTS.override.md`. |
| MCP | `shared/mcp.yml` selections render to `[mcp_servers]`. | Stdio command/args/env and HTTP url/static headers are covered. |
| Extra folders | Named permission profile under `[permissions.mfz.filesystem]` plus `default_permissions = "mfz"`. | Maps read/write/deny from references and extra folders. |
| Skills | Catalog/install model includes Codex target; enable/disable writes `[[skills.config]]` by SKILL.md path. | Toggle writes fail clearly when the installed path cannot be resolved. |
| Hooks | Initially pass through `codex.config.hooks` or render hooks.json from `codex.hooks`. | Hooks are powerful; start explicit rather than inferred. |
| Subagents | Add optional source dir, e.g. `codex/agents/*.toml`. | Codex agent files are TOML, unlike OpenCode/Claude markdown agents. |
| Plugins | Initially pass through `[plugins.*]` config. | Plugin installation/marketplaces should be separate from renderer MVP. |
| Profile files | Do not use Codex `--profile` initially. | mfz profiles already select the rendered state; nested profile systems will confuse apply/sync. |
| Thread dispatch | Add later via `codex exec --json`. | Separate from rendering because session ingestion and runner semantics need their own tests. |

## Cross-Tool Feature Matrix

| mfz concept | Claude Code | OpenCode | Codex |
| --- | --- | --- | --- |
| Agent target | `claude-code` | `opencode` | `codex` |
| Primary config format | JSON | JSON/JSONC | TOML |
| Global config path | ~/.claude/settings.json plus ~/.claude.json | ~/.config/opencode/opencode.jsonc | ~/.codex/config.toml |
| Project config path | .claude/settings.json, .claude/settings.local.json, .mcp.json | opencode.jsonc/json, .opencode/ | .codex/config.toml |
| Instructions | CLAUDE.md | `instructions` array and project docs | AGENTS.md |
| Tool-neutral generated guidance | Imported by rendered CLAUDE.md | Listed in `instructions` | Installed to ~/.codex/AGENTS.md |
| MCP | ~/.claude.json and .mcp.json | `mcp` object | `[mcp_servers]` |
| Permissions | `permissions.allow/ask/deny`, `defaultMode`, `additionalDirectories` | `permission` object | `approval_policy`, `sandbox_mode`, `[permissions]` profiles |
| Extra folders | Read/Edit permissions plus `additionalDirectories` | `external_directory` and `edit` rules | Named filesystem permission profile |
| Skills | .claude/skills, skillOverrides | `skills.paths`, `skills.urls`, `permission.skill` | .agents/skills and `[[skills.config]]` |
| Commands | Merged into skills; legacy .claude/commands supported | command(s) markdown files | Deprecated prompts; prefer skills |
| Subagents | Markdown in .claude/agents or ~/.claude/agents | agent(s)/mode(s) markdown files | TOML in .codex/agents or ~/.codex/agents |
| Plugins | Marketplace/local plugins | TS/JS plugin files or config specs | Plugin directory/config, marketplace |
| Noninteractive runner | `claude -p --output-format stream-json` | `opencode run --format json` | `codex exec --json` |

## Implemented Codex MVP

The first Codex change is intentionally narrow:

1. Add `codex` as an agent target.
2. Add `codex.config` pass-through TOML config in profile manifests.
3. Render `configs/<profile>/codex/config.toml`.
4. Render and install `~/.codex/AGENTS.md` from the same generated AGENTS source used by existing agents.
5. Render Codex MCP servers from `shared/mcp.yml`.
6. Render references and `extra_folders` as a Codex permission profile.
7. Add sync support for unmanaged top-level Codex config keys in the managed snapshot.
8. Add integration tests for apply, no-link, status, MCP, extra folders, and sync.

Defer these until after the renderer is stable:

- Codex cloud tasks.
- Codex app settings.
- Plugin marketplace management.
- Codex import flows.
- Thread/session dispatch and ingestion.
- Project-local `.codex/` generation.

## Design Choices To Settle

### Merge vs Symlink

Use Claude-style merge for `~/.codex/config.toml`.

Reason: Codex user config can contain plugin state, app/connectors controls,
project trust, OAuth-related settings, and local preferences. A symlinked file
would make mfz own too much user-local state.

### Native References vs Index Files

Keep the existing generated `~/.mindframe-z/references.md` and
`~/.mindframe-z/extra_folders.md` indexes as the portable base.

Reason: indexes are tool-neutral and already work for Claude Code and OpenCode.
Codex can consume the same guidance through AGENTS.md. Native OpenCode
`references` support is useful, but adopting it for only one target would split
the source-of-truth model.

### Commands vs Skills

For Codex and Claude Code, prefer skills over command/prompt files.

Reason: Claude Code docs now describe custom commands as merged into skills,
and Codex docs describe custom prompts as deprecated in favor of skills. OpenCode
commands remain native and should stay as OpenCode-specific source files.

### Permissions Model

Keep each tool's native permission model behind a common mfz intent:

| mfz input | Claude Code output | OpenCode output | Codex output |
| --- | --- | --- | --- |
| `references_dir` | Allow Read, deny Edit | `external_directory: allow`, `edit: deny` | `read` permission |
| `extra_folders.read=allow` | Allow Read and add `additionalDirectories` | `external_directory: allow` | filesystem read/write depending on edit |
| `extra_folders.edit=allow` | Allow Edit | no `edit` deny rule | filesystem write |
| `extra_folders.read/edit=deny` | Deny Read/Edit | deny rules | filesystem deny |

Codex should use named permission profiles rather than legacy workspace-write
only settings because the profile syntax can express read, write, and deny.
