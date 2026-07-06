# Tyler Technologies Branding Research (for brand-accurate visual skills)

**Status:** Research — active gathering. Forge design tokens verified against source; corporate
brand assets (insidetyler) not yet explored.
**Created:** 2026-07-02
**Primary goal:** Capture the authoritative Tyler Technologies look-and-feel so future skills that
render HTML — presentations, design showcases, general visualization — match Tyler's own software
instead of the generic feel of skills like `visual-explainer`. The reusable end-product is a shared
`:root { --forge-* }` theme reference (light + dark) plus type scale, spacing, and a `dataviz`
palette swap that visual skills consume, rather than re-deriving the brand each time.

This is a **living document**: it grows as the research continues (Tyler Forge, then insidetyler
corporate brand, then whatever visual skills consume it). Update it as findings land and code appears.

---

## Sources gathered so far

| Source | What it gives | Access |
| --- | --- | --- |
| Tyler Forge repo (cloned) | Authoritative design tokens (SCSS source of truth) | `/home/mark/work/forge` — local, read-only |
| `forge.tylerdev.io` | Storybook component catalog + rendered token galleries | Public |
| `tylerforge.design` | Design-token docs + blog | Public |
| Confluence "Figma Make – Guidance & Rules" (TA1, `263226246`) | Copy/paste brand rules doc + component specs | Confluence |
| Confluence "Tyler Forge Ecosystem" (`1441989197`) | Package map, version matrix, gotchas | Confluence |
| Confluence "VPAT Remediation" (FED, `488886573`) | Accessibility/markup patterns for Forge | Confluence |
| Forge MCP server | Live component docs, design tokens, icon search, API validation | Public npm — `@tylertech/forge-mcp` (not yet installed) |
| insidetyler DAM / SharePoint | Corporate logos, PPT/Teams templates, print colors | **Not yet explored** — separate auth |

Confluence cloudId: `748898e2-ca0a-43b6-981b-09e249be204c`.

---

## What Tyler Forge is

Tyler's official design system: framework-agnostic **Web Components built on Lit v3**, successor to
`@tylertech/tyler-components-web` (TCW). Element prefix `<forge-*>`; CSS custom properties under the
`--forge-*` namespace. Forge 3.0 (June 2024) removed all `--mdc-*` properties, decoupling it from
Angular Material's CSS.

**Ecosystem** (two GitHub repos, five npm packages):

- `@tylertech/forge` (v3.14.4, May 2026) — core web components, self-contained.
- `@tylertech/forge-core` — base classes/utilities.
- `@tylertech/forge-tailwind` (v0.1.0 ⚠️ immature) — Tailwind v4 `@theme` mapping.
- `@tylertech/forge-angular` (v7.x, Angular 20–22) — Angular adapter (proxies + CVA directives).
- `@tylertech/forge-extended` (v1.6.3) — composite UI patterns; no Angular adapter exists.
- `@tylertech/tyler-icons` — 8500+ icons.

For HTML/visual skills we consume the **CSS tokens + prebuilt stylesheets** directly; the Angular
packages are not relevant.

---

## How tokens are named, emitted, and themed

- **Source of truth:** SCSS Sass maps under `packages/forge/src/lib/core/styles/tokens/` in the cloned
  repo. Values live in maps (some computed); there is no hand-written `:root` file with hardcoded hex.
- **Naming:** `--forge-<module>-<token>` — e.g. `--forge-theme-primary`, `--forge-spacing-medium`,
  `--forge-shape-large`, `--forge-elevation-4`, `--forge-z-index-dialog`,
  `--forge-animation-duration-short4`, `--forge-typography-<style>-<prop>`.
- **Theming is `:root`-based**, NOT a class or `data-theme` attribute. Light is the default; dark is
  opt-in by loading a second stylesheet that re-declares the same `:root` vars.
- **Override** by setting `:root { --forge-theme-primary: … }`, or via the Sass `theme.provide()`
  mixin: `@use '.../theme' as forge-theme; :root { @include forge-theme.provide((primary: red)); }`.
- **Prebuilt stylesheets** (npm `dist/`): `forge.css` (everything), `forge-tokens.css` (tokens only),
  `forge-core.css` (`<body>` base styles), `forge-dark.css` (dark overrides — load AFTER `forge.css`).
- **CDN consumption (plain HTML):**
  - Script: `https://cdn.forge.tylertech.com/v1/libs/@tylertech/forge@<version>/index.js`
  - Styles: `https://cdn.forge.tylertech.com/v1/css/forge.css`
  - Roboto font: `https://cdn.forge.tylertech.com/v1/css/tyler-font.css`

---

## Forge MCP server (`@tylertech/forge-mcp`)

Official open-source MCP server (repo `tyler-technologies-oss/forge-mcp`, Apache-2.0, announced
2025-11-05) that connects AI assistants to live Tyler Forge docs, components, and design tokens via a
progressive-disclosure model. Docs sourced from Custom Elements Manifest (CEM) files + the Forge docs
site. **Auto-detects the Forge version installed in your project**, falling back to the bundled latest
stable. This is a strong candidate to wire into the visual-skill workflow: it gives authoritative,
version-correct tokens/components at generation time rather than relying on this doc's snapshot.

- **Package:** `@tylertech/forge-mcp@latest` · **Transport:** stdio (no remote/http endpoint).
- Blog: `tylerforge.design/blog/2025/11/05/forge-mcp-server`;
  setup guide: `forge.tylerdev.io/main/?path=/docs/getting-started-forge-mcp-server--docs`
  (Storybook is JS-rendered — the README in the repo is the reliable text source).

**Install (Claude Code):**

```bash
claude mcp add -t stdio -s [scope] forge -- npx -y @tylertech/forge-mcp@latest
# scope = user | project | local
```

Codex (`~/.codex/config.toml`): `[mcp_servers.forge]` `command = "npx"`,
`args = ["-y", "@tylertech/forge-mcp@latest"]`. Gemini:
`gemini mcp add -t stdio -s [scope] forge npx -y @tylertech/forge-mcp@latest`. VS Code
(`.vscode/mcp.json`) / Claude Desktop use the equivalent `npx` stdio config.

**Tools exposed:**

- Components: `get_component_docs`, `list_components`, `find_components` (fuzzy),
  `validate_component_api` (verify props/attrs/events/methods/slots/CSS parts after generation).
- Design system: **`get_design_tokens`** (colors, spacing, typography, animation, …),
  `setup_typography`, `setup_icons`, **`find_icons`** (natural-language icon search).
- Framework: `setup_framework` (Angular/React/Vue/Svelte/Lit). Migration:
  `get_version_migration_guide` (defaults v2→v3). General: `get_usage_guide`.

**`forge_mode` prompt:** sets baseline rules for Forge-specific tasks; takes a `task` param and steers
the LLM toward the right tools + best practices. Triggered via slash command / prompt selection.

### Hands-on findings (exercised 2026-07-02, work profile)

Installed and enabled in the work profile; all tools respond. What each actually returns:

- **`get_design_tokens <category>` returns token NAMES, purposes, and usage context — NOT concrete
  values.** e.g. it lists `--forge-theme-primary` / `--forge-theme-surface-container-high` and what
  they're for, but no hex. **Implication:** for actual hex/px/rem values, the cloned repo
  (`/home/mark/work/forge`) and the token tables below remain the source of truth. The MCP is for
  discovering *which* token to use and correct naming, not for values. Categories: color, spacing,
  typography, animation, border, elevation, layering, shape, all.
- **`get_usage_guide` (general)** returns real copy-paste HTML: `<forge-scaffold>` layout, the
  text-field "decorator" pattern (Forge component wraps a native `<input>`/`<label>`), CSS-only
  variants (`class="forge-button forge-button--raised"` on native elements), `::part()` styling,
  form integration, per-component tree-shaking imports (`import "@tylertech/forge/button"`). Also
  `installation` and `framework` (angular/react/vue/svelte/vanilla) variants.
- **`list_components`** — ~100 components, one-line descriptions. Notables for viz/dashboards:
  `forge-key` / `forge-key-item` (chart legends), `forge-meter` / `forge-meter-group`, `forge-table`,
  `forge-page-state` (empty/error states), `forge-skeleton`, `forge-stack` (spacing utility),
  `forge-scaffold` (page layout). `find_components` does fuzzy/multi-term search over the same set.
- **`get_component_docs`** — `summary` / `full` / `usage-examples` formats; `full` takes a `sections`
  filter (properties/methods/events/slots/css-custom-properties/css-parts/css-classes/states).
  Example: `forge-button` variants are **`text` / `outlined` / `tonal` / `filled` / `raised` /
  `link`** (note `outlined`, not `outline`), plus `theme` (default `primary`), `pill`, `dense`,
  `full-width`. ⚠️ Minor discrepancy vs the Confluence Figma doc which wrote `outline`.
- **`validate_component_api`** — pass a component + candidate APIs; it confirms valid ones, flags
  unmatched (tested `bogusProp` / `forge-button--nonsense` → correctly rejected), and lists the full
  available API surface to correct against. Ignores standard HTML/ARIA/`data-*`. This is the
  post-generation guardrail: generate markup, then validate the Forge-specific attrs/classes.
- **`find_icons`** — natural-language search over Tyler Icons; returns name, `tylIcon<Name>` ESM
  import, keywords, and ready-made import + `IconRegistry.define([...])` + `<forge-icon>` snippets.
  ⚠️ Keyword metadata is noisy/auto-generated (a "badge_account_alert" result listed camera
  keywords) — trust the icon *name*, not the keyword blurb. `setup_icons` gives the full registration
  guide.

**Workflow implication for visual skills:** use the MCP live at generation time for component
structure, correct API names, icon discovery, and post-gen validation; keep the static token tables
below (repo-derived) for the concrete color/spacing/type values the MCP omits.

---

## Design tokens (verified against `/home/mark/work/forge`)

### Color / theme (`--forge-theme-*`)

Palette sources: `tokens/color-palette/_material-color-palette.scss` (Material) and
`_extended-color-palette.scss` (Tyler custom: neutral, crimson, burnt-orange, ruddy-pink, apricot,
dollar-bill, maroon).

**Core brand colors (light) — all confirmed exact:**

| Role | Token | Light | Dark |
| --- | --- | --- | --- |
| Brand | `--forge-theme-brand` | `#283593` | `#212121` |
| Primary | `--forge-theme-primary` | `#3f51b5` | `#8c9eff` |
| Secondary | `--forge-theme-secondary` | `#ffc107` | `#ffe082` |
| Tertiary | `--forge-theme-tertiary` | `#3d5afe` | `#ffe082` |
| Surface | `--forge-theme-surface` | `#ffffff` | `#2c2c2c` |
| Success | `--forge-theme-success` | `#2e7d32` | (dark variant) |
| Error | `--forge-theme-error` | `#b00020` | (dark variant) |
| Warning | `--forge-theme-warning` | `#d14900` | (dark variant) |
| Info | `--forge-theme-info` | `#1565c0` | (dark variant) |

- **Foreground variant:** add `on` → `--forge-theme-on-primary` (mostly `#fff`; `on-secondary` is
  `#000`). Guaranteed-contrast pairing.
- **Container tones** per color: `-container-minimum` / `-container-low` / `-container` /
  `-container-high`, each with `on-*-container-*` text colors. (E.g. primary containers light:
  `#f7f8fc / #e8eaf6 / #d1d5ed / #b6bde3`.)
- **Text emphasis:** `--forge-theme-text-high` rgba(0,0,0,.87) / `-medium` .60 / `-low` .38 /
  `-lowest` .12; `-inverse` variants use white. Dark theme swaps to white base.
- **Outline:** `-outline-high` `#212121` / `-medium` `#757575` / `-low` `#9e9e9e` / base `#e0e0e0`.

### Spacing (`--forge-spacing-*`, base 16px)

`xxxsmall 2` · `xxsmall 4` · `xsmall 8` · `small 12` · `medium 16` · **`medium-large 20`** ·
`large 24` · `xlarge 32` · `xxlarge 48` · `xxxlarge 56` (px).
⚠️ Confluence's table **missed the 20px `medium-large` step**.

### Shape / border-radius (`--forge-shape-*`, base 4px)

**`extra-small 1`** · `small 2` · `medium 4` · `large 8` · `extra-large 16` · `full 9999` (pill) ·
**`round 50%`**. Values scaled by `--forge-shape-factor` (global knob). Directional variants exist
(`*-block-start`, `*-inline-end`, …).
⚠️ Confluence **missed `extra-small` (1px) and `round` (50%)**.

### Typography (`--forge-typography-*`)

- Family `'Roboto', sans-serif`; base `1rem` (16px). Weights: light **300**, regular **400**,
  medium **500**, bold **700**. Base body style = **body2**.
- Type scale (size / line-height, at 16px root):
  - **Body** (wt 400): body1 14/18 · body2 16/22 · body3 18/24 · body4 20/28
  - **Heading** (wt 500): heading1 14/18 → heading5 24/28 → heading8 36/42
  - **Subheading** (wt 400): mirrors heading sizes
  - **Display** (wt 300): display1 24/36 → display6 48/64 → display8 64/76
  - **Label** (wt 400): label1 12/20 · label2 13/20 · label3 14/20
  - **Button** (wt 500, 14px, wide tracking), **Overline** (wt 500, 12px, uppercase)
- Utility classes `.forge-typography--<style>` are generated.

### Elevation, z-index, border, motion

- **Elevation:** `--forge-elevation-0 … -24` (Material 3-layer umbra/penumbra/ambient shadows). E.g.
  `-4` = `0 2px 4px -1px rgba(0,0,0,.2), 0 4px 5px 0 rgba(0,0,0,.14), 0 1px 10px 0 rgba(0,0,0,.12)`.
- **Z-index:** surface 1 · header 4 · backdrop 7 · dialog 8 · notification 9 · popup 10 · tooltip 11.
- **Border width:** thin 1 · medium 2 · thick 4 (px).
- **Motion durations:** short1 50 · short4 200 · medium2 300 · long2 500 … extra-long4 1000 (ms).
  **Easings:** standard/emphasized `cubic-bezier(0.2,0,0,1)`; decelerate `(0,0,0,1)`; accelerate
  `(0.3,0,1,1)`.

### Interaction surfaces

- **Focus ring** (`--forge-focus-indicator-*`): width 2px, color = primary, outward-offset 4px,
  shape extra-small (1px), active-width 6px, duration 600ms, easing emphasized.
- **State layer** (hover/press overlays): hover-opacity 0.08, pressed-opacity 0.12, color on-surface.
- **Scrollbar:** width/height 16px, thumb-min 32px, radius = shape-full, thumb uses
  surface-container-medium/high.
- **Breakpoints:** none defined by Forge — layout is delegated to Tailwind (`sm:/md:/lg:` v4 defaults)
  plus a `.grid-min-320` helper and `<forge-scaffold>` for page layout.

### forge-tailwind (Tailwind v4)

`@import "@tylertech/forge-tailwind";` (requires Forge CSS loaded so `--forge-*` resolve). Maps tokens
into `@theme`: spacing (`p-4`, `gap-large`), radius (`rounded-*`), elevation (`shadow-*`), z-index
(`z-dialog`), colors (`bg-primary`, `text-high`, `border-outline`), typography (`text-heading4`,
`text-body1`), motion (`duration-short-1`, note the hyphen). Import BEFORE your own `@theme` so brand
overrides win.

### Icons

- `@tylertech/tyler-icons` — 8500+ icons (Material base + Tyler custom), kebab-case names, exported as
  `tylIcon<Name>` objects (`{ name, data }`).
- Register before render: `import { IconRegistry } from '@tylertech/forge'; IconRegistry.define([tylIconFavorite]);`
  then `<forge-icon name="favorite"></forge-icon>`. There is NO URL fallback unless you opt in.
- CDN raw SVG: `https://cdn.forge.tylertech.com/v1/icons/svg/<standard|extended|custom>/<name>.svg`, or
  `<forge-icon name="…" external>` to lazy-fetch at runtime.
- Plain-HTML/Figma guidance also allows Pictogrammers **Material Design Icons (MDI)**.

---

## Conventions & rules that carry the "feel"

- **Text is sentence case, never ALL CAPS** (buttons, labels).
- **Accessibility (from VPAT Remediation):** body text contrast ≥4.5:1, large text ≥3:1; use the
  guaranteed-contrast `on-*` foreground variants; 44×44px (Forge uses 40×40px) touch targets; proper
  ARIA on dialogs/menus/tabs/expansion panels; visible focus indicators (never remove them).
- **Fallback:** anything not defined in Forge guidance defaults to **Material Design 2**.

### Relationship to the `impeccable` skill

`impeccable` (`~/.claude/skills/impeccable/`, v3.9.1) is the design-engineering skill we'll drive this
with. Key alignment point: its setup **only generates a brand palette (`palette.mjs`) when no
committed brand colors exist** — if Forge tokens are present as the committed theme, "identity
preservation wins" and it builds on them. So the play is to make the Forge token theme the committed
baseline, then let impeccable's rules (contrast, semantic z-index, radius caps 12–16px on cards —
compatible with Forge's 8px `large`) refine on top. Its absolute bans (side-stripe borders, gradient
text, decorative glassmorphism) don't conflict with Forge.

---

## Open threads / next steps

- [ ] **Evaluate the Forge MCP server** (`@tylertech/forge-mcp`) as a live token/component source for
      the visual-skill workflow — decide whether skills should call `get_design_tokens` / `find_icons`
      / `validate_component_api` at generation time vs. rely on the static theme reference below.
- [ ] **insidetyler corporate brand** (DAM/SharePoint): official logos, PPT/Teams templates, exact
      print/marketing colors, brand voice. Needs separate auth — not yet explored.
- [ ] Build the shared `:root { --forge-* }` theme reference (light + dark) generated from
      `/home/mark/work/forge` so it's authoritative.
- [ ] Decide how visual skills consume it (shared CSS file? skill reference? `dataviz` palette swap).
- [ ] Confirm whether corporate marketing palette differs from Forge product palette (e.g. is brand
      `#283593` the same indigo used in marketing?).
- [ ] Capture Forge component base styles worth mirroring (app-bar uses brand bg + on-brand text).

---

## Changelog

- **2026-07-02** — Doc created. Forge design tokens gathered and verified against the cloned repo
  (`/home/mark/work/forge`); Confluence discrepancies corrected (spacing 20px, shape 1px & 50%).
  Added Forge MCP server section (`@tylertech/forge-mcp` — tools + install). insidetyler corporate
  brand still outstanding.
