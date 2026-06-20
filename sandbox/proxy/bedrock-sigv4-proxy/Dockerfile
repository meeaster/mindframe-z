FROM public.ecr.aws/aws-observability/aws-sigv4-proxy:latest AS sigv4_proxy

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=sigv4_proxy /aws-sigv4-proxy /usr/local/bin/aws-sigv4-proxy
COPY proxy/bedrock-sigv4-proxy/entrypoint.sh /usr/local/bin/bedrock-sigv4-proxy-entrypoint

RUN chmod +x /usr/local/bin/bedrock-sigv4-proxy-entrypoint

ENTRYPOINT ["bedrock-sigv4-proxy-entrypoint"]
