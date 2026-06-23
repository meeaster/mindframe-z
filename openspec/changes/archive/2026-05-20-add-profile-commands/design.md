## Context

mindframe-z renders profile-aware configuration for AI coding tools (OpenCode, Claude Code). Currently it manages skills, MCP servers, references, plugins, and dotfiles through profiles. OpenCode custom commands (slash commands defined as markdown files) have no profile support — they exist only as project-local files in `.opencode/commands/` or must be manually placed in `~/.config/opencode/commands/`.

The existing render pipeline copies plugin files from `opencode/plugins/` by name matching the profile's `opencode_plugins` array, then symlinks the config file. This pattern can be reused for commands — the main difference is that commands output a directory of markdown files rather than TypeScript plugin files.

## Goals / Non-Goals

**Goals:**
- Profiles can list command names in a `commands:` array (additive on merge, deduplicated)
- Enabled commands are rendered to `.runtime/<profile>/opencode/commands/` during `apply`
- `~/.config/opencode/commands/` is symlinked to the runtime commands directory
- `status` shows enabled commands
- `sync` detects command files in `opencode/commands/` not referenced by the active profile

**Non-Goals:**
- Git-sourced commands (commands are always local markdown files)
- Cross-tool command support (commands are OpenCode-only, no `targets` field needed)
- Inline commands in `opencode.jsonc` (we render files, not JSON command entries)
- Auto-discovery from `.opencode/` directory (that directory is OpenSpec's workspace, not a mindframe-z source)

## Decisions

### 1. Source directory: `opencode/commands/`

**Choice:** Commands live in `opencode/commands/<name>.md` at the repo root, parallel to `opencode/plugins/`.

**Alternatives considered:**
- `.opencode/commands/` — This is OpenSpec's workspace; mixing concerns with mindframe-z source management.
- `shared/commands.yml` manifest — Overkill. Commands are simple markdown files that don't need metadata (no repo URL, no installer, no targets). The `opencode_plugins` pattern proves that a flat file directory + profile name list is sufficient.

**Rationale:** Mirrors the proven `opencode/plugins/` pattern. No new manifest file. No git source complexity. The profile YAML is the only registry needed.

### 2. Profile field: `commands: string[]`

**Choice:** Add `commands` as a top-level array in the profile schema, additive on merge like `skills` and `opencode_plugins`.

**Rationale:** Consistent with existing profile fields. Child profiles add commands on top of the base. Deduplicated via the same `dedupe()` utility.

### 3. Render: copy + symlink directory

**Choice:** `collectCommandFiles()` walks `opencode/commands/`, filters by profile `commands` list, copies matching `.md` files to `.runtime/<profile>/opencode/commands/`. A single symlink points `~/.config/opencode/commands/` at the runtime directory.

**Alternatives considered:**
- Individual file symlinks — More complex, harder to clean up stale links.
- Inline into `opencode.jsonc` `command` key — Requires YAML frontmatter parsing, loses markdown format, couples command lifecycle to config file edits.

**Rationale:** Directory symlink is clean and matches how OpenCode discovers commands. The symlink logic already handles backup of existing directories/files.

### 4. Sync: detect orphaned command files

**Choice:** `sync` scans `opencode/commands/*.md` for files whose basename (minus `.md`) is not in the active profile's `commands` list. Offers to add them to a chosen profile.

**Rationale:** Catches the "I wrote a new command but forgot to add it to the profile" case. Mirrors how skill sync works — detect unmanaged assets, offer to register them.

### 5. Exclude `.opencode/` from mindframe-z source discovery

**Choice:** mindframe-z never reads from `.opencode/commands/` or `.opencode/skills/` for profile management.

**Rationale:** `.opencode/` is OpenSpec's workspace. Commands and skills managed by mindframe-z belong in `opencode/commands/` and `skills/` respectively. This keeps a clean boundary between tool-specific convention and profile management.

## Risks / Trade-offs

- **Directory symlink replaces existing `~/.config/opencode/commands/`** — If the user has manually placed command files there, the backup mechanism renames the old directory and symlinks in its place. This is consistent with how the config file symlink works, but it's a directory-level operation rather than file-level. Mitigation: the existing backup logic already handles this case with user confirmation.

- **Command name collisions across profiles** — If `base` and `personal` both list the same command name, `dedupe()` handles it. No risk.

- **Stale symlinks on profile switch** — Switching profiles re-renders and re-links. The symlink target changes. This is consistent with existing behavior for `opencode.jsonc`.

- **OpenCode reads commands from both global and project-local** — When working in the mindframe-z repo itself, OpenCode would discover commands from both `~/.config/opencode/commands/` (profile-managed) and `.opencode/commands/` (project-local). This is by design — project-local commands are always available. When working in other repos, only profile-managed global commands are available. Mitigation: move project-local commands to `opencode/commands/` and register them in profiles so they're available globally.