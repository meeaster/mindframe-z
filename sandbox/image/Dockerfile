FROM debian:13-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV MISE_INSTALL_PATH=/usr/local/bin/mise \
    MISE_VERSION=v2026.6.2 \
    MISE_YES=1 \
    MISE_GLOBAL_CONFIG_FILE=/home/sandbox/mise.toml \
    PATH=/home/sandbox/.local/share/mise/shims:/home/sandbox/.local/bin:/home/sandbox/.opencode/bin:$PATH

ARG MFZ_SANDBOX_AGENTS="claude-code,opencode"

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

RUN useradd --create-home --home-dir /home/sandbox --shell /usr/bin/zsh sandbox \
    && mkdir -p /home/sandbox/.claude /home/sandbox/.local/share/opencode \
    && printf '%s\n' 'export PATH=/home/sandbox/.local/share/mise/shims:/home/sandbox/.local/bin:/home/sandbox/.opencode/bin:$PATH' > /etc/profile.d/sandbox-path.sh \
    && chown -R sandbox:sandbox /home/sandbox /opt/oh-my-zsh

COPY --chown=sandbox:sandbox placeholders/claude/settings.json /home/sandbox/.claude/settings.json
COPY --chown=sandbox:sandbox placeholders/opencode/auth.json /home/sandbox/.local/share/opencode/auth.json
COPY --chown=sandbox:sandbox generated/mise.toml /home/sandbox/mise.toml
COPY --chown=sandbox:sandbox scripts/ /opt/mindframe-z/sandbox/scripts/

USER sandbox
RUN mise install \
    && mise exec -- bash -lc 'if [[ ",${MFZ_SANDBOX_AGENTS}," == *",claude-code,"* ]]; then curl -fsSL https://claude.ai/install.sh | bash; fi; if [[ ",${MFZ_SANDBOX_AGENTS}," == *",opencode,"* ]]; then curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path; fi'

WORKDIR /workspace
