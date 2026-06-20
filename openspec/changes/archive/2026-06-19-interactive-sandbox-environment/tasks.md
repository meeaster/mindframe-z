## 1. Unified environment injection

- [x] 1.1 Remove the `claude` vs `opencode`/`bash` env branch in `scripts/run-sandbox.sh` so the container is prepared identically
- [x] 1.2 Always inject the union of provider env: Bedrock/Claude env (`CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_MODEL`, `AWS_*` placeholders, debug dir) and `GH_TOKEN=PLACEHOLDER`
- [x] 1.3 Make the agent argument optional — no agent named means enter the interactive shell; a named agent runs directly
- [x] 1.4 Verify the launcher still rejects credential-store mounts and mounts no host `$HOME` or secret dotfiles
- [x] 1.5 Add sandbox-owned persisted Claude/opencode state mounts under `.cache/sandbox-home/` with sanitized seed files

## 2. Shell layer in the image

- [x] 2.1 Add zsh, oh-my-zsh, powerlevel10k, and mise to `sandbox/Dockerfile`
- [x] 2.2 Add a committed sanitized `.zshrc`, `.p10k.zsh`, and `mise.toml` with no real credentials, no hardcoded operator host paths, Node 24 from mise, and a 3-day minimum release age
- [x] 2.3 Lay the dotfiles into the container home as the `node` user during image build or start
- [x] 2.4 Confirm the shell config files contain only prompt/tool/shell config (no secrets, no personal absolute paths)
- [x] 2.5 Disable shell history persistence to avoid zsh lock errors and history leakage

## 3. Entrypoint: shims as background service, then exec session leader

- [x] 3.1 Refactor `scripts/run-with-mcp-shims.mjs` to start MCP shims in the background and not tie them to a single agent process
- [x] 3.2 Run `mise install` during image build so startup does not reinstall tools
- [x] 3.3 Start the session leader: an interactive zsh when no agent is named, or the named agent command directly
- [x] 3.4 Confirm container teardown on session exit reaps the background shims (no orphaned shim processes)
- [x] 3.5 Wait for shim local endpoints before starting the shell or named agent

## 4. Verification

- [x] 4.1 Enter the sandbox with no agent and confirm an interactive zsh session with the powerlevel10k prompt
- [x] 4.2 From inside the shell, run `claude`, `opencode`, and `gh api user` and confirm each works through its broker path
- [x] 4.3 Run an agent, exit back to the shell, run a second agent, and confirm the MCP shims stayed up across both
- [x] 4.4 Confirm `mise.toml`-declared tools are present on the shell PATH after build-time install
- [x] 4.5 Inspect the running container: no host `$HOME`/secret dotfile mounts, no real provider credentials in env or filesystem
- [x] 4.6 Confirm `opencode mcp list` reports Jira and Confluence connected through the local shims
