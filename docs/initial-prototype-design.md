# AI Configuration Management Design

**Status:** Draft design handoff  
**Created:** 2026-05-11  
**Primary goal:** Build a small, composable configuration management system for AI coding tools across personal machines, work machines, Home Assistant, and teammates using Claude Code.

## Executive Summary

We want a source-controlled, profile-aware, machine-wide AI setup that works across many computers and eventually across multiple AI coding tools. The first implementation should be intentionally small: a set of focused CLIs and manifests that render global OpenCode and Claude Code configuration from layered repositories.

The system should not force projects into a special workspace directory. Projects must be able to live anywhere on disk. The configuration system should operate at the machine/user level first, with project-specific behavior deferred until a concrete need appears.

The recommended starting architecture is a layered repo model:

```text
source-controlled configuration repos
        |
        v
profile-aware renderer/orchestrator
        |
        +--> OpenCode runtime files
        |
        +--> Claude Code runtime files
        |
        +--> reference clones/indexes
        |
        +--> MCP config
        |
        +--> skills installed through npx skills
```

The system owns catalog, profile, policy, and orchestration. Existing tools should own tool-specific installation details when they already solve the problem well. In particular, use `npx skills` as the initial skill installer/adapter rather than rebuilding skill installation.

## Problem Statement

The user runs AI coding tools on several machines:

- Personal laptop.
- Personal desktop PC.
- TV-attached PC.
- Home Assistant server.
- Work computer.

The user wants a consistent base AI setup across these machines, while allowing environment-specific overlays. The most sensitive split is personal vs work:

- Personal/common setup can live in the user's private repo.
- Work-specific setup must not be committed to the user's personal repo.
- Work-specific setup should live in a company-owned private repo or another approved company-controlled location.

The user also has teammates who use Claude Code rather than OpenCode. The system should start with OpenCode support but be designed so the same base setup can render a Claude Code-compatible setup for teammates.

## Prior Attempt And Lessons

The existing `/home/mark/code/dev-workspace` repo was a first attempt at solving this problem. It contains useful ideas, but the next iteration should avoid its main friction points.

Useful concepts from the prior attempt:

- `reference-sources.yml` as a tracked manifest of useful reference repositories.
- `references/` as local-only clones, not tracked contents.
- `sources/sources.lock.yml` as a lockfile concept for pinned upstream asset repos.
- `.upstream/` sidecars for promoted upstream assets and customization tracking.
- Separation between raw references and runtime-active assets.
- Awareness of OpenCode and Claude Code schema differences.
- Recognition that symlinks inside project directories can create tool/file-picker limitations.

Friction in the prior attempt:

- It encouraged or required projects to live under a workspace folder structure.
- The workspace/TUI concept became too broad before the primitives were proven.
- Some features, such as per-project skills, upstream promotion, and TUI session management, may be useful later but are not necessary for the first iteration.
- The launcher/workspace model created too much coupling between project layout and AI configuration.

The next iteration should extract the useful ideas but start smaller.

## Design Principles

### KISS

Start with the smallest useful system:

- Global/user-level config first.
- Project-specific behavior later.
- OpenCode first, Claude Code renderer alongside or shortly after.
- CLI first, TUI only if CLI friction proves it is needed.

### YAGNI

Do not implement features just because the old workspace had them:

- Do not build a full TUI yet.
- Do not build native skill installation yet.
- Do not build project-specific skills yet unless a real project requires it.
- Do not implement upstream sidecar merge flows until third-party skill customization becomes painful.

### SOLID-Oriented Boundaries

Use clear, replaceable components:

- Single Responsibility: manifests parse manifests; renderers render tool config; installers install; syncers sync references.
- Open/Closed: add new target tools via new renderers, not conditionals throughout the system.
- Liskov Substitution: installer interfaces should allow swapping `NpxSkillsInstaller` for `NativeSkillsInstaller` later.
- Interface Segregation: reference management, skill management, MCP rendering, and config rendering should have separate interfaces.
- Dependency Inversion: high-level orchestration depends on abstract ports such as `SkillInstaller`, `ReferenceStore`, and `ConfigRenderer`, not concrete shell commands.

## Non-Goals For The First Iteration

- No full-screen TUI.
- No mandatory workspace directory for projects.
- No forced project registration for every repo.
- No automatic modification of arbitrary project repositories.
- No custom skill package manager unless `npx skills` proves insufficient.
- No complex upstream merge automation in phase 1.
- No secret storage in Git.
- No work-specific data in personal repos.

## Core Architectural Model

The system has three conceptual layers:

```text
catalog = things that exist
profile = things this context wants
machine = things this computer actually enables
```

Examples:

- Catalog says a reference called `ocx` exists at `https://github.com/kdcokenny/ocx`.
- Profile says the `work` profile wants `ocx`, `opencode`, `jira`, and `company-platform` references.
- Machine state says this particular laptop has `ocx` enabled and cloned at `~/references/ocx`.

This separation prevents one manifest from trying to encode every concern.

## Repository Layout

Recommended local checkout layout:

```text
~/mindframe-z/
├── base/                         # personal/shared baseline repo
│   ├── shared/
│   │   ├── AGENTS.md
│   │   ├── rules/
│   │   ├── refs.yml
│   │   ├── skills.yml
│   │   └── mcp.yml
│   ├── opencode/
│   │   ├── opencode.jsonc
│   │   ├── agents/
│   │   ├── commands/
│   │   └── plugins/
│   ├── claude/
│   │   ├── CLAUDE.md
│   │   ├── settings.json
│   │   ├── rules/
│   │   ├── skills/
│   │   ├── agents/
│   │   └── plugins/
│   └── profiles/
│       ├── personal.yml
│       ├── home-assistant.yml
│       └── tv-pc.yml
│
├── work-overlay/                 # company-owned private repo, present only on work machines
│   ├── shared/
│   │   ├── refs.yml
│   │   ├── skills.yml
│   │   └── mcp.yml
│   ├── instructions/
│   │   └── work.md
│   ├── opencode/
│   │   └── opencode.jsonc
│   ├── claude/
│   │   └── settings.json
│   └── profiles/
│       └── work.yml
│
└── machine/                      # local-only, not committed
    └── machine.yml
```

The exact root path can be configurable. `~/ai-config` is only a recommended default.

## Source-Control Boundaries

Use separate repositories for separate trust and ownership domains:

```text
personal private repo:
  github.com/<user>/ai-config-base

company private repo:
  github.com/<company>/ai-config-work
```

Rules:

- Personal/shared setup can be in `ai-config-base`.
- Work-only references, MCPs, instructions, and profiles must be in `ai-config-work` or another company-approved repo.
- Machine-local state must not be committed.
- Secrets must never be committed. Use environment variables, OS keychains, or provider-specific auth flows.

## Runtime Layout

The runtime files should be rendered into a repo-visible generated directory, then symlinked into each tool's expected global paths.

Recommended runtime layout:

```text
~/mindframe-z/.runtime/
├── opencode/
│   ├── opencode.jsonc
│   ├── agent/
│   ├── command/
│   ├── plugin/
│   └── skills/
├── claude/
│   ├── CLAUDE.md
│   ├── settings.json
│   ├── rules/
│   ├── skills/
│   └── agents/
└── indexes/
    └── references.md
```

Then symlink where needed:

```text
~/.config/opencode/opencode.jsonc -> ~/mindframe-z/.runtime/opencode/opencode.jsonc
~/.config/opencode/agent          -> ~/mindframe-z/.runtime/opencode/agent
~/.config/opencode/command        -> ~/mindframe-z/.runtime/opencode/command
~/.config/opencode/plugin         -> ~/mindframe-z/.runtime/opencode/plugin

~/.claude/CLAUDE.md               -> ~/mindframe-z/.runtime/claude/CLAUDE.md
~/.claude/settings.json           -> ~/mindframe-z/.runtime/claude/settings.json
~/.claude/rules                   -> ~/mindframe-z/.runtime/claude/rules
~/.claude/agents                  -> ~/mindframe-z/.runtime/claude/agents
```

Skills are a special case. Initially, let `npx skills` install them into the correct target paths rather than symlinking them manually.

## OpenCode Facts From Research

OpenCode uses `~/.config/opencode/` for global configuration.

Important locations:

```text
~/.config/opencode/opencode.json
~/.config/opencode/opencode.jsonc
~/.config/opencode/agent/<name>.md
~/.config/opencode/agents/<name>.md
~/.config/opencode/command/<name>.md
~/.config/opencode/commands/<name>.md
~/.config/opencode/skill/<name>/SKILL.md
~/.config/opencode/skills/<name>/SKILL.md
```

OpenCode config supports:

- `instructions`: array of instruction files.
- `skills.paths`: additional skill paths.
- `mcp`: object keyed by server name.
- `plugin`: array of plugin specs.
- `permission`: tool permissions.
- `OPENCODE_CONFIG`: additional explicit config file.
- `OPENCODE_CONFIG_DIR`: alternative config directory containing config, agents, commands, plugins, and skills.

OpenCode config shape details that matter:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "instructions": ["AGENTS.md"],
  "skills": {
    "paths": ["/absolute/path/to/skills"],
  },
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "enabled": true,
    },
    "local-server": {
      "type": "local",
      "command": ["some-command", "arg"],
      "enabled": false,
      "env": {},
    },
  },
  "plugin": [
    "opencode-plugin-name",
    "./local-plugin.ts",
    ["opencode-plugin-with-options", { "key": "value" }],
  ],
}
```

For OpenCode, it is acceptable and desirable to keep MCP servers present with `enabled: false` when they are only used occasionally.

## Claude Code Facts From Research

Claude Code has a different configuration model than OpenCode.

Scopes:

| Scope   | Location                                         | Shared                  |
| ------- | ------------------------------------------------ | ----------------------- |
| Managed | `/etc/claude-code/`, MDM, server-managed policy  | organization-controlled |
| User    | `~/.claude/` and `~/.claude.json`                | no                      |
| Project | `.claude/` and `.mcp.json`                       | yes, committed          |
| Local   | `.claude/settings.local.json`, `CLAUDE.local.md` | no, gitignored          |

Settings precedence:

```text
Managed > command line arguments > Local > Project > User
```

Claude Code locations:

```text
~/.claude/CLAUDE.md
~/.claude/settings.json
~/.claude/rules/
~/.claude/skills/<skill>/SKILL.md
~/.claude/agents/<agent>.md
~/.claude/commands/<command>.md
~/.claude/output-styles/
~/.claude.json

project/CLAUDE.md
project/CLAUDE.local.md
project/.claude/CLAUDE.md
project/.claude/settings.json
project/.claude/settings.local.json
project/.claude/rules/
project/.claude/skills/
project/.claude/agents/
project/.mcp.json
```

Claude Code reads `CLAUDE.md`, not `AGENTS.md`.

Recommended compatibility pattern:

```markdown
# CLAUDE.md

@AGENTS.md

## Claude Code

Claude-specific guidance can go here.
```

Alternatively, symlink `CLAUDE.md` to `AGENTS.md` if no Claude-specific section is needed. Prefer import over symlink when supporting Windows users or adding Claude-specific guidance.

Claude Code skills:

- Live in `~/.claude/skills/<name>/SKILL.md` for personal/global scope.
- Live in `.claude/skills/<name>/SKILL.md` for project scope.
- Custom commands are now effectively merged into skills; `.claude/commands/*.md` still works but new workflows should generally use skills.
- Skills can include supporting files.
- Skills support `description`, `when_to_use`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `model`, `effort`, `context`, `agent`, `hooks`, `paths`, and shell options.
- Skill descriptions are listed to Claude; full skill content only loads when invoked.

Claude Code rules:

- `.claude/rules/*.md` files can load unconditionally or be path-scoped with `paths` frontmatter.
- User-level rules in `~/.claude/rules/` apply everywhere.
- Project rules are more specific than user rules.

Claude Code references and additional directories:

- `--add-dir` grants file access to external directories.
- `--add-dir` does not generally load external `.claude/` config.
- Exception: `.claude/skills/` inside an added directory can be loaded.
- To load `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md`, and `CLAUDE.local.md` from additional dirs, set `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.

Claude Code MCP scopes:

| MCP Scope | Stored In                                   | Loads In        | Shared |
| --------- | ------------------------------------------- | --------------- | ------ |
| Local     | `~/.claude.json` under current project path | current project | no     |
| Project   | `.mcp.json` at project root                 | current project | yes    |
| User      | `~/.claude.json` global                     | all projects    | no     |

MCP precedence:

```text
Local > Project > User > Plugin > claude.ai connectors
```

Claude Code supports HTTP, SSE, and stdio MCP transports. HTTP is preferred over SSE when available.

Claude Code plugin facts:

- Plugins are best for sharing reusable behavior with teammates.
- Plugin skills are namespaced as `/plugin-name:skill-name`.
- Plugins can bundle skills, commands, agents, hooks, MCP servers, LSP config, monitors, bin executables, and limited settings.
- A plugin has `.claude-plugin/plugin.json` at the plugin root.
- Component directories such as `skills/`, `agents/`, and `hooks/` live at the plugin root, not inside `.claude-plugin/`.
- `claude --plugin-dir ./plugin` can test a local plugin.

## OpenCode To Claude Code Mapping

| Concept                      | OpenCode                                          | Claude Code                                      |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------------ |
| Global instructions          | `AGENTS.md`, `instructions` config                | `~/.claude/CLAUDE.md`, `~/.claude/rules/`        |
| Project instructions         | project `AGENTS.md`                               | `CLAUDE.md` or `.claude/CLAUDE.md`               |
| Private project instructions | custom instruction file                           | `CLAUDE.local.md`                                |
| Skills                       | `~/.config/opencode/skills` or `.opencode/skills` | `~/.claude/skills` or `.claude/skills`           |
| Commands                     | `.opencode/commands`                              | skills preferred; `.claude/commands` still works |
| Agents/subagents             | `.opencode/agent`                                 | `~/.claude/agents` or `.claude/agents`           |
| MCP                          | `opencode.jsonc` `mcp` field                      | `.mcp.json` or `~/.claude.json`                  |
| Plugins                      | OpenCode JS/TS plugin entries                     | Claude Code plugin packages                      |
| External references          | permissions plus explicit paths                   | `--add-dir`, MCP, or manual file access          |

## Reference Management Design

References are useful source repos that can be cloned locally for AI agents to inspect. They are not necessarily runtime-active configuration.

Reference management should be a standalone CLI or module first.

Recommended manifest:

```yaml
# shared/refs.yml
references:
  - name: ocx
    url: https://github.com/kdcokenny/ocx
    description: OpenCode profile manager with isolated portable profiles.
    tags: [opencode, profiles]

  - name: opencode
    url: https://github.com/anomalyco/opencode
    description: OpenCode source and documentation.
    tags: [opencode]
```

Work overlay can add work-only references:

```yaml
# work-overlay/shared/refs.yml
references:
  - name: company-platform
    url: git@github.com:company/platform.git
    description: Company platform source and architectural reference.
    tags: [work, platform]
```

Machine state controls what is cloned/enabled:

```yaml
# machine/machine.yml
profile: work
references_dir: ~/references
enabled_references:
  - opencode
  - ocx
  - company-platform
```

Reference CLI responsibilities:

```text
refctl list
refctl enable <name>
refctl disable <name>
refctl sync [name]
refctl index
refctl status
```

Reference flow:

```text
refctl enable ocx
    |
    v
record ocx enabled in machine-local state
    |
    v
refctl sync ocx
    |
    v
clone/update ~/references/ocx
    |
    v
refctl index
    |
    v
generate slim markdown index with names/descriptions/paths
```

The generated index should be included in global instructions, not every reference's full content. The index gives the agent discoverability without loading all references into context.

Example generated index:

```markdown
# Enabled References

- `ocx`: OpenCode profile manager with isolated portable profiles. Path: `~/references/ocx`.
- `opencode`: OpenCode source and documentation. Path: `~/references/opencode`.
```

## Skills Management Design

Use `npx skills` as the initial installer/adapter.

Rationale:

- It already supports multiple agents, including Claude Code and OpenCode.
- It supports installing from GitHub, Git URLs, and local paths.
- It handles agent-specific install paths.
- It supports specific skill selection from repos.
- It supports update workflows.
- It supports symlink/copy behavior.

The system should not initially reimplement:

- Skill discovery.
- Agent-specific skill paths.
- Update detection.
- Install/uninstall behavior.
- Symlink vs copy behavior.
- Cross-agent compatibility handling.

The system should own:

- Skill catalog.
- Profile selection.
- Work/personal policy boundaries.
- Target agent selection.
- Local vs remote source declarations.
- Whether a skill is approved for work machines.

Recommended manifest:

```yaml
# shared/skills.yml
skills:
  - name: impeccable
    source: local
    path: ~/mindframe-z/base/claude/skills/impeccable
    description: Frontend critique and UI polish skill.
    targets: [opencode, claude-code]
    profiles: [personal, work]
    installer: npx-skills

  - name: vercel-web-design
    source: git
    repo: vercel-labs/agent-skills
    skill: web-design-guidelines
    description: Vercel web design guidance skill.
    targets: [opencode, claude-code]
    profiles: [personal]
    installer: npx-skills
```

Work overlay example:

```yaml
# work-overlay/shared/skills.yml
skills:
  - name: company-review
    source: local
    path: ~/mindframe-z/work-overlay/claude/skills/company-review
    description: Company code review process and required checks.
    targets: [claude-code, opencode]
    profiles: [work]
    installer: npx-skills
```

CLI responsibilities:

```text
mindframe-z skills list
mindframe-z skills enable <name> --profile <profile>
mindframe-z skills disable <name> --profile <profile>
mindframe-z skills apply --profile <profile> --target claude-code
mindframe-z skills apply --profile <profile> --target opencode
mindframe-z skills update --profile <profile>
mindframe-z skills doctor
```

Internally, the first implementation should shell out to `npx skills` through an adapter:

```text
SkillManager
    |
    v
SkillInstaller interface
    |
    +--> NpxSkillsInstaller
    |
    +--> NativeSkillsInstaller later, only if needed
```

Conceptual commands the adapter may emit:

```bash
npx skills add ~/mindframe-z/base/claude/skills/impeccable -a claude-code -a opencode -g -y
npx skills add vercel-labs/agent-skills --skill web-design-guidelines -a claude-code -g -y
```

Exact flags must be verified during implementation against current `npx skills` docs/help.

Important design decision: `npx skills` is not the source of truth. It is an installer. The source of truth is `skills.yml` plus profile and machine state.

## MCP Management Design

MCP configuration should use a catalog and render target-specific config.

Recommended manifest:

```yaml
# shared/mcp.yml
servers:
  context7:
    description: Documentation lookup MCP.
    targets: [opencode, claude-code]
    type: remote
    transport: http
    url: https://mcp.context7.com/mcp
    profiles: [personal, work]
    default_enabled: true

  excalidraw:
    description: Local Excalidraw MCP server.
    targets: [opencode]
    type: local
    command: ["node", "~/references/mcp_excalidraw/dist/index.js"]
    profiles: [personal]
    default_enabled: false
    env:
      EXPRESS_SERVER_URL: "http://localhost:3000"
      ENABLE_CANVAS_SYNC: "true"
```

OpenCode render example:

```jsonc
{
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "enabled": true,
    },
    "excalidraw": {
      "type": "local",
      "command": ["node", "/home/mark/references/mcp_excalidraw/dist/index.js"],
      "enabled": false,
      "env": {
        "EXPRESS_SERVER_URL": "http://localhost:3000",
        "ENABLE_CANVAS_SYNC": "true",
      },
    },
  },
}
```

Claude Code project `.mcp.json` render example:

```json
{
  "mcpServers": {
    "context7": {
      "type": "http",
      "url": "https://mcp.context7.com/mcp"
    }
  }
}
```

Claude Code user-scope MCP can be managed through `claude mcp add --scope user` or by carefully updating `~/.claude.json`. Prefer the CLI where possible unless direct file rendering is well understood and safe.

MCP CLI responsibilities:

```text
mcpx list
mcpx enable <name> --profile <profile>
mcpx disable <name> --profile <profile>
mcpx render --target opencode --profile <profile>
mcpx render --target claude-code --profile <profile>
mcpx doctor
```

Whether `mcpx` is standalone or a subcommand under `mindframe-z` can be decided later. Keep implementation modular either way.

## Instruction Management Design

Use `AGENTS.md` as the canonical cross-agent instruction file when possible.

For OpenCode:

```jsonc
{
  "instructions": [
    "~/mindframe-z/.runtime/shared/AGENTS.md",
    "~/mindframe-z/.runtime/indexes/references.md",
  ],
}
```

For Claude Code:

```markdown
# CLAUDE.md

@~/mindframe-z/.runtime/shared/AGENTS.md
@~/mindframe-z/.runtime/indexes/references.md

## Claude Code

Use Claude Code-specific guidance here.
```

Keep global instructions short. Use skills for procedures. Use Claude Code rules for topic/path-specific guidance. Use reference indexes for discoverability rather than including full reference content.

Claude Code-specific support:

- Render `~/.claude/CLAUDE.md`.
- Render `~/.claude/rules/` for global rules.
- For project/team sharing, optionally generate committed `.claude/` files later.
- For local-only per-project customization, use `CLAUDE.local.md` and `.claude/settings.local.json` only when project-specific support is added.

## Plugin Management Design

OpenCode and Claude Code plugins are very different.

OpenCode plugins:

- JS/TS functions referenced from `opencode.jsonc` `plugin` array.
- Can be npm packages, local files, file URLs, or `[name, options]` tuples.

Claude Code plugins:

- Directory/package format with `.claude-plugin/plugin.json`.
- Can include skills, agents, hooks, MCP, LSP, monitors, bin executables, and limited settings.
- Good for sharing with teammates.
- Namespaces skills as `/plugin-name:skill-name`.

Initial recommendation:

- Track personal OpenCode plugins in the base repo and render `plugin` entries.
- Do not attempt to make OpenCode plugins portable to Claude Code.
- For teammate sharing, package Claude Code skills/agents/hooks into a Claude Code plugin after the standalone files stabilize.
- Keep plugin management separate from skill management.

Future Claude plugin layout:

```text
team-ai-plugin/
├── .claude-plugin/
│   └── plugin.json
├── skills/
├── agents/
├── hooks/
├── .mcp.json
├── bin/
└── settings.json
```

## OCX Research Summary

OCX is an OpenCode extension/profile manager at `https://github.com/kdcokenny/ocx`.

Useful OCX concepts:

- Profiles let users work in any repo with selected config.
- Profiles live under `~/.config/opencode/profiles/<name>/`.
- OCX can launch OpenCode with a selected profile.
- OCX uses `OPENCODE_CONFIG_DIR` to point OpenCode at profile config.
- OCX emphasizes profile isolation and registry isolation.
- OCX copies components into project `.opencode/` following a ShadCN-style ownership model.
- OCX uses receipt/lockfile concepts with hashes for installed components.

Recommendation:

- Study OCX and borrow concepts.
- Do not adopt OCX wholesale in the first iteration.
- Avoid coupling the system to OCX if it conflicts with source-controlled global symlinks or cross-tool Claude Code support.

Why not adopt OCX wholesale immediately:

- It is OpenCode-focused.
- It may encourage project `.opencode/` component copying, while this design starts with machine-wide global config.
- It does not solve the full cross-tool, work-overlay, reference-management vision by itself.

## CLI Design

Start with small CLIs or one CLI with strongly separated subcommands. The names are placeholders.

### `mindframe-z`

Primary orchestrator.

```text
mindframe-z doctor
mindframe-z status
mindframe-z apply --profile personal --target opencode
mindframe-z apply --profile personal --target claude-code
mindframe-z apply --profile personal --target all
mindframe-z diff-runtime
mindframe-z use <profile>
```

Responsibilities:

- Load base repo manifests.
- Load optional overlay repo manifests.
- Load machine state.
- Resolve active profile.
- Coordinate renderers.
- Create or verify symlinks.
- Report drift.

### `refctl`

Reference manager.

```text
refctl list
refctl enable <name>
refctl disable <name>
refctl sync [name]
refctl index
refctl status
```

Responsibilities:

- Read reference catalogs.
- Maintain machine-local enabled reference state.
- Clone/update references.
- Generate reference index markdown.

### `skills` subcommands

Can be `mindframe-z skills ...` rather than a separate binary.

```text
mindframe-z skills list
mindframe-z skills enable <name> --profile <profile>
mindframe-z skills disable <name> --profile <profile>
mindframe-z skills apply --profile <profile> --target claude-code
mindframe-z skills update --profile <profile>
mindframe-z skills doctor
```

Responsibilities:

- Read skill catalogs.
- Resolve profile-enabled skills.
- Delegate install/update/remove to `npx skills` via an adapter.
- Validate that installed skills match desired state.

### `mcpx`

May start as `mindframe-z mcp ...`.

```text
mindframe-z mcp list
mindframe-z mcp enable <name> --profile <profile>
mindframe-z mcp disable <name> --profile <profile>
mindframe-z mcp render --profile <profile> --target opencode
mindframe-z mcp render --profile <profile> --target claude-code
mindframe-z mcp doctor
```

Responsibilities:

- Read MCP catalogs.
- Resolve profile-enabled servers.
- Render target-specific MCP config.
- Validate that secrets are referenced via environment variables, not committed literals.

## Suggested Interfaces

These are conceptual interfaces, not required exact code.

```typescript
interface ManifestLoader<T> {
  load(path: string): Promise<T>;
}

interface ProfileResolver {
  resolve(input: ResolveProfileInput): Promise<ResolvedProfile>;
}

interface ConfigRenderer {
  target: "opencode" | "claude-code";
  render(profile: ResolvedProfile): Promise<RenderedArtifact[]>;
}

interface SkillInstaller {
  install(skill: ResolvedSkill, target: ToolTarget): Promise<void>;
  update(skill: ResolvedSkill, target: ToolTarget): Promise<void>;
  remove(skill: ResolvedSkill, target: ToolTarget): Promise<void>;
  status(skill: ResolvedSkill, target: ToolTarget): Promise<SkillInstallStatus>;
}

interface ReferenceStore {
  sync(reference: ResolvedReference): Promise<ReferenceStatus>;
  status(reference: ResolvedReference): Promise<ReferenceStatus>;
}

interface SymlinkManager {
  ensureLink(linkPath: string, targetPath: string): Promise<void>;
  verifyLink(linkPath: string, targetPath: string): Promise<LinkStatus>;
}
```

Concrete adapters:

```text
YamlManifestLoader
JsoncConfigLoader
OpenCodeConfigRenderer
ClaudeCodeConfigRenderer
NpxSkillsInstaller
GitReferenceStore
NodeFsSymlinkManager
```

## Profile Resolution

Profile resolution should be deterministic.

Suggested precedence:

```text
CLI --profile
    > MFZ_PROFILE environment variable
    > machine/machine.yml profile
    > default profile from base config
```

Profile merge order:

```text
base defaults
    -> base profile
    -> overlay defaults, if overlay present
    -> overlay profile, if selected profile extends/uses overlay
    -> machine overrides
```

Arrays should generally concatenate and deduplicate. Objects should deep-merge. Scalar values should be overridden by the more specific layer.

The implementation should document exact merge semantics before relying on them widely.

## Example Profile Manifest

```yaml
# profiles/personal.yml
name: personal
description: Personal default AI setup.

targets:
  - opencode
  - claude-code

instructions:
  include:
    - shared/AGENTS.md

references:
  enable:
    - opencode
    - ocx
    - vercel-skills

skills:
  enable:
    - impeccable
    - vercel-web-design

mcp:
  enable:
    - context7
    - grep-app
  disabled_available:
    - excalidraw

opencode:
  model: anthropic/claude-sonnet-4-6
  small_model: anthropic/claude-haiku-4-5

claude:
  model: sonnet
  settings:
    includeGitInstructions: true
```

Work profile example:

```yaml
# work-overlay/profiles/work.yml
name: work
extends: personal
description: Work machine profile with company-only additions.

instructions:
  include:
    - instructions/work.md

references:
  enable:
    - company-platform
    - company-runbooks

skills:
  enable:
    - company-review

mcp:
  enable:
    - jira
    - github-enterprise
  disable:
    - personal-only-server

opencode:
  model: anthropic/claude-sonnet-4-6

claude:
  model: sonnet
```

## Security And Trust Rules

- Never commit secrets.
- Never commit work-specific content into personal repos.
- Work overlay must be optional and only present on work machines.
- Third-party skills should be reviewed before being used on work machines.
- Skills with side effects should set Claude Code `disable-model-invocation: true` where appropriate.
- Claude Code skills with `allowed-tools` should be treated as higher trust because they can pre-approve tool usage while active.
- MCP servers should be reviewed before enabling, especially servers that fetch untrusted content.
- Prefer environment variable references for credentials.
- Prefer CLI-driven OAuth auth flows for Claude Code MCP where possible.
- Generated runtime files should be inspectable and diffable.

## First Implementation Phase

Phase 1 should prove the minimum useful loop.

Deliverables:

- `mindframe-z doctor` verifies expected directories, required tools, active profile, and symlink status.
- `mindframe-z apply --profile personal --target opencode` renders OpenCode global config and symlinks it.
- `mindframe-z apply --profile personal --target claude-code` renders Claude Code global config and symlinks it.
- `refctl list`, `refctl enable`, `refctl sync`, and `refctl index` work for references.
- `mindframe-z skills apply` delegates to `npx skills` for local-path skills.

Do not implement:

- Work overlay automation beyond manifest loading if simple.
- TUI.
- Project-specific repo wiring.
- Claude Code plugin packaging.
- Native skill installer.

## Second Implementation Phase

Deliverables:

- Work overlay support.
- MCP catalog rendering for OpenCode.
- Claude Code user/project MCP strategy decided and implemented.
- Profile inheritance.
- Skill installation from remote Git sources through `npx skills`.
- Runtime diff command showing what would change before apply.

## Third Implementation Phase

Deliverables:

- Claude Code plugin packaging for teammate distribution.
- Team bootstrap docs.
- Optional project-level `.claude/` and `.mcp.json` generation for repos that explicitly opt in.
- More robust update/status reporting.

## Future Enhancements

- TUI after the CLI primitives are stable.
- Project-specific skill/reference selection.
- Upstream source lockfiles and `.upstream/` sidecar customization tracking.
- AI-assisted merge review for customized third-party skills.
- OCX integration or migration path if it becomes beneficial.
- Background reference update summaries.
- Claude Code project plugin marketplace for team distribution.

## Implementation Checklist For A New Agent

Before writing code:

1. Read this document fully.
2. Inspect existing `/home/mark/code/dev-workspace` manifests and docs for reusable ideas, but do not assume the old workspace structure is the target.
3. Verify current `npx skills` CLI flags with `npx skills --help` and relevant subcommand help.
4. Verify current OpenCode config schema before writing OpenCode config.
5. Verify current Claude Code settings schema or docs before writing Claude Code config.
6. Ask before making project-repo modifications or adding new top-level repos.

Implementation order:

1. Define manifest schemas and types.
2. Implement manifest loading and profile resolution.
3. Implement dry-run rendering to `.runtime/`.
4. Implement `doctor` and `status` before destructive/apply behavior.
5. Implement symlink creation with conflict checks.
6. Implement reference sync.
7. Implement `NpxSkillsInstaller` adapter.
8. Implement MCP rendering.

Conflict rules:

- If a target symlink path exists and points to the expected target, leave it.
- If a target path exists and is a regular file not managed by this system, stop and ask.
- If a target path is a symlink to a different target, stop and ask unless an explicit `--force` was provided.
- Never delete user files automatically.

## Key Decisions Captured

- Use layered source-controlled repos: base plus optional work overlay.
- Keep project directories independent; no forced workspace structure.
- Use global/machine-wide config first.
- Use `AGENTS.md` as canonical shared instructions and generate/import `CLAUDE.md` for Claude Code.
- Use `npx skills` initially as the skill installer/adapter.
- Keep the system's source of truth in manifests, not in `npx skills` state.
- Build small CLIs/modules first; defer TUI.
- Keep work-only content in company-owned repos.
- Render runtime files into a visible `.runtime/` directory and symlink tool globals to them.
- Make renderers target-specific: OpenCode and Claude Code should share manifests but not config file formats.
