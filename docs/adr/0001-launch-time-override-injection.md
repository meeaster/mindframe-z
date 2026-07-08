# Project-scoped overrides are injected at launch, not written into repositories

Project-scoped toggles (MCP servers, skills) used to be written into config files inside the repository (`.codex/config.toml`, `.opencode/opencode.jsonc`) and git-excluded. Those paths are plausibly team-tracked — `.git/info/exclude` is a no-op for tracked files — so on repos we don't own, mindframe-z risked dirtying or clobbering project-owned harness config, and codex has no by-convention-untracked local config file to hide in. We decided all project-scoped drift lives in one mfz-owned store keyed by project path (`~/.mindframe-z/overrides.json`, modeled on `~/.claude.json`'s `projects` map), delivered at session start by managed zsh functions that shadow `codex`/`opencode`/`claude` and inject each harness's native session-scoped layer (`codex -c`, `OPENCODE_CONFIG_CONTENT`, `claude --settings`).

## Considered Options

- **Repo-local config files** (prior behavior): natively read by the harnesses, but oversteps on tracked team config; rejected.
- **Guarded repo writes** (only when the file is untracked): still plants files in other people's projects and fails unpredictably; rejected.
- **Seed-and-preserve hand-edits to managed global configs**: makes toggles invisible drift and stops profile edits from propagating; rejected.

## Consequences

- Sessions launched without the shell functions (IDE spawns, scripts, other shells) silently see profile defaults plus global toggles only. Accepted: global-scope toggles deliberately stay baked into rendered configs at apply, and `mfz mcp status` / `mfz skills status` print the merged truth.
- The store carries pre-rendered launch payloads (not just intent) because codex's `skills.config` is an array its layer merge replaces wholesale — launchers must stay a single `jq` read with zero logic.
