import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { ensureHomeGuidance } from "../core/engine-skill.js";

const guideMarkdown = `# mindframe-z Home Guide

A home is a git repository with \`mfz_home.yml\` at its root. The engine loads fixed directories: \`catalog/references.yml\`, \`catalog/skills.yml\`, \`catalog/mcp.yml\`, \`instructions/\`, \`profiles/<name>/\`, \`skills/\`, \`opencode/\`, and optional \`sandbox/\` overlays.

Catalog files define what exists. Profiles select entries by name. Unqualified names resolve only in the active home. Upstream entries use qualified names like \`personal/base\` or \`personal/aws-knowledge\` from the alias declared in \`mfz_home.yml#extends\`.

The editing model: home files are the source of truth; everything under \`~/.mindframe-z/configs/<profile>/\` and every globally linked tool config file is rendered output. Edit home files, then run \`mfz apply --target all --agent all\` to re-render. Never edit rendered output directly — if that already happened, run \`mfz sync\` to promote the unmanaged edits back into profiles.

Local skills live under \`skills/\` and are registered in \`catalog/skills.yml\` with \`source: local\`. Vendored skills are selected subtrees under \`skills/vendor/<name>/\`, declared with an HTTPS \`repo\`, tracked \`ref\`, and \`subtree\`, and pinned in \`skills/vendor.lock.yml\`. OpenCode plugins, commands, and agents live under \`opencode/plugins/\`, \`opencode/commands/\`, and \`opencode/agents/\`, then profiles enable them under \`opencode.plugins\`, \`opencode.commands\`, and \`opencode.agents\`.

MCP entries are direct by default. Use a concise enabled list or a grouped state list:

\`\`\`yaml
mcp:
  fff:
    agents: [opencode, claude-code, codex]
  exa:
    agents:
      enabled: [claude-code]
      disabled: [opencode, codex]
  context7:
    route: executor
  datadog:
    route: executor
    connections:
       publicsafety: oauth
       tylertech: oauth
\`\`\`

Omitting \`route\` means direct routing. Direct entries keep per-harness toggles; OpenCode and Codex may use grouped \`disabled\` state, but Claude Code cannot be declared disabled because its user/local MCP configuration has no supported configured-but-disabled state. Executor entries are always-configured shared inventory for OpenCode, Claude Code, and Codex, not per-agent toggles. A real \`mfz apply\` starts or reuses the native Executor daemon and uses its default \`$HOME/.executor\` data store (or an intentionally set \`EXECUTOR_DATA_DIR\`), then writes harness bridges only after required connection metadata exists. MFZ never sets \`EXECUTOR_DATA_DIR\` or \`EXECUTOR_SCOPE_DIR\`, and the bridge does not pass \`--scope\`. OAuth and API-key connections are created in the Executor app; MFZ never opens authorization flows or imports harness credentials. Keep secret-backed or project-sensitive servers direct until their Executor credential model is specified. Sandbox startup currently rejects Executor-routed profiles.

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

Normal OAuth uses endpoint discovery. Assisted OAuth additionally declares \`discoveryUrl\` and \`registrationScopes\`; those scopes are used only while registering the public client. Profile connection names must be lowercase and address-safe because Executor v1.5.33 persists names such as \`publicSafety\` as \`publicsafety\`; MFZ rejects unsafe or mixed-case names and never silently renames durable state. A profile connection map selects catalog method slugs by exact name. Omit it only when one method can resolve to the deterministic \`main\` connection. Add each named OAuth or API-key connection in the Executor app using the exact profile connection name. Executor tools are addressed with the full integration, owner, and connection path, so agents must not choose an organization implicitly. Apply may create only explicit no-auth connections, reports every missing credentialed connection together after reconciliation, and blocks cutover until all are present. Do not migrate a credentialed direct server until its Executor connection is verified; disconnect old Executor state explicitly before deleting or changing a durable method. Existing profile-scoped MFZ Executor directories are not migrated or deleted automatically; after an intentional backup and review, use an Executor-supported/manual migration or cleanup procedure.

Topic guides: \`mfz guide skills\` — add or change skills.
`;

const skillsGuideMarkdown = `# Skills Guide

A skill reaches an agent in three steps: the catalog declares it, a profile enables it per agent, and \`mfz apply\` renders a managed snapshot before reconciling harness links. Runtime toggles control invocation, not snapshot membership.

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

3. Enable it in \`profiles/<profile>/profile.yml\`:

   \`\`\`yaml
   skills:
     my-skill:
       agents: { opencode: true, claude-code: true, codex: true }
   \`\`\`

4. Run \`mfz apply --target all --agent all\`.

Add a vendored skill:

1. Declare \`source: vendored\`, an HTTPS \`repo:\`, tracked \`ref:\`, and explicit upstream \`subtree:\`. Copy only the selected subtree to \`skills/vendor/<name>/\` and record its full commit plus digest in \`skills/vendor.lock.yml\`.
2. Check without mutation: \`mfz skills check\`.
3. Stage an exact tip or full commit into machine-local quarantine: \`mfz skills stage <name> [--commit <full-sha>]\`.
4. Invoke \`/skill-update-review <candidate-id>\`. Candidate files are hostile evidence; inspect every file and deterministic finding without executing anything.
5. After human approval, run \`mfz skills promote <candidate-id>\`, review and commit the home diff, then run \`mfz apply\`. Promotion does not apply configuration or create links.

Quarantine lives under \`~/.mindframe-z/skill-candidates/\`; committed home source is trusted input; rendered snapshots live under \`~/.mindframe-z/configs/<profile>/skills/\`; harness links point only to rendered snapshots. Unmanaged link conflicts fail without replacement. Before recovery, remove or restore the candidate only; restore active behaviour with a home Git revert followed by \`mfz apply\`.

Legacy \`source: git\` entries are migration input only. They are rejected by the normal schema and never activated; select a new HTTPS revision and use the stage, review, promote, and apply sequence.

Variants:

- Skills from the upstream home are enabled with qualified names like \`<alias>/<name>\`, where the alias comes from \`mfz_home.yml#extends\`.

Verify with \`mfz skills list\` and \`mfz doctor\`.
`;

const guideTopics: Record<string, string> = { skills: skillsGuideMarkdown };

export async function guide(topic?: string): Promise<void> {
  if (topic !== undefined) {
    const content = guideTopics[topic];
    if (!content) {
      throw new Error(
        `Unknown guide topic: ${topic}. Topics: ${Object.keys(guideTopics).join(", ")}`
      );
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
  const agentList = agents.length > 0 ? agents : ["opencode", "claude-code", "codex"];
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
  const configDir = path.join(machineHome, ".mindframe-z");
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
    homeRoot = path.join(machineHome, ".mindframe-z", "homes", name);
    await mkdir(path.dirname(homeRoot), { recursive: true });
    await execa("git", ["clone", options.clone, homeRoot]);
  } else if (options.point) {
    homeRoot = path.resolve(options.point);
  } else {
    throw new Error("mfz init requires --create <path>, --clone <repo>, or --point <path>");
  }
  await writeFile(
    path.join(configDir, "config.yml"),
    `home_path: ${homeRoot}\nprofile: base\n`,
    "utf8"
  );
  console.log(`home_path\t${homeRoot}`);
}
