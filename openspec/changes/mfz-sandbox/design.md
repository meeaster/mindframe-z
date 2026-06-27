## Context

mindframe-z resolves "who you are in a given context" into rendered artifacts:
dotfiles (`.zshrc`, `.p10k.zsh`), `mise/config.toml`, and agent config (opencode,
claude), then links them into `~/`. A standalone sandbox proved a security boundary
for running agents in an ephemeral container — Agent Vault credential brokering, a
MITM egress proxy, a Bedrock SigV4 signer, placeholder credentials, MCP egress
shims, and a no-`$HOME` posture. Its capabilities already live in `openspec/specs/`
(`sandbox-runtime`, `sandbox-shell`, `credential-broker`, `bedrock-signing-proxy`,
`mcp-broker`) and its implementation in `sandbox/`.

Today that implementation runs through hand-written shell scripts
(`sandbox/scripts/run-sandbox.sh`, `sandbox/compose.yaml`) with hardcoded host paths
(`/home/mark/...`) and disposable, committed shell/mise/agent config
(`sandbox/image/dotfiles/`) that duplicates what mindframe-z already renders per
profile. The vision (`docs/vision-mindframe-z.md`) frames the target precisely: the
sandbox is **not a separate profile** but the profile you already have, run through a
boundary overlay; the disposable config is an explicit stand-in for the rendered
profile part.

This change makes that real: `mfz sandbox` becomes a runner hanging off profile
resolution, consuming the same rendered `configs/<profile>/` the host uses.

## Goals / Non-Goals

**Goals:**
- One command surface (`mfz sandbox [shell|cc|oc]`, `mfz cc`/`mfz oc`) that launches an
  ephemeral, credential-brokered agent container from the active profile.
- The container's environment is a function of resolved render output — the same
  dotfiles/mise/agent config the host gets — so it feels like the WSL shell.
- A single Dockerfile whose built artifact is composed dynamically per-machine from
  resolved render output; no per-profile image variants to hand-maintain.
- Fast startup: `mfz apply` config changes appear with no rebuild; tool-layer changes
  trigger an auto-detected rebuild; otherwise launches warm.
- Profiles stay byte-identical across work and personal computers; the only
  machine-specific knobs (credential mode, git identity) live in machine config.
- mindframe-z manages git config so the sandbox has identical git identity without
  identity ever entering the repo.

**Non-Goals:**
- Per-entry host/sandbox config scoping (e.g. `contexts: [host, sandbox]` tags). The
  boundary stays code-only for now; scoping is deferred until a real delta needs it.
- A complete network egress firewall. Direct outbound lockdown remains deferred per
  the existing `sandbox-runtime` spec; this is a development sandbox, not production
  isolation.
- The actual shareable-core / private-profile repo split. This change only keeps paths
  clean so that split stays cheap later.
- Portable git config management (aliases, `init.defaultBranch`, etc.). None exist
  today; only identity is managed now.

## Decisions

### Sandbox is a render context, not a profile

The sandbox consumes the *same* resolved profile the host uses. Host render links
`configs/<profile>/` into `~/`; the sandbox mounts the same `configs/<profile>/` into
the container, then code wraps it with the boundary. **Alternative considered:**
parallel `sandbox-personal`/`sandbox-work` profiles — rejected because it doubles the
config surface and breaks "add once, applies everywhere," which is the user's primary
requirement given separate work and personal computers.

### Credential mode is a machine property, not a profile property

The Claude credential leg (Bedrock vs subscription) is selected by machine config
(`~/.mindframe-z/config.yml`), auto-detected from the machine-local Claude settings
where possible (apply already reads that file to merge Bedrock/AWS settings). This
keeps profiles byte-identical across computers — the work computer brokers Bedrock,
the personal computer brokers the Claude subscription OAuth token, with the same
profile YAML on both. **Alternative considered:** encode auth mode in the profile —
rejected because the same profile must run on a Bedrock work laptop and a subscription
personal laptop; auth is a property of *where* you run, which is the machine.

### Single Dockerfile, dynamically composed artifact

One Dockerfile is maintained in the repo. Its built artifact is a deterministic
function of resolved render output: the profile's `mise.toml` tool list and agent set
are fed as build inputs so mise tools and agents are baked. A build hash over the full
build inputs (Dockerfile + generated build context incl. baked helper scripts and
placeholder files + resolved `mise.toml` + agent set + pinned agent installer versions)
determines staleness; `mfz sandbox` rebuilds only when that hash changes and otherwise
launches the warm image. **Alternatives
considered:** (a) one generic image with tools installed at runtime into a named
volume — rejected because it adds runtime install latency and volume-management logic;
(b) per-profile hand-maintained Dockerfiles — rejected because it multiplies what must
be maintained. Baking from resolved render keeps the image a pure function of config.

### Baked vs mounted layer boundary

- **Baked** (changes rarely, slow to produce): mise-installed tools, zsh/oh-my-zsh/
  powerlevel10k framework, agent binaries.
- **Mounted read-only** (changes often, must be instant): sandbox runtime config generated
  from rendered `configs/<profile>/{dotfiles,opencode,claude}` with container-native
  paths, the references directory (`MFZ_REFERENCES_DIR`, one bind mount of the whole
  tree), translated extra folders, the rendered `~/.gitconfig` + `~/.config/git/ignore`,
  and the `/workspace`.

Generating a sandbox runtime layer from the rendered config keeps `mfz apply` →
instant-in-sandbox consistent with how host render behaves, while avoiding host absolute
paths inside agent-visible markdown and config.

### Sandbox has a container-native path model

The sandbox image uses a `sandbox` user with home `/home/sandbox`. `/workspace` is the
project working tree, `/references` is the read-only reference clone tree, and
machine-local `extra_folders` are mounted under `/extra/<slug>` according to their read
and edit grants. `mfz sandbox` writes runtime copies of path-sensitive files under
`~/.mindframe-z/sandbox/<profile>/runtime/` and mounts them into `/home/sandbox`,
rewriting host paths to container paths. Host/source render output remains valid for the
host and is not expected to be path-valid inside the container.

### Lifecycle: persistent services + volumes, ephemeral container

Broker services (Agent Vault, and the Bedrock signer when the credential mode selects
it) run as persistent `compose up -d` services with persistent named volumes for
broker state. The agent container itself is ephemeral (`--rm`). This reconciles the
vision's "ephemeral" posture with the startup-time requirement: per-invocation cost is
just `docker run` of a warm image against already-running services.

### Git config via a managed include, not by owning ~/.gitconfig

mindframe-z gains a git-config renderer that manages identity through a native git
`[include]` directive rather than overwriting `~/.gitconfig`. Apply renders a
machine-local identity fragment (`~/.mindframe-z/gitconfig`) from
`~/.mindframe-z/config.yml` and ensures `~/.gitconfig` contains an idempotent
`[include] path = <fragment>` entry, preserving any user-curated git config (aliases,
signing, `includeIf`, credential helpers). This mirrors how the managed `.zshrc`
*sources* local includes instead of replacing user content. The clobber risk is purely
a *host* concern; the ephemeral container has a fresh `$HOME`, so there the sandbox
mounts a clean composed git config (identity fragment + global ignore) read-only. Git
*auth* stays a separate concern brokered via Agent Vault `GH_TOKEN`.
**Alternatives considered:** (a) read-merge-write `~/.gitconfig` like Claude
`settings.json` — rejected because git config is INI, often hand-curated, and merging
risks dropping `includeIf`/signing/helper blocks; (b) inject identity as
`GIT_AUTHOR_*`/`GIT_COMMITTER_*` env vars — rejected because the include path also
carries the global ignore file and any future portable settings through one consistent
mechanism.

### Sandbox consumes the managed Claude snapshot, not the merged settings

The sandbox mounts the managed `configs/<profile>/claude/settings.json` snapshot, not
the merged machine-local `~/.claude/settings.json`. This is deliberate: the snapshot
excludes machine-local Bedrock/AWS and other host secrets, so using it *is* the boundary
doing its job rather than a limitation to work around. The container path mapping is
made explicit — read-only config files vs. writable seeded state (claude local state +
`.claude.json`, opencode data/state/auth) vs. read-write workspace — so a read-only
config mount never overlays a directory a tool must write into.

### Sandbox MCP config is generated, and helper scripts are baked

Sandbox MCP broker/shim config is generated from the resolved profile's MCP entries
(applying the existing taxonomy), not from a committed sandbox MCP manifest; only the
sandbox runtime MCP config is rewritten to local shim endpoints while source/host config
keeps pointing upstream. The same runtime render rewrites agent-visible instruction and
index paths to `/home/sandbox/.mindframe-z`, `/references`, and `/extra/<slug>`. Because
`/workspace` becomes the operator's project directory (not the mindframe-z repo), the
runtime helper scripts (MCP shim launcher, egress shim) are baked into the image rather
than executed from the workspace mount — which also makes them build-hash inputs.

### Generated runtime, no hardcoded paths

`mfz sandbox` generates the compose service definitions and `docker run` arguments from
resolved profile + machine config rather than committing host-specific paths. This is
the "keep it clean now" requirement: the runner never embeds `/home/mark/...`, so a
future shareable-core / private-profile repo split needs no path surgery.

### Initialization is explicit-only and never destructive

Initialization happens **only** through an explicit `mfz sandbox init`; it is never
triggered implicitly. When the broker is not initialized, `mfz sandbox` refuses to
launch and instructs the operator to run `mfz sandbox init`. This is deliberate: the
Agent Vault master password is the single recovery root — losing it loses every
brokered credential — so the code path that creates (or could destroy) that state must
never run as a side effect of a normal launch.

`mfz sandbox init` is idempotent and strictly non-destructive. On an uninitialized
machine it generates a strong master password and a scoped agent token (instance role
`no-access`, vault grant `local-ai-dev-sandbox:proxy`), starts Agent Vault (creating its
data volume), creates the `local-ai-dev-sandbox` vault, and fetches the MITM CA. On an
already-initialized machine it refuses to overwrite the existing master password or
broker state and only reports status. There is **no `--reinit` flag and no automated
reset/destroy command** in this change: with no such code path, a destructive rebuild
cannot be triggered by mistake. If a teardown is ever genuinely required, it is a
deliberate manual operation (e.g. removing the broker data volume) documented as such,
performed with full awareness.

The generated master password is persisted only to the machine-local secrets location
(`~/.mindframe-z/secrets/`) with restricted permissions and is never printed. Because
that file is the sole copy, init guidance SHALL direct the operator to back up the
secrets file itself (pointing at the path, not echoing the value) so a disk loss does
not become unrecoverable credential loss.

A deliberate boundary: init generates only **infrastructure** secrets it can create
itself. **Provider credentials** (OpenAI OAuth, GitHub token, Bedrock/AWS profile,
Claude subscription token) cannot be generated and remain a separate, guided seeding
step. So a fresh clone runs `mfz sandbox init` once to stand up the broker, then a
one-time credential-seeding pass before agents can reach providers. **Alternative
considered:** auto-bootstrap on first launch — rejected because it makes the
irreversible master-password creation a side effect of a normal command, exactly the
risk the operator wants to avoid.

## Risks / Trade-offs

- **Build-hash staleness misses a relevant input** → rebuild on a superset of inputs
  (Dockerfile + resolved `mise.toml` + agent set) and expose a `--rebuild` flag to force.
- **Auto-detecting Bedrock vs subscription from machine Claude settings is brittle** →
  allow an explicit machine-config override (`sandbox.credentials`) that wins over
  detection; detection is a convenience, not the source of truth.
- **Subscription OAuth brokering is new and the token refreshes** → Agent Vault already
  refreshes OpenAI OAuth; reuse that mechanism for the Claude subscription token and
  document refresh validation as a follow-up if durable refresh storage is incomplete
  (consistent with the existing Bedrock refresh deferral).
- **Mounting the rendered config layer read-only may break tools that expect to write
  into their config dir** → keep writable agent state dirs (opencode data/state, claude
  data) on per-run volumes as the current launcher already does; mount only the rendered
  config files read-only.
- **De-hardcoding paths up front adds work before first green run** → accept it; the
  user explicitly chose "keep it clean now" to avoid a later refactor.
- **Losing the master password loses all brokered credentials** → init is explicit-only
  and non-destructive, refuses to overwrite an existing master password, ships no
  automated reset/destroy path, and directs the operator to back up the machine-local
  secrets file.
- **Generated secrets could be committed or world-readable** → store only under the
  gitignored `~/.mindframe-z/secrets/` with restricted file permissions, and never echo
  generated values to stdout.

## Migration Plan

1. Land the machine-config schema additions (git identity, sandbox credential mode) and
   the git-config renderer; `mfz apply` renders `~/.gitconfig`.
2. Refactor `sandbox/` Dockerfile + compose + launcher to be profile/path-driven and
   generated, consuming rendered `configs/<profile>/` by mount.
3. Add the `sandbox-image-build` flow (single Dockerfile, dynamic build inputs, build
   hash, auto-rebuild).
4. Add the `mfz sandbox` CLI surface, `mfz cc`/`mfz oc` shortcuts, rendered aliases, and
   lifecycle orchestration.
5. Wire credential-mode selection and Claude subscription brokering.

Rollback: the existing `sandbox/scripts/run-sandbox.sh` path can remain available until
the `mfz sandbox` path is validated on both a Bedrock (work) and subscription (personal)
machine.

## Open Questions

- Exact machine-config field shape for credential mode and git identity (single
  `sandbox.credentials: bedrock|subscription` plus `git.{name,email}`?).
- How the Claude subscription OAuth token is seeded into Agent Vault on a personal
  machine (one-time `vault grant` flow vs. reusing the existing OpenAI OAuth upload path).
- Exact machine-local layout for Agent Vault operational secrets under
  `~/.mindframe-z/secrets/` (single `sandbox.env` vs. discrete files).
