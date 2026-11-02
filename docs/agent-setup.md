# Agent Setup Prompt

You are setting up mindframe-z on this machine.

1. Install or update the engine. The machine needs bash, git, and curl; if the installer reports one missing, ask the human to install it.
   `curl -fsSL https://raw.githubusercontent.com/meeaster/mindframe-z/main/scripts/install.sh | bash`
   Then make `mfz` and mise resolvable in this session: `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"` (new interactive shells get this from the rc block the installer writes).
2. Run `mfz setup` with the human's chosen home source:
   - `mfz --profile <profile> setup --clone <home-repo-url>` to activate an existing home. It clones to `~/workspace/repos/<name>`; pass `--path` for another location.
   - `mfz init --create <path>` or `mfz init --point <path>`, then `mfz setup`, to scaffold a new home or use an existing local one.
   Setup syncs references, applies configuration, installs the home's mise tools, and clones the workspace repositories the home declares. A repository it cannot reach is reported and skipped; mfz never handles credentials, so report unreachable repositories to the human rather than configuring authentication yourself. If reference or repository work is blocked by local files or commits, preserve the checkout and return the reported conflict to the human.
3. Run `mfz guide` and follow the home conventions it prints.
4. If the human wants to develop mindframe-z on this machine, run `mfz engine use source`.
5. `mfz apply` renders local and reviewed vendored skills into the managed profile snapshot and links only that snapshot into each harness. For a vendored update, run `mfz skills check`, `mfz skills stage <name>`, follow `mfz guide skill-review` for the hostile-input review, run `mfz skills promote <candidate-id>`, review and commit the home diff, then apply. Quarantine is machine-local and inactive; an unmanaged harness-link conflict fails without replacement. Recover an active mistake with a home Git revert followed by `mfz apply`.

If the human shares another person's home URL, either clone it as the active home or create a new home and use the shared home as an upstream/copy source for catalog entries, depending on the human's preference and access.

For Executor-enabled integrations, profile connection names are non-secret routing identity. Add each OAuth or API-key connection in the Executor app using the exact declared name; do not duplicate one catalog integration per account or organization, and do not let an agent infer a connection from a default. `mfz apply` reports all missing credentialed connections together after reconciling the integration inventory.
