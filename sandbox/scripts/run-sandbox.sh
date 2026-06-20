#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

agent="${1:-}"
if [ $# -gt 0 ]; then
  shift
fi

case "$agent" in
  ""|bash|zsh|claude|opencode|gh) ;;
  *)
    echo "Unsupported agent: $agent" >&2
    echo "Usage: $0 [bash|zsh|claude|opencode|gh] [agent args...]" >&2
    echo "Omit the agent to enter an interactive zsh session." >&2
    exit 2
    ;;
esac

read -r default_bedrock_host _ <<< "$(hostname -I)"
bedrock_proxy_url="${ANTHROPIC_BEDROCK_BASE_URL:-http://${default_bedrock_host}:${BEDROCK_SIGV4_PROXY_PORT:-8080}}"
agent_vault_addr="${AGENT_VAULT_ADDR:-http://127.0.0.1:${AGENT_VAULT_API_PORT:-14321}}"
agent_vault_container_addr="${AGENT_VAULT_CONTAINER_ADDR:-http://host.docker.internal:${AGENT_VAULT_API_PORT:-14321}}"
agent_vault_mitm_port="${AGENT_VAULT_MITM_PORT:-14322}"
claude_debug_dir="$(pwd)/.cache/claude-debug"
claude_debug_file=/workspace/.cache/claude-debug/debug.log
agent_vault_cache_dir="$(pwd)/.cache/agent-vault"
sandbox_home_dir="$(pwd)/.cache/sandbox-home"
host_ca_path="$agent_vault_cache_dir/mitm-ca.pem"
container_ca_path=/etc/agent-vault/mitm-ca.pem
bedrock_proxy_host="${bedrock_proxy_url#*://}"
bedrock_proxy_host="${bedrock_proxy_host%%/*}"
bedrock_proxy_host="${bedrock_proxy_host%%:*}"

reject_credential_mount() {
  local source_path="$1"
  local resolved

  resolved="$(realpath -m "$source_path")"
  case "$resolved" in
    "$HOME/.aws"|"$HOME/.aws"/*|"$HOME/.agent-vault"|"$HOME/.agent-vault"/*|"$HOME/.claude"|"$HOME/.claude"/*|"$HOME/.config/gh"|"$HOME/.config/gh"/*|"$HOME/.zshrc"|"$HOME/.zsh_history"|"$HOME/.p10k.zsh")
      echo "Refusing to mount credential store: $source_path" >&2
      exit 2
      ;;
  esac
}

if [ -z "${AGENT_VAULT_TOKEN:-}" ]; then
  echo "AGENT_VAULT_TOKEN is required. Create an Agent Vault agent with vault grant local-ai-dev-sandbox:proxy and set the token in .env." >&2
  exit 2
fi

mkdir -p "$agent_vault_cache_dir"
mkdir -p "$claude_debug_dir"
mkdir -p \
  "$sandbox_home_dir/claude" \
  "$sandbox_home_dir/opencode-config" \
  "$sandbox_home_dir/opencode-data" \
  "$sandbox_home_dir/opencode-state"

if [ ! -f "$sandbox_home_dir/claude/settings.json" ]; then
  cp image/placeholders/claude/settings.json "$sandbox_home_dir/claude/settings.json"
fi
if [ ! -f "$sandbox_home_dir/opencode-data/auth.json" ]; then
  cp image/placeholders/opencode/auth.json "$sandbox_home_dir/opencode-data/auth.json"
fi
if [ ! -f "$sandbox_home_dir/claude.json" ]; then
  printf '{}\n' > "$sandbox_home_dir/claude.json"
fi

if [ ! -s "$host_ca_path" ]; then
  agent-vault ca fetch --address "$agent_vault_addr" --output "$host_ca_path" >/dev/null 2>&1
fi

agent_vault_proxy_url="http://${AGENT_VAULT_TOKEN}:local-ai-dev-sandbox@host.docker.internal:${agent_vault_mitm_port}"

docker_args=(
  run
  --rm
  -i
  --add-host host.docker.internal:host-gateway
  -v "$(pwd):/workspace"
  -v "$sandbox_home_dir/claude:/home/node/.claude"
  -v "$sandbox_home_dir/claude.json:/home/node/.claude.json"
  -v "$sandbox_home_dir/opencode-config:/home/node/.config/opencode"
  -v "$sandbox_home_dir/opencode-data:/home/node/.local/share/opencode"
  -v "$sandbox_home_dir/opencode-state:/home/node/.local/state/opencode"
  -w /workspace
)

if [ -t 0 ]; then
  docker_args+=(-t)
fi

if [ -n "$host_ca_path" ] && [ -f "$host_ca_path" ]; then
  docker_args+=(-v "$host_ca_path:$container_ca_path:ro")
fi

if [ -n "${SANDBOX_REFERENCE_MOUNTS:-}" ]; then
  IFS=',' read -r -a reference_mounts <<< "$SANDBOX_REFERENCE_MOUNTS"
  for source_path in "${reference_mounts[@]}"; do
    [ -n "$source_path" ] || continue
    reject_credential_mount "$source_path"
    mount_name="$(basename "$source_path")"
    docker_args+=(-v "$(realpath -m "$source_path"):/references/$mount_name:ro")
  done
fi

docker_args+=(
  -e "HTTPS_PROXY=$agent_vault_proxy_url"
  -e "HTTP_PROXY=$agent_vault_proxy_url"
  -e "NO_PROXY=localhost,127.0.0.1,host.docker.internal,$bedrock_proxy_host"
  -e NODE_USE_ENV_PROXY=1
  -e "OPENCLAW_PROXY_URL=$agent_vault_proxy_url"
  -e "SSL_CERT_FILE=$container_ca_path"
  -e "NODE_EXTRA_CA_CERTS=$container_ca_path"
  -e "REQUESTS_CA_BUNDLE=$container_ca_path"
  -e "CURL_CA_BUNDLE=$container_ca_path"
  -e "GIT_SSL_CAINFO=$container_ca_path"
  -e "DENO_CERT=$container_ca_path"
  -e "AGENT_VAULT_TOKEN=$AGENT_VAULT_TOKEN"
  -e "AGENT_VAULT_ADDR=$agent_vault_container_addr"
  -e AGENT_VAULT_VAULT=local-ai-dev-sandbox
  -e WORKSPACE_DIR=/workspace
  -e "MCP_SHIM_PROXY_HOST=host.docker.internal"
  -e "MCP_SHIM_PROXY_PORT=$agent_vault_mitm_port"
  -e "SANDBOX_MCP_BROKER_ENABLED=${SANDBOX_MCP_BROKER_ENABLED:-1}"
  -e CLAUDE_CODE_USE_BEDROCK=1
  -e "ANTHROPIC_BEDROCK_BASE_URL=$bedrock_proxy_url"
  -e "ANTHROPIC_MODEL=${ANTHROPIC_MODEL:-us.anthropic.claude-haiku-4-5-20251001-v1:0}"
  -e "CLAUDE_CODE_DEBUG_LOGS_DIR=${CLAUDE_CODE_DEBUG_LOGS_DIR:-/workspace/.cache/claude-debug}"
  -e "AWS_REGION=${BEDROCK_AWS_REGION:-us-west-2}"
  -e AWS_EC2_METADATA_DISABLED=true
  -e AWS_ACCESS_KEY_ID=PLACEHOLDER
  -e AWS_SECRET_ACCESS_KEY=PLACEHOLDER
  -e AWS_SESSION_TOKEN=PLACEHOLDER
  -e GH_TOKEN=PLACEHOLDER
)

docker_args+=(
  "${SANDBOX_IMAGE:-local-ai-dev-sandbox-agent:latest}"
  node
  /workspace/scripts/run-with-mcp-shims.mjs
)

if [ -n "$agent" ]; then
  docker_args+=("$agent")
fi

if [ "$agent" = "claude" ]; then
  docker_args+=(--debug --debug-file "$claude_debug_file")
fi

docker_args+=("$@")

exec docker "${docker_args[@]}"
