## Context

mindframe-z already renders Codex `config.toml` via `src/renderers/codex.ts`: the
profile's opaque `codex.config` block is deep-merged with derived sections
(`mcp_servers`, `permissions`, `default_permissions`), serialized with `smol-toml`,
and applied to `~/.codex/config.toml` through a local merge that preserves user keys:

```
config           = deepMerge(profile.codex.config, { permissions…, mcp_servers… })
mergedLocalConfig = deepMerge(readTomlObject(~/.codex/config.toml), config)
```

Codex enables curated plugins with per-plugin TOML blocks keyed by a fully-qualified
id (`<name>@<marketplace>`):

```toml
[plugins."github@openai-curated"]
enabled = true
```

These blocks are written by the interactive `/plugins` browser, not declared anywhere,
so the enabled set is machine-local and non-reproducible. `syncCodex` currently offers
to adopt *unmanaged top-level* keys back into a profile; it has no notion of plugins.

The user has decided: mfz is the **full owner** of the `[plugins]` table (prune
strays), plugin keys are written with an **explicit `@marketplace`** suffix, and TUI
settings stay **pass-through** via `codex.config.tui`.

## Goals / Non-Goals

**Goals:**

- Declare Codex curated-plugin enablement in profiles, keyed by `<name>@<marketplace>`,
  merged across the `base` → child extends chain.
- Render declared plugins into `[plugins."<id>"]` blocks in the managed snapshot.
- Make the local `[plugins]` table reflect exactly the declared set (prune undeclared).
- Give interactive installs a supported path into a profile via sync adoption.
- Seed base/work profiles from current machine state and document `codex.config.tui`.

**Non-Goals:**

- Marketplace source registration (`~/.agents/plugins/marketplace.json`).
- Authoring mfz-sourced plugin folders (the opencode `plugins/` analog).
- Plugin app/MCP authentication or connector setup.
- Project-local `.codex/` plugin config.
- A first-class `codex.tui` schema block or theme/widget validation.

## Decisions

### Decision 1: `codex.plugins` map keyed by fully-qualified id

Add `codex.plugins` as a map: `{ "<name>@<marketplace>": { enabled: bool,
toggleable?: bool } }`. This mirrors the existing `mcp` and skill toggle shapes and
merges naturally through `deepMerge` in `mergeProfiles` (base then child), so the
base/work split needs no new machinery.

- **Why explicit `@marketplace`**: it matches exactly what Codex writes to
  `config.toml`, supports more than one marketplace without a hidden default, and keeps
  the profile key identical to the rendered TOML key (no transform to reason about).
- **Alternative rejected**: bare names + a configurable default marketplace. Tidier
  YAML, but bakes in a marketplace assumption and adds a name→id transform that the
  sync-adoption path would have to invert.

### Decision 2: Render into `config.plugins`, reuse smol-toml

`renderCodexPlugins(profile)` returns `{ "<id>": { enabled } }` and is added to the
derived object alongside `mcp_servers`. `smol-toml` already quotes dotted keys, so
`{ plugins: { "github@openai-curated": { enabled: true } } }` serializes to the exact
`[plugins."github@openai-curated"]` block Codex expects. No custom serialization.

### Decision 3: Authoritative-replace of `[plugins]` in the local merge

`deepMerge` only unions keys — it can never delete — so it cannot prune strays. Full
ownership therefore requires replacing the `plugins` sub-table wholesale after the
merge:

```
mergedLocalConfig          = deepMerge(readTomlObject(localConfigPath), config)
mergedLocalConfig.plugins  = config.plugins   // authoritative-replace; drop if empty
```

Everything else about the local merge stays additive (user keys preserved). Only the
`plugins` table becomes owned. If the profile declares no plugins, mfz removes the
`plugins` table entirely so the owned surface is unambiguous.

- **Alternative rejected**: additive merge (set declared, leave strays). Simpler and
  non-breaking, but the user explicitly chose full ownership for reproducibility.

### Decision 4: `plugins` joins `CODEX_DERIVED_KEYS`

Adding `"plugins"` to `CODEX_DERIVED_KEYS` makes `syncCodex` skip it in the
top-level-key adoption loop (it is mfz-managed, not a stray user key), which is
required for drift detection and adoption to behave correctly.

### Decision 5: Sync adoption for locally-enabled, undeclared plugins

Because full ownership deletes undeclared plugins on apply, `syncCodex` gains an
inverse check: read the local `[plugins]` table, and for any `<id>` with
`enabled = true` that is not declared in `profile.codex.plugins`, emit a
`SyncCandidate` targeting `codex.plugins.<id>`. This turns "install via `/plugins`,
then adopt into a profile" into the supported workflow, instead of a silent deletion.

### Decision 6: TUI settings stay pass-through

`[tui]` is a plain top-level table; because `codex.config` is opaque pass-through,
`codex.config.tui.theme` / `codex.config.tui.status_line` already render today with no
code change. This is symmetric with how `claude.settings` carries `statusLine` without
mfz modeling its internals. A first-class `codex.tui` block is not built (YAGNI): TUI
keys are rarely hand-edited, so the drift pressure that justifies full-owner plugins
does not apply here.

## Risks / Trade-offs

- **Interactive `/plugins` installs vanish on next apply** → Mitigated by sync adoption
  (Decision 5) and by documenting the "install then adopt" workflow. This is the
  intended consequence of full ownership, consistent with how skills/MCP are declared.
- **Empty vs. absent `[plugins]` table** → If a profile declares no plugins, mfz drops
  the table rather than writing an empty one, so "owned but empty" reads unambiguously
  as "no plugins enabled."
- **`codex.config.tui` remains additive while `plugins` is authoritative** → An
  intentional asymmetry (Decision 6); documented so the differing merge semantics are
  not surprising.
- **Plugin id typos are not validated** → mfz does not know the marketplace catalog, so
  a mistyped `<id>` renders a dead `[plugins]` block. Acceptable: Codex simply ignores
  unknown ids, and adoption round-trips real ids from live config.

## Migration Plan

1. Ship schema + renderer + sync together; no behavior changes until a profile declares
   `codex.plugins`.
2. Seed `profiles/base` and `profiles/work` from current machine state
   (`github@openai-curated` in base; `teams`, `outlook-calendar`, `outlook-email`,
   `sharepoint` in work) plus `codex.config.tui` defaults.
3. First `mfz apply` after adoption makes the local `[plugins]` table authoritative;
   any locally-enabled plugin not seeded is pruned (run `mfz sync` first to adopt).
4. Rollback: remove the `codex.plugins` blocks from profiles; the next apply writes no
   `plugins` table and local Codex plugin state is again user-managed.
