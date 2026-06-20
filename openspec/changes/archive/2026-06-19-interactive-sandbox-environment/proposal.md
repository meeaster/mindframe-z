## Why

The sandbox today runs one agent per ephemeral `docker run --rm` and branches its
environment on which agent is launched, so it is a one-shot tool runner rather
than an environment an operator can work out of. The goal is to make the
container feel like the operator's own shell — enter it, and `claude`, `opencode`,
and `gh` are all just commands on the PATH — while keeping the existing
credential boundary intact.

## What Changes

- **BREAKING** Stop branching the container environment on the launched agent.
  The launcher injects the union of provider environment (Bedrock/Claude env and
  the GitHub placeholder) and prepares the container identically regardless of
  which tool runs, so any agent can be started from inside the container.
- Flip the in-container entrypoint so MCP egress shims run as a background
  service for the life of the container, wait for local shim readiness, then
  start an interactive shell or named agent command.
  Agents become clients of an already-running broker rather than owning the shim
  lifecycle. Shims no longer die when a single agent process exits.
- Add an interactive shell layer to the sandbox image: zsh, oh-my-zsh,
  powerlevel10k, and mise. The image build runs `mise install` and lays down a
  simple sanitized `.zshrc` / `.p10k.zsh` / `mise.toml`; Node resolves from the
  committed mise manifest at build time with a minimum release-age gate. These
  shell configs are explicit throwaway stand-ins for a future mindframe-z profile.
- Persist Claude Code and opencode state in repo-local sandbox-owned directories
  under `.cache/sandbox-home/`, seeded with sanitized defaults, instead of
  mounting the operator's real host home or secret-bearing dotfiles.
- Keep the runner generic and profile-driven; no personal host paths are
  hardcoded.

The long-term vision of folding this into mindframe-z (see
`docs/vision-mindframe-z.md`) is explicitly OUT of scope for this change.

## Capabilities

### New Capabilities

- `sandbox-shell`: An interactive shell environment inside the container — zsh +
  oh-my-zsh + powerlevel10k + mise, with dev dependencies installed during image
  build and sanitized config laid down from non-secret sources, so the container
  approximates the operator's WSL shell.

### Modified Capabilities

- `sandbox-runtime`: The launch flow no longer branches the container
  environment per agent and no longer requires choosing an agent at launch; the
  container is prepared identically and supports interactive entry. MCP shims run
  as a container-lifetime background service rather than alongside a single
  agent process, and agent state persists in sandbox-owned repo-local mounts.

## Impact

- **Code**: `scripts/run-sandbox.sh` (drop per-agent env branching, support
  interactive entry), `scripts/run-with-mcp-shims.mjs` (shims as background
  service, then exec a shell), `sandbox/Dockerfile` (zsh, oh-my-zsh,
  powerlevel10k, mise),
  new sanitized shell config files and a `mise.toml`.
- **Specs**: modifies `sandbox-runtime`; adds `sandbox-shell`.
- **Boundary**: must preserve the existing credential boundary — no host `$HOME`
  or secret-bearing dotfile mounts; only sanitized config is laid down.
- **Out of scope**: mindframe-z integration, `mfz sandbox` invocation, and the
  core/personal repo split.
