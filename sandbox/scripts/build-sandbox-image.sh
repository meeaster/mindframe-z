#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

docker build -t "${SANDBOX_IMAGE:-local-ai-dev-sandbox-agent:latest}" -f image/Dockerfile .
