import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

const guideMarkdown = `# mindframe-z Home Guide

A home is a git repository with \`mfz_home.yml\` at its root. The engine loads fixed directories: \`catalog/references.yml\`, \`catalog/skills.yml\`, \`catalog/mcp.yml\`, \`instructions/\`, \`profiles/<name>/\`, \`skills/\`, \`opencode/\`, and optional \`sandbox/\` overlays.

Catalog files define what exists. Profiles select entries by name. Unqualified names resolve only in the active home. Upstream entries use qualified names like \`personal/base\` or \`personal/aws-knowledge\` from the alias declared in \`mfz_home.yml#extends\`.

Edit home files directly for durable configuration. Use \`mfz apply\` to render machine-local output under \`~/.mindframe-z/configs/<profile>/\`. Use \`mfz sync\` after editing rendered files to promote unmanaged keys back into profiles.

Local skills live under \`skills/\` and are registered in \`catalog/skills.yml\` with \`source: local\`. OpenCode plugins, commands, and agents live under \`opencode/plugins/\`, \`opencode/commands/\`, and \`opencode/agents/\`, then profiles enable them under \`opencode.plugins\`, \`opencode.commands\`, and \`opencode.agents\`.
`;

export async function guide(): Promise<void> {
  console.log(guideMarkdown.trimEnd());
}

const schemaBaseUrl = "https://raw.githubusercontent.com/meeaster/mindframe-z/main/schemas";

async function scaffoldHome(homeRoot: string, agents: string[]): Promise<void> {
  await mkdir(path.join(homeRoot, "catalog"), { recursive: true });
  await mkdir(path.join(homeRoot, "instructions"), { recursive: true });
  await mkdir(path.join(homeRoot, "profiles", "base"), { recursive: true });
  await mkdir(path.join(homeRoot, "skills", "mindframe-z"), { recursive: true });
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
    [
      `# yaml-language-server: $schema=${schemaBaseUrl}/skills.schema.json`,
      "skills:",
      "  - name: mindframe-z",
      "    source: local",
      "    skill: mindframe-z",
      "    description: Guidance for editing a mindframe-z home.",
      ""
    ].join("\n"),
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
      "skills:",
      "  mindframe-z:",
      `    agents: { ${agentList.map((agent) => `${agent}: true`).join(", ")} }`,
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(homeRoot, "skills", "mindframe-z", "SKILL.md"),
    [
      "---",
      "description: Use when editing a mindframe-z home, including profiles, catalog entries, local skills, OpenCode plugins, or machine config.",
      "---",
      "Run `mfz guide` and follow the home conventions it prints.",
      ""
    ].join("\n"),
    "utf8"
  );
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
