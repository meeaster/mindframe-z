## Context

mindframe-z profiles currently have a `targets` field (`targets: [opencode, claude-code]`) that is declared in the Zod schema, merged through profile inheritance, and never enforced. The CLI's `--target` flag controls which renderers run, defaulting to `all` (all four render targets). The profile's `targets` field is inert.

Meanwhile, every skill and MCP entry in a profile requires an explicit `targets` list. For profiles like `personal` that only use opencode, every single entry repeats `[opencode]`. The `all` shorthand for skills resolves to a hardcoded `["opencode", "claude-code"]` regardless of what the profile actually uses.

The claude-code renderer always runs when `--target all` is used (the default), producing `configs/<profile>/claude/` files and symlinks into `~/.claude/` even for users who never use Claude Code.

## Goals / Non-Goals

**Goals:**
- Replace the dead `targets` field with a meaningful `agents` field that gates rendering
- Make skill and MCP targets default to the profile's agents when omitted
- Make `all` in skill targets resolve to the profile's agents, not a hardcoded list
- Skip rendering agent config entirely when that agent is not in the profile's agents list
- Reduce repetition in profile YAMLs

**Non-Goals:**
- Changing how mise or dotfiles rendering works (these are infrastructure, not agents)
- Adding new agent types beyond opencode and claude-code
- Changing the merge semantics for profile inheritance (agents still replaces parent if non-empty, same as targets did)
- Supporting per-agent overrides of the agents list at the machine level

## Decisions

### Decision 1: `agents` replaces `targets` on profile schema

**Choice**: Rename `targets` to `agents` with type `z.array(z.enum(["opencode", "claude-code"]))`, default `["opencode", "claude-code"]`.

**Alternatives considered**:
- Keep `targets` but enforce it: Confusing name — "targets" conflates render targets with agent targets, and includes mise/dotfiles which aren't agents
- Add `agents` alongside `targets`: Two fields for the same concept is worse than one clear one

**Rationale**: `agents` clearly communicates "which AI coding assistants this profile configures." Since the project has no external users yet (per AGENTS.md), a breaking rename is acceptable.

### Decision 2: Skill and MCP targets default to profile's agents

**Choice**: Make `targets` optional on skill entries (defaults to profile's `agents`) and on MCP config entries (defaults to profile's `agents`). Omitted means "all agents in this profile."

**Alternatives considered**:
- Default to empty/requiring explicit targets: This is the current pain point — forces repetition
- Default to all known agents (hardcoded list): Defeats the purpose of `agents`; a profile with `agents: [opencode]` that omits a target shouldn't get claude-code config

**Rationale**: In profiles with a single agent, most entries target that agent. Defaulting to the profile's agents eliminates the common case of repetition while still allowing explicit overrides.

### Decision 3: `all` in skill targets resolves to profile's agents

**Choice**: `expandSkillTargets(["all"], agents)` returns the profile's `agents` list, not hardcoded `["opencode", "claude-code"]`.

**Rationale**: A profile with `agents: [opencode]` and `some-skill: [all]` should install that skill only for opencode. The `all` keyword means "all of MY agents," not "all possible agents."

### Decision 4: Agent list gates rendering

**Choice**: The render pipeline filters which agent renderers run based on `profile.agents`. If `agents: [opencode]`, only the opencode renderer runs. The claude renderer is skipped entirely — no files, no symlinks, no local merged files.

**Alternatives considered**:
- Render all agents but skip symlinks: Leaves stale rendered files, confusing state
- Render all agents, just don't link: Same problem — files exist but aren't connected

**Rationale**: If an agent isn't in use, producing its config files at all is noise. Clean generation means only producing what's active.

### Decision 5: CLI flag reorganization

**Choice**: Introduce `--agent` flag for filtering agent renderers. Keep `--target` for non-agent renderers (mise, dotfiles). `mfz apply` with no flags renders all agents in the profile plus all infrastructure.

**Alternatives considered**:
- Keep `--target` for everything but check agents: Confusing — `--target claude-code` would succeed but produce nothing if `agents: [opencode]`
- Single `--only` flag replacing both: Too abstract; agents and infrastructure are conceptually different

**Rationale**: Separate flags for separate concerns. `--agent opencode` is clear. `--target mise` is clear. The default (no flags) renders everything the profile says it should.

### Decision 6: `opencode` and `claude` config sections remain in profile schema regardless of agents

**Choice**: The `opencode` and `claude` sections stay in the schema. If an agent isn't in `agents`, its config section is simply never read by a renderer. Inherited config from base profiles is harmless.

**Rationale**: Removing `claude` from the Zod schema would break profile inheritance for profiles that do use Claude. Keeping it inert is simpler than conditional schema shapes.

## Risks / Trade-offs

- **[Breaking change]** `targets` → `agents` is a breaking schema change. All profile YAMLs must be updated. **Mitigation**: No external users; breaking change is acceptable per project convention.
- **[Skill target resolution change]** `all` resolving to profile agents instead of hardcoded list changes behavior for any profile that uses `all` but has a different agents list than both. **Mitigation**: Base profile has `agents: [opencode, claude-code]` (both agents), so `all` resolves identically for base. Child profiles that restrict agents likely want this behavior.
- **[Stale rendered config]** If a user previously had `agents: [opencode, claude-code]` and changes to `agents: [opencode]`, old claude config files in `configs/<profile>/claude/` and symlinks into `~/.claude/` will be orphaned. **Mitigation**: `mfz apply` should clean up stale agent output. Alternatively, document that removing an agent from the list requires manual cleanup or a fresh `mfz apply --agent claude-code` to remove links first.
- **[CLI flag complexity]** Having both `--agent` and `--target` flags on `mfz apply` adds cognitive load. **Mitigation**: The common case is `mfz apply` with no flags. Explicit flags are power-user options.

## Open Questions

- Should `mfz apply` automatically clean up rendered files for agents removed from the agents list, or should that be a manual step?