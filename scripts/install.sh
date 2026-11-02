#!/usr/bin/env bash
set -euo pipefail

MFZ_HOME="${MFZ_HOME:-$HOME}"
MFZ_BIN="$MFZ_HOME/.local/bin"
REPO="${MFZ_REPO:-meeaster/mindframe-z}"
TAG="${MFZ_VERSION:-latest}"

missing=()
for tool in git curl; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "mindframe-z needs bash, git, and curl; install ${missing[*]} with your package manager first." >&2
  exit 1
fi

mkdir -p "$MFZ_BIN"

if command -v mise >/dev/null 2>&1; then
  mise self-update -y || true
else
  curl https://mise.run | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

case "$(uname -s)" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch="x64" ;;
  aarch64 | arm64) arch="arm64" ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
asset="mfz-$os-$arch"

if [ "$TAG" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$asset"
else
  url="https://github.com/$REPO/releases/download/$TAG/$asset"
fi

# The self-contained bun binary embeds its runtime and assets — install it directly.
# Download to a temp file and rename: atomic, so a dropped transfer never truncates
# the live binary and a running mfz process never causes ETXTBSY.
tmp="$(mktemp "$MFZ_BIN/mfz.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp"
chmod +x "$tmp"
# mfz-release always holds the release binary, so `mfz-release engine use release` can recover
# from a broken source build. A source install links mfz into a checkout; leave that link alone.
cp "$tmp" "$MFZ_BIN/mfz-release"
if [ -L "$MFZ_BIN/mfz" ]; then
  echo "mfz runs from a source checkout; updated only mfz-release"
else
  mv "$tmp" "$MFZ_BIN/mfz"
fi

rc="$HOME/.zshrc"
shell_kind="zsh"
if [ -n "${SHELL:-}" ] && [ "$(basename "$SHELL")" = "bash" ]; then
  rc="$HOME/.bashrc"
  shell_kind="bash"
fi
# Put mfz on PATH and activate mise for the user's shells. Guarded so re-running
# installs once.
if ! grep -qs "Added by mindframe-z installer" "$rc"; then
  {
    printf '\n# Added by mindframe-z installer\n'
    # Expand PATH when the generated rc file is sourced.
    # shellcheck disable=SC2016
    printf 'export PATH="%s:$PATH"\n' "$MFZ_BIN"
    # Run mise activation when the generated rc file is sourced.
    # shellcheck disable=SC2016
    printf 'if command -v mise >/dev/null 2>&1; then eval "$(mise activate %s)"; fi\n' "$shell_kind"
  } >> "$rc"
fi

echo "installed the mfz release binary to $MFZ_BIN"
