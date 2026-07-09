## 1. Home manifest and layout (engine-side, content stays in-repo)

- [x] 1.1 Add `mfz_home.yml` Zod schema (`description?`, `extends?: {name, repo}`) to `src/core/manifests.ts`; regenerate schemas including `mfz_home.schema.json` and rename `refs.schema.json` → `references.schema.json`
- [x] 1.2 Rename `shared/` → `catalog/`, `refs.yml` → `references.yml`, move `AGENTS.global.md` → `instructions/AGENTS.md`; update manifest loaders and all path references
- [x] 1.3 Add home loading: require `mfz_home.yml` at the config root, resolve content from the opinionated layout, clear error when missing
- [x] 1.4 Rename machine config `repo_path` → `home_path`; update machine schema, resolution order (`MFZ_ROOT` > `home_path` > cwd), and `machine-config.example.yml`
- [x] 1.5 Add `mfz_home.yml` to this repo so it remains a valid home during migration; update editor schema mappings

## 2. Machine-local rendering

- [x] 2.1 Move rendered output root from `<home>/configs/<profile>/` to `~/.mindframe-z/configs/<profile>/`; update all renderers, symlink planning, sync readers, and sandbox runtime render inputs
- [x] 2.2 Change references default from `~/references` to `~/.mindframe-z/references/`; add doctor hint when legacy `~/references` exists without an override
- [x] 2.3 Update integration tests for the new rendered root and references default; delete `configs/` from the repo and gitignore nothing (no rendered output in homes)

## 3. Home inheritance and qualified references

- [x] 3.1 Implement upstream declaration parsing and alias registry from `mfz_home.yml#extends`
- [x] 3.2 Implement qualified reference parsing (`<alias>/<name>`, slash-separated, transitive path composition) for profile `extends`, skills, MCP, references, and instructions
- [x] 3.3 Enforce resolution rules: unqualified = local-only (error with qualified suggestion when found upstream), qualified = named home only, unknown alias errors
- [x] 3.4 Merge the upstream layer under existing `extends` semantics across the repo boundary (catalog, profiles, skills, plugins, instructions)
- [x] 3.5 Add render-time collision error when two same-terminal-name definitions are both active for one harness
- [x] 3.6 Unit tests: alias resolution, qualified/unqualified errors, transitive composition, duplicate-at-rest vs active collision

## 4. Upstream clone management

- [x] 4.1 Implement managed clones at `~/.mindframe-z/homes/<alias>/` (reuse ref-store git plumbing): clone on first resolve, `git pull --ff-only` on apply when clean, warn-and-skip when dirty/ahead, stale-clone warning offline, hard fail with no clone
- [x] 4.2 Auto-expose upstream clones as read/edit extra folders in rendered agent permissions and the extra-folders index
- [x] 4.3 Extend `mfz sync` to offer pushable upstream profiles as assignment targets, write to the clone working tree, and report uncommitted writes; exclude non-pushable remotes via `git push --dry-run`
- [x] 4.4 Add doctor checks: dirty, ahead/unpushed, and stale upstream clones
- [x] 4.5 Integration tests: apply with clean/dirty/offline upstream, cross-home sync assignment, doctor reporting

## 5. Bootstrap: init, guide, installer

- [x] 5.1 Implement `mfz init`: write machine config, resolve home via clone/create/point-at-existing, record `home_path`
- [x] 5.2 Implement the home scaffold: `mfz_home.yml`, empty catalog files, `instructions/AGENTS.md` stub, starter `profiles/base/profile.yml` (agents asked at init), `.gitignore`, README linking to agent-setup doc, schema modelines on all YAML files; verify fresh scaffold passes `mfz apply`
- [x] 5.3 Implement `mfz guide` printing the home-conventions guide (layout, catalog entries, plugins/skills, qualified references, CLI-vs-edit doctrine)
- [x] 5.4 Scaffold the slim `skills/mindframe-z/` guidance skill with `source: local` catalog entry enabled in the starter profile
- [x] 5.5 Write `docs/agent-setup.md` (agent-facing onboarding prompt: installer → `mfz init` → guide skill)
- [x] 5.6 Add node guarantee to the mise renderer: inject `node@24` when the resolved tools declare no node; profile override wins; tests
- [x] 5.7 Write the curl install script: mise install/self-update, node via mise, engine tarball from GitHub Releases → `~/.mindframe-z/engine/`, `mfz` launcher in `~/.mindframe-z/bin/`, PATH append; add `~/.mindframe-z/bin` PATH guarantee to the managed `.zshrc` renderer
- [x] 5.8 Add a release build producing the engine tarball (bundled JS + launcher) as a GitHub Releases artifact

## 6. Cut the personal home

- [x] 6.1 Create the personal home repo; move `profiles/base/`, `profiles/personal/`, `catalog/`, `instructions/`, `skills/`, `opencode/` into it; give it `package.json`/vitest for plugin tests
- [x] 6.2 Point the personal machine's `home_path` at the new repo, run `mfz apply`, and diff rendered output against pre-move output for parity
- [x] 6.3 Decide thread destination ownership: use the implicit default `home` destination instead of a separate `thread.destinations` remote

## 7. Cut the work home

- [x] 7.1 Create the work home repo: `work` profile with `extends: personal/base`, work catalog entries (jira/confluence/datadog/forge MCP, work skills, work references), `sandbox/agent-vault/` overlays, `mfz_home.yml` with `extends: {name: personal, repo: <personal home URL>}`
- [x] 7.2 Qualify upstream mentions in the work profile (`personal/base`, `personal/aws-knowledge`, `personal/visual-explainer`)
- [x] 7.3 Migrate the work machine via `mfz init`; verify upstream clone, apply parity, and remove machine-config separation hacks

## 8. Strip the engine

- [x] 8.1 Delete moved content from mindframe-z (profiles, catalog, skills, opencode content, work sandbox overlays, `configs/`); keep engine, tests, schemas, sandbox scaffolding
- [x] 8.2 Update ARCHITECTURE.md and README for the engine/home split, new paths, bootstrap flow, and glossary alignment with CONTEXT.md
- [x] 8.3 Run full check suite (`pnpm check`); verify both machines render and link correctly from their homes
