ANALYSIS_RUNTIME=docker
. "$HOME/.deno/env"

# Finalize shared zsh setup after profile-specific overrides are applied.
mfz_finalize_zsh
unset -f mfz_finalize_zsh
