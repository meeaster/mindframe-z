## Context

mindframe-z is a profile-aware AI tool configuration renderer. Today the engine (`src/`, `schemas/`, `tests/`) and one person's content (`profiles/`, `shared/`, `skills/`, `opencode/`, `configs/`, `sandbox/agent-vault/*.yaml`) share one repository, and the config root defaults to the repo itself (`MFZ_ROOT` > machine `repo_path` > cwd). Work/personal separation is currently done with machine-config overrides on the work machine.

The design was settled in a grilling session; the resulting glossary lives in `CONTEXT.md` (Home, Engine, Upstream alias, Qualified reference). This document records the technical decisions.

## Goals / Non-Goals

**Goals:**

- The engine is content-free and installable standalone; homes are standalone git repos.
- A work home extends a personal home across repos with explicit, unambiguous references.
- `~/.mindframe-z/` is the single machine-local root (engine, rendered configs, home clones, references, overrides, threads, secrets).
- A stranger can bootstrap with one curl command plus `mfz init`, guided by agent-readable docs and a version-true `mfz guide`.
- Every migration step leaves both of Mark's machines working.

**Non-Goals:**

- Multi-source resolution (two equal active homes). One active home per machine, hard rule.
- npm registry publishing, `mfz upgrade` self-update, SHA-pinning of upstreams — all later, all pure additions.
- Alias overrides (`as:`) for untrusted upstreams; qualified syntax beyond `<alias>/<name>` path composition.
- Preserving backward compatibility with the merged-repo layout (repo policy: no external users, no fallbacks).

## Decisions

### D1: Engine + home split (not template/fork)

Homes are separate git repos the engine operates on; the engine ships zero profiles. A fork-based model would make engine upgrades perpetual merge conflicts and put personal content in product history. The seam already exists: everything resolves relative to a config root.

### D2: Home layout is opinionated; `mfz_home.yml` is the marker

```
<home>/
├── mfz_home.yml          # description?, extends?: {name, repo}
├── catalog/
│   ├── references.yml    # renamed from refs.yml — "references", never "refs"
│   ├── skills.yml
│   └── mcp.yml
├── instructions/         # was shared/AGENTS.global.md; profiles point at files here
├── profiles/<name>/profile.yml (+ mise.toml, dotfiles)
├── skills/               # local skill sources (+ tests)
├── opencode/             # plugins/, commands/, agents/ (+ tests)
└── sandbox/agent-vault/  # home-owned sandbox service overlays
```

Directory names are fixed (no layout configuration in v1 — `mfz_home.yml` is the future hook). Homes may contain code and tests; a home gets its own minimal `package.json`/vitest when it has plugins. `shared/` → `catalog/` (a catalog is selected *from*; "registry" implies a publish target).

### D3: Rendered output is machine-local, never in the home

Render to `~/.mindframe-z/configs/<profile>/`. Rendered output bakes in machine-local inputs (extra-folder permissions, machine overrides), so committing it means cross-machine churn; and rendered `node_modules` doesn't belong in git. Symlinks point into `~/.mindframe-z/configs/` instead of `<repo>/configs/`. References default likewise moves to `~/.mindframe-z/references/` (machine config / `MFZ_REFERENCES_DIR` still override).

### D4: One upstream per home, home-level extends

`mfz_home.yml#extends` declares at most one upstream: `{name: <alias>, repo: <git-url>}`. The entire upstream layer (catalog, profiles, skills, plugins, instructions) is the parent layer; merge semantics are exactly the existing profile `extends` table, applied across the repo boundary. Per-profile git extends was rejected: profiles are selections from catalogs plus sibling files and cannot travel alone. Chains are linear (`work → personal`, later `→ common`); a "common" upstream requires no new machinery.

### D5: Consumer-assigned aliases, qualified references with `/`

- Unqualified name ⇒ defined in *this* home's catalog. Validation error if absent locally.
- Qualified `<alias>/<name>` (e.g. `personal/aws-knowledge`, `extends: personal/base`) ⇒ defined in the home reached via the consumer's declared alias. Slash, not colon.
- Aliases are consumer-owned (like git remotes): an upstream renaming itself can never break downstreams — critical once coworkers extend homes they don't control. Upstream homes have **no** self-declared identity.
- Transitive chains compose as paths: `personal/common/x` — every segment is a name assigned by someone in the reader's trust path.
- Duplicate definitions across homes are legal at rest (qualification disambiguates); two distinct same-terminal-name definitions **both active for one harness** are a render-time error (rename or disable one).

Empirical basis: the work profile mentions ~10 locally-defined names vs 3 upstream-defined (`personal/base`, `aws-knowledge`, `visual-explainer`); bulk inheritance is silent and unaffected by qualification.

### D6: Upstream clones are writable working copies

Clones live at `~/.mindframe-z/homes/<alias>/` (reusing ref-store clone management). They are working copies, not caches: auto-exposed via extra folders so agents can edit/commit/push the personal home from the work machine. Render reads the working tree as-is (edit-first applies upstream too). `mfz apply` updates with `git pull --ff-only` only when clean; dirty/ahead clones warn, never clobber. Offline: render from the stale clone with a warning; hard-fail only with no clone. No aliasing detection between the active home and an upstream URL (personal machine has no upstream at all).

### D7: `mfz sync` can target upstream profiles

Sync keeps its prompt (assign to base vs current profile) but "base" may live in the upstream clone; sync writes to that working tree and reports "written to upstream home `personal` — uncommitted". `mfz doctor` flags dirty/unpushed upstream clones. Homes whose remote isn't pushable (`git push --dry-run` fails) are not offered as sync targets.

### D8: `mfz init` and minimal-but-valid scaffold

`mfz init` writes `~/.mindframe-z/config.yml` and resolves the home three ways: clone existing (default destination `~/.mindframe-z/homes/<name>/`, custom path allowed), create new (scaffold + `git init` + first commit), or point at an existing local directory. Machine config key: `home_path` (renamed from `repo_path`; `MFZ_ROOT` env keeps its name). Scaffold contents: `mfz_home.yml`, empty catalog files, `instructions/AGENTS.md` stub, `profiles/base/profile.yml` (agents asked at init), `.gitignore`, the slim guidance skill (D9), and a one-paragraph README linking to the engine's agent-setup doc. No empty `opencode/`/`sandbox/` dirs — conventions are taught by the guide, not by empty folders.

Editor validation: scaffolded YAML files carry `# yaml-language-server: $schema=<published engine schema URL>` modelines. No per-editor config files, works wherever the home is cloned; trades offline-first validation for zero machinery (rejected: `mfz apply` writing schemas into the home).

### D9: Guidance ships as `mfz guide` + a scaffolded slim skill

`mfz guide` prints the full home-conventions guide (layout, catalog entries, qualified references, CLI-vs-edit division of labor) from the installed engine — version-true by construction. The scaffold wires it as a local skill: `skills/mindframe-z/SKILL.md` whose body is "run `mfz guide` and follow it", plus a `source: local` catalog entry enabled in the starter profile. This dogfoods the local-skill mechanism as the first example in every fresh home. Named `guide`, not `skill`, to avoid colliding with the existing `mfz skills` subcommand. Rejected: git-installed skill (version drift), AGENTS.md line (always-on context cost, no trigger matching), engine auto-injection (new concept, can't disable).

### D10: Distribution — GitHub Releases tarball + curl bootstrap; no npm, no compiled binary

The curl installer is a bootstrap orchestrator: install-or-self-update mise → ensure node via mise (`node@24` if none) → download the engine tarball (built JS) from GitHub Releases into `~/.mindframe-z/engine/` → write an `mfz` launcher into `~/.mindframe-z/bin/` → ensure PATH (append to shell rc at bootstrap; the managed `.zshrc` guarantees it permanently). Upgrades: re-run the script.

- mise must not manage the engine: mise's config is mfz *output* (bootstrap circularity).
- No `npm i -g`: not published yet, and global npm packages vanish on mise node-version switches. A fixed engine folder survives node switches.
- No bun-compiled binary: the ecosystem needs node regardless (npx skills, TS plugins); a second runtime is vanity.
- Render-time guarantee: if the resolved mise config declares no node, the engine injects `node@24`; profile-declared node wins. Apply can never render away the engine's own runtime.

## Risks / Trade-offs

- [Work machine must fetch the personal home] → Mark's GitHub account is authorized on both; if that ever changes, flip the chain to `work → common ← personal` — a per-home choice, not an architecture change.
- [Coworkers cloning a work home can't resolve its private upstream] → Sharing is copying, not activating; a home is only activatable by someone with access to its whole chain. Documented in the guide.
- [Qualified-name renames: moving a definition between homes touches mention sites] → 3 sites today; validation errors are loud and name the missing entry.
- [Sync writes rotting uncommitted in upstream clones] → sync prints an explicit uncommitted notice; doctor flags dirty/unpushed clones.
- [Schema modelines need network once per editor cache] → acceptable; schemas are stable and cached.
- [Bundled-JS tarball still requires node at launcher time] → installer guarantees node via mise before first run; launcher fails with a clear message if node vanishes.
- [Stale upstream clone renders old config offline] → warning on every apply that used a stale clone.
- [Migration breaks a live machine] → migration order is parity-verified per step (see Migration Plan); the old layout keeps working until the machine's config is re-pointed.

## Migration Plan

1. **Engine-side features in-place** (content still in-repo, everything keeps rendering): home resolution via `home_path`/`mfz_home.yml`, catalog renames, rendered output → `~/.mindframe-z/configs/`, references default change, `init`, `guide`, upstream extends + qualified references + clone management, cross-home sync, doctor checks. The current repo temporarily *is* a valid home (add `mfz_home.yml`, rename `shared/` → `catalog/`).
2. **Cut the personal home**: new repo; move `profiles/` (minus work), `catalog/`, `instructions/`, `skills/`, `opencode/`; point the personal machine's `home_path` at it; `mfz apply`; diff rendered output for parity.
3. **Cut the work home**: new repo with the `work` profile, work catalog entries (datadog/jira/confluence/forge MCP, work skills, work references, `sandbox/agent-vault/` overlays), `extends: {name: personal, repo: …}`; migrate the work machine; delete machine-config separation hacks.
4. **Strip mindframe-z to pure engine**: delete moved content, update ARCHITECTURE/README, add `docs/agent-setup.md`; installer + GitHub Releases when sharing becomes real.

Rollback per step: machine config re-points at the previous root; content moves are git-revertable.

## Open Questions

- Node default pin: `node@24` assumed; confirm the exact default at implementation time.
- Whether `mfz guide` v1 needs topic args (`mfz guide <topic>`) — start single-page, split only if it gets fat.
- Exact `.gitignore` contents for scaffolded homes (at minimum `node_modules/`).
