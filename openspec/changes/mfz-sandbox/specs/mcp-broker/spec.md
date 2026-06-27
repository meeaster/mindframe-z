## ADDED Requirements

### Requirement: Sandbox MCP broker and shim config is generated from the resolved profile

The sandbox SHALL generate its MCP broker and per-server shim configuration from the
resolved profile's MCP entries rather than from a committed sandbox-specific MCP
manifest. The generation SHALL apply the existing MCP server taxonomy to classify each
resolved server and SHALL produce shim definitions only for same-host multi-identity
credentialed servers. Source and host-rendered agent MCP config SHALL keep pointing at
upstream URLs; only the sandbox runtime MCP config SHALL be rewritten to local shim
endpoints. Generation SHALL cover both opencode and Claude MCP config paths when
Claude-targeted remote MCP servers are enabled.

#### Scenario: Shim config derives from resolved profile

- **WHEN** the resolved profile enables credentialed remote MCP servers and the sandbox
  launches
- **THEN** the sandbox generates broker/shim config for those servers from the resolved
  profile, without a committed sandbox MCP manifest

#### Scenario: Only sandbox runtime config points at shims

- **WHEN** the sandbox rewrites MCP endpoints to local shims
- **THEN** the source profile and host-rendered agent MCP config still point at the
  upstream URLs

#### Scenario: Both agent MCP paths are covered

- **WHEN** a Claude-targeted remote MCP server and an opencode-targeted remote MCP
  server are enabled
- **THEN** the sandbox generates shim-pointing MCP config for each agent's config path

### Requirement: Sandbox runtime helper scripts are baked into the image

The sandbox SHALL provide its runtime helper scripts (the MCP shim launcher and egress
shim) from inside the image rather than from the mounted workspace, because the
workspace mount is the operator's project directory and not the mindframe-z repository.

#### Scenario: Helpers are available without the sandbox repo as workspace

- **WHEN** the sandbox launches with an arbitrary project mounted at the workspace path
- **THEN** the MCP shim launcher and egress shim run from the image and do not depend on
  the workspace containing those scripts
