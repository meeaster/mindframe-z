#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

repo_dir=".cache/aws-sigv4-proxy"
repo_url="https://github.com/awslabs/aws-sigv4-proxy.git"

if [ -d "$repo_dir/.git" ]; then
  git -C "$repo_dir" fetch --depth 1 origin main
  git -C "$repo_dir" checkout --detach FETCH_HEAD
else
  git clone --depth 1 "$repo_url" "$repo_dir"
fi

mkdir -p bin
go build -C "$repo_dir" -o "$(pwd)/bin/aws-sigv4-proxy" ./cmd/aws-sigv4-proxy
