## ADDED Requirements

### Requirement: mfz guide command
The engine SHALL provide an `mfz guide` command that prints the home-conventions guide as markdown to stdout, generated from the installed engine version. The guide SHALL cover: the home layout, adding catalog entries (references, skills, MCP servers), adding local skills and OpenCode plugins/commands, profiles and `extends`, qualified references and upstream aliases, machine config, and the division of labor between editing files directly and using CLI commands. The command SHALL be named `guide` to avoid colliding with the existing `mfz skills` subcommand.

#### Scenario: Printing the guide
- **WHEN** `mfz guide` runs
- **THEN** the full conventions guide is written to stdout as markdown and the exit code is 0

#### Scenario: Guide matches installed engine
- **WHEN** two machines run different engine versions
- **THEN** each prints the guide bundled with its own installed version

### Requirement: Slim guidance skill in scaffolded homes
`mfz init` SHALL scaffold a local skill `skills/mindframe-z/SKILL.md` whose frontmatter description triggers on editing a mindframe-z home (adding plugins, skills, catalog entries, profiles, or machine config) and whose body instructs the agent to run `mfz guide` and follow its output. The scaffold SHALL register the skill as a `source: local` catalog entry enabled in the starter profile, so the skill flows through the normal skill machinery and can be toggled per profile.

#### Scenario: Agent adds a plugin in a fresh home
- **WHEN** an agent with the scaffolded skill is asked to add an OpenCode plugin inside a home
- **THEN** the skill directs it to run `mfz guide`, which states that plugins live in `opencode/plugins/` and are registered under a profile's `opencode.plugins`

#### Scenario: Skill is toggleable
- **WHEN** a profile disables the `mindframe-z` skill
- **THEN** the skill is not exposed to that profile's harnesses, like any other catalog skill

### Requirement: Agent onboarding document
The engine repository SHALL contain `docs/agent-setup.md`, written as a prompt for an AI agent performing machine setup: run the curl installer, run `mfz init`, and answer the init questions with the human; it SHALL explain using another person's home as an upstream or as a source to copy entries from. Scaffolded home READMEs SHALL link to this document.

#### Scenario: Coworker onboarding
- **WHEN** a coworker's agent is pointed at `docs/agent-setup.md` together with a shared home URL
- **THEN** the document alone suffices to reach a working `mfz apply` with that home as upstream or as copied content
