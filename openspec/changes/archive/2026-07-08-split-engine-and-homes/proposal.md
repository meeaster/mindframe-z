## Why

mindframe-z currently mixes the engine (CLI, renderers, schemas) with one person's content — profiles, catalogs, skills, plugins, and rendered output all live in the same repository. That blocks sharing: a coworker cannot adopt the tool without adopting Mark's configuration history, work content leaks into a personal repo, and machine-config hacks are needed to keep work and personal apart. Splitting content into standalone git repositories ("homes") that the engine resolves, extends, and renders makes mindframe-z a shareable product and makes work/personal separation structural instead of hacked.

## What Changes

- **BREAKING**: mindframe-z becomes a pure engine; all content (`profiles/`, `shared/`, `skills/`, `opencode/`, work sandbox overlays) moves out into home repositories. The engine ships zero profiles.
- New **home** concept: a git repo with `mfz_home.yml`, `catalog/` (`references.yml`, `skills.yml`, `mcp.yml`), `instructions/`, `profiles/`, `skills/`, `opencode/`, and `sandbox/` in an opinionated layout. A machine activates exactly one home via machine config `home_path` (renamed from `repo_path`).
- New **home inheritance**: a home may declare one upstream home (`extends: {name, repo}`) forming a linear chain. The upstream layer (catalogs, profiles, skills, plugins) merges under existing `extends` semantics. Cross-home references are qualified with a consumer-assigned alias (`personal/base`, `personal/aws-knowledge`); unqualified names always resolve in the local catalog.
- New **managed upstream clones**: writable working copies at `~/.mindframe-z/homes/<alias>/`, updated `--ff-only` on apply when clean, exposed to agents via extra folders, and offered as `mfz sync` targets when pushable.
- **BREAKING**: rendered output moves from `<repo>/configs/<profile>/` to `~/.mindframe-z/configs/<profile>/`; references default moves from `~/references` to `~/.mindframe-z/references/`. `~/.mindframe-z/` becomes the single machine-local root.
- New **`mfz init`** machine bootstrap: writes machine config and clones, creates (scaffolds), or points at a home. Scaffolds are minimal-but-valid with schema modelines and a slim `mindframe-z` guidance skill.
- New **`mfz guide`** command printing the home-conventions guide from the installed engine; the scaffolded slim skill defers to it.
- New **curl installer** and engine packaging: GitHub Releases tarball installed to `~/.mindframe-z/engine/` with an `mfz` launcher in `~/.mindframe-z/bin/` on PATH; installer installs/updates mise and ensures node via mise. Render guarantees `node` in mise config (default `node@24`) unless a profile overrides.
- Catalog renames: `shared/` → `catalog/`, `refs.yml` → `references.yml`.

## Capabilities

### New Capabilities

- `home-manifest`: the home repository format — `mfz_home.yml`, opinionated directory layout, catalog files, validation, and what `mfz init` scaffolds.
- `home-inheritance`: upstream declaration with consumer-assigned aliases, chain merge semantics, qualified references (`<alias>/<name>`), duplicate-definition rules, and render-collision errors.
- `upstream-clones`: managed writable clones under `~/.mindframe-z/homes/`, update/dirty/offline behavior, doctor checks, and cross-home `mfz sync` targeting.
- `machine-bootstrap`: `mfz init` flow, machine config `home_path`, the curl installer, engine install layout under `~/.mindframe-z/`, PATH guarantee, and the node-in-mise render guarantee.
- `engine-guide`: the `mfz guide` command, the scaffolded slim guidance skill, and the engine-side agent onboarding doc.

### Modified Capabilities

- `yaml-schemas`: adds the `mfz_home.yml` schema, renames `refs.schema.json` to `references.schema.json`, and replaces per-editor schema mapping with `$schema` modelines pointing at published engine schema URLs in scaffolded files.
- `managed-zsh-config`: rendered dotfiles move to `~/.mindframe-z/configs/<profile>/`; the managed `.zshrc` additionally guarantees `~/.mindframe-z/bin` on PATH.

## Impact

- **Engine code**: `src/core` (manifest loading, profile resolution gains home/alias resolution), `src/renderers/*` (output root change), `src/sync` (cross-home targets), `src/cli/mfz.ts` (`init`, `guide`), `src/ref-store` (reused for home clones), doctor checks.
- **Repos**: two new content repos (personal home, work home); mindframe-z strips to engine-only afterward.
- **Machines**: both machines re-point via `mfz init`/machine-config edit; work machine drops its machine-config separation hacks.
- **Docs**: ARCHITECTURE.md, README, new `docs/agent-setup.md`; CONTEXT.md glossary already updated (Home, Engine, Upstream alias, Qualified reference).
- **Not in scope**: npm publishing, `mfz upgrade`, qualified-name features beyond one-hop aliases with transitive path composition, multi-source resolution.
