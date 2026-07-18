# Agent Setup Prompt

You are setting up mindframe-z on this machine.

1. Install or update the engine:
   `curl -fsSL https://raw.githubusercontent.com/meeaster/mindframe-z/master/scripts/install.sh | bash`
   Then make `mfz` resolvable in this session: `export PATH="$HOME/.mindframe-z/bin:$HOME/.local/bin:$PATH"` (new interactive shells get this from the rc block the installer writes).
2. Run `mfz init` with the human's chosen home source:
   - `mfz init --clone <home-repo-url>` to activate an existing home.
   - `mfz init --create <path>` to scaffold a new home.
   - `mfz init --point <path>` to use an existing local home directory.
3. Run `mfz guide` and follow the home conventions it prints.
4. Run `mfz apply --target all --agent all` after the home is selected.
5. `mfz apply` renders local and reviewed vendored skills into the managed profile snapshot and links only that snapshot into each harness. For a vendored update, run `mfz skills check`, `mfz skills stage <name>`, invoke `/skill-update-review <candidate-id>` as a hostile-input review, obtain human approval, run `mfz skills promote <candidate-id>`, review and commit the home diff, then apply. Quarantine is machine-local and inactive; an unmanaged harness-link conflict fails without replacement. Recover an active mistake with a home Git revert followed by `mfz apply`.

If the human shares another person's home URL, either clone it as the active home or create a new home and use the shared home as an upstream/copy source for catalog entries, depending on the human's preference and access.

For Executor-routed integrations, profile connection names are non-secret routing identity. Connect each declared identity explicitly with `mfz executor connect <integration> --connection <name>`; do not duplicate one catalog integration per account or organization, and do not let an agent infer a connection from a default.
