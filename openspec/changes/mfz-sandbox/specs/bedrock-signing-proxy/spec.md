## ADDED Requirements

### Requirement: Bedrock signer runs only in Bedrock credential mode

The Bedrock signing proxy SHALL run only when the machine's sandbox credential mode is
Bedrock, and its lifecycle SHALL be managed by `mfz sandbox` as a persistent broker
service. When the machine credential mode is subscription, the sandbox SHALL NOT start
the Bedrock signer.

#### Scenario: Signer starts in Bedrock mode

- **WHEN** the machine credential mode is Bedrock and the operator runs `mfz sandbox`
- **THEN** mindframe-z ensures the Bedrock signing proxy service is running before
  launching the agent container

#### Scenario: Signer is absent in subscription mode

- **WHEN** the machine credential mode is subscription and the operator runs
  `mfz sandbox`
- **THEN** mindframe-z does not start the Bedrock signing proxy

#### Scenario: Signer persists across agent runs

- **WHEN** an ephemeral agent container exits in Bedrock mode
- **THEN** the Bedrock signing proxy service keeps running for the next launch
