## Context

mindframe-z is a profile-aware renderer for agent CLI configuration. Today it
supports OpenCode and Claude Code as agent targets, plus mise and dotfiles as
infrastructure targets. Profiles select agents, skills, MCP servers, references,
and tool-specific settings; `mfz apply` renders profile snapshots under
`configs/<profile>/` and then links or merges those snapshots into real user-level
tool configuration.

Codex now exposes the same broad category of configuration surfaces:
`~/.codex/config.toml`, `~/.codex/AGENTS.md`, `[mcp_servers]`, Agent Skills,
hooks, custom agents, plugins, named permission profiles, and `codex exec --json`.
This change adds local Codex CLI/IDE configuration rendering. It deliberately does
not take on Codex cloud/app lifecycle management or thread runner integration.

## Goals / Non-Goals

**Goals:**

- Add `codex` as a normal mfz agent target.
- Render a managed Codex config snapshot under `configs/<profile>/codex/`.
- Apply Codex user config with a local merge strategy that preserves user-owned
  Codex state.
- Reuse the existing mfz catalog/profile model for Codex MCP, guidance, references,
  extra folders, and skill targeting.
- Keep the first implementation narrow enough to test with existing apply, status,
  doctor, sync, and skill-toggle flows.

**Non-Goals:**

- Managing Codex cloud tasks, cloud environments, desktop app settings, import flows,
  or plugin marketplace installation.
- Generating project-local `.codex/` configuration.
- Adding Codex to `mfz thread` dispatch or session ingestion.
- Translating OpenCode commands into Codex prompts. Codex prompts are deprecated in
  favor of skills, so this change does not create a prompt renderer.
- Replacing the existing generated reference/extra-folder indexes with
  tool-specific native reference configuration.

## Decisions

### Codex is a third agent target

The manifest `agents` enum becomes `["opencode", "claude-code", "codex"]`.
Default agents become all three targets unless a profile overrides `agents`.
Default skill and MCP targets continue to resolve to the profile's resolved
agent list rather than a hardcoded list.

**Alternative considered:** add a separate `codex_enabled` flag. Rejected because
agent gating, skill targeting, MCP targeting, apply filtering, and status reporting
already use a common agent abstraction.

### Codex profile config is TOML pass-through

Add `profile.codex.config` as a nested record rendered to TOML. This mirrors
`opencode.config` and `claude.settings`: mfz validates the outer manifest shape but
does not try to exhaustively model every Codex configuration key.

**Alternative considered:** encode every Codex config option in Zod. Rejected
because Codex config is broad and changes quickly; pass-through keeps mfz stable
while still producing a valid managed snapshot.

### Apply uses merge, not symlink

`configs/<profile>/codex/config.toml` is the managed snapshot. During real apply,
mfz reads the existing `~/.codex/config.toml`, deep-merges profile-managed keys on
top, writes the merged local file, and preserves unrelated user-owned keys.

This follows Claude Code's `settings.json` pattern rather than OpenCode's symlink
pattern. Codex user config can contain local plugin/app controls, project trust,
provider settings, and other user choices that mfz should not delete.

**Alternative considered:** symlink `~/.codex/config.toml` to the managed snapshot.
Rejected because it makes mfz the owner of the entire user Codex config file.

### Codex guidance is global AGENTS.md

The renderer writes `configs/<profile>/codex/AGENTS.md` from the same generated
AGENTS source used by other targets, then installs it as `~/.codex/AGENTS.md`.
It does not write `AGENTS.override.md`.

**Alternative considered:** use `AGENTS.override.md` so mfz always wins. Rejected
because override files are a blunt temporary escape hatch; a managed default should
compose with repo AGENTS files rather than bypass them.

### MCP rendering targets Codex `[mcp_servers]`

The Codex renderer filters resolved MCP entries for `codex` and emits them under
`[mcp_servers.<name>]`:

- Local stdio servers become `command` plus `args` split from the shared command
  array, with `env` copied when present.
- Remote HTTP servers become `url` plus static headers when present.
- The profile's `enabled` flag is rendered where Codex supports an enabled flag.

**Alternative considered:** require users to configure Codex MCP separately through
`codex mcp add`. Rejected because MCP catalog/profile targeting is a core mfz
capability and should remain tool-neutral.

### Extra folders render as a named Codex permission profile

Codex has both legacy sandbox fields and newer named permission profiles. The
renderer should generate a named profile, e.g. `permissions.mfz`, and set
`default_permissions = "mfz"` when it has generated filesystem rules. The profile
maps `references_dir` to read-only access and `extra_folders` to read/write/deny
according to their existing mfz read/edit values.

**Alternative considered:** use `sandbox_workspace_write.writable_roots`. Rejected
because that does not express read-only and deny semantics as cleanly as Codex
permission profiles.

### Codex skill toggles use config entries only when paths are known

Codex discovers skills from `.agents/skills`, `$HOME/.agents/skills`, admin, and
system scopes. Its config disables skills through `[[skills.config]]` entries keyed
by `path = "/path/to/SKILL.md"`. mfz can support Codex toggles only when it can
resolve the installed skill's `SKILL.md` path.

For this change, Codex skill targeting is allowed in manifests, but local toggle
write behavior must fail clearly for unresolved paths rather than inventing one.

**Alternative considered:** write synthetic names into Codex config. Rejected
because Codex's documented override key is path-based, not name-based.

### Codex profile files are not used initially

Codex supports `$CODEX_HOME/<profile>.config.toml` selected with `codex --profile`,
but mfz already has a profile selection layer. The renderer writes only the managed
base config snapshot for the selected mfz profile.

**Alternative considered:** render one Codex profile file per mfz profile. Rejected
for the first implementation because nested profile selection would complicate apply
and sync without solving a current need.

## Risks / Trade-offs

- **TOML merge semantics may differ from JSON merge semantics** -> keep merge behavior
  intentionally simple: merge plain objects/tables recursively and replace arrays or
  scalar values with managed values.
- **Codex config keys may change** -> use pass-through config and focused rendering for
  only the keys mfz derives.
- **Generated permission profile could override user default permissions** -> set
  `default_permissions` only when mfz generates a permission profile, and preserve
  unrelated user-defined permission profiles during local merge.
- **Skill toggles may not know installed Codex paths** -> expose a clear unsupported
  path error until the skills adapter can provide canonical installed SKILL.md paths.
- **MCP auth variants differ across tools** -> start with the existing shared MCP
  model (local command, remote URL, env, headers) and avoid inventing Codex-specific
  OAuth fields in this change.
- **Codex project-local config remains unmanaged** -> accept this as a deliberate MVP
  boundary; user-level config is enough for parity with current mfz global rendering.

## Migration Plan

1. Extend schemas and profile resolution to include `codex`.
2. Add the Codex renderer and integrate it into render dispatch, apply, status, and
   doctor.
3. Add local TOML merge/write support for `~/.codex/config.toml` and AGENTS install.
4. Add Codex sync detection for unmanaged managed-snapshot keys.
5. Extend skill target/toggle plumbing for Codex.
6. Regenerate JSON schemas and update architecture/docs.
7. Validate with focused integration tests and `pnpm build`.

Rollback: remove `codex` from profile `agents` and rerun apply. The renderer should
stop producing Codex output for default apply, while any existing `~/.codex/config.toml`
remains user-local and can be edited manually.

## Open Questions

- Should the default base profile include `codex` immediately, or should Codex be
  opt-in for `personal` first until the renderer is proven locally?
- Should mfz install `~/.codex/AGENTS.md` by writing a local file or by symlinking to
  `configs/<profile>/codex/AGENTS.md`?
- What installed-skill path source should the Codex skill-toggle implementation use
  for git-sourced skills installed by `npx skills`?
