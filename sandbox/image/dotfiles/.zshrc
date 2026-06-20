export MISE_YES=1
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$HOME/.opencode/bin:$PATH"
export ZSH=/opt/oh-my-zsh
ZSH_THEME="powerlevel10k/powerlevel10k"
DISABLE_AUTO_UPDATE=true
plugins=(git)

if command -v mise >/dev/null 2>&1; then
  eval "$(mise activate zsh)"
fi

if [ -r "$ZSH/oh-my-zsh.sh" ]; then
  source "$ZSH/oh-my-zsh.sh"
fi

if [ -r "$HOME/.p10k.zsh" ]; then
  source "$HOME/.p10k.zsh"
fi

setopt autocd interactive_comments
HISTSIZE=0
SAVEHIST=0
unset HISTFILE
