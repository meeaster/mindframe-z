#!/usr/bin/env bash
set -euo pipefail

mkdir -p /home/mark/.aws

if [ -d /host-aws ]; then
  cp -f /host-aws/config /home/mark/.aws/config 2>/dev/null || true
  cp -f /host-aws/credentials /home/mark/.aws/credentials 2>/dev/null || true
  chmod 700 /home/mark/.aws
  chmod 600 /home/mark/.aws/config /home/mark/.aws/credentials 2>/dev/null || true
fi

exec aws-sigv4-proxy "$@"
