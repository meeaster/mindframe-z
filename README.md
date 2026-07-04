# mindframe-z

Profile-aware AI tool configuration renderer. Reads YAML manifests from profiles and renders runtime config for OpenCode and Claude Code. Machine-local config selects the active profile, sets reference directories, and grants agents access to extra local folders.

## Commands

```sh
pnpm install
pnpm build
pnpm test
pnpm test:all
pnpm test:integration
pnpm test:sessions
pnpm lint
pnpm fmt
pnpm check
pnpm schemas
pnpm build && npm link
pnpm dev doctor
pnpm dev --profile personal apply --target all --dry-run
pnpm dev --home /tmp/mindframe-z-home smoke-opencode
pnpm dev refs list
pnpm dev thread destinations
mfz doctor
```

By default, commands use `--root <path>`, `MFZ_ROOT`, `repo_path` from `~/.mindframe-z/config.yml`, then the current directory as the config root. Set `repo_path` when using the globally linked `mfz` command from outside this repository.

`~/.mindframe-z/config.yml` may declare `extra_folders` for local directories agents should know about outside the workspace. `mfz apply` writes `~/.mindframe-z/extra_folders.md`, adds it to rendered agent instructions, grants OpenCode/Claude read access, and renders edit permissions from each entry. The configured `references_dir` is always readable by agents and edit-denied by default.

`mfz thread` manages cross-session thread logs outside the public config repo. Destinations are resolved from profile and machine config at command time and stored under `~/.mindframe-z/threads/<destination>/<slug>/`. Use `mfz thread create <slug> --dest <destination> --charter "<lens>"`, `mfz thread discover "<prompt>"`, `mfz thread ingest <ids...> --thread <slug>`, `mfz thread list`, `mfz thread show <slug>`, `mfz thread runs`, and `mfz thread destinations`. Read commands default to condensed text and accept `--json` where structured output is useful.

`mfz sessions backup` mirrors every local Claude Code and OpenCode session, full-fidelity and unmodified, to an S3 archive — idempotent and incremental, safe to run repeatedly. Archives are a machine-config concept (`archives` in `~/.mindframe-z/config.yml`, sibling to thread `destinations`): named S3 buckets `{ name, bucket, region, prefix?, profile?, default? }`, one `default: true` (writable), any others read-only. Where a thread `destination` backs up the *synthesized* thread store to a git remote, an `archive` backs up *raw* harness sessions to S3 — the source material threads are built from, which the harness itself deletes after its own retention window. Threads consult a readable archive to hydrate a session that has vanished from the local store, transparently, on refresh/ingest.

Thread ingestion uses a separate tools container (`Dockerfile.tools`) to run Claude Code or OpenCode headlessly. Agents are read-only text returners; TypeScript writes `manifest.json`, session files, `log.md`, `digest.md`, and `runs.json`. Raw traces and `cli.log` stay machine-local under `~/.mindframe-z/threads/`.

Integration tests use temporary directories and do not touch `~/.config/opencode` or `~/.claude`.

OpenCode plugins can be developed in `opencode/plugins/`. Enabled plugins are copied into `configs/<profile>/opencode/plugins/` and referenced from rendered `opencode.jsonc` with `file://` plugin entries. This avoids taking ownership of an existing global `~/.config/opencode/plugins` directory.

Skills are installed by `npx skills`/skills.sh into agent-owned locations such as `~/.agents/skills`; OpenCode auto-loads that directory. The renderer does not create or point OpenCode at a rendered skills directory.

`smoke-opencode` renders OpenCode config into `configs/<profile>/opencode` and runs `opencode debug config` with `OPENCODE_CONFIG_DIR` pointed at that rendered directory. It also redirects XDG config/data/cache/state paths under the provided `--home` directory so the check does not touch normal OpenCode state. If the `opencode` binary is unavailable, the check is skipped.

## Pre-commit

Gitleaks is configured as a pre-commit hook to detect secrets in commits. `pre-commit` is installed via `mise` (see `profiles/base/mise.toml`). The hook config lives in `.pre-commit-config.yaml` at the repo root.

```sh
mise install              # ensure pre-commit is available
pre-commit install        # enable hooks locally (run once)
pre-commit run --all-files  # run all hooks manually
```
