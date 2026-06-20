## Purpose

Define how Claude Code reaches Amazon Bedrock from the sandbox without exposing AWS credential material to the agent container.

## Requirements

### Requirement: SigV4 signing for Claude Code Bedrock

The sandbox SHALL run `aws-sigv4-proxy` outside the agent container. It accepts unsigned Bedrock Runtime requests from Claude Code, signs them with AWS Signature Version 4, and forwards them to the real Bedrock endpoint. AWS signing credentials MUST NOT be exposed to the agent container.

The proxy SHALL be configured with explicit service, region, signing-host, and upstream-host overrides so requests addressed to the local WSL proxy endpoint are signed as Bedrock Runtime requests.

#### Scenario: Unsigned request is signed and forwarded

- **WHEN** Claude Code sends an unsigned Bedrock request to the configured proxy endpoint
- **THEN** the proxy attaches a valid SigV4 authorization header and the upstream Bedrock request succeeds

#### Scenario: Local proxy host header does not break service detection

- **WHEN** Claude Code sends a request whose HTTP `Host` header is the local WSL proxy endpoint
- **THEN** the signer still signs for the Bedrock Runtime service using the configured `--name`, `--region`, `--sign-host`, and `--host` values

#### Scenario: Agent container holds no AWS credentials

- **WHEN** the agent container environment, filesystem, and mounts are inspected
- **THEN** no AWS access key, secret key, session token, SSO token, or AWS credential file is present

### Requirement: Credential process runs outside the agent container

The signing proxy SHALL source credentials from the Bedrock credential-process profile in a host/WSL process by default. Any writable AWS credential cache, credential-process logs, or refresh-token store SHALL be scoped to that signer environment and SHALL NOT be mounted into the agent container.

#### Scenario: Host signer can hold signer state

- **WHEN** the Bedrock signer runs on WSL/host
- **THEN** the agent container can reach the signer endpoint but cannot read the signer's AWS credential cache or credential-process runtime state

#### Scenario: Refresh validation may be deferred

- **WHEN** durable refresh-token storage is not available in the signer container
- **THEN** the implementation documents refresh as a deferred validation item rather than claiming full auto-refresh support

### Requirement: Bedrock is the only AWS surface in scope

The signing proxy SHALL broker AWS Bedrock model inference only. General multi-profile AWS CLI access is explicitly out of scope for this change.

#### Scenario: General AWS CLI is not provided

- **WHEN** an operator looks for arbitrary AWS CLI/profile brokering inside the agent container
- **THEN** it is documented as out of scope and not configured by this change
