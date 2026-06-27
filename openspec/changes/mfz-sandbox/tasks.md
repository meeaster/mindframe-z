## 1. Machine config schema: identity and credential mode

- [x] 1.1 Add git identity fields (`git.name`, `git.email`) to the machine config Zod schema in `src/core/manifests.ts`
- [x] 1.2 Add `sandbox.credentials` field (`bedrock` | `subscription`) to the machine config schema
- [x] 1.3 Regenerate `schemas/machine.schema.json` via `pnpm schemas` and update `machine-config.example.yml` with the new fields
- [x] 1.4 Add machine-config detection helper that resolves credential mode from explicit config, falling back to detection from machine-local Claude settings
- [x] 1.5 Define the machine-local source for Agent Vault operational secrets (agent token, broker master password) under `~/.mindframe-z/secrets/`, replacing committed `sandbox/.env` for clone-and-run

## 2. Git config renderer

- [x] 2.1 Add a git-config renderer that writes a machine-local identity fragment (`~/.mindframe-z/gitconfig`) from machine config, omitting identity fields when none are declared
- [x] 2.2 Wire apply to ensure `~/.gitconfig` contains an idempotent `[include] path = <fragment>` directive, preserving all existing user-curated git config (no clobber)
- [x] 2.3 Add tests covering identity-present, identity-absent, include-idempotency, and existing-config-preservation, and assert no identity in the repo

## 3. Profile-driven, generated sandbox runtime

- [x] 3.1 Add a sandbox orchestration module under `src/` that resolves the active profile and machine config into runtime inputs (mounts, env, services)
- [x] 3.2 Generate broker service definitions (Agent Vault always; Bedrock signer only in Bedrock mode) without hardcoded host paths
- [x] 3.3 Generate agent container run arguments (mounts, env, NO_PROXY) from resolved config, replacing hardcoded paths in the current launcher
- [x] 3.4 Implement the explicit read-only-config vs writable-state mount mapping: read-only config files (CLAUDE.md, managed `settings.json` snapshot + Claude MCP snapshot, `opencode.jsonc`, commands/plugins, `.zshrc`, `.p10k.zsh`, mise config, composed gitconfig + global ignore, references); writable seeded state (claude local state + `.claude.json`, opencode data/state/auth); read-write workspace
- [x] 3.5 Mount the managed Claude `settings.json` snapshot (not the merged machine-local `~/.claude/settings.json`) so host Bedrock/AWS secrets are excluded; remove the committed disposable `sandbox/image/dotfiles/` config from the launch path
- [x] 3.6 Assert no hardcoded user-home absolute paths remain in the runner
- [x] 3.7 Generate sandbox MCP broker/shim config from the resolved profile's MCP entries (applying the existing taxonomy), producing shims only for same-host multi-identity credentialed servers, covering both opencode and Claude MCP config paths
- [x] 3.8 Rewrite only the sandbox runtime MCP config to local shim endpoints; leave source and host-rendered MCP config pointed at upstream URLs

## 4. Single-Dockerfile dynamic image build

- [x] 4.1 Refactor the sandbox Dockerfile to accept resolved render output (mise tool list, agent set) as build inputs, and bake the runtime helper scripts (MCP shim launcher, egress shim) into the image so they no longer depend on the workspace mount
- [x] 4.2 Implement build-hash computation over the full build inputs (Dockerfile + generated build context incl. baked helper scripts and placeholder files + resolved `mise.toml` + agent set + pinned agent installer versions) and associate it with the built image
- [x] 4.3 Implement staleness check: rebuild when hash differs, launch warm otherwise, with a force-rebuild option
- [x] 4.4 Implement clone-and-run: first invocation with no image builds then launches

## 5. Credential brokering: mode selection and subscription leg

- [x] 5.1 Select the Claude credential leg from machine credential mode in the runtime module
- [x] 5.2 Implement the Agent Vault-brokered Claude subscription leg (placeholder auth in container, real token injected/refreshed by broker)
- [x] 5.3 Make the Bedrock signer conditional on Bedrock mode and managed as a persistent service by `mfz sandbox`
- [x] 5.4 Document/seed the one-time flow to load the Claude subscription credential into Agent Vault on a personal machine
- [x] 5.5 Implement init generation: strong master password + scoped agent token (`no-access` role, `local-ai-dev-sandbox:proxy` grant), start Agent Vault to create the data volume, create the `local-ai-dev-sandbox` vault, fetch the MITM CA; persist generated secrets to `~/.mindframe-z/secrets/` with restricted perms, never print them, never overwrite an existing master password, and instruct the operator to back up the secrets file
- [x] 5.6 Implement the separate guided provider-credential seeding step (OpenAI, GitHub, Bedrock/AWS, Claude subscription), distinct from infra bootstrap

## 6. CLI surface and aliases

- [x] 6.1 Add `mfz sandbox [shell|cc|oc]` command with trailing-argument forwarding in `src/cli/mfz.ts`
- [x] 6.2 Add top-level `mfz cc` / `mfz oc` shortcuts equivalent to the sandbox subcommands
- [x] 6.3 Render `mfzcc` / `mfzoc` shell aliases into the managed zsh startup file through the apply pipeline
- [x] 6.4 Wire lifecycle orchestration: ensure required services are up before launch; run the agent container ephemerally (`--rm`)
- [x] 6.5 Implement initialization-state detection: when uninitialized, `mfz sandbox` refuses to launch and instructs the operator to run `mfz sandbox init` (no implicit init)
- [x] 6.6 Add the explicit-only `mfz sandbox init` command: idempotent and strictly non-destructive (reports status when already initialized); no `--reinit` flag and no automated reset/destroy command

## 7. Validation across both credential modes

- [ ] 7.1 Verify on a Bedrock (work) machine: `mfz sandbox cc` runs via the signer with no AWS creds in the container
- [x] 7.2 Verify on a subscription (personal) machine: `mfz sandbox cc` runs via Agent Vault subscription brokering with no Bedrock signer
- [x] 7.3 Verify `mfz apply` config changes appear in the sandbox without rebuild, and a `mise.toml` change triggers a rebuild
- [x] 7.4 Verify git identity inside the container matches the host, no identity is committed to the repo or rendered profile config, and no token is present in mounted git config
- [x] 7.5 Verify the host `~/.gitconfig` retains its pre-existing user-curated keys after apply (include-only, no clobber)
- [x] 7.6 Verify on an uninitialized machine: `mfz sandbox` refuses and points to `mfz sandbox init`; `init` stands up the broker (master password + token stored privately, data volume + vault created), re-running `init` is non-destructive, then provider-credential seeding is a separate step
- [x] 7.7 Run `pnpm check` and `pnpm exec openspec validate --changes mfz-sandbox`
