# mindframe-z

mindframe-z is the engine for rendering profile-aware AI coding tool configuration. The engine owns the CLI, schemas, renderers, sync logic, sandbox/thread helpers, and packaging. User content lives in separate **home** repositories.

A home is a git repo with `mfz_home.yml`, `catalog/`, `instructions/`, `profiles/`, optional local `skills/`, optional `opencode/`, and optional `sandbox/` overlays. A machine activates one home through `~/.mindframe-z/config.yml#home_path`.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/meeaster/mindframe-z/master/scripts/install.sh | bash
```

This installs mise, node (for the `skills` CLI), and the self-contained `mfz` binary to `~/.local/bin/mfz`, and adds shell integration to your rc file. Then, in a new shell:

```sh
mfz init --create ~/code/my-home   # or --clone <home-repo-url> / --point <path>
mfz apply --target all --agent all
```

### Agent-driven setup

Or let your AI coding agent do the whole setup — paste this into Claude Code, opencode, or Codex:

```text
Set up mindframe-z on this machine. Fetch
https://raw.githubusercontent.com/meeaster/mindframe-z/master/docs/agent-setup.md
and follow its steps. My home: <your home repo URL, or "create a new home at ~/code/my-home">
```

## Core Commands

```sh
pnpm install
pnpm build
pnpm dev guide
pnpm dev --home /tmp/mfz-home init --create /tmp/my-home
pnpm dev apply --target all --agent all --no-link
```

Common commands:

- `mfz init` creates machine config and creates, clones, or points at a home.
- `mfz guide` prints home layout and editing conventions.
- `mfz apply` renders the active home into `~/.mindframe-z/configs/<profile>/` and links or merges global tool config.
- `mfz sync` promotes unmanaged rendered config edits back into home profiles.
- `mfz doctor` validates manifests, symlinks, stale project toggles, legacy references, and upstream clone state.
- `mfz schemas` regenerates committed JSON Schemas from Zod schemas.
- `mfz work` manages durable work units, machine-local session bindings, orientation, checkpoints, and context receipts.

## Work Context

Work units preserve operational continuity across OpenCode sessions and compaction without replacing
repository documentation, Git, specifications, threads, or transcripts as authorities. Durable unit
records use `work.units_root` when configured and otherwise default to
`~/.mindframe-z/work/v1/units/`. Runtime bindings and delivery state remain under
`~/.mindframe-z/work/v1/`; linked artifacts remain pointers and are loaded only when needed.

Authored context is filesystem-first. Creation scaffolds stable paths, agents edit Markdown directly,
and validation synchronizes deterministic runtime state:

```sh
mfz work create context-continuity --title "Context continuity"
mfz work instructions update context-continuity
# Edit the returned orientation.md and context-map.md files.
mfz work instructions checkpoint context-continuity
# Create a new checkpoint Markdown file with the required frontmatter.
mfz work validate context-continuity
mfz work status context-continuity
mfz work attach context-continuity --session opencode:ses_123
mfz work phase context-continuity --phase implement
mfz work detach --session opencode:ses_123
```

The orientation hash advances its revision only after validated file changes. Attached sessions then
become stale until the adapter delivers that revision. Validated checkpoint hashes make prior
checkpoint files immutable while allowing new files to be appended. Each checkpoint carries a stable
frontmatter `id` alongside `session`, `boundary`, and `created_at`; using the ID as the filename keeps
files easy to identify. Structured reads include only files whose hashes are recorded in the manifest;
legacy checkpoint JSONL is removed after successful migration and validation. Bindings, phases, receipts, and
safe lifecycle operations remain CLI-owned; compaction writes a checkpoint file exclusively and then
uses the same validation path.

Adapters use explicit structured output:

```sh
mfz work context --session opencode:ses_123 --json
mfz work checkpoints context-continuity --json
mfz work receipts context-continuity --json
```

The optional OpenCode server and TUI adapters are enabled from a home profile as separate plugin
entries. They depend on experimental OpenCode context and compaction hooks, so failures are recorded
when possible and never block an ordinary request. Linked MFZ threads are passive historical context;
work operations do not create, ingest, refresh, or inject them.

## Machine Config

Machine-local config lives at `~/.mindframe-z/config.yml`:

```yaml
profile: personal
home_path: ~/code/my-mindframe-home
references_dir: ~/.mindframe-z/references
```

Resolution order:

- Profile: `--profile` > `MFZ_PROFILE` > machine config > `personal`
- Home root: `--root` > `MFZ_ROOT` > machine `home_path` > cwd
- References: `MFZ_REFERENCES_DIR` > machine `references_dir` > `~/.mindframe-z/references`

## Home Layout

```text
<home>/
├── mfz_home.yml
├── catalog/
│   ├── references.yml
│   ├── skills.yml
│   └── mcp.yml
├── instructions/
│   └── AGENTS.md
├── profiles/<name>/
│   ├── profile.yml
│   ├── mise.toml
│   └── dotfiles...
├── skills/
├── opencode/
│   ├── plugins/
│   ├── commands/
│   └── agents/
└── sandbox/
```

Homes may declare one upstream:

```yaml
extends:
  name: personal
  repo: git@github.com:you/personal-home.git
```

Unqualified names resolve only in the active home. Upstream entries use qualified names such as `personal/base`, `personal/aws-knowledge`, or `personal/common/tool`.

## Rendered Output

Rendered files are machine-local and never committed to homes:

```text
~/.mindframe-z/configs/<profile>/
```

References default to:

```text
~/.mindframe-z/references/
```

Upstream homes are managed as writable clones under:

```text
~/.mindframe-z/homes/<alias>/
```

## Development

```sh
pnpm build
pnpm test
pnpm test:integration
pnpm check
pnpm schemas
pnpm release
```

`pnpm release` cross-compiles a self-contained `bun --compile` binary per platform
(`release/mfz-<os>-<arch>`); `scripts/install.sh` downloads the matching one. It
requires `bun` on PATH.

If local mise shims are not active before applying a home, run commands with explicit tools, for example:

```sh
mise exec node@24.18.0 pnpm@11.9.0 -- pnpm build
```

Integration tests use temporary roots and homes and must not touch real `~/.config/opencode`, `~/.claude`, or `~/.config/mise`.
