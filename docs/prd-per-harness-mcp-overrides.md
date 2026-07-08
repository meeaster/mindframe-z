# PRD: Per-Harness MCP Defaults and Launch-Time Overrides

## Problem Statement

I keep rarely-used MCP servers installed but disabled, and flip them on only when a session needs them. That workflow exists in Claude Code (`/mcp`, sticky per project) and OpenCode (session toggle), but Codex has no runtime toggle at all — its config flag is the toggle, and mindframe-z owns that config, so any hand-flip is clobbered on the next apply. I also cannot express different default states per harness (jira on by default in codex, off elsewhere) because a server's enabled state is one boolean across all harnesses. Finally, project-scoped toggles today write into files inside the repository that a team may legitimately own and track — on a contract repo, my tooling must not dirty or overwrite project config.

## Solution

Profiles declare, per MCP server, exactly which harnesses it exists on and its default state on each — one map, no separate availability field. All deliberate per-project drift (MCP and skills) lives in a single mfz-owned override store keyed by project path, never in the repo. Managed shell launchers shadow the harness commands under their usual names and inject the current project's overrides at session start through each harness's native launch-time layer, so "select the MCP before the session" becomes: toggle with `mfz mcp`, then launch as usual. Claude Code's native `/mcp` workflow stays exactly as it is.

## User Stories

1. As a multi-harness user, I want an MCP server enabled by default in codex but disabled by default in opencode, so that each harness starts with the setup that fits how I use it.
2. As a profile author, I want availability and default state in one `agents` map per server, so that I cannot declare contradictory availability/enabled combinations.
3. As a profile author, I want a child profile to flip one harness's default without restating the whole entry, so that work and personal profiles stay small.
4. As a profile author, I want validation to reject `claude-code: false`, so that I cannot declare a state Claude Code cannot represent.
5. As a codex user, I want to enable a rarely-used MCP server for the current project before launching, so that I get the toggle workflow codex's TUI lacks.
6. As a codex user, I want that override injected at launch rather than written into managed config, so that `mfz apply` and my toggles never fight.
7. As a consultant on a contract repo, I want project-scoped toggles to write nothing inside the repository, so that I never dirty or overstep the team's checked-in harness config.
8. As an opencode user, I want a persistent per-project MCP override, so that I don't re-toggle the same server every session.
9. As a Claude Code user, I want my existing `/mcp` per-project toggles preserved across every apply, so that adopting this change costs me nothing.
10. As a user, I want `mfz mcp enable <name>` to apply to every harness the server exists on unless I narrow it, so that one command covers the common case.
11. As a user, I want an error when I enable a server for a harness it isn't available on, so that impossible overrides are caught at write time, not at harness startup.
12. As a user, I want toggling a value back to its profile default to erase the override, so that the store only ever records drift.
13. As a user, I want `mfz mcp status` to show effective per-harness state with overrides marked, so that I can always answer "did I leave jira on here?".
14. As a user, I want an MCP TUI with the same interactions as the skills TUI, so that I don't learn a second interface.
15. As a skills user, I want project-scoped skill toggles stored the same way as MCP overrides, so that one mental model covers both.
16. As a skills user, I want global skill toggles to keep working exactly as today, so that sessions launched outside my shell still see them.
17. As a user, I want the launchers to keep the commands named `codex`, `opencode`, and `claude`, so that my muscle memory and scripts keep working.
18. As a user, I want a launcher to run the real binary untouched when there are no overrides, no store, or no jq, so that a broken store can never block launching a harness.
19. As a user whose secrets stay in env vars, I want codex to receive secret headers as env-var indirection, so that a literal `{env:VAR}` placeholder is never sent to an MCP server.
20. As a sandbox user, I want the same override store to be consumable when containers are provisioned, so that per-project selection follows me into containerized sessions later.
21. As a future contributor, I want overrides validated on read and written atomically, so that a hand-edit typo aborts loudly instead of silently truncating my state.
22. As a profile author, I want skill entries to use the same `agents` map as MCP entries, so that one schema shape expresses availability and per-harness defaults for both catalogs.
23. As a multi-harness user, I want a skill enabled by default in one harness and disabled by default in another, so that profile defaults match how the runtime already treats skills per-harness.

## Implementation Decisions

- Profile MCP entries and skill entries carry a single `agents` map: harness key present = available, boolean value = profile default. The legacy enabled/targets pair (and for skills, the `all` token and bare null entries) is removed with no compatibility parsing (pre-release clean cut). Values are YAML booleans, not on/off strings, to avoid YAML 1.1/1.2 boolean ambiguity.
- Skills differ from MCP in two ways: `claude-code: false` is valid (every harness supports config-level skill disabling), and `toggleable` remains a sibling scalar — it governs the toggle surface, not defaults.
- `claude-code: false` fails manifest validation: Claude Code's expressible states for user-scope servers are present-enabled or absent; its per-project disable state is harness-owned and preserved, never seeded.
- Profile defaults are enforced: apply re-asserts them in rendered configs. Deliberate drift is recorded exclusively as overrides — per-project, per-harness deltas that are deleted when they equal the default.
- The override store is one machine-level JSON document keyed by project root (modeled on Claude Code's own per-project state file), holding intent (name -> boolean per harness, for MCP and skills) plus pre-rendered launch payloads. Payloads re-render on every toggle and every apply so they always reflect current defaults. Storage is per-harness because the toggle command owns target knowledge; launchers stay dumb.
- Payloads exist because codex's skills config is an array that its layer merge replaces wholesale — a launcher cannot delta it, so mfz renders the full value ahead of time. Launchers reduce to a single jq read.
- Injection uses each harness's native session-scoped layer: codex dotted `-c` config flags (which deep-merge over user and project files), opencode's config-content environment variable (merged last), claude's `--settings` CLI layer (skills only; no MCP flags for claude).
- Launchers are managed zsh functions (functions, not aliases — aliases cannot compute) shadowing the real commands; they exec the real binary via `command`. Sessions bypassing them see profile defaults plus global toggles — accepted degradation, surfaced by status commands.
- Codex rendering translates `{env:VAR}` header references into codex's env-header indirection field; codex performs no string templating, so literal emission would leak the placeholder as the header value.
- Skills alignment migrates project scope only; global-scope toggles remain baked into rendered configs at apply so launcher-bypassing sessions keep them. Repo-file writes and the git-exclude machinery are deleted.

## Testing Decisions

- Test at the existing top seam: CLI integration tests that run `mfz` commands against a temporary repo root and home, asserting rendered config files and store contents — the established pattern for apply/skills coverage in this codebase. No new code seams are introduced; the override store module gets focused unit tests for delta semantics, corrupt-file aborts, and payload re-rendering.
- Launchers are verified at the same seam by asserting the rendered managed zsh content, plus a manual end-to-end smoke (toggle, launch, observe the server initialize; bypass launch, observe defaults). Shell-level injection is deliberately not simulated in CI.
- Good tests here assert external behavior — file contents, command output, exit codes — not internal helper calls; renderer characterization follows the existing apply integration tests.
- Schema tests cover: legacy field rejection, claude-code-false rejection, inheritance merging per harness key.

## Out of Scope

- Sandbox consumption of the override store (baking merged config into containers at provision time) — deliberate follow-up; the store shape is designed for it.
- Claude Code MCP launch injection (`--mcp-config`); no current server needs "available but default-off" on claude.
- Merging the skills and MCP TUIs into one surface (both read the same store; unification can come later).
- Any backward compatibility for the old profile schema.

## Further Notes

- Grounding was source-verified during design: codex layer precedence, read-only `/mcp`, array-replacing merges, and the absence of any by-convention-untracked codex project file were confirmed against the codex repository (cloned as a reference); opencode's config-content merge order against the opencode reference; claude flag behavior against the installed CLI and official docs.
- One verification gate before wiring the claude launcher: confirm `skillOverrides` is honored via `--settings`; the fallback (keep claude's conventionally-untracked local settings file for project skill toggles) is recorded in the change's design doc.
- Domain vocabulary used here (Harness, Profile default, Override, Launcher) is defined in CONTEXT.md.
- Full spec-level detail lives in the openspec change `per-harness-mcp-overrides`.
