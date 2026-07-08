#!/usr/bin/env bash
set -euo pipefail

MFZ_HOME="${MFZ_HOME:-$HOME}"
MFZ_ROOT="$MFZ_HOME/.mindframe-z"
MFZ_BIN="$MFZ_ROOT/bin"
MFZ_ENGINE="$MFZ_ROOT/engine"
REPO="${MFZ_REPO:-meeaster/mindframe-z}"
TAG="${MFZ_VERSION:-latest}"

mkdir -p "$MFZ_BIN" "$MFZ_ENGINE"

if command -v mise >/dev/null 2>&1; then
  mise self-update -y || true
else
  curl https://mise.run | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

mise install node@24
mise use -g node@24

asset="mindframe-z-engine.tar.gz"
if [ "$TAG" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$asset"
else
  url="https://github.com/$REPO/releases/download/$TAG/$asset"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp/$asset"
rm -rf "$MFZ_ENGINE"/*
tar -xzf "$tmp/$asset" -C "$MFZ_ENGINE"

cat > "$MFZ_BIN/mfz" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ENGINE="$HOME/.mindframe-z/engine"
exec node "$ENGINE/dist/cli/mfz.js" "$@"
EOF
chmod +x "$MFZ_BIN/mfz"

case ":$PATH:" in
  *:"$MFZ_BIN":*) ;;
  *)
    rc="$HOME/.zshrc"
    [ -n "${SHELL:-}" ] && [ "$(basename "$SHELL")" = "bash" ] && rc="$HOME/.bashrc"
    printf '\nexport PATH="%s:$PATH"\n' "$MFZ_BIN" >> "$rc"
    ;;
esac

echo "installed mfz to $MFZ_BIN/mfz"
