# Work-only Oh My Zsh plugins. Keep here until plugin auto-bootstrap exists.
plugins+=(docker aws terraform)

# Work workspace defaults.
export OPENCODE_SPACE=work
export LLM_WIKI_HOME="/mnt/c/vaults/wiki"

# Route work agent CLIs through Agent Vault.
#alias claude='agent-vault run -- claude'
#alias opencode='agent-vault run -- opencode'

# Finalize shared zsh setup after profile-specific overrides are applied.
mfz_finalize_zsh
unset -f mfz_finalize_zsh
