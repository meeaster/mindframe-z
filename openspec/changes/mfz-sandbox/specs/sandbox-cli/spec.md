## ADDED Requirements

### Requirement: mfz sandbox command surface

mindframe-z SHALL expose a `mfz sandbox` command that launches the sandbox for the
active profile. It SHALL accept a subcommand selecting what runs inside the container:
`shell` (or no subcommand) for an interactive shell, `cc` for Claude Code, and `oc`
for opencode. Trailing arguments SHALL be forwarded to the launched agent.

#### Scenario: Interactive shell launch

- **WHEN** the operator runs `mfz sandbox` or `mfz sandbox shell`
- **THEN** mindframe-z launches the sandbox container for the active profile and drops
  the operator into the interactive shell

#### Scenario: Agent launch with forwarded arguments

- **WHEN** the operator runs `mfz sandbox cc -p 'Reply with ok only.'`
- **THEN** mindframe-z launches the sandbox and runs Claude Code inside it with the
  forwarded arguments

#### Scenario: opencode launch

- **WHEN** the operator runs `mfz sandbox oc run -m openai/gpt-5.4-mini 'ok'`
- **THEN** mindframe-z launches the sandbox and runs opencode inside it with the
  forwarded arguments

### Requirement: Top-level agent shortcuts

mindframe-z SHALL provide `mfz cc` and `mfz oc` as top-level shortcuts equivalent to
`mfz sandbox cc` and `mfz sandbox oc` respectively, forwarding trailing arguments.

#### Scenario: Shortcut launches agent in sandbox

- **WHEN** the operator runs `mfz cc`
- **THEN** mindframe-z behaves identically to `mfz sandbox cc`

### Requirement: Rendered shell aliases for sandbox launch

mindframe-z SHALL render shell aliases `mfzcc` and `mfzoc` into the managed zsh
startup file through the apply pipeline, so `mfz apply` produces the aliases without
hand-editing the shell config.

#### Scenario: Aliases appear after apply

- **WHEN** the operator runs `mfz apply` and starts a new managed shell
- **THEN** `mfzcc` and `mfzoc` are defined and invoke the sandbox agent shortcuts

### Requirement: Clone-and-run auto-build

The first `mfz sandbox` invocation SHALL build the agent image when no image exists
for the active machine, then launch, so a freshly cloned repository runs without a
separate manual build step.

#### Scenario: First run builds then launches

- **WHEN** the operator runs `mfz sandbox` and no built sandbox image exists
- **THEN** mindframe-z builds the image and then launches the container

#### Scenario: Subsequent runs skip the build

- **WHEN** the operator runs `mfz sandbox` and a current image already exists
- **THEN** mindframe-z launches without rebuilding

### Requirement: Initialization is explicit-only and non-destructive

Initialization of the sandbox broker SHALL happen only through an explicit `mfz sandbox
init` command and SHALL NOT be triggered implicitly by any other command. When the
broker is not initialized, `mfz sandbox` SHALL refuse to launch and SHALL instruct the
operator to run `mfz sandbox init`. `mfz sandbox init` SHALL be idempotent and strictly
non-destructive: on an already-initialized machine it SHALL NOT overwrite the existing
master password or broker state and SHALL only report status. This change SHALL NOT
provide a reinitialize flag or an automated reset/destroy command; teardown SHALL be a
manual, documented operation.

#### Scenario: Launch is refused when uninitialized

- **WHEN** the operator runs `mfz sandbox` and the sandbox broker is not yet initialized
- **THEN** mindframe-z refuses to launch and instructs the operator to run
  `mfz sandbox init`

#### Scenario: Explicit init creates state once

- **WHEN** the operator runs `mfz sandbox init` on an uninitialized machine
- **THEN** mindframe-z initializes the broker and persists the generated secrets

#### Scenario: Re-running init is harmless

- **WHEN** the operator runs `mfz sandbox init` against an already-initialized broker
- **THEN** mindframe-z makes no destructive changes, does not overwrite the master
  password, and reports the existing initialized state

#### Scenario: No automated reset path exists

- **WHEN** the operator inspects the sandbox command surface
- **THEN** there is no reinitialize flag and no automated reset/destroy command

### Requirement: Lifecycle orchestration

`mfz sandbox` SHALL ensure the persistent broker services required by the active
machine's credential mode are running before launching the agent container, and SHALL
run the agent container as an ephemeral container that is removed on exit.

#### Scenario: Services are started before the container

- **WHEN** the operator runs `mfz sandbox` and the required broker services are not
  running
- **THEN** mindframe-z starts the broker services before launching the agent container

#### Scenario: Agent container is ephemeral

- **WHEN** the agent container exits
- **THEN** the agent container is removed while the broker services and their state
  volumes persist
