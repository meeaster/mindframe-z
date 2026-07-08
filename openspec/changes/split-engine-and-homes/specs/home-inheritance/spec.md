## ADDED Requirements

### Requirement: Single upstream home per home
A home MAY declare at most one upstream home via `mfz_home.yml#extends: { name, repo }`, forming a linear chain. When an upstream is declared, the upstream home's entire content layer — catalog, profiles, instructions, local skills, and harness content — SHALL be available as the parent layer for resolution, merged under the existing profile `extends` merge semantics.

#### Scenario: Work home extends personal home
- **WHEN** the work home declares `extends: { name: personal, repo: <url> }` and its `work` profile declares `extends: personal/base`
- **THEN** the resolved `work` profile merges `base` from the upstream home exactly as an in-repo `extends: base` would

#### Scenario: No upstream declared
- **WHEN** a home has no `extends` in `mfz_home.yml`
- **THEN** all resolution happens within the home alone and qualified references are validation errors

### Requirement: Consumer-assigned upstream alias
The upstream alias SHALL be the `name` the downstream home assigns in its own `extends` declaration. The engine SHALL NOT derive home identity from any upstream self-declaration. Alias resolution SHALL compose transitively as path segments: `<alias>/<upstream-alias>/<entry>` reaches entries two hops up.

#### Scenario: Upstream rename does not break downstream
- **WHEN** the upstream repository changes its own naming or description
- **THEN** downstream qualified references using the consumer-assigned alias continue to resolve unchanged

#### Scenario: Transitive path composition
- **WHEN** home C extends B under alias `personal` and B extends A under alias `common`
- **THEN** C references an entry defined in A as `personal/common/<entry>`

### Requirement: Qualified reference resolution
An unqualified name in a profile or catalog reference SHALL resolve only in the current home's own catalog (or profiles, for `extends`), and SHALL be a validation error if not defined there. A qualified reference `<alias>/<name>` (slash-separated) SHALL resolve only in the home reached via that alias, and SHALL be a validation error if not defined there or if the alias is not declared.

#### Scenario: Unqualified name defined locally
- **WHEN** the work profile references skill `jira-writer` and the work catalog defines it
- **THEN** resolution succeeds against the work home's definition

#### Scenario: Unqualified name only defined upstream
- **WHEN** the work profile references MCP server `aws-knowledge` unqualified and only the upstream catalog defines it
- **THEN** validation fails and the error suggests the qualified form `personal/aws-knowledge`

#### Scenario: Qualified name resolves upstream
- **WHEN** the work profile references `personal/aws-knowledge` and the upstream catalog defines `aws-knowledge`
- **THEN** resolution succeeds against the upstream definition

#### Scenario: Unknown alias
- **WHEN** a reference uses `foo/entry` and no upstream is declared under alias `foo`
- **THEN** validation fails naming the unknown alias

### Requirement: Duplicate definitions across the chain
Defining a name in a downstream catalog that also exists in an upstream catalog SHALL be legal; qualification keeps references unambiguous. However, when two distinct definitions with the same terminal name are both active for the same harness in the resolved profile, rendering SHALL fail with an error naming both homes and the colliding entry.

#### Scenario: Duplicate at rest
- **WHEN** both the work and personal catalogs define an MCP server named `aws-knowledge` but only one is active for each harness
- **THEN** validation and rendering succeed

#### Scenario: Active render collision
- **WHEN** the resolved profile activates both the local `aws-knowledge` and `personal/aws-knowledge` for the same harness
- **THEN** rendering fails with an error identifying the colliding terminal name and both defining homes
