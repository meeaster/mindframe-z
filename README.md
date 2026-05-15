# mindframe-z

Profile-aware AI tool configuration renderer. Reads YAML manifests from profiles and renders runtime config for OpenCode and Claude Code. Machine-local config can add per-host OpenCode permission rules and reference directories.

## Commands

```sh
pnpm install
pnpm build
pnpm test
pnpm build && npm link
pnpm dev -- doctor
pnpm dev -- apply --profile personal --target all --dry-run
pnpm dev -- smoke-opencode --home /tmp/mindframe-z-home
pnpm dev -- refs list
mfz doctor
```

By default, commands use `--root <path>`, `MFZ_ROOT`, `repo_path` from `~/.mindframe-z/config.yml`, then the current directory as the config root. Set `repo_path` when using the globally linked `mfz` command from outside this repository.

Integration tests use temporary directories and do not touch `~/.config/opencode` or `~/.claude`.

OpenCode plugins can be developed in `opencode/plugins/`. Enabled plugins are copied into `.runtime/opencode/plugins/` and referenced from rendered `opencode.jsonc` with `file://` plugin entries. This avoids taking ownership of an existing global `~/.config/opencode/plugins` directory.

Skills are installed by `npx skills`/skills.sh into agent-owned locations such as `~/.agents/skills`; OpenCode auto-loads that directory. The renderer does not create or point OpenCode at `.runtime/opencode/skills`.

`smoke-opencode` renders OpenCode config into `.runtime/opencode` and runs `opencode debug config` with `OPENCODE_CONFIG_DIR` pointed at that runtime directory. It also redirects XDG config/data/cache/state paths under the provided `--home` directory so the check does not touch normal OpenCode state. If the `opencode` binary is unavailable, the check is skipped.

## Pre-commit

Gitleaks is configured as a pre-commit hook to detect secrets in commits. `pre-commit` is installed via `mise` (see `profiles/base/mise.toml`). The hook config lives in `.pre-commit-config.yaml` at the repo root.

```sh
mise install              # ensure pre-commit is available
pre-commit install        # enable hooks locally (run once)
pre-commit run --all-files  # run all hooks manually
```
