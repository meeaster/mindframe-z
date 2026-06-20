## Context

The sandbox runs one agent per `docker run --rm` and branches the container
environment on which agent is launched (`scripts/run-sandbox.sh:116`). The
in-container entrypoint (`scripts/run-with-mcp-shims.mjs`) spawns MCP shims, then
spawns the single agent, and kills the shims when that agent exits
(`run-with-mcp-shims.mjs:75-93`). This makes the sandbox a one-shot tool runner.

The operator wants to enter the container as an environment — a shell where
`claude`, `opencode`, and `gh` are all on the PATH and MCP shims are already
running — that feels like their WSL shell, while preserving the credential
boundary (no host `$HOME` or secret dotfile mounts; the launcher already rejects
credential-store mounts at `run-sandbox.sh:39-50`).

This is Horizon 1: prove the interactive environment works. The longer-term
vision of folding this into mindframe-z is captured in
`docs/vision-mindframe-z.md` and is out of scope here.

## Goals / Non-Goals

**Goals:**
- Prepare the container identically regardless of agent; inject the union of
  provider environment.
- Run MCP shims as a container-lifetime background service decoupled from any
  single agent process, with readiness gating before clients start.
- Provide an interactive zsh + oh-my-zsh + powerlevel10k + mise shell, with
  `mise install` during image build and sanitized config laid down.
- Persist Claude Code and opencode state in sandbox-owned repo-local directories,
  not host home directories.
- Keep the runner generic — no hardcoded operator host paths.

**Non-Goals:**
- mindframe-z integration, `mfz sandbox`, or the core/personal repo split.
- A persistent long-lived daemon container with `up`/`down`/`status` lifecycle
  management (see Decisions — deferred).
- Direct egress lockdown beyond the existing proxy posture (already deferred in
  the README).

## Decisions

### Decision: Inject the union of provider env; prepare the container identically

Remove the `claude` vs `opencode`/`bash` env branch. Always inject the Bedrock /
Claude env (`CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_BEDROCK_BASE_URL`,
`ANTHROPIC_MODEL`, `AWS_*` placeholders, debug dir) and the `GH_TOKEN=PLACEHOLDER`
together.

Rationale: the two env sets target different upstreams through different config
namespaces and do not conflict — opencode ignores `ANTHROPIC_BEDROCK_BASE_URL`,
Claude ignores `GH_TOKEN`. The branch was tidiness, not necessity. Removing it is
the precondition for "enter as a shell and run whatever," and collapses three
launch paths into one.

Alternative considered: keep branching and add a separate `shell` mode that
injects the union. Rejected — it keeps three code paths and re-creates the
"which mode am I in" problem the change is meant to remove.

### Decision: Container lifecycle is one container per shell session (per-entry)

Each launch starts a container, runs shims in the background, then starts the
interactive shell (or the named agent). The wrapper remains alive to own shim log
pipes and cleanup. The container lives as long as that session and is removed on
exit (`--rm` retained).

Rationale (KISS/YAGNI for Horizon 1): tool-switching — the operator's core ask —
already works within a single session. Inside one shell the operator runs
`opencode`, exits back to the shell, runs `claude`, all against the same
long-running shims in the same container. A persistent `up`/`down` daemon adds
lifecycle state ("is it up?", "which one am I in?", stale containers) that is not
needed to prove the concept.

Alternative considered: long-lived detached container with `sandbox up` /
`exec` / `down`. Deferred — it buys cross-invocation filesystem persistence and
one-time shim boot, but those are not required for Horizon 1. Recorded as a
follow-up, not built now.

### Decision: Entrypoint starts shims as a background service, then starts the session command

`run-with-mcp-shims.mjs` flips from "spawn shims, spawn agent, kill shims on
agent exit" to: generate config, start shims in the background, wait for their
local endpoints to accept connections, then start the session command — an
interactive shell when no agent is named, or the named agent command directly.
Shims are bound to wrapper/container lifetime, not to a single agent invocation.

Rationale: agents become clients of an already-running broker. The wrapper stays
alive instead of `exec`ing the session process so shim stderr log pipes remain
open and the wrapper can explicitly terminate shims when the session exits.

### Decision: Shell layer is baked into the image; config laid down from sanitized sources

Use a Debian base image and install zsh, oh-my-zsh, powerlevel10k, and mise in
`sandbox/Dockerfile`. Commit a simple `.zshrc`, `.p10k.zsh`, and `mise.toml`,
with Node coming from mise rather than the base image. The committed `mise.toml`
uses a Node 24 major-version selector and a minimum release-age gate, so builds
pick the latest eligible Node 24 release without taking brand-new releases. The
image build lays the dotfiles into the container home and runs `mise install`.

Rationale: baking the shell into the image keeps the environment reproducible and
self-contained, honoring the credential boundary for free — nothing from the host
`$HOME` is mounted, so `~/.zsh_history` and secret-exporting rc files never enter
the container. The committed config is an explicit throwaway stand-in for the
eventual mindframe-z profile; keeping it path-agnostic keeps the future swap
cheap.

Alternative considered: mount the operator's host dotfiles read-only. Rejected —
it conflicts with the existing `reject_credential_mount` posture and risks
leaking history and secret-bearing rc files.

### Decision: Persist agent state in sandbox-owned repo-local mounts

Mount repo-local directories under `.cache/sandbox-home/` into the container for
Claude Code and opencode state: Claude's `.claude` and `.claude.json`, plus
opencode config, data, and state directories. Seed missing files from sanitized
placeholders only.

Rationale: direct host home mounts would violate the credential boundary, but
fully ephemeral containers lose useful agent state on every launch. Repo-local
sandbox state gives persistence across temporary containers while keeping the
operator's real home, shell history, and secret-bearing dotfiles out of the
container.

## Risks / Trade-offs

- **Union env injection surfaces Bedrock/Claude env to opencode sessions and vice
  versa** → Acceptable: values are placeholders or proxy settings, not real
  credentials, and the tools ignore each other's namespaces. The credential
  boundary is unchanged.
- **Per-entry lifecycle re-boots shims on every entry** → Accepted for Horizon 1;
  useful agent state persists through sandbox-owned mounts, and the
  long-lived-container option remains a deferred follow-up if shim boot cost
  becomes annoying in practice.
- **Baked shell config drifts from the operator's real WSL shell** → Intentional;
  it is a stand-in. The vision doc commits to replacing it with a mindframe-z
  profile, and the path-agnostic constraint keeps that swap cheap.
- **Image grows with zsh/oh-my-zsh/p10k/mise and build time increases** →
  Acceptable for a dev sandbox; startup stays fast because tool installation is
  baked into the image.
