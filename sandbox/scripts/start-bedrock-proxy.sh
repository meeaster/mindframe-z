#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

export AWS_PROFILE="${AWS_PROFILE:-bedrock-sandbox}"
export BEDROCK_AWS_REGION="${BEDROCK_AWS_REGION:-us-west-2}"
export BEDROCK_SIGV4_PROXY_PORT="${BEDROCK_SIGV4_PROXY_PORT:-8080}"
export AWS_REGION="$BEDROCK_AWS_REGION"
export AWS_SDK_LOAD_CONFIG="${AWS_SDK_LOAD_CONFIG:-1}"

if [ ! -x ./bin/aws-sigv4-proxy ]; then
  ./scripts/build-bedrock-proxy.sh
fi

exec ./bin/aws-sigv4-proxy \
  --name bedrock \
  --region "$BEDROCK_AWS_REGION" \
  --sign-host "bedrock-runtime.${BEDROCK_AWS_REGION}.amazonaws.com" \
  --host "bedrock-runtime.${BEDROCK_AWS_REGION}.amazonaws.com" \
  --port ":${BEDROCK_SIGV4_PROXY_PORT}"
