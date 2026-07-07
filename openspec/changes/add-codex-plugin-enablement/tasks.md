## 1. Schema And Profile Model

- [x] 1.1 Add a `codex.plugins` map to the profile schema (`schemas/profile.schema.json` source) keyed by `<name>@<marketplace>` with `enabled: boolean` and optional `toggleable: boolean`.
- [x] 1.2 Add matching TypeScript types for `codex.plugins` in `src/core` and ensure `mergeProfiles` deep-merges the block across the extends chain like `mcp` and `codex.config`.
- [x] 1.3 Regenerate `schemas/*.schema.json` with `pnpm schemas`.
- [x] 1.4 Add a focused test that base→child profile resolution merges and overrides `codex.plugins` entries.

## 2. Renderer

- [x] 2.1 Add `renderCodexPlugins(profile)` in `src/renderers/codex.ts` returning `{ "<id>": { enabled } }` from declared plugins.
- [x] 2.2 Add the plugins result to the derived `config` object alongside `mcp_servers`, and omit the `plugins` key entirely when no plugins are declared.
- [x] 2.3 Add `"plugins"` to `CODEX_DERIVED_KEYS`.
- [x] 2.4 In the local merge, after `deepMerge`, authoritatively replace `mergedLocalConfig.plugins` with the rendered plugins (and delete the key when the declared set is empty).
- [x] 2.5 Add tests: render enabled/disabled blocks, no-plugins produces no `[plugins]` table, prune of undeclared local plugin, preservation of unrelated local keys, empty set removes the table, and `--no-link` writes no local config.

## 3. Sync Adoption

- [x] 3.1 In `src/sync/codex.ts`, read the local `[plugins]` table and emit a `SyncCandidate` targeting `codex.plugins.<id>` for each `enabled = true` plugin not declared in the resolved profile.
- [x] 3.2 Ensure declared plugins and the derived `plugins` key are excluded from the existing top-level-key adoption loop.
- [x] 3.3 Add tests: undeclared enabled plugin is offered for adoption; declared plugin is not.

## 4. Profiles And Docs

- [x] 4.1 Seed `profiles/base/profile.yml` with `codex.plugins."github@openai-curated".enabled = true` and base `codex.config.tui` defaults (theme, status_line, status_line_use_colors).
- [x] 4.2 Seed `profiles/work/profile.yml` with `codex.plugins` for `teams`, `outlook-calendar`, `outlook-email`, and `sharepoint` (`@openai-curated`).
- [x] 4.3 Document the "install via `/plugins` then adopt via `mfz sync`" workflow and the full-owner prune behavior in the Codex config docs/ARCHITECTURE.
- [x] 4.4 Document that Codex TUI settings are set through `codex.config.tui` pass-through (additive), distinct from the authoritative `codex.plugins` table.

## 5. Verification

- [x] 5.1 Run `pnpm test` and `pnpm schemas` (verify no schema drift) and lint.
- [x] 5.2 Dry-run `mfz apply --agent codex` for base and work profiles and confirm rendered `[plugins]` blocks and `[tui]` settings match intent.
