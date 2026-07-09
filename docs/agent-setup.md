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
5. Run `mfz skills sync` to install the profile's skills into each harness. This uses the `skills` CLI; if it reports the CLI is missing, install it (`npm install -g skills`) and re-run.

If the human shares another person's home URL, either clone it as the active home or create a new home and use the shared home as an upstream/copy source for catalog entries, depending on the human's preference and access.
