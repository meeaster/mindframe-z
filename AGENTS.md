# AGENTS.md

Read `ARCHITECTURE.md` before making any architectural changes or decisions. Any changes to the architecture or new/updated architectural principles must also update `ARCHITECTURE.md` to keep it current — this file is the authoritative record of the project's architecture.

## Commands

```sh
npm run build          # tsc → dist/
npm test               # vitest run
npm run test:integration  # vitest run tests/integration
npm run lint           # oxlint
npm run fmt            # oxfmt
npm run check          # lint → fmt:check → build → test (run this before committing)
npm run dev -- doctor
npm run dev -- refs list
```

`npm run dev` uses `tsx` for development. The compiled entry point in `bin/mindframe-z` imports from `dist/` — build first before using the binary.

After `mindframe-z apply`, run `mise install` to download binaries referenced in the active profile (e.g. `fff-mcp`).

## Pre-commit

Gitleaks is configured as a pre-commit hook to detect secrets in commits.

```sh
pre-commit install     # enable hooks locally (run once)
pre-commit run --all-files  # run all hooks manually
```

`pre-commit` is provided by mise (see `profiles/base/mise.toml`). The hook config lives in `.pre-commit-config.yaml` at the repo root.

## Architecture

Profile-aware AI tool config renderer. Reads YAML manifests from `shared/`, `profiles/`, and `machine/` and renders runtime config for OpenCode and Claude Code into `.runtime/`. Symlinks are created from global config directories into the rendered runtime files.

Key directories:

- `src/core/` — manifests, profile resolution, path logic, rendering orchestration, symlinks
- `src/cli/mindframe-z.ts` — main CLI: apply, doctor, status, sync, skills, smoke-opencode, refs
- `src/renderers/` — OpenCode and Claude config generators
- `src/ref-store/` — git clone/update references, write reference index
- `src/skills/` — npx skills integration
- `shared/` — manifest YAML files (refs, skills, MCP servers, AGENTS.md instructions)
- `profiles/` — profile definitions
- `machine/` — per-machine overrides (gitignored, see `machine.yml.example`)
- `opencode/plugins/` — OpenCode plugin source files
- `tests/integration/` — fully isolated CLI integration tests (temp dirs, no real homedirs)
- `skills/` — local skill source directories

## Module system

ESM with `module: "nodenext"` and `moduleResolution: "nodenext"`. Import paths use `.js` extensions for TypeScript source files. Strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

## Testing

Integration tests are completely isolated — they use `mkdtemp` temp directories for both `root` and `home`, and override `OPENCODE_CONFIG_DIR`, `CLAUDE_CONFIG_DIR`, and all other paths via env vars. They never touch `~/.config/opencode`, `~/.claude`, `~/.config/mise`, or any real home directory paths. Tests use `--no-link` to avoid symlink creation unless explicitly testing symlink behavior.

## Environment variables

- `MFZ_ROOT` — overrides config root (default: cwd)
- `MFZ_HOME` — overrides home directory (default: `$HOME`)
- `MFZ_PROFILE` — profile name (default: `machine/machine.yml` profile or `personal`)
- `MFZ_REFERENCES_DIR` — where refs are cloned (default: `~/references`)
- `OPENCODE_CONFIG_DIR` — OpenCode config dir (default: `~/.config/opencode`)
- `CLAUDE_CONFIG_DIR` — Claude config dir (default: `~/.claude`)

## Conventions

- This repo is in active development with no external users yet; prefer the simplest direct design and do not add backward-compatibility or fallback behavior unless there is a concrete current need.
- Lint/formatter: oxlint + oxfmt (not eslint/prettier). Config in `oxlint.json` and `.oxfmtrc.json`.
- `dist/`, `.runtime/`, `machine/machine.yml`, `/references/` are gitignored.
- The shared instruction file `shared/AGENTS.global.md` is rendered into AI tool runtime config — it is not this repo's agents guide.
- Profiles use `extends` to inherit from a parent. `profiles/base.yml` is the shared foundation; `personal` and `work` extend it. Arrays (`skills`, `references`, `instructions`, `opencode_plugins`) are additive on merge; maps (`mcp`, `opencode`, `claude`) are deep-merged with child keys overriding parent keys.
- MCP servers are configured in profiles as a map: `serverName: { enabled: true/false }`. Servers not listed are not rendered. `shared/mcp.yml` defines server configurations (type, url, command, etc.) but does not control enable state or profile visibility.
