## Why

mindframe-z renders first-class Codex configuration (config, AGENTS, MCP, permissions)
but explicitly deferred plugin management. Codex now enables curated plugins through
`[plugins."<name>@<marketplace>"]` blocks in `config.toml`, and those blocks are
written interactively by the `/plugins` browser rather than declared anywhere. As a
result, which plugins are on drifts per-machine and is not reproducible from a profile.
Making plugin enablement a profile-declared, mfz-owned surface keeps Codex plugins
consistent across machines and lets the base/work split control them like skills and MCP.

## What Changes

- Add a `codex.plugins` profile block: a map keyed by the fully-qualified plugin id
  (e.g. `github@openai-curated`) whose values declare `enabled` (and optional
  `toggleable`), merged across `base` → child profiles via the existing deep merge.
- Render declared plugins into `[plugins."<id>"]` blocks in the managed Codex
  `config.toml` snapshot.
- Make mfz the **full owner** of the `[plugins]` table: during local apply, the
  rendered plugin set replaces the local `[plugins]` table wholesale rather than being
  deep-merged, so plugins not declared in any profile are pruned. **BREAKING** for
  local Codex state: a plugin enabled only via the interactive `/plugins` browser and
  not declared in a profile is removed on the next `mfz apply`.
- Add `plugins` to the Codex derived keys so sync treats the table as mfz-managed.
- Extend Codex sync to surface locally-enabled-but-undeclared plugins as adoption
  candidates that write back into `codex.plugins`, so interactive installs have a
  supported path into a profile instead of silently vanishing.
- Populate the base/work profiles from current machine state: `github@openai-curated`
  in base; `teams`, `outlook-calendar`, `outlook-email`, and `sharepoint`
  (`@openai-curated`) in work.
- TUI settings (theme, status_line) are handled through the existing `codex.config`
  pass-through (`codex.config.tui`), not a new block; no code change is required beyond
  documenting and seeding base/work `codex.config.tui` values.
- Keep marketplace registration, authoring mfz-sourced plugins, plugin apps/MCP
  authentication, and project-local `.codex/` plugin config out of this change.

## Capabilities

### New Capabilities

- `codex-plugin-enablement`: declaring, rendering, owning (prune-on-apply), and
  adopting-via-sync Codex curated-plugin enablement from resolved mfz profiles.

### Modified Capabilities

- `codex-agent-config`: the Codex renderer and local apply merge gain a plugins pass;
  the local merge treats the `[plugins]` table as authoritative-replace, and `plugins`
  joins the Codex derived keys.

## Impact

- `schemas/profile.schema.json` gains the `codex.plugins` block; generated JSON schema
  regenerates.
- `src/renderers/codex.ts`: new `renderCodexPlugins`, `plugins` added to
  `CODEX_DERIVED_KEYS`, and an authoritative-replace step in the local merge.
- `src/sync/codex.ts`: plugin adoption candidate detection for locally-enabled,
  undeclared plugins.
- `profiles/base/profile.yml` and `profiles/work/profile.yml`: seeded
  `codex.plugins` and `codex.config.tui` entries.
- Integration tests cover plugin rendering, prune-on-apply, no-link behavior, sync
  adoption, and base/work merge.
