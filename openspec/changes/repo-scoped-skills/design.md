## Context

Skill toggle state is currently always written to project-local config files:
- OpenCode: `.opencode/opencode.jsonc` → `permission.skill`
- Claude Code: `.claude/settings.local.json` → `skillOverrides`

The `config-io.ts` module derives file paths from `paths.root` (the mindframe-z repo root), with no awareness of whether the user is inside a git repository. This works when `mfz skills` is always run from within a project, but breaks when run outside a repo — it creates orphaned local config files in non-project directories.

OpenCode supports layered config: global (`~/.config/opencode/opencode.jsonc`) is merged with local (`.opencode/opencode.jsonc`), with local winning. Claude Code has a similar model: user (`~/.claude/settings.json`) vs local (`.claude/settings.local.json`). We should leverage this layering by writing skill toggles to the appropriate scope based on context.

## Goals / Non-Goals

**Goals:**
- Write skill toggles to local config when inside a git repo, global config when not
- Use `git rev-parse --show-toplevel` to find the actual repo root for local config placement
- Preserve existing `permission.skill` / `skillOverrides` in global config across `mfz apply` runs
- Maintain current behavior for in-repo usage (no user-visible change)

**Non-Goals:**
- Changing how `mfz apply` renders non-skill permissions (bash, edit, external_directory stay global-only)
- Changing how skills are installed (`npx skills add -g` stays global)
- Adding per-project skill installation (skills remain globally installed, visibility is per-scope)
- Changing the Claude Code renderer to write skill overrides during `apply`

## Decisions

### Decision 1: Use `git rev-parse --show-toplevel` for repo detection

**Choice**: Shell out to `git rev-parse --show-toplevel` from `process.cwd()`.

**Why**: This is the most reliable way to detect the git repo root. It handles:
- Subdirectories within a repo (always returns the root)
- Git worktrees (returns the worktree root)
- Non-repo directories (exits non-zero)

**Alternatives considered**:
- Walking up from cwd looking for `.git/`: Reimplements git logic, fragile with worktrees/submodules
- Using `paths.root`: This is the mindframe-z repo root, not the user's current project. Wrong semantics.
- Using a flag (`--global`/`--local`): Adds CLI complexity when detection is automatic and reliable

### Decision 2: Add a `resolveSkillConfigTarget` helper

**Choice**: Add a function to `config-io.ts` that returns the config paths for a given scope.

```typescript
interface SkillConfigPaths {
  opencode: string;      // path to opencode config file
  claude: string;        // path to claude settings file
  isRepo: boolean;       // whether we're in a repo
  repoRoot?: string;     // git repo root if in a repo
}

async function resolveSkillConfigPaths(runtimePaths: RuntimePaths): Promise<SkillConfigPaths>
```

**Why**: Centralizes the detection logic. All read/write functions call this instead of deriving paths independently. Makes testing easier (mock one function).

### Decision 3: Global OpenCode skill writes preserve existing `permission` keys

**Choice**: When writing `permission.skill` to the global OpenCode config, read the existing file first and merge. Only the `permission.skill` key is touched; other keys are preserved.

**Why**: `mfz apply` writes the global OpenCode config. If we blindly overwrite it with just `{ permission: { skill: {...} } }`, we'd destroy instructions, MCP, plugins, etc. We need to merge.

**Alternative considered**: Write skill overrides to a separate file. Rejected because OpenCode doesn't support multiple config file paths for the same scope.

### Decision 4: Global Claude Code skill writes go to `settings.json` (not `settings.local.json`)

**Choice**: When outside a repo, write `skillOverrides` to `~/.claude/settings.json`.

**Why**: Claude Code's scope model is user > project > local. Outside a repo there's no project or local scope, so user-level is correct. The Claude renderer already deep-merges into `~/.claude/settings.json` via `readExistingSettings()`, so `skillOverrides` written by the skills command will be preserved across `apply` runs (the renderer doesn't set `skillOverrides` itself).

### Decision 5: `ensureGitExcluded` only runs in repo scope

**Choice**: Skip `ensureGitExcluded` when writing to global config. It only makes sense for local config files that live inside a repo.

**Why**: Global config files (`~/.config/opencode/`, `~/.claude/`) are never in a repo's working tree, so there's nothing to exclude.

## Risks / Trade-offs

**[Risk] `git rev-parse` adds subprocess overhead** → Mitigation: Only called once per `mfz skills` invocation. Git is fast for this query (<10ms). The result can be cached for the duration of the command.

**[Risk] Race between `mfz apply` and `mfz skills` on global config** → Mitigation: Same risk exists today for local config. Low probability since these are interactive commands. Document that `apply` overwrites global config (except preserved `permission.skill` / `skillOverrides`).

**[Risk] Non-repo users lose per-directory skill state** → Mitigation: This is expected. Outside a repo, toggles are global. If a user wants per-project toggles, they run `mfz skills` from within the project.

**[Trade-off] `git rev-parse` fails if git is not installed** → Fallback: Treat as non-repo, write to global. This matches current behavior where `ensureGitExcluded` already silently handles missing `.git/`.
