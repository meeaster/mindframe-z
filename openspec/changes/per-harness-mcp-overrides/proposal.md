## Why

MCP servers currently carry a single `enabled` boolean across all harnesses, so a server cannot default on in codex but off elsewhere (e.g. jira). Codex also has no runtime MCP toggle — its TUI `/mcp` is read-only — so the "install rarely-used MCPs disabled, flip them on when needed" workflow that works in Claude Code and OpenCode has no codex equivalent. Meanwhile, repo-scoped skill toggles write into files that teams may check in (`.codex/config.toml`, `.opencode/opencode.jsonc`), risking clobbering project-owned config on contract repos.

## What Changes

- **BREAKING**: Profile `mcp` entries replace `enabled` + `targets` with a single `agents` map (`harness -> boolean`): presence = availability, value = per-harness default state. `claude-code: false` is rejected at validation (Claude Code has no config-level "installed but off" for user-scope servers). No backward compatibility or fallbacks.
- **BREAKING**: Profile `skills` entries adopt the same `agents` map, replacing `enabled` + `targets` (and the `all` token and legacy `null` entries). `toggleable` remains a sibling boolean. Unlike MCP, `claude-code: false` is valid — every harness supports config-level skill disabling.
- Per-project overrides for MCP servers and skills move to a single mfz-owned store keyed by project path (`~/.mindframe-z/overrides.json`), storing per-harness intent plus pre-rendered launch payloads. Overrides are deltas: an override equal to the profile default is removed.
- New managed zsh launcher functions shadow `codex`, `opencode`, and `claude`, injecting the current project's payloads at session start via each harness's native mechanism (`codex -c`, `OPENCODE_CONFIG_CONTENT`, `claude --settings`). Sessions launched without the launcher see profile defaults plus global toggles only.
- New `mfz mcp` toggle surface (CLI, TUI parity with skills) that expands a server to its targeted harnesses at write time.
- Repo-scoped skill toggling stops writing repo-local files (`.codex/config.toml`, `.opencode/opencode.jsonc`, `.claude/settings.local.json`) and the git-exclude machinery is removed; project-scoped skill overrides move to the override store. Global-scope skill toggling is unchanged.
- Codex MCP rendering fix: headers with `{env:VAR}` references render as `env_http_headers` (env-var indirection) instead of literal `http_headers` — codex never templates values.

## Capabilities

### New Capabilities

- `mcp-profile-defaults`: the `agents` map schema for profile MCP entries and per-harness rendering semantics (codex/opencode `enabled` flags, claude-code presence-only, `claude-code: false` rejection, codex env-header indirection).
- `local-override-store`: the single per-machine override file keyed by project path — per-harness MCP/skill intent, delta semantics, and payload re-rendering on toggle and on apply.
- `harness-launchers`: managed zsh functions that shadow harness commands and inject the project's payloads at launch; defined degradation when bypassed.
- `mcp-local-toggle`: `mfz mcp` enable/disable/status commands and TUI toggling, with target expansion at write time.

### Modified Capabilities

- `skill-local-toggle`: repo-scoped toggles no longer write repo-local config files; project-scoped skill overrides are stored in the override store and delivered by launchers. Global scope behavior is unchanged.
- `skill-profile-defaults`: the `{ enabled, targets }` shape (and legacy `null` entries) is replaced by the `agents` map with a sibling `toggleable`; per-harness defaults become expressible.

## Impact

- `src/core/manifests.ts` (mcp and skill profile schemas), `schemas/profile.schema.json` (regenerated), all `profiles/*/profile.yml` (migrated — every mcp and skill entry).
- `src/core/profile.ts` (`ResolvedMcpServer`, `filterMcpForTarget`), renderers `codex.ts`/`opencode.ts`/`claude.ts`.
- `src/tui/*` (skill toggle state, config paths — repo-file paths removed), `src/core/skill-overrides.ts` (payload rendering reuse), new override-store module, `src/cli/mfz.ts` (`mfz mcp`).
- Managed zsh rendering (`src/core/zsh.ts` / dotfiles renderer) gains launcher functions; requires `jq` (already a mise-managed environment).
- Sandbox consumption of the override store (`mfz sandbox up` baking merged config into containers) is a follow-up change, out of scope here.
