## ADDED Requirements

### Requirement: Explicit observe toggle owns the lapdog container and network
The system SHALL provide `mfz thread observe up`, `mfz thread observe down`, and `mfz thread observe status` as the only commands that start, stop, or report the local lapdog observability stack. `observe up` SHALL ensure a Docker network named `mfz-net` and a lapdog container named `lapdog` running with `--lapdog-mode --web-ui-port=8080`, publishing ports `8126` (intake) and `8080` (web UI), with a machine-local volume for snapshots. `observe down` SHALL remove the container and network. Both SHALL be idempotent.

#### Scenario: Bring the stack up
- **WHEN** `mfz thread observe up` runs and no lapdog container exists
- **THEN** the `mfz-net` network and `lapdog` container are created, ports 8126 and 8080 are published, and the command reports the dashboard URL `http://localhost:8080`

#### Scenario: Up is idempotent
- **WHEN** `mfz thread observe up` runs and a healthy lapdog container is already present
- **THEN** the command leaves it running and reports it as already up, without creating a duplicate container

#### Scenario: Bring the stack down idempotently
- **WHEN** `mfz thread observe down` runs whether or not the container or network exist
- **THEN** the `lapdog` container and `mfz-net` network are removed if present, and the command succeeds without error when they are absent

### Requirement: Liveness is determined by the lapdog `/info` endpoint
The system SHALL determine whether lapdog is available by probing `GET /info` and treating an HTTP 200 response as alive. `mfz thread observe status` SHALL report whether lapdog is reachable based on this probe and SHALL NOT rely on any persisted enabled flag.

#### Scenario: Status reports a reachable lapdog
- **WHEN** `mfz thread observe status` runs and `GET /info` returns 200
- **THEN** the command reports lapdog as up and surfaces the dashboard URL

#### Scenario: Status reports an unreachable lapdog
- **WHEN** `mfz thread observe status` runs and the `/info` probe fails or refuses the connection
- **THEN** the command reports lapdog as down without erroring

### Requirement: The running container is the only source of enabled state
The system SHALL NOT persist a separate "observe enabled" flag. The presence of a reachable lapdog container SHALL be the sole indicator that observability is active, so there is no state that can drift from reality.

#### Scenario: No flag file is written or read
- **WHEN** observability is toggled up or down
- **THEN** enablement is derived only from container reachability, and no enabled/disabled flag is written to or read from configuration
