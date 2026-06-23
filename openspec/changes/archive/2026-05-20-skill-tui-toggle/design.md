## Context

Today, mindframe-z manages AI tool skills via `mfz skills sync`, which installs skills globally to `~/.claude/skills/` and `~/.agents/skills/` using `npx skills`. Profile YAML declares which skills are available for which targets (`[opencode]`, `[claude-code]`, etc.). Both OpenCode and Claude Code discover installed skills by scanning their respective directories.

The problem: all installed skills appear in every session. OpenCode injects every skill's name and description into `<available_skills>` in the system prompt on every turn. Claude Code lists all skills in its context. Most skills are task-specific and sit idle, wasting context window budget. There is no per-project mechanism to hide skills without uninstalling them globally.

### Current flow
```
profile YAML → resolveProfile() → enabledSkills[] → mfz skills sync → npx skills install
                                                       ↓
                                              global disk (~/.agents/skills/)
                                                       ↓
                                              OpenCode scans → all skills always visible
```

### Target flow
```
profile YAML (+ enabled defaults) → TUI reads → user toggles → writes
                                   ↗
                 ~/.agents/skills/ (installed, always present)
                                                            ↓
                 ┌──────────────────────────────────────────┐
                 │ .opencode/opencode.jsonc                 │
                 │   permission.skill.<name>: "deny"/"allow" │
                 │                                          │
                 │ .claude/settings.local.json               │
                 │   skillOverrides.<name>: "off"/"on"       │
                 └──────────────────────────────────────────┘
                                     ↓
                 OpenCode: denied skills excluded from <available_skills>
                 Claude Code: off skills hidden (hot-reloads instantly)
```

### Key constraints
- OpenCode needs restart to pick up opencode.jsonc changes (no hot-reload for config)
- Claude Code hot-reloads settings.local.json (instant feedback)
- `mfz apply` regenerates opencode.jsonc from profiles (would overwrite TUI changes) — so TUI must NOT flow through apply
- Must stay compatible with `npx skills` installation — skills remain installed, only visibility changes

## Goals / Non-Goals

**Goals:**
- User can enable/disable skills per-project via a TUI (like `opencode auth login` selector style)
- Disabled skills are hidden from the agent's system prompt (saves context)
- Toggle state is local, per-project, not committed (in `.gitignore` or tool-managed)
- Profile YAML declares default enabled/disabled state per skill
- CLI shortcuts for scripting (`mfz skills enable/disable`)

**Non-Goals:**
- Session-level toggle (mid-conversation) — OpenCode restart limitation
- Per-skill context budget management (CC-style `name-only` state) — binary on/off is sufficient
- Skill install/uninstall management — `mfz skills sync` remains the installer
- Integration with `mfz apply` — toggle is a separate, independent flow

## Decisions

### Decision 1: Profile skill schema gains `enabled: boolean` (mirrors MCP pattern)

**Chosen**: `{ enabled: boolean, targets?: [...] }` object per skill entry, replacing the current `null | [...]` union.

**Rationale**: MCP already uses `{ enabled: boolean, targets?: [...] }` in profiles. Using the same shape for skills creates a consistent mental model. The `enabled` field provides the default state for the TUI — most skills default to `false`, a few core skills default to `true`.

**Alternatives considered**:
- Don't add `enabled`, infer default from presence → TUI has no default to show, all skills appear "on" until user toggles
- New `skills_default_state` profile field → adds a second place to configure skills, confusing

**Migration**: Existing skill entries like `skillName: [opencode]` become `skillName: { enabled: true, targets: [opencode] }`. The empty-array pattern (`skillName: []`) is superseded by `enabled: false` and can be removed from the codebase.

### Decision 2: Toggle writes directly to local tool config files, NOT through mfz apply

**Chosen**: TUI reads/writes `.opencode/opencode.jsonc` and `.claude/settings.local.json` directly, merging its `permission.skill` or `skillOverrides` section with existing content. `mfz apply` is not involved.

**Rationale**: `mfz apply` regenerates opencode.jsonc from profiles and machine config — it would clobber local toggle state. Keeping toggle separate avoids this conflict entirely. The TUI only manages `permission.skill` (OpenCode) and `skillOverrides` (Claude Code) blocks; it leaves everything else in those files untouched.

**Alternatives considered**:
- Flow through mfz apply with a separate state file → adds complexity, requires mfz apply to merge three sources
- Write to `.mindframe/skills.json` and have mfz apply render from it → same problem, apply would need to know about local state
- File rename approach (SKILL.md → _SKILL.md) → fragile, breaks `npx skills` management, doesn't work well per-project

### Decision 3: TUI uses @clack/core (not ink, not raw readline)

**Chosen**: Subclass `@clack/core`'s `MultiSelectPrompt` to build a persistent toggle list. Reuse the `@clack/prompts` render function for checkbox styling.

**Rationale**: Clack's `MultiSelectPrompt` already has all the keyboard interactions (arrow keys, space toggle, a=all, i=invert), box-drawing styling, and sliding window for long lists. The only customization needed: override Enter to not submit, add save-on-demand (`s`) and quit (`q`), wire to config read/write. About 60-80 lines of code.

**Alternatives considered**:
- `@clack/prompts` multi-select as-is → one-shot, exits on Enter, no "persistent" feel
- `ink` (React for terminal) → heavier dependency (React runtime, ~200KB), more code
- Raw readline → would need to build checkbox rendering, cursor wrapping, and sliding window from scratch

### Decision 4: Sync installs all skills regardless of enabled state

**Chosen**: `mfz skills sync` installs every skill declared in the profile, even those with `enabled: false`. The `enabled` field only affects visibility (rendered as permission/override rules), not installation.

**Rationale**: If a disabled skill isn't installed, toggling it on requires running `mfz skills sync` first — adding friction to what should be an instant toggle. Installing everything upfront means the TUI toggle is instantaneous (just writes config, no install step).

### Decision 5: Skill merge changes from simple spread to deep merge

**Chosen**: Change `{ ...base.skills, ...child.skills }` to `deepMerge(base.skills, child.skills)` in `mergeProfiles()`.

**Rationale**: Currently a child profile that overrides one skill's targets replaces the entire entry — the parent's settings are lost. With the `enabled` field, partial overrides make sense (e.g., parent sets `enabled: false`, child just changes targets). Deep merge preserves both fields. MCP already uses deep merge — this brings skills in line.

**Behavior**: Child keys override parent keys at the leaf level. Example:
```yaml
# base:
skills:
  hunk-review: { enabled: false, targets: [opencode] }
# personal:
skills:
  hunk-review: { targets: [opencode, claude-code] }
# resolved:
skills:
  hunk-review: { enabled: false, targets: [opencode, claude-code] } # enabled preserved, targets overridden
```

### Decision 6: OpenCode uses permission.skill deny, Claude Code uses skillOverrides off

**Chosen**: Two different render targets for the same toggle action:

| Toggle state | OpenCode output | Claude Code output |
|---|---|---|
| Enabled | `permission.skill.<name>: "allow"` (or omitted) | `skillOverrides.<name>: "on"` (or omitted) |
| Disabled | `permission.skill.<name>: "deny"` | `skillOverrides.<name>: "off"` |

**Rationale**: These are each tool's native mechanism for hiding skills. OpenCode filters denied skills from `<available_skills>` via `Permission.evaluate("skill", name, ...)`. Claude Code hides `"off"` skills from both the model's context and the `/` menu. Using native mechanisms means we don't fight the tools.

## Risks / Trade-offs

- **[Risk] OpenCode needs restart for changes to take effect** → Mitigation: TUI shows a note "Restart opencode for changes to take effect." Claude Code hot-reloads instantly. Acceptable because user configures before session.
- **[Risk] TUI and mfz apply could conflict if both write to opencode.jsonc** → Mitigation: TUI only touches `permission.skill` block; mfz apply preserves existing permission rules (machine permission spread, line 118-120). They shouldn't overlap in practice.
- **[Risk] Profile YAML migration is breaking** → Mitigation: No external users (YAGNI). Update existing profiles in this repo as part of implementation.
- **[Risk] @clack/core adds a new dependency** → Mitigation: It's ~30KB, 2 transitive deps (sisteransi, fast-wrap-ansi). The project already depends on `execa`, `yaml`, `zod`, etc. — this is small by comparison.
- **[Trade-off] Binary on/off vs CC's 4-state system (on/name-only/user-invocable-only/off)** → Binary is simpler and sufficient for the stated problem (context window pressure from descriptions). Can extend later if needed.

## Open Questions

- Should `mfz doctor` validate that `.opencode/opencode.jsonc` permission rules match profile defaults? (Probably not — doctor validates manifests, not runtime state.)
- Should the TUI merge existing `skillOverrides` entries that were set outside mindframe-z (e.g., via CC's built-in `/skills` menu)? Yes — TUI reads current state, doesn't clobber unknown keys.
