# mindframe-z

A profile-aware configuration renderer for AI coding tools. It keeps one set of
YAML manifests as the source of truth for OpenCode and Claude Code — plus tool
versions (mise), dotfiles, references, skills, and MCP servers — and renders them
into the config files each tool expects.

Instead of hand-editing `~/.config/opencode/opencode.jsonc`, `~/.claude/CLAUDE.md`,
`~/.config/mise/config.toml`, and a pile of dotfiles on every machine, you describe
what you want once in a profile and run `mfz apply`. The machine you're on decides
which profile is active and fills in host-specific details.

The CLI is `mfz`.

## What it manages

- **OpenCode and Claude Code** — agent instructions, permissions, MCP servers, and
  slash commands, rendered to each tool's native config format.
- **mise** — tool versions and per-project environment.
- **Dotfiles** — files like `.npmrc` and a managed `.zshrc` that sources local
  secrets and machine-specific overrides.
- **References** — git repos cloned locally that agents can consult, plus a
  generated index so agents can discover them without loading everything into
  context.
- **Skills** — portable skill definitions installed per agent, with repo-local and
  global enable/disable toggles.
- **Threads** — long-running topics of work distilled from your agent sessions
  across harnesses (see [Threads](#threads)).

## How it works

Configuration is layered so no single file has to encode every concern:

- **Catalog** (`shared/*.yml`) — what exists: available references, skills, and MCP
  servers.
- **Profile** (`profiles/*/profile.yml`) — what a context wants: which catalog items
  are enabled, plus tool settings. Profiles inherit from `base` via `extends`.
- **Machine** (`~/.mindframe-z/config.yml`) — what this computer enables: active
  profile, repo path, references directory, git identity, and extra local folders.
  This file is machine-local and never committed.

Two commands move config in each direction:

```
mfz apply   profiles ──► rendered configs/<profile>/ ──► ~/.config/opencode, ~/.claude, …
mfz sync    edited configs/<profile>/ ──► back into profiles/*.yml
```

`apply` renders each profile into `configs/<profile>/` and symlinks the global tool
paths to those rendered files, so the source of truth stays visible and editable.
Because agents can edit the rendered files directly, `sync` detects those unmanaged
changes and promotes them back into the profile YAML.

For the full design, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Getting started

Requirements: Node.js and [pnpm](https://pnpm.io/). [mise](https://mise.jdx.dev/)
is used for tool versions and the pre-commit hook.

```sh
pnpm install
pnpm build
npm link            # makes the `mfz` command available globally
```

Create your machine config from the example:

```sh
cp machine-config.example.yml ~/.mindframe-z/config.yml
# edit ~/.mindframe-z/config.yml — set the active profile, repo_path, and references_dir
```

Check that everything resolves, preview a render, then apply:

```sh
mfz doctor                                   # verify manifests, profile, and symlinks
mfz --profile personal apply --dry-run       # preview without touching anything
mfz apply                                    # render and link tool globals
```

When running the globally linked `mfz` from outside this repo, set `repo_path` in
`~/.mindframe-z/config.yml` (or pass `--root <path>` / `MFZ_ROOT`) so it can find
the manifests.

During local development you can run the CLI without linking:

```sh
pnpm dev doctor
pnpm dev --profile personal apply --dry-run
```

## Features

`mfz` groups its commands by area. Run any command with `--help` for its flags.

### Core

- `mfz apply` — render runtime files and safely link tool globals.
- `mfz sync` — detect unmanaged edits in rendered config and promote them to profiles.
- `mfz doctor` — verify manifests, profile resolution, and symlink status.
- `mfz status` — print the resolved profile status.
- `mfz schemas` — regenerate the JSON Schemas for the YAML manifests.

### References

- `mfz refs sync` — clone or update the reference repositories.
- `mfz refs list` / `mfz refs status` — inspect available and enabled references.
- `mfz refs index` — regenerate the runtime reference index agents read.

### Skills

- `mfz skills sync` — install every profile-declared skill (including disabled ones).
- `mfz skills enable` / `mfz skills disable` — toggle a skill for the current repo or
  globally.
- `mfz skills list` — list profile-enabled skills.
- `mfz skills upgrade` — update git-sourced skills to their latest versions.

### Threads

`mfz thread` manages cross-session thread logs distilled from your agent sessions.
A thread has a charter (what it's about), member sessions, and generated artifacts
(session files, a log, and a digest). Thread state lives under
`~/.mindframe-z/threads/` and is stored to per-destination git remotes resolved from
your profile and machine config — separate from `mfz apply`.

- `mfz thread create <slug> --charter "<lens>"` — start a thread.
- `mfz thread discover "<prompt>"` — find candidate sessions for a new thread.
- `mfz thread ingest <ids…>` — add sessions and rebuild the digest.
- `mfz thread sweep` — detect and triage new or changed sessions against charters.
- `mfz thread pending` / `reject` / `conclude` — work through triage proposals.
- `mfz thread refresh` — re-ingest member sessions that have new content.
- `mfz thread list` / `show <slug>` / `runs` — read thread state.

Read commands default to condensed text and accept `--json` where structured output
is useful. See [CONTEXT.md](CONTEXT.md) for the thread glossary.

### Sessions

- `mfz sessions backup` — mirror every local Claude Code and OpenCode session,
  full-fidelity and unmodified, to a configured S3 archive. Idempotent and
  incremental — safe to run repeatedly.

### Sandbox

- `mfz sandbox` — launch the active profile inside a credential-brokered container
  (`cc` / `oc` to run Claude Code or OpenCode inside it).
- `mfz sandbox observe` — manage the optional lapdog observability dashboard.

### smoke-opencode

- `mfz smoke-opencode` — render the OpenCode config and validate it with an isolated
  `opencode debug config` run that does not touch normal OpenCode state.

## Configuration

### Machine config

`~/.mindframe-z/config.yml` selects the active profile and provides host-specific
inputs. Start from [`machine-config.example.yml`](machine-config.example.yml):

```yaml
profile: personal
repo_path: ~/code/mindframe-z
references_dir: ~/references

# git:
#   name: Your Name
#   email: you@example.com

# extra_folders:
#   - path: ~/code/work/my-work-repo
#     description: Work project — needed when modifying deploy logic
#     edit: deny
```

`extra_folders` declares directories outside the workspace that agents may access.
`mfz apply` writes `~/.mindframe-z/extra_folders.md`, adds it to rendered agent
instructions, and renders matching OpenCode and Claude Code permissions. Because
paths are host-specific, extra folders live in machine config, not profiles.

### Profiles

Profiles live in `profiles/<name>/profile.yml` and select from the shared catalog:

```yaml
name: personal
extends: base
agents: [opencode, claude-code]
references:
  - clack
  - ha-mcp
skills:
  home-assistant-best-practices:
    enabled: false
mcp:
  homeassistant:
    enabled: false
```

Profiles inherit from a parent with `extends`; arrays are additive and maps deep-merge
with the child overriding the parent. The full merge semantics are in
[ARCHITECTURE.md](ARCHITECTURE.md).

### Schemas

The manifest schemas are defined once as Zod in `src/core/manifests.ts`. `mfz schemas`
generates editor-facing JSON Schema files into `schemas/`, which the project editor
settings (`.zed/`, `.vscode/`) map to the YAML files for autocomplete and validation.
When you change a manifest schema, run `pnpm schemas` and commit the result alongside
the source change.

## Development

```sh
pnpm build              # compile TypeScript
pnpm test               # unit tests (src, opencode)
pnpm test:all           # every test suite
pnpm test:integration   # integration tests (use temp dirs; never touch real config)
pnpm test:sessions      # session backup tests
pnpm lint               # oxlint
pnpm fmt                # oxfmt
pnpm check              # lint + format check + build + test
pnpm schemas            # regenerate JSON Schemas from Zod
```

Integration tests use temporary directories and do not touch `~/.config/opencode` or
`~/.claude`.

OpenCode plugins are developed in `opencode/plugins/`. Enabled plugins are copied into
`configs/<profile>/opencode/plugins/` and referenced from the rendered `opencode.jsonc`
with `file://` entries, so mindframe-z never takes over an existing global plugins
directory.

### Pre-commit

Gitleaks runs as a pre-commit hook to catch secrets before they're committed.
`pre-commit` is installed via mise (see `profiles/base/mise.toml`); the hook config
lives in `.pre-commit-config.yaml`.

```sh
mise install                # ensure pre-commit is available
pre-commit install          # enable hooks locally (run once)
pre-commit run --all-files  # run all hooks manually
```
