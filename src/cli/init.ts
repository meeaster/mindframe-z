import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { ensureHomeGuidance } from "../core/engine-skill.js";
import { machineConfigPath, mindframeZDir, upstreamHomeRoot } from "../core/paths.js";

const mcpGuideMarkdown = `# MCP Guide

Use this guide when adding or changing a direct MCP server, Executor routing, or Executor authentication.

The catalog defines server connection details. A profile may select native agents, Executor, or both independently.

Select direct harnesses with \`agents\` and Executor with \`executor.enabled: true\`. Set both for both routes. Omitting \`agents\` selects no direct harnesses. Use a concise enabled list or a grouped state list:

\`\`\`yaml
mcp:
  fff:
    agents: [opencode, claude-code, codex]
  exa:
    agents:
      enabled: [claude-code]
      disabled: [opencode, codex]
  context7:
    executor:
      enabled: true
  datadog:
    agents: [opencode, claude-code, codex]
    executor:
      enabled: true
      connections:
        publicsafety: oauth
        tylertech: oauth
\`\`\`

Omitting \`agents\` leaves a server Executor-only. Direct entries keep per-harness toggles; OpenCode and Codex may use grouped \`disabled\` state, but Claude Code cannot be declared disabled because its user/local MCP configuration has no supported configured-but-disabled state.

Executor entries are shared inventory for all connected supported harnesses, not per-agent toggles. Set the profile-level \`executor.bridge: false\` to reconcile Executor without adding its MCP bridge to any agent. A real \`mfz apply\` starts or reuses the native Executor daemon and uses its default \`$HOME/.executor\` data store (or an intentionally set \`EXECUTOR_DATA_DIR\`), then writes harness bridges only when the bridge is enabled and required connection metadata exists. MFZ never sets \`EXECUTOR_DATA_DIR\` or \`EXECUTOR_SCOPE_DIR\`, and the bridge does not pass \`--scope\`. OAuth and API-key connections are created in the Executor app; MFZ never opens authorization flows or imports harness credentials. Keep secret-backed or project-sensitive servers direct until their Executor credential model is specified. Sandbox startup currently rejects profiles with Executor integrations.

Declare Executor authentication structure in the catalog, never credential values:

\`\`\`yaml
executor:
  authentication:
    - slug: none
      kind: none
    - slug: oauth
      kind: oauth2
    - slug: api-key
      kind: apikey
      placements:
        - carrier: header
          name: X-API-Key
          variable: api_key
\`\`\`

Normal OAuth uses endpoint discovery. The catalog accepts assisted OAuth only with both \`discoveryUrl\` and \`registrationScopes\`, but MFZ currently sends neither field to Executor. MFZ uses \`registrationScopes\` locally to check reported missing OAuth scopes. These declarations do not configure public-client registration; verify the connection in Executor before cutover.

Profile connection names must be lowercase and address-safe because Executor persists names such as \`publicSafety\` as \`publicsafety\`; MFZ rejects unsafe or mixed-case names and never silently renames durable state. A profile connection map selects catalog method slugs by exact name. Omit it only when one method can resolve to the deterministic \`main\` connection. Add each named OAuth or API-key connection in the Executor app using the exact profile connection name. Executor tools are addressed with the full integration, owner, and connection path, so agents must not choose an organization implicitly.

Apply may create only explicit no-auth connections, reports every missing credentialed connection together after reconciliation, and blocks cutover until all are present. Do not migrate a credentialed direct server until its Executor connection is verified; disconnect old Executor state explicitly before deleting or changing a durable method. Existing profile-scoped MFZ Executor directories are not migrated or deleted automatically; after an intentional backup and review, use an Executor-supported/manual migration or cleanup procedure.

Verify with plain \`mfz apply\`, then \`mfz doctor\`. Done when every declared credentialed connection has compatible metadata, the intended routing is rendered, and the profile reports healthy links.
`;

const cronGuideMarkdown = `# Scheduled OpenCode Jobs Guide

Use this guide before adding or changing a recurring \`opencode2 run\` job. Users may call these cron jobs. On this system, use an \`mfz\`-managed systemd user timer rather than \`crontab\`. Do not add a scheduler library, generic job schema, or wrapper CLI for this pattern.

## Choose a session policy

Choose the smallest policy that fits the job:

| Need | Policy | Where the task runs | \`opencode2 run\` flags |
| --- | --- | --- | --- |
| Independent run with fresh context | New direct session | New Build root | Omit \`--session\` and \`--continue\` |
| One cumulative conversation | Persistent direct session | Existing Build root | \`--session <id>\` |
| One visible thread with isolated work per run | Persistent root plus worker | Fresh child below an existing Build root | \`--session <id>\` on the root, then delegate once |
| Independent copy of a useful baseline | Forked session | New root copied from the baseline | \`--session <id> --fork\` |

Use a new direct session for independent checks that do not need a stable visible thread. Use a persistent direct session only when prior results help the next run. Use a persistent root plus a worker when the top-level session should stay stable but each run needs fresh working context, bounded fan-out, or large evidence collection. A direct policy means the Build root performs the task from the prompt without delegating first.

New sessions and forks are durable top-level sessions, so they appear in normal session lists. Choose the service's working directory deliberately because OpenCode scopes those lists by location. Worker children are also durable, but normal root-only lists hide them because they have a parent session.

Never use \`--continue\` in a scheduled service. It selects whichever root session happens to be latest for the location. A fixed \`--session\` ID is deterministic, but deleting that session makes the job fail. Do not target one persistent session from multiple services; separate services can submit competing prompts even though each individual oneshot service prevents its own overlap.

## Common setup

Keep each direct job in three source files:

~~~text
profiles/<profile>/.config/
├── opencode/jobs/<job>.md
└── systemd/user/
    ├── <job>.service
    └── <job>.timer
~~~

### Write the service and timer

Use a oneshot service. Set an absolute working directory, a complete non-interactive \`PATH\`, and the prompt file as standard input.

~~~ini
[Unit]
Description=Run <job description>

[Service]
Type=oneshot
WorkingDirectory=/absolute/project/or/reference/path
Environment=HOME=%h
Environment=PATH=%h/.local/share/mise/shims:%h/.local/bin:%h/.opencode/bin:/usr/local/bin:/usr/bin:/bin
StandardInput=file:%h/.config/opencode/jobs/<job>.md
ExecStart=%h/.opencode/bin/opencode2 run --auto --model <provider/model#variant> --agent build
~~~

Add \`--session <id>\` for either persistent policy. Add \`--fork\` only for the fork policy. Use Build with \`--auto\` by default. Keep read-only, mutation, approval, and external-side-effect guardrails in the prompt; \`--auto\` approves requests that agent policy does not explicitly deny. Add a job-specific agent only when repeated use proves that the job needs a stable custom system prompt or tighter tool policy.

Use a calendar timer with missed-run catch-up:

~~~ini
[Unit]
Description=Schedule <job description>

[Timer]
OnCalendar=*-*-* 08:00:00
Persistent=true

[Install]
WantedBy=timers.target
~~~

\`Persistent=true\` runs one catch-up activation after a missed calendar event; it does not replay every missed occurrence. Starting an already active oneshot service does not create a second concurrent instance. If different services can touch the same mutable state, serialize them or give each service isolated state.

This machine keeps WSL running, so no Windows scheduler or keepalive process is needed. If the user manager must survive logout or WSL restarts, inspect \`loginctl show-user "$USER" -p Linger\` and enable lingering deliberately. Treat the OpenCode transcript as durable report history. The systemd journal is operational output and may be volatile unless the machine configures persistent journaling.

### Write a bounded prompt

Derive the work window from the schedule when the task can be stateless; do not add a state file merely to remember the previous run. Name authoritative data sources, allowed temporary writes, prohibited mutations, and the exact human-facing output.

For evidence-heavy jobs, write temporary data under \`/tmp/opencode\` and remove it before returning.

When the prompt already contains the complete workflow, avoid redundant skill loads unless higher-priority instructions require them. Load skills for behavior the prompt does not provide; loaded skill text becomes part of that session's context.

## If using a persistent session

Create a persistent root once and record its exact ID in the service. The session location must match the service working directory. Skip this step for new direct sessions; for forks, select the intended baseline session instead.

~~~sh
opencode2 api v2.session.create --data '{"title":"Scheduled: <job>","agent":"build","model":{"providerID":"<provider>","id":"<model>","variant":"<variant>"},"location":{"directory":"<absolute-directory>"}}'
~~~

## If using a scheduled worker

Use two prompt files: \`profiles/<profile>/.config/opencode/jobs/<job>.md\` for the root's delegation instructions and \`<job>-task.md\` beside it for the complete work and output contract.

Keep a generic scheduled worker body-free so OpenCode uses its normal system prompt. Leave its model unset when it should inherit the model and variant selected by the root service.

~~~markdown
---
description: Runs one isolated scheduled job and may delegate bounded discovery to explore and research agents.
mode: subagent
permission:
  todowrite: deny
  task:
    "*": deny
    explore: allow
    research: allow
  delegate_general: deny
---
~~~

Enable the agent and nested depth in the home profile:

~~~yaml
opencode_v2:
  config:
    experimental:
      subagent_depth: 2
  agents:
    - scheduled-worker
~~~

Profile inheritance may require retaining the profile's other enabled agents in the \`agents\` list. Depth \`2\` permits \`root -> worker -> child\`; it does not grant delegation. Deny delegation on custom subagents by default. On \`worker\` and \`scheduled-worker\`, deny every child before allowing only \`explore\` and \`research\`. Use a separate read-only specialist when a child needs shell or authenticated service access that those agents do not have.

Keep the root prompt short. Pass one complete task prompt to one fresh worker, then emit only the worker's bounded human report without a preface or second synthesis. Gather and partition shared evidence before fan-out; give each child a complete batch manifest and a response cap. Keep large inventories, raw diffs, tool transcripts, and child reports out of the persistent root. Raw work remains in durable child sessions, which do not appear in the normal top-level session list.

## Models and context

Set the root model with \`--model provider/model#variant\`. A model-free child inherits the parent's model and variant. A configured child model overrides the parent.

Do not use \`OPENCODE_CONFIG_CONTENT\` as per-run agent configuration when \`opencode2 run\` connects to the shared service. The shared server reads that configuration when it starts. The CLI environment attached to a managed-service session is shell environment, not a new location configuration.

OpenCode compacts long sessions automatically. Compaction preserves the durable transcript but replaces old model-visible context with a lossy summary and recent tail. Start with automatic compaction.

Compaction is checked before a model request, not during a running model request or tool. In a worker, the risky boundary is after child results return and before synthesis, so bound fan-in as described above. A persistent root stores both the worker tool result and the final answer.

### Only if repeated runs need explicit compaction

Add a compact-before-run wrapper only after repeated runs show stale-context behavior or insufficient headroom. There is no \`opencode2 run --compact-first\` flag. A wrapper must submit compaction, wait for the session to become idle, verify that compaction succeeded, and only then run the scheduled prompt:

~~~sh
opencode2 api post /api/session/<id>/compact --data '{}'
opencode2 api post /api/session/<id>/wait
opencode2 run --session <id> ...
~~~

The wrapper adds a model call and retains a lossy summary plus recent context rather than producing a blank session.

## Activate and verify every job

After completing common setup and the sections for the chosen session policy, apply and activate the job:

~~~sh
mfz apply
systemd-analyze --user verify ~/.config/systemd/user/<job>.service ~/.config/systemd/user/<job>.timer
systemctl --user daemon-reload
systemctl --user enable --now <job>.timer
systemctl --user start <job>.service
~~~

Inspect the result:

~~~sh
systemctl --user status <job>.service
systemctl --user list-timers <job>.timer --all
journalctl --user -u <job>.service --since today
loginctl show-user "$USER" -p Linger
~~~

For a persistent root plus worker, inspect the effective runtime rather than trusting source YAML alone: confirm the worker has no configured model or body, the root delegates exactly once, child models inherit the requested variant, delegation stops at the intended depth, and child results stay bounded. Use a disposable top-level test session when exercising a large prompt so verification does not pollute the production root.

Done when the manual service run succeeds, the next timer occurrence is correct in the local timezone, the intended session policy is visible in OpenCode, child models and permissions match the design, temporary state is gone, and no prohibited mutation occurred.
`;

const guideMarkdown = `# mindframe-z Home Guide

A home is a git repository with \`mfz_home.yml\` at its root. The engine loads fixed directories: \`catalog/references.yml\`, \`catalog/skills.yml\`, \`catalog/mcp.yml\`, \`instructions/\`, \`profiles/<name>/\`, \`skills/\`, \`opencode/\`, and optional \`sandbox/\` overlays.

Catalog files define what exists. Profiles select entries by name. Unqualified names resolve only in the active home. Upstream entries use qualified names like \`personal/base\` or \`personal/aws-knowledge\` from the alias declared in \`mfz_home.yml#extends\`.

The editing model: home files are the source of truth; everything under \`~/.mindframe-z/configs/<profile>/\` and managed harness configuration is rendered output. Edit home files, then run plain \`mfz apply\` to re-render; it follows the active home and profile from \`~/.mindframe-z/config.yml\`. Reserve \`--root\`, \`--home\`, and \`--profile\` for isolated tests with an explicit test home. Never edit rendered output directly. Use \`mfz sync\` only to promote supported unmanaged configuration keys; source changes, including skills, remain home edits followed by \`mfz apply\`.

Use \`instructions\` for guidance every agent should receive. Use \`instruction_references\` for branch-specific guidance: each entry declares a stable kebab-case \`name\`, a source \`path\` under an active or upstream home's \`instructions/\` directory, and a trigger-focused \`description\`. MFZ copies these files into the rendered profile and adds compact pointers to global instructions; the agent reads a referenced file only when its description matches the task.

~~~yaml
instruction_references:
  - name: browser
    path: instructions/BROWSER.md
    description: Browser automation, website interaction, or authenticated Chrome
~~~

Use \`capability_groups\` to replace the full reference and extra-folder inventories in global instructions with a compact awareness index. Each enabled reference and extra folder must declare a matching \`group\`, a short \`summary\`, and at least one \`signal\`. MFZ keeps \`~/.mindframe-z/references.md\` and \`~/.mindframe-z/extra_folders.md\` as the full indexes. It writes the awareness index and detailed group files under \`~/.mindframe-z/capabilities/\`.

~~~yaml
capability_groups:
  - name: agent-tooling
    summary: Agent harnesses, configuration engines, and workflow sources.

extra_folders:
  - path: ~/workspace/repos/mindframe-z
    group: agent-tooling
    summary: Mindframe-Z
    signals: [Mindframe-Z, agent configuration]
    description: Profile-aware AI tooling engine.
~~~

Runtime-managed files:

- Mise profile settings live in \`profiles/<profile>/mise.toml\`; profile task files live under \`profiles/<profile>/.config/mise/tasks/\`. Run \`mfz apply --target mise\` after changing them. MFZ renders native Mise fragments under \`conf.d/\` and namespaced tasks under \`tasks/\`.
- User systemd files live under \`profiles/<profile>/.config/systemd/user/\`. Run \`mfz apply --target dotfiles\` after changing them. MFZ writes unit files under \`~/.config/systemd/user/\`, but does not reload, enable, start, stop, or disable services.
- When a systemd service should run, use \`systemctl --user daemon-reload\`, then explicitly \`systemctl --user enable <unit>\` and \`systemctl --user start <unit>\` as appropriate. \`WantedBy=default.target\` affects enablement only.

Local skills live under \`skills/\`; OpenCode plugins, commands, and agents live under \`opencode/plugins/\`, \`opencode/commands/\`, and \`opencode/agents/\`. A command may be a flat \`<name>.md\` file or a \`<name>/COMMAND.md\` package whose sibling development metadata is not rendered. Profiles enable these assets.

Before changing a topic below, run its guide:

- \`mfz guide mcp\` - add or change direct MCP servers, Executor routing, or Executor authentication.
- \`mfz guide cron\` - add or change a recurring OpenCode job.
- \`mfz guide skills\` - add or change local, trusted Git, or vendored skills.
- \`mfz guide references\` - add or change read-only reference repositories.
- \`mfz guide extra-folders\` - grant host folders or update capability-map metadata.
`;

const extraFoldersGuideMarkdown = `# Extra Folders Guide

Use this guide before granting agent access to a host directory or changing its capability-map description.

\`extra_folders\` is both an access grant and cross-repository routing metadata. Declare it in a profile for profile-scoped behavior or machine config for machine-specific access. The rendered \`~/.mindframe-z/extra_folders.md\` index exposes each folder's role and effective permissions to agents.

~~~yaml
extra_folders:
  - path: /home/mark/workspace/repos/payments
    group: product-systems
    summary: Payment reconciliation
    signals: [payments, settlement files, reconciliation]
    description: "Payment reconciliation: reconciles settlement files and exceptions; TypeScript, PostgreSQL, and S3."
    url: https://github.com/example/payments
    read: allow
    edit: allow
~~~

\`path\` is required. If the profile defines \`capability_groups\`, also declare a matching \`group\`, a short \`summary\`, and at least one \`signal\`. Use \`url\` for a Git source a reader may need to reopen; omit it for mounts and local configuration directories. \`read\` and \`edit\` are permission grants, not documentation; declare only directories agents are intended to access.

Write \`description\` as capability-map metadata, not a miniature repository summary: lead with the domain outcome, state the capability, then include discriminative technology, integration, or dependency signals. Avoid generic "needed when" clauses, exhaustive inventories, volatile counts, and details an agent can discover after opening the folder.

Within profile inheritance, a child entry overrides its parent by path, and a machine-config entry overrides both. Active and upstream homes are not granted implicitly; declare any home agents should edit as an extra folder.

Run plain \`mfz apply\`, inspect \`~/.mindframe-z/extra_folders.md\`, and run \`mfz doctor\`. Done when the full index shows the intended permissions. If the profile defines \`capability_groups\`, also inspect \`~/.mindframe-z/capabilities/index.md\` and the matching group file; confirm the compact index exposes enough signals to find the group.
`;

const skillsGuideMarkdown = `# Skills Guide

A skill reaches an agent in three steps: the catalog declares it, a profile enables it per agent, and \`mfz apply\` renders a managed snapshot before reconciling harness links. Runtime toggles control invocation, not snapshot membership. Every source type below requires profile enablement before activation:

\`\`\`yaml
skills:
  my-skill:
    agents: { opencode: true, claude-code: true, codex: true }
\`\`\`

Put this selection in \`profiles/<profile>/profile.yml\`, using the skill's catalog name.

Add a local skill:

1. Create \`skills/<name>/SKILL.md\`. The frontmatter must carry both \`name:\` and \`description:\` — Mindframe-Z validates these fields before rendering:

   \`\`\`markdown
   ---
   name: my-skill
   description: Use when <trigger phrasing an agent would match>.
   ---
   <skill body>
   \`\`\`

2. Declare it in \`catalog/skills.yml\`:

   \`\`\`yaml
    skills:
      - name: my-skill
        source: local
        skill: my-skill
        description: One-line summary.
   \`\`\`

3. Enable it as above, then run plain \`mfz apply\`, \`mfz skills list\`, and \`mfz doctor\`. Done when the skill appears for its selected agents and the profile reports healthy links.

Add a trusted Git skill:

1. Declare \`source: git\`, an HTTPS \`repo:\`, full lowercase \`commit:\`, and explicit upstream \`subtree:\`. The commit is the exact content activated by \`mfz apply\`; Git entries bypass staging and vendor locks.
2. Run plain \`mfz apply\`, then \`mfz skills list\` and \`mfz doctor\`. Update the skill later by changing its commit and applying again.

Add a vendored skill:

1. Declare \`source: vendored\`, an HTTPS \`repo:\`, and tracked \`ref:\`. For one payload, add an explicit upstream \`subtree:\`; for provider payloads, add exactly \`claude-code\`, \`codex\`, and \`opencode-v2\` under \`variants:\`. MFZ copies a single payload to \`skills/vendor/<name>/\` or provider payloads to \`skills/vendor/<name>/<target>/\` and records the full commit plus digest in \`skills/vendor.lock.yml\` (including each provider digest for variants).
2. Check without mutation: \`mfz skills check\`.
3. Stage an exact tip or full commit into machine-local quarantine: \`mfz skills stage <name> [--commit <full-sha>]\`.
4. Invoke \`/skill-update-review <candidate-id>\`. Candidate files are hostile evidence; inspect every file and deterministic finding without executing anything.
5. After the review, run \`mfz skills promote <candidate-id>\`, review and commit the home diff, then run \`mfz apply\`, \`mfz skills list\`, and \`mfz doctor\`. Done when the promoted skill appears for its selected agents and the profile reports healthy links. Promotion does not apply configuration or create links.

Quarantine lives under \`~/.mindframe-z/skill-candidates/\`; committed home source is trusted input; single-subtree rendered snapshots live under \`~/.mindframe-z/configs/<profile>/skills/\`, while provider variants use \`~/.mindframe-z/configs/<profile>/opencode-v2/skills/\` and target-scoped legacy paths under \`~/.mindframe-z/configs/<profile>/<target>/skills/\`. Harness links point only to rendered snapshots. Unmanaged link conflicts fail without replacement. Before recovery, remove or restore the candidate only; restore active behaviour with a home Git revert followed by \`mfz apply\`.

Unpinned \`source: git\` entries are legacy migration input only. They are rejected by the normal schema and never activated; select a new HTTPS revision and use the stage, review, promote, and apply sequence.

Skills from the upstream home are enabled with qualified names like \`<alias>/<name>\`, where the alias comes from \`mfz_home.yml#extends\`.
`;

const referencesGuideMarkdown = `# References Guide

A reference is a read-only local clone that gives agents source-grounded context when a repository becomes relevant. The catalog declares available repositories, and a profile enables them. Full \`mfz apply\` clones or updates enabled references, removes deselected checkouts that MFZ owns and can delete safely, regenerates local indexes, refreshes embedded agent snapshots, and activates configuration.

Add a reference:

1. Declare it in \`catalog/references.yml\`:

   \`\`\`yaml
   references:
     - name: example
       url: https://github.com/example/example.git
       group: agent-tooling
       summary: Example workflow library
       signals: [example configuration, adapters, runtime behavior]
       description: "TypeScript library for example workflows. Inspect it for example configuration, adapters, or runtime behavior. Main entrypoint: src/index.ts."
   \`\`\`

2. Enable it in \`profiles/<profile>/profile.yml\`:

   \`\`\`yaml
   references:
     - example
   \`\`\`

3. Run plain \`mfz apply\` to synchronize references, regenerate indexes, refresh embedded agent snapshots, and activate configuration. Use \`mfz refs list\` to inspect availability. Use \`mfz refs sync example\` when you need to update only this reference without activating configuration. Both named and bulk reference synchronization regenerate the local reference, extra-folder, and capability indexes automatically.

Bulk reconciliation removes a deselected checkout only when MFZ owns it and Git establishes that removal is safe. MFZ preserves modified or untracked files, ahead or divergent commits, and checkouts with an unexpected remote. Resolve a reported conflict instead of deleting local work. Named synchronization does not update or remove unrelated references.

Use \`--verbose\` with apply or reference synchronization to show unchanged checks and internal operations. Default output lists changes and items that need attention. Captured output uses plain lines without terminal control sequences.

If the profile defines \`capability_groups\`, each enabled reference must declare a matching \`group\`, a short \`summary\`, and at least one \`signal\`.

Write descriptions as routing metadata, not miniature repository summaries. Lead with the stack or repository type and its purpose, name the concepts or situations that should cause an agent to inspect it, and include at most one or two durable entrypoints, packages, or config models. Keep descriptions concise; avoid promotional language, exhaustive feature lists, volatile counts, and details agents can discover after opening the repository.

References inherited from an upstream home use qualified names like \`<alias>/<name>\`, where the alias comes from \`mfz_home.yml#extends\`.

Rendered indexes mark reference clones as read-only. Agents may inspect them but must not edit, reorganize, or write within the reference paths. Verify a complete activation with \`mfz refs list\` and \`mfz doctor\`. A focused \`mfz refs sync [name]\` updates local references and indexes only; run full \`mfz apply\` when agent snapshots or configuration also need activation.
`;

const guideTopics = new Map([
  ["cron", cronGuideMarkdown],
  ["mcp", mcpGuideMarkdown],
  ["skills", skillsGuideMarkdown],
  ["references", referencesGuideMarkdown],
  ["extra-folders", extraFoldersGuideMarkdown]
]);

export const guideTopicNames = [...guideTopics.keys()];

export async function guide(topic?: string): Promise<void> {
  if (topic !== undefined) {
    const content = guideTopics.get(topic);
    if (!content) {
      throw new Error(`Unknown guide topic: ${topic}. Topics: ${guideTopicNames.join(", ")}`);
    }
    console.log(content.trimEnd());
    return;
  }
  console.log(guideMarkdown.trimEnd());
}

const schemaBaseUrl = "https://raw.githubusercontent.com/meeaster/mindframe-z/main/schemas";

async function scaffoldHome(homeRoot: string, agents: string[]): Promise<void> {
  await mkdir(path.join(homeRoot, "catalog"), { recursive: true });
  await mkdir(path.join(homeRoot, "instructions"), { recursive: true });
  await mkdir(path.join(homeRoot, "profiles", "base"), { recursive: true });
  await writeFile(
    path.join(homeRoot, "mfz_home.yml"),
    `# yaml-language-server: $schema=${schemaBaseUrl}/mfz_home.schema.json\ndescription: mindframe-z home\n`,
    "utf8"
  );
  await writeFile(
    path.join(homeRoot, "catalog", "references.yml"),
    `# yaml-language-server: $schema=${schemaBaseUrl}/references.schema.json\nreferences: []\n`,
    "utf8"
  );
  await writeFile(
    path.join(homeRoot, "catalog", "mcp.yml"),
    `# yaml-language-server: $schema=${schemaBaseUrl}/mcp.schema.json\nservers: {}\n`,
    "utf8"
  );
  await writeFile(
    path.join(homeRoot, "catalog", "skills.yml"),
    `# yaml-language-server: $schema=${schemaBaseUrl}/skills.schema.json\nskills: []\n`,
    "utf8"
  );
  await writeFile(
    path.join(homeRoot, "instructions", "AGENTS.md"),
    "# Home Instructions\n",
    "utf8"
  );
  const agentList = agents.length > 0 ? agents : ["opencode-v2", "claude-code", "codex"];
  await writeFile(
    path.join(homeRoot, "profiles", "base", "profile.yml"),
    [
      `# yaml-language-server: $schema=${schemaBaseUrl}/profile.schema.json`,
      "name: base",
      `agents: [${agentList.join(", ")}]`,
      "instructions:",
      "  - instructions/AGENTS.md",
      ""
    ].join("\n"),
    "utf8"
  );
  await ensureHomeGuidance(homeRoot);
  await writeFile(path.join(homeRoot, ".gitignore"), "node_modules/\n", "utf8");
  await writeFile(
    path.join(homeRoot, "README.md"),
    "# mindframe-z home\n\nSee the engine `docs/agent-setup.md` and run `mfz guide` for conventions.\n",
    "utf8"
  );
}

export async function initHome(options: {
  create?: string | undefined;
  clone?: string | undefined;
  point?: string | undefined;
  name?: string | undefined;
  agents?: string | undefined;
  home?: string | undefined;
}): Promise<void> {
  const machineHome = path.resolve(
    options.home ?? process.env.MFZ_HOME ?? process.env.HOME ?? process.cwd()
  );
  const configDir = mindframeZDir(machineHome);
  await mkdir(configDir, { recursive: true });
  let homeRoot: string;
  if (options.create) {
    homeRoot = path.resolve(options.create);
    await scaffoldHome(
      homeRoot,
      options.agents
        ?.split(",")
        .map((agent) => agent.trim())
        .filter(Boolean) ?? []
    );
    await execa("git", ["init"], { cwd: homeRoot });
    await execa("git", ["add", "."], { cwd: homeRoot });
    await execa("git", ["commit", "-m", "Initial mindframe-z home"], { cwd: homeRoot }).catch(
      () => undefined
    );
  } else if (options.clone) {
    const name = options.name ?? path.basename(options.clone, ".git");
    homeRoot = upstreamHomeRoot(machineHome, name);
    await mkdir(path.dirname(homeRoot), { recursive: true });
    await execa("git", ["clone", options.clone, homeRoot]);
  } else if (options.point) {
    homeRoot = path.resolve(options.point);
  } else {
    throw new Error("mfz init requires --create <path>, --clone <repo>, or --point <path>");
  }
  await writeFile(
    machineConfigPath(machineHome),
    `home_path: ${homeRoot}\nprofile: base\n`,
    "utf8"
  );
  console.log(`home_path\t${homeRoot}`);
}
