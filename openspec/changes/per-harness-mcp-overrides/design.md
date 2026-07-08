## Context

mindframe-z renders managed config for three harnesses. MCP profile entries are `{ enabled: boolean, targets?: harness[] }` resolved in `src/core/profile.ts` (`filterMcpForTarget`); `enabled` means different things per harness today — opencode renders it, codex renders and re-asserts it on every apply, claude-code ignores it. Skill toggling (`src/tui/skill-toggle-state.ts`, `src/core/skill-overrides.ts`) is delta-based with two scopes; its repo scope writes into files teams may track.

Source-verified harness facts this design relies on:

- **codex** (`openai/codex` @ main 2026-07-07): `[mcp_servers.*].enabled` defaults true; disabled servers are never spawned (`connection_manager.rs`). Config layers deep-merge at raw-TOML level; `-c key=value` session flags (precedence 30) beat user (20) and project (25) files. TUI `/mcp` is read-only; no config reload. Profiles cannot contain `mcp_servers`. Config rejects unknown fields and never interpolates values; secrets flow via `env_http_headers` / `bearer_token_env_var` / `env_vars`. There is no by-convention-untracked project config file.
- **opencode**: `OPENCODE_CONFIG_CONTENT` (JSON string env var) is merged last as a local-scope layer (`packages/opencode/src/config/config.ts`), deep-merging partial `mcp.<name>` and `permission.skill.<name>` entries.
- **claude-code**: `--mcp-config` adds servers for a session; `--settings <file-or-json>` loads settings at CLI-arg precedence (above all settings files). Runtime MCP toggle state lives in `~/.claude.json` `projects.<path>.disabledMcpServers` — one file keyed by project path, which this design mirrors.

## Goals / Non-Goals

**Goals:**

- Per-harness MCP availability and default-enabled state declared in profiles.
- A pre-launch toggle workflow ("select the MCP before the session") uniform across codex and opencode, without writing files into project repos.
- One storage shape for MCP and skill project overrides; skills migrate onto it.
- Preserve claude-code's native `/mcp` workflow untouched.

**Non-Goals:**

- Sandbox consumption of the override store (`mfz sandbox up` baking merged container config) — follow-up change.
- Backward compatibility for the old `mcp`/`skills` profile schemas — this repo is pre-release; clean cut.
- Claude-code MCP launch injection (`--mcp-config`) — no current server needs "available but default-off" in claude.

## Decisions

### D1: `agents` map replaces `enabled` + `targets` — for MCP entries and skill entries

`agents: Record<harness, boolean>` — presence = availability, value = default state. Chosen over `enabled: bool | map` + `targets` (two fields that must agree) and over an `enabled_for` override map (three fields, two concepts). The map also merges better through profile inheritance: `deepMerge` combines per-key, so a child profile can flip one harness without restating the entry, where `targets` arrays replaced wholesale. Values are YAML booleans, not `on`/`off` strings (YAML 1.1/1.2 ambiguity). For MCP entries, `claude-code: false` fails validation because the state is inexpressible in claude's model — its honest states are present (on, user may toggle per-project in-harness) or absent.

Skill entries adopt the identical map: the runtime already models skills per-harness (toggle state, overrides, TUI are per-target) — only the profile default was scalar. Differences from MCP: `claude-code: false` is valid (all three harnesses support config-level skill disabling), and `toggleable` remains a sibling scalar — it governs the toggle surface, not defaults, and no per-harness toggleability has been needed. The `all` token and legacy `null` entries are removed; the cost is verbosity (~40 base skill entries gain a flow-style map line), accepted for one schema shape and no shorthands, consistent with the MCP decision.

### D2: profile = enforced defaults; drift lives only in the override store

`mfz apply` re-asserts profile defaults into rendered configs (codex/opencode `enabled` flags). Hand-edits to rendered files are not preserved (unchanged from today). Deliberate deviations are recorded as overrides — deltas keyed by project path; an override equal to the profile default is deleted, so the store only ever records drift (same semantics as `writeSkillOverrideDelta`).

### D3: one override file, keyed by project path, per-harness sections

`~/.mindframe-z/overrides.json`: `projects.<repo-root>.<harness>.{mcp, skills}` intent maps plus pre-rendered payloads. Modeled on `~/.claude.json` `projects` — one file per machine, not per repo. Per-harness (not harness-agnostic) because launchers are dumb: the toggle command expands a server to its targeted harnesses at write time, where target knowledge lives; a harness-agnostic entry would let the codex launcher inject `-c mcp_servers.X.enabled=true` for a server absent from codex's config, creating a partial entry that fails codex config validation at startup.

### D4: intent + pre-rendered payloads in the same file

Alongside intent, mfz renders per-harness injection payloads at toggle time and re-renders them on `mfz apply` (profile shifts change what a delta means): `argv` for codex (`-c` args), `config` JSON for opencode (`OPENCODE_CONFIG_CONTENT`), `settings` JSON for claude (skills only). Needed because codex skills live in a `skills.config` **array** — codex layer merges replace arrays wholesale, so a launcher cannot delta it; the payload carries the full rendered array. Keeps launchers to a single `jq` read with zero logic.

### D5: launch-time injection via managed zsh functions, not repo files

Functions (not aliases — aliases cannot compute) shadow `codex`/`opencode`/`claude` under the same command names and inject via each harness's native session-scoped layer. Chosen over writing repo-local config because codex/opencode project files are plausibly team-tracked — `.git/info/exclude` is a no-op for tracked files, and mfz must not dirty project-owned config on contract repos. Claude's launcher injects `--settings` for skill overrides only.

### D6: skills alignment — project scope migrates, global scope stays

Project-scoped skill toggles move to the override store and launchers; the repo-file write paths and git-exclude machinery in `skill-config-paths.ts` are deleted. Global-scope toggles keep today's apply-baked behavior so sessions bypassing the launcher (IDE spawns, scripts) still see them — the failure mode of migrating everything is silent, environment-dependent divergence; the failure mode of layering is merely "two places to look", surfaced by `mfz mcp status` / `mfz skills status` printing the merged view.

### D7: codex secret headers render as env indirection

`renderCodexMcp` maps a catalog header value `{env:VAR}` to `env_http_headers = { <header> = "VAR" }`; literal values stay in `http_headers`. Codex never templates strings, so the current literal emission would send `{env:EXA_API_KEY}` verbatim.

## Risks / Trade-offs

- [Launcher bypass: sessions not started through zsh functions silently see defaults + global toggles only] → Accepted by design (D6 keeps globals baked); status commands print the merged truth; launchers are rendered into managed zsh which this machine already uses everywhere.
- [Claude `skillOverrides` via `--settings` is unverified] → Verify during implementation with a throwaway session before wiring the claude launcher; if unsupported, claude project-scoped skill toggles keep writing `.claude/settings.local.json` (the one repo file that is by-convention untracked).
- [Corrupt/hand-edited overrides.json] → Validate with a zod schema at every read; atomic write (temp + rename); a parse failure aborts the toggle rather than truncating state.
- [`jq` dependency in launchers] → Guard in the function: if `jq` or the store is missing, exec the real binary unmodified.
- [Codex `-c skills.config=[...]` payload grows large] → Only rendered when a project has codex skill overrides; absent otherwise.
- [Force-asserting `enabled` on codex apply clobbers hand-edits to `~/.codex/config.toml`] → Intended (D2); the supported paths are profile edit, `mfz mcp`, or per-session launcher injection.

## Migration Plan

1. Schema + resolver + renderers land together with profile migrations (`profiles/*/profile.yml` rewritten to `agents` maps) — repo is pre-release, single commit, no fallback parsing.
2. Override store + `mfz mcp` + launcher rendering land next; skills repo-scope migration last, deleting the repo-file paths.
3. Rollback = revert; the override store file is additive and ignorable by older code.

## Open Questions

- Exact overrides file name/location (`~/.mindframe-z/overrides.json` assumed).
- Whether `mfz skills` TUI and `mfz mcp` TUI merge into one surface now or later (later is assumed; both read the same store).
