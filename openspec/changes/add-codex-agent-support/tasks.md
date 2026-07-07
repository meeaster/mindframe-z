## 1. Schema And Profile Model

- [x] 1.1 Add `codex` to agent, target, and skill target enums in `src/core/manifests.ts` and related TypeScript types.
- [x] 1.2 Add `codex.config` to the profile schema as a TOML-compatible pass-through object with existing profile deep-merge semantics.
- [x] 1.3 Update profile resolution so inherited Codex config merges consistently with `opencode.config`, `claude`, and `mise`.
- [x] 1.4 Regenerate `schemas/*.schema.json` with `pnpm schemas`.
- [x] 1.5 Update CLI help, status, and doctor output where agent target names are enumerated.

## 2. Codex Paths And TOML Merge

- [x] 2.1 Add Codex runtime path resolution for `CODEX_HOME` and fallback `~/.codex`.
- [x] 2.2 Add Codex managed snapshot paths under `configs/<profile>/codex/`.
- [x] 2.3 Add TOML serialization and merge helpers for `config.toml` using the repository's existing TOML dependency.
- [x] 2.4 Preserve unrelated local Codex config keys while replacing mfz-managed keys during linked apply.
- [x] 2.5 Add focused tests for Codex TOML merge behavior and path resolution.

## 3. Codex Renderer And Apply

- [x] 3.1 Create `src/renderers/codex.ts` to render `configs/<profile>/codex/config.toml` and `configs/<profile>/codex/AGENTS.md`.
- [x] 3.2 Render profile `codex.config` keys into Codex TOML without inventing normalized domain-specific wrappers.
- [x] 3.3 Render enabled MCP servers for target `codex` into Codex `[mcp_servers]` TOML tables.
- [x] 3.4 Render references and extra folders into a named Codex permissions profile and set it as the default permissions profile.
- [x] 3.5 Install global Codex guidance to `~/.codex/AGENTS.md` during linked apply without writing `AGENTS.override.md`.
- [x] 3.6 Wire Codex into render target dispatch, apply filtering, dry-run output, and no-link behavior.

## 4. Sync And Skill Toggles

- [x] 4.1 Add `src/sync/codex.ts` to detect unmanaged top-level `codex.config` keys from rendered and local Codex TOML.
- [x] 4.2 Ignore generated Codex tables during sync, including MCP servers and generated permissions profile content.
- [x] 4.3 Wire Codex sync into `src/sync/index.ts`.
- [x] 4.4 Extend skill target types, config path resolution, and installed-state discovery to include Codex.
- [x] 4.5 Implement Codex skill override read/write using path-based `[[skills.config]]` entries when an installed skill path is known.
- [x] 4.6 Return a clear actionable error when a Codex skill toggle is requested for a skill whose install path cannot be resolved.
- [x] 4.7 Update skills TUI target cycling and CLI messages to include `codex`.

## 5. Integration Tests And Documentation

- [x] 5.1 Add integration tests for `mfz apply --agent codex --no-link` rendering Codex `config.toml` and `AGENTS.md`.
- [x] 5.2 Add linked apply tests proving local `~/.codex/config.toml` merge preserves unrelated TOML keys.
- [x] 5.3 Add Codex MCP rendering tests for stdio and remote server definitions.
- [x] 5.4 Add Codex filesystem permissions rendering tests for references and extra folders.
- [x] 5.5 Add Codex sync tests for unmanaged keys and generated-key ignores.
- [x] 5.6 Add Codex skill toggle tests for repo/global config paths and unresolved install path handling.
- [x] 5.7 Update `ARCHITECTURE.md` with Codex as a supported renderer and local merge target.
- [x] 5.8 Keep `docs/agent-cli-configuration-map.md` aligned with implementation decisions if they change during buildout.

## 6. Verification

- [x] 6.1 Run `pnpm schemas`.
- [x] 6.2 Run focused tests for profile resolution, rendering/apply, sync, and skill toggles.
- [x] 6.3 Run `pnpm build`.
- [x] 6.4 Run `openspec validate --changes add-codex-agent-support`.
- [x] 6.5 Run `pnpm check` before handoff if the implementation touches broad CLI/apply behavior.
