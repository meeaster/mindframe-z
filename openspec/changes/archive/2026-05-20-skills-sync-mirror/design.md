## Context

`mfz skills` currently has three subcommands: `list` (read-only), `apply` (install missing), and `update` (refresh git skills). There is no removal path. When a user removes a skill from their profile YAML and runs `mfz skills apply`, the skill remains installed in `~/.agents/skills/` and `~/.claude/skills/`. This violates the architecture principle that manifests are source of truth and tool-level state is a rendered output.

The `npx skills` CLI already supports `remove` with agent filtering (`-a <agent>`), global scope (`-g`), and skip-confirm (`-y`). The same mechanism used to install can cleanly uninstall.

## Goals / Non-Goals

**Goals:**
- One command (`mfz skills sync`) to make installed global skills match the resolved profile
- A separate update command for refreshing existing git skills (`mfz skills upgrade`)
- A way to disable inherited skills via empty target list (`skillName: []`)
- Remove the now-redundant `mfz skills apply` and `mfz skills update` commands

**Non-Goals:**
- Project-scoped skill management (only global)
- Interactive removal confirmation (just goes; `--dry-run` available)
- Skill pinning or version locking
- Tracking user-installed non-profile skills (unmanaged skills are removed during sync)

## Decisions

### Command rename: `apply` → `sync`, `update` → `upgrade`

- `apply` was install-only and misleading
- `sync` clearly communicates two-directional reconciliation
- `upgrade` avoids confusion with `sync` and mirrors package-manager convention

### Sync never updates

`mfz skills sync` only reconciles set membership. It never calls `npx skills update`. This keeps profile changes predictable — removing a skill from YAML and syncing won't unexpectedly pull new versions of other git skills.

### Upgrade never reconciles membership

`mfz skills upgrade` only runs `npx skills update` for git-sourced profile skills. It does not add/remove skills.

### Disabled skills use empty array

```yaml
skills:
  homeassistant: []
```

An empty target list means the skill is explicitly disabled, overriding any inherited enablement. This is the smallest schema change — no new field, no new type union.

Schema change: `profileSkillTargetsSchema` currently requires `min(1)`. Remove that constraint. `expandSkillTargets` already returns filtered targets; an empty input naturally produces an empty output. Jobs that iterate `enabledSkills` already filter on `entry.targets.includes(target)`, so an empty target array naturally excludes the skill from all targets.

### Unmanaged skills are removed

The architecture says manifests are source of truth. If a skill is installed but not in the resolved profile, `sync` removes it. There is no skip/prompt/keep path during sync — if you want a skill installed, put it in your profile. The `mfz sync` (top-level) command remains available for promoting unmanaged skills back into profiles before syncing.

## Risks / Trade-offs

- **Destructive by default**: Users who installed skills manually without adding them to profiles will lose them on `mfz skills sync`. → Mitigation: `--dry-run` shows what would happen. Users should run `mfz sync` first to discover and promote unmanaged skills.
- **npx skills remove behavior**: Multi-agent removal behavior depends on `npx skills` internals. → Mitigation: We run remove per-agent per-skill with explicit `-a <agent> -g -y` flags.
- **No undo**: Removed skills are gone unless reapplied. → Mitigation: `--dry-run` preview before committing.
