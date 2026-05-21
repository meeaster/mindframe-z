# AGENTS.md

## Commands

```sh
pnpm build             # tsc -p tsconfig.json -> dist/
pnpm test              # vitest run
pnpm test -- <file>    # focused Vitest run
pnpm test:integration  # vitest run tests/integration
pnpm lint              # oxlint
pnpm fmt               # oxfmt; skips configs/, schemas/, skills/, openspec/
pnpm check             # lint -> fmt:check -> build -> test
pnpm schemas           # regenerate schemas/*.schema.json from src/core/manifests.ts
pnpm dev -- doctor
pnpm dev -- apply --profile personal --target all --dry-run
pnpm dev -- smoke-opencode --home /tmp/mindframe-z-home
pnpm dev -- refs list
```

Use `pnpm dev -- ...` for source execution via `tsx`. The installed `mfz` binary imports from `dist/`, so run `pnpm build` before testing `bin/mfz` or `npm link` behavior.

## Architecture

Read `ARCHITECTURE.md` before architectural changes; update it in the same change when architecture or architectural principles change.

This is a profile-aware AI tool config renderer. Source manifests live in `shared/` and `profiles/`; rendered, inspectable runtime output lives in `configs/<profile>/`; global tool config paths are linked or merged from there.

Key entrypoints:

- `src/cli/mfz.ts` defines CLI commands: `apply`, `doctor`, `status`, `sync`, `skills`, `smoke-opencode`, `refs`.
- `src/core/manifests.ts` defines Zod schemas; run `pnpm schemas` after changing manifest shapes and commit `schemas/*.schema.json`.
- `src/core/profile.ts` resolves profile inheritance and merge semantics.
- `src/renderers/` owns target-specific output for `opencode`, `claude-code`, `mise`, and `dotfiles`.
- `src/sync/` promotes unmanaged edits from rendered configs back into profile YAML/TOML.

## Manifest Model

Profile resolution is `--profile` > `MFZ_PROFILE` > machine config > `personal`; root resolution is `--root` > `MFZ_ROOT` > machine `repo_path` > cwd.

`shared/*.yml` is the catalog of available refs, skills, and MCP servers. `profiles/*/profile.yml` selects what a profile enables. Machine config belongs in `~/.mindframe-z/config.yml` and is based on `machine-config.example.yml`; it owns `references_dir`, `extra_folders`, and machine-specific OpenCode overrides.

Profile arrays such as `instructions`, `references`, `opencode.plugins`, and `opencode.commands` are additive and deduplicated. Maps such as `skills`, `mcp`, `opencode.config`, `claude`, and `mise` are deep-merged with child keys overriding parent keys. `agents` is replaced by the child when set.

MCP enablement is profile-owned: `shared/mcp.yml` defines connection details only; profiles use `mcp.<name>.enabled` and optional `targets` to render servers.

## Rendering And Sync

`mfz apply` writes rendered files under `configs/<profile>/`, writes machine-local `~/.mindframe-z/references.md` and `~/.mindframe-z/extra_folders.md` when configured, and links global config unless `--no-link` or `--dry-run` is used. After a real apply, run `mise install` to fetch tools declared by the active profile.

`extra_folders` grants agents access to host-local directories outside the workspace. Renderers add OpenCode `external_directory`/`edit` permissions and Claude `permissions`/`additionalDirectories`; `references_dir` is always readable and edit-denied by default.

Claude `settings.json` and Claude MCP are not symlinked. The committed `configs/<profile>/claude/settings.json` and `mcp.json` are managed snapshots; apply merges them into local `~/.claude/settings.json` and `~/.claude.json#mcpServers` while preserving unrelated user state.

OpenCode plugins and commands are source files under `opencode/`; profiles list enabled names, and apply copies them into `configs/<profile>/opencode/` before linking the rendered OpenCode config/commands.

`mfz sync` is the intended path after editing rendered configs directly in `configs/<profile>/`; it detects unmanaged top-level config keys and promotes them to `base` or the active profile.

## Testing And Safety

Integration tests are isolated with temp `root` and `home` directories and override `OPENCODE_CONFIG_DIR` and `CLAUDE_CONFIG_DIR`; they should not touch real `~/.config/opencode`, `~/.claude`, or `~/.config/mise`. Use `--no-link` in new tests unless symlink behavior is under test.

`smoke-opencode` renders OpenCode config into `configs/<profile>/opencode`, points `OPENCODE_CONFIG_DIR` there, redirects XDG paths under the provided `--home`, and skips if the `opencode` binary is missing.

Pre-commit runs only Gitleaks. `pre-commit` is supplied by mise (`profiles/base/mise.toml`); use `mise install`, then `pre-commit install` or `pre-commit run --all-files`.

## Repo Conventions

ESM uses `module: "nodenext"`; TypeScript source imports local modules with `.js` extensions. Strict mode includes `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

Lint/format tooling is oxlint/oxfmt, not ESLint/Prettier. `.oxfmtrc.json` intentionally ignores rendered/generated/profile-owned trees such as `configs/`, `schemas/`, `skills/`, and `openspec/`.

`pnpm-workspace.yaml` enforces `minimumReleaseAge`, `strictDepBuilds`, and allowed build scripts; do not bypass these when adding packages.

This repo has no external users yet. Prefer one direct implementation over fallback or backward-compatibility paths unless persisted data, shipped behavior, or an explicit requirement makes compatibility necessary.

## Reference Descriptions

`shared/refs.yml` entries have a `description` field rendered into agent-visible indexes. Follow the conventions in `ARCHITECTURE.md#Description-Convention` when adding or updating descriptions: lead with language/stack, state purpose, and include LLM-actionable details (entrypoints, package names, config models).

`extra_folders` entries in machine config also have a `description` field rendered into `~/.mindframe-z/extra_folders.md`. Describe what the directory contains and why an agent might need access, following the same convention section.

`shared/AGENTS.global.md` is rendered into agent runtime configs. Do not put repo-maintainer instructions there unless they should appear in generated OpenCode/Claude guidance.
