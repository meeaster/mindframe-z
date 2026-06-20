FROM debian:13-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV MISE_INSTALL_PATH=/usr/local/bin/mise \
    MISE_VERSION=v2026.6.2 \
    MISE_YES=1 \
    MISE_GLOBAL_CONFIG_FILE=/home/node/mise.toml \
    PATH=/home/node/.local/share/mise/shims:/home/node/.local/bin:/home/node/.opencode/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      gh \
      iproute2 \
      iptables \
      jq \
      openssh-client \
      python3 \
      tar \
      xz-utils \
      zsh \
    && rm -rf /var/lib/apt/lists/* \
    && git clone --depth=1 https://github.com/ohmyzsh/ohmyzsh.git /opt/oh-my-zsh \
    && git clone --depth=1 --branch v1.20.0 https://github.com/romkatv/powerlevel10k.git /opt/oh-my-zsh/custom/themes/powerlevel10k \
    && curl https://mise.run | sh

RUN useradd --create-home --home-dir /home/node --shell /usr/bin/zsh node \
    && mkdir -p /home/node/.claude /home/node/.local/share/opencode \
    && printf '%s\n' 'export PATH=/home/node/.local/share/mise/shims:/home/node/.local/bin:/home/node/.opencode/bin:$PATH' > /etc/profile.d/sandbox-path.sh \
    && chown -R node:node /home/node /opt/oh-my-zsh

COPY --chown=node:node image/placeholders/claude/settings.json /home/node/.claude/settings.json
COPY --chown=node:node image/placeholders/opencode/auth.json /home/node/.local/share/opencode/auth.json
COPY --chown=node:node image/dotfiles/.zshrc /home/node/.zshrc
COPY --chown=node:node image/dotfiles/.p10k.zsh /home/node/.p10k.zsh
COPY --chown=node:node image/dotfiles/mise.toml /home/node/mise.toml

USER node
RUN mise install \
    && mise exec -- bash -lc 'curl -fsSL https://claude.ai/install.sh | bash && curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path'

WORKDIR /workspace
