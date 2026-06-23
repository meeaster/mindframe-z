# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

typeset -U path fpath plugins

# Shared executables and completions used across machines.
path=(
  "$HOME/.local/bin"
  "$HOME/.opencode/bin"
  "$HOME/bin"
  "$HOME/.dotnet/tools"
  "/usr/local/go/bin"
  "$HOME/go/bin"
  $path
)

fpath=(
  "$HOME/.zsh/completions"
  "$HOME/.oh-my-zsh/custom/completions"
  $fpath
)

export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="powerlevel10k/powerlevel10k"

mfz_ensure_omz_plugin() {
  local plugin_name="$1"
  local plugin_repo="$2"
  local plugin_dir="$HOME/.oh-my-zsh/custom/plugins/$plugin_name"

  if [ -r "$plugin_dir/$plugin_name.plugin.zsh" ]; then
    return
  fi

  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 "$plugin_repo" "$plugin_dir" >/dev/null 2>&1 || true
  fi
}

mfz_ensure_omz_plugin fast-syntax-highlighting https://github.com/zdharma-continuum/fast-syntax-highlighting
plugins=(git mise zsh-autosuggestions zsh-bat fast-syntax-highlighting)

# Language/runtime managers that install shell environment files.
if [ -f "$HOME/.cargo/env" ]; then
  source "$HOME/.cargo/env"
fi

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

export BROWSER=wslview

export PNPM_HOME="$HOME/.local/share/pnpm"
path=("$PNPM_HOME" ${path:#$PNPM_HOME})

# Safety wrappers and convenience aliases.
alias ll="ls -la"
alias npm="sfw npm"
alias pnpm="sfw pnpm"
alias pip="sfw pip"
alias uv="sfw uv"
alias cargo="sfw cargo"

# Source framework/hooks after profile-specific plugin additions are appended.
mfz_finalize_zsh() {
  if [ -r "$ZSH/oh-my-zsh.sh" ]; then
    source "$ZSH/oh-my-zsh.sh"
  fi

  if [ -s "$HOME/.bun/_bun" ]; then
    source "$HOME/.bun/_bun"
  fi

  if command -v direnv >/dev/null 2>&1; then
    eval "$(direnv hook zsh)"
  fi

  if command -v mise >/dev/null 2>&1; then
    eval "$(mise activate zsh)"
  fi

  # To customize prompt, edit the managed profile .p10k.zsh source, then run mfz apply.
  [[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh
}
