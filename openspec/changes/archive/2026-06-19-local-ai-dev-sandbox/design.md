## Context

The important trust boundary is the **coding-agent container**. It should not contain real AWS credentials, OpenAI credentials, GitHub tokens, OAuth refresh tokens, or host credential-store mounts. Broker services may hold credentials in separate containers or host processes if the agent container can only reach them over constrained proxy paths.

Supported first-cut agent paths:
- **Claude Code** uses AWS Bedrock. Bedrock requires SigV4, so a header-injecting proxy is not sufficient. A dedicated `aws-sigv4-proxy` signs Bedrock requests outside the agent container.
- **opencode** uses OpenAI only. It can use `OPENAI_API_KEY`/auth config or OpenAI OAuth auth state; in the sandbox, those values should be placeholders and Agent Vault should inject or refresh the real credential.

Not supported in the first cut:
- Anthropic-direct for opencode.
- General multi-profile AWS CLI access from inside the sandbox.
- stdio MCP servers that require local secrets inside the agent container.

## Decisions

### Containerize Agent Vault server, keep launch wrapper on WSL/host

Agent Vault supports running its server container with `HOME=/data`, persistent `/data/.agent-vault`, API port `14321`, and MITM proxy port `14322`. We should run the server this way instead of depending on a WSL daemon.

`agent-vault run --isolation=container` is not WSL-compatible in the current environment because the local CLI attempts to bind its forwarder to Docker's per-invocation bridge gateway IP, which WSL cannot bind. Therefore the WSL-supported launch path uses a named Agent Vault agent token rather than per-run host session minting.

Create the sandbox agent with instance role `no-access` and vault grant `local-ai-dev-sandbox:proxy`. The launcher reads the token from local `.env`, constructs proxy URLs for `host.docker.internal`, fetches and mounts the Agent Vault MITM CA read-only into the sandbox, and points CA environment variables at the mounted container path. This keeps real provider credentials in Agent Vault while avoiding the broken WSL container-isolation forwarder.

### The agent container is the no-secrets boundary

Credential-bearing broker containers are acceptable. The agent container must not mount `~/.aws`, `~/.agent-vault`, `~/.claude`, OpenAI auth stores, or any broker data volume. It receives placeholders, proxy/CA environment, and a scoped Agent Vault agent token. That token is a capability to use configured proxy services in the assigned vault, not to reveal stored credential values.

### Claude Code uses Bedrock through a dedicated signer

Claude Code should run with `CLAUDE_CODE_USE_BEDROCK=1` and `ANTHROPIC_BEDROCK_BASE_URL` pointing at the Bedrock signer. The signer runs as a host/WSL process by default, built from `awslabs/aws-sigv4-proxy`, because the Bedrock credential process uses a browser callback and local credential/session storage.

The signer must be started with explicit signing overrides: `--name bedrock`, `--region <region>`, `--sign-host bedrock-runtime.<region>.amazonaws.com`, and `--host bedrock-runtime.<region>.amazonaws.com`. Claude connects to the WSL proxy IP, so the incoming HTTP `Host` header is not the Bedrock runtime hostname; without `--region` and `--sign-host`, `aws-sigv4-proxy` cannot infer the AWS service and returns 502.

The credential process has real constraints discovered during implementation:
- It requires `~/.claude/settings.json` with `CLAUDE_CODE_USE_BEDROCK=1`.
- It writes logs under the Bedrock distribution `logs/` directory.
- It writes credentials under `~/.aws/credentials` for session storage.
- First-run browser auth and durable refresh-token storage are not cleanly solved in the signer container yet.

Therefore the first cut keeps the signer on WSL/host so first-run auth and refresh use the existing working environment. A purpose-built signer container remains experimental unless we add a container-compatible auth callback and refresh-token store.

### opencode uses OpenAI through Agent Vault

opencode supports OpenAI API key auth via `OPENAI_API_KEY`/config and supports OpenAI OAuth state in its auth store. The sandbox should not put the real OpenAI secret in the agent container. Use a placeholder value in env/auth content and configure Agent Vault to inject or refresh the real OpenAI credential.

Anthropic-direct opencode support is explicitly out of scope for this first cut to avoid confusing it with Claude Code's Bedrock path.

### Agent Vault agent token drives container proxying on WSL

Use a named Agent Vault agent token as the WSL-compatible authorization mechanism. The wrapper runs the agent container with Agent Vault proxy env built directly for Docker networking. The Bedrock signer host is added to `NO_PROXY` so Claude Code reaches the local SigV4 signer directly instead of routing signer traffic through Agent Vault.

This mode does not provide Agent Vault's built-in kernel egress lockdown. Direct egress prevention is deferred until we add a WSL-compatible network/firewall layer or Agent Vault gains a compatible bind strategy.

## Risks / Trade-offs

- Agent Vault agent-token proxying plus Docker launch does not block direct container egress by itself; strict egress must be added separately if required.
- A leaked sandbox Agent Vault token can use configured proxy services in `local-ai-dev-sandbox`, but should not be able to reveal stored credential values when limited to instance role `no-access` and vault role `proxy`.
- Bedrock signer refresh is not fully validated in a container because the credential process relies on browser callback and keyring/session behavior.
- opencode OAuth may require Agent Vault OAuth token-upload/connect flow rather than just API-key injection, depending on which OpenAI auth mode we choose.
- Telemetry should be either explicitly allowlisted through Agent Vault passthrough or disabled; it should not become an unreviewed direct egress hole.

## Migration Plan

1. Run Agent Vault server as a container with a persistent data volume and published API/MITM ports.
2. Create a named Agent Vault agent with `no-access` instance role and `local-ai-dev-sandbox:proxy` vault grant, then store its token in local `.env`.
3. Configure Agent Vault services for OpenAI auth for opencode. Unmatched hosts may be proxied/passed through; strict deny is not required for the first cut.
4. Run the Bedrock signer outside the agent container and verify unsigned Bedrock Invoke/Converse requests from a scrubbed caller return 200.
5. Launch Claude Code in the agent container and verify Bedrock inference through the signer.
6. Launch opencode in the agent container and verify OpenAI requests succeed through Agent Vault using only placeholder credentials in the container.
7. Verify no real provider credentials or broker storage are present in the agent container filesystem or environment.
8. Decide whether to add a separate WSL-compatible egress lockdown layer or keep direct-egress prevention deferred.
