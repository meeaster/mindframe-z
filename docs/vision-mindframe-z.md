# Long-Term Vision: Sandbox as a mindframe-z Capability

This sandbox is a proving ground. The long-term intent is to fold it into
[mindframe-z](file:///home/mark/code/mindframe-z) so that running an ephemeral,
credential-brokered agent container becomes a first-class capability of the same
system that already renders shell, tool, and agent config across machines.

This document captures the target so the throwaway Horizon 1 work in this repo
stays honest to it. It is intentionally a sketch, not a spec.

## Why mindframe-z

mindframe-z already resolves "who you are in a given context" into rendered
artifacts: dotfiles (`.zshrc`, `.p10k.zsh`), `mise/config.toml`, and agent config
(opencode, claude). A sandbox needs exactly those artifacts plus a security
boundary. So the sandbox is not a new thing to configure — it is one more runner
hanging off profile resolution that already exists.

mindframe-z gains a third meaning:

| Capability | Status |
| --- | --- |
| Config sync across terminals | today |
| Agent config rendering (opencode, claude) | today |
| Ephemeral sandboxes to work out of | the vision |

## The Core Idea: profile × boundary-overlay

The sandbox is **not** a separate profile from `work` or `personal`. It is the
profile you already have, run through a boundary overlay that strips secrets and
inserts the broker.

```
   profile (WHO you are)          overlay (WHERE you run)
   ┌──────────────────────┐       ┌──────────────────────┐
   │ work / personal:     │       │ sandbox overlay:     │
   │  dotfiles, refs,     │──────▶│  • brokered creds    │──▶ ephemeral
   │  mise deps, agent cfg│       │  • proxy egress      │    container
   └──────────────────────┘       │  • placeholder env   │
   (already maintained)           │  • no host $HOME     │
                                  └──────────────────────┘
```

Pick `work` or `personal`; the overlay removes secrets and adds the boundary.
You do not maintain parallel `sandbox-work` / `sandbox-personal` configs —
sandboxes come for free from the profiles you already keep.

## The Delta Between WSL and Sandbox

The container should feel like your WSL instance. The only differences are the
security boundary — everything else is the same rendered profile.

| | WSL | Sandbox |
| --- | --- | --- |
| zsh + p10k + plugins | yes | **same** |
| mise dev deps | yes | **same** |
| aliases, prompt, keybinds | yes | **same** |
| opencode / claude / gh on PATH | yes | **same** |
| credentials | reads real `~/.aws`, `~/.claude`, gh token | **brokered via Agent Vault** |
| egress | open | **through MITM proxy** |
| shell history | `~/.zsh_history` (secrets) | **fresh / none** |
| home directory | full `$HOME` mounted | **only `/workspace` + rendered dotfiles** |

Everything above the credential line is "your environment." Everything below is
the boundary. If the sandbox feels different beyond those rows, the config is
wrong, not the design.

## Division of Labor

What this repo proves out splits cleanly when it moves:

| Folds into the profile (the "me" part) | Stays as the boundary (the real value) |
| --- | --- |
| `.zshrc`, `.p10k.zsh` | Agent Vault wiring |
| `mise.toml` dev deps | bedrock-sigv4-proxy |
| opencode / claude config | MITM egress + CA plumbing |
| refs, aliases | placeholder env injection |
| | mount-rejection / no-`$HOME` posture |
| | MCP egress shims |

The cheap `.zshrc` / `.p10k.zsh` / `mise.toml` written in Horizon 1 are explicit
stand-ins for the profile part. The proxy / vault / shim machinery is the
permanent core that becomes the **sandbox boundary overlay** in mindframe-z.

## Sharing and the Repo Split

mindframe-z today is personal — it carries specific refs, extra folders, and
setups. Sharing the sandbox capability without sharing personal config implies a
future split:

| Repo | Contents |
| --- | --- |
| `mindframe-z-core` (shareable) | renderer engine, sandbox capability, base profile |
| `mindframe-z-<user>` (private) | personal profiles, refs, extra folders |

The sandbox **capability** belongs in core; a specific **sandbox profile** stays
private. This argues for keeping the sandbox runner generic and profile-driven —
never hardcoding personal paths — even in Horizon 1, so the split stays cheap.

## Eventual Invocation

```
   profiles/<p>/ ──▶ renderers ──▶ configs/<p>/{dotfiles,mise,opencode,claude}
                                          │
                                          ▼
                            `mfz sandbox up`  spins an ephemeral container
                            from the rendered profile — your prompt, your
                            tools, brokered creds, agents on PATH.

   Then an MCP server fronts it:  "run that"  ──▶  mfz spins the sandbox.
```

## Horizon Sequence

1. **Horizon 1 (this repo):** prove the interactive environment — unified env
   injection, container-as-environment lifecycle, MCP shims as a background
   service, and a simple zsh / p10k / mise setup. Disposable config.
2. **Move to mindframe-z:** fold the boundary in as a sandbox overlay; consume
   rendered dotfiles / mise / agent config from profile resolution.
3. **Horizon 2 (mindframe-z):** `mfz sandbox` against any profile; MCP front
   door; eventual core / personal repo split for sharing.
