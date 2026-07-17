import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, configsPath, setupIntegrationFixture } from "./support.js";

describe("apply integration", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());
  });

  afterEach(() => {
    root = "";
    home = "";
  });

  async function exists(file: string): Promise<boolean> {
    try {
      await access(file);
      return true;
    } catch {
      return false;
    }
  }

  it("renders and links OpenCode and Claude config into temporary homes", async () => {
    const renderedNodeModules = configsPath(home, "personal", "opencode", "node_modules");
    const managedPlugins = path.join(home, ".config", "opencode", "plugins", "mindframe-z");
    const stalePlugin = path.join(managedPlugins, "stale.ts");
    await mkdir(path.dirname(renderedNodeModules), { recursive: true });
    await symlink(path.join(home, ".config", "opencode", "node_modules"), renderedNodeModules);
    await mkdir(managedPlugins, { recursive: true });
    await writeFile(stalePlugin, "export default {}\n", "utf8");

    const result = await cli("mfz", root, home, ["apply", "--target", "all"]);
    expect(result.stdout).toContain("rendered");

    const opencode = await readFile(
      configsPath(home, "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );
    expect(opencode).toContain("https://opencode.ai/config.json");
    expect(opencode).toContain("context7");
    expect(await readFile(path.join(managedPlugins, "config-marker.ts"), "utf8")).toContain(
      "mindframe-z-plugin-loaded"
    );
    await expect(lstat(stalePlugin)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(configsPath(home, "personal", "opencode", "commands", "test-cmd.md"), "utf8")
    ).toContain("Run the test command.");

    const claude = await readFile(configsPath(home, "personal", "claude", "CLAUDE.md"), "utf8");
    expect(claude).toContain("@" + configsPath(home, "personal", "AGENTS.md"));

    const claudeMcp = JSON.parse(
      await readFile(configsPath(home, "personal", "claude", "mcp.json"), "utf8")
    ) as Record<string, unknown>;
    expect(claudeMcp).toMatchObject({
      context7: { type: "http", url: "https://mcp.context7.com/mcp" },
      "local-helper": { type: "stdio", command: "tool-helper", args: ["--serve"] }
    });

    await expect(realpath(path.join(home, ".config", "opencode", "opencode.jsonc"))).resolves.toBe(
      configsPath(home, "personal", "opencode", "opencode.jsonc")
    );
    await expect(realpath(path.join(home, ".config", "opencode", "commands"))).resolves.toBe(
      configsPath(home, "personal", "opencode", "commands")
    );
    await expect(lstat(renderedNodeModules)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(realpath(path.join(home, ".claude", "CLAUDE.md"))).resolves.toBe(
      configsPath(home, "personal", "claude", "CLAUDE.md")
    );
    expect((await lstat(path.join(home, ".claude", "settings.json"))).isSymbolicLink()).toBe(false);

    const localClaudeJson = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(localClaudeJson.mcpServers).toMatchObject(claudeMcp);
  });

  it("renders, links, and removes merged OpenCode runtime dependencies", async () => {
    await writeFile(
      path.join(root, "profiles", "base", "profile.yml"),
      [
        "name: base",
        "opencode:",
        "  dependencies:",
        "    '@acme/base': 1.2.3",
        "    shared: 1.0.0",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "opencode:",
        "  dependencies:",
        "    '@acme/personal': 2.3.4",
        "    shared: 2.0.0",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);

    const manifestPath = configsPath(home, "personal", "opencode", "package.json");
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual({
      dependencies: { "@acme/base": "1.2.3", "@acme/personal": "2.3.4", shared: "2.0.0" }
    });
    await expect(realpath(path.join(home, ".config", "opencode", "package.json"))).resolves.toBe(
      manifestPath
    );

    await writeFile(path.join(root, "profiles", "base", "profile.yml"), "name: base\n", "utf8");
    await mkdir(path.join(root, "profiles", "clean"), { recursive: true });
    await writeFile(
      path.join(root, "profiles", "clean", "profile.yml"),
      ["name: clean", "extends: base", "agents: [opencode]", ""].join("\n"),
      "utf8"
    );
    await cli("mfz", root, home, ["--profile", "clean", "apply", "--agent", "opencode"]);

    await expect(
      lstat(path.join(home, ".config", "opencode", "package.json"))
    ).rejects.toMatchObject({
      code: "ENOENT"
    });

    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      ["name: personal", "extends: base", "agents: [opencode]", ""].join("\n"),
      "utf8"
    );
    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);

    await expect(access(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(path.join(home, ".config", "opencode", "package.json"))
    ).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("migrates delegate general configuration from agent-task paths", async () => {
    const renderedOpencode = configsPath(home, "personal", "opencode");
    const oldRenderedConfig = path.join(renderedOpencode, "agent-task.json");
    const oldLinkedConfig = path.join(home, ".config", "opencode", "agent-task.json");
    await mkdir(path.dirname(oldRenderedConfig), { recursive: true });
    await mkdir(path.dirname(oldLinkedConfig), { recursive: true });
    await writeFile(oldRenderedConfig, '{"models":[]}\n', "utf8");
    await symlink(oldRenderedConfig, oldLinkedConfig);
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "opencode:",
        "  delegate_general:",
        "    models:",
        "      - id: openai/gpt-5.6-terra",
        "        variants: [low]",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);

    const newRenderedConfig = path.join(renderedOpencode, "delegate-general.json");
    const newLinkedConfig = path.join(home, ".config", "opencode", "delegate-general.json");
    await expect(readFile(newRenderedConfig, "utf8")).resolves.toContain("openai/gpt-5.6-terra");
    await expect(realpath(newLinkedConfig)).resolves.toBe(newRenderedConfig);
    await expect(lstat(oldRenderedConfig)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(oldLinkedConfig)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies machine-local OpenCode permission overrides", async () => {
    const workDir = path.join(home, "work");
    const referencesDir = path.join(home, "references");
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      [
        "profile: personal",
        "references_dir: ~/references",
        "opencode:",
        "  permission:",
        "    websearch: allow",
        "    external_directory:",
        `      ${workDir}/**: allow`,
        "    edit:",
        `      ${referencesDir}/**: deny`,
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["apply", "--agent", "opencode"]);
    expect(result.stdout).toContain("rendered");

    const opencode = await readFile(
      configsPath(home, "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );
    expect(opencode).toContain("permission");
    expect(opencode).toContain(workDir);
    expect(opencode).toContain(referencesDir);
  });

  it("renders extra folders in OpenCode config", async () => {
    const workPath = path.join(home, "code", "work");
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      [
        "profile: personal",
        "references_dir: ~/references",
        "extra_folders:",
        `  - path: ~/code/work`,
        `    description: Work code`,
        `  - path: ~/code/restricted`,
        `    read: deny`,
        `    edit: deny`,
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    const opencode = await readFile(
      configsPath(home, "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );
    const config = JSON.parse(opencode) as {
      permission: { external_directory: Record<string, string>; edit: Record<string, string> };
    };
    expect(config.permission.external_directory[`${workPath}/**`]).toBe("allow");
    expect(config.permission.external_directory[`${home}/code/restricted/**`]).toBe("deny");
    expect(config.permission.edit[`${home}/code/restricted/**`]).toBe("deny");
  });

  it("renders extra folders in Claude settings", async () => {
    const codePath = path.join(home, "code");
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      [
        "profile: personal",
        "references_dir: ~/references",
        "extra_folders:",
        `  - path: ~/code`,
        `    description: All code`,
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "claude-code", "--no-link"]);

    const settings = JSON.parse(
      await readFile(configsPath(home, "personal", "claude", "settings.json"), "utf8")
    ) as Record<string, unknown>;
    expect(settings).toHaveProperty("permissions");
    expect(settings).toHaveProperty("additionalDirectories");
    expect(settings.additionalDirectories).toContain(codePath);
    expect((settings.permissions as { allow?: string[] }).allow).toContain(`Read(/${codePath}/**)`);
  });

  it("renders Codex config and guidance without writing local files in no-link mode", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [codex]",
        "instructions:",
        "  - instructions/AGENTS.md",
        "references:",
        "  - local-ref",
        "mcp:",
        "  context7:",
        "    agents: [codex]",
        "  local-helper:",
        "    agents: { disabled: [codex] }",
        "codex:",
        "  config:",
        "    model: test/codex",
        "  plugins:",
        '    "github@openai-curated":',
        "      enabled: true",
        "      toggleable: false",
        '    "teams@openai-curated":',
        "      enabled: false",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      [
        "profile: personal",
        "references_dir: ~/references",
        "extra_folders:",
        "  - path: ~/work",
        "    description: Work code",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "codex", "--no-link"]);

    const config = parse(
      await readFile(configsPath(home, "personal", "codex", "config.toml"), "utf8")
    ) as Record<string, unknown>;
    expect(config.model).toBe("test/codex");
    expect(config.plugins).toEqual({
      "github@openai-curated": { enabled: true, toggleable: false },
      "teams@openai-curated": { enabled: false }
    });
    expect(config.default_permissions).toBe("mfz");
    expect(config.mcp_servers).toMatchObject({
      context7: { url: "https://mcp.context7.com/mcp", enabled: true },
      "local-helper": { command: "tool-helper", args: ["--serve"], enabled: false }
    });
    expect(config.permissions).toMatchObject({
      mfz: {
        filesystem: { [path.join(home, "references")]: "read", [path.join(home, "work")]: "write" }
      }
    });
    const codexAgents = await readFile(configsPath(home, "personal", "codex", "AGENTS.md"), "utf8");
    expect(codexAgents).toContain("# Test Agents");
    // Codex cannot follow @import directives, so its AGENTS.md inlines the
    // reference and extra-folder index contents alongside the instruction file.
    expect(codexAgents).toContain("# Enabled References");
    expect(codexAgents).toContain("# Extra Folders");
    expect(codexAgents).toContain("Work code");
    expect(await exists(path.join(home, ".codex", "config.toml"))).toBe(false);
  });

  it("omits Codex plugins from rendered TOML when no plugins are declared", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "agents: [codex]",
        "codex:",
        "  config:",
        "    model: test/codex",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "codex", "--no-link"]);

    const config = parse(
      await readFile(configsPath(home, "personal", "codex", "config.toml"), "utf8")
    ) as Record<string, unknown>;
    expect(config).not.toHaveProperty("plugins");
  });

  it("renders Pi settings and guidance without writing local files in no-link mode", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "agents: [pi]",
        "instructions:",
        "  - instructions/AGENTS.md",
        "pi:",
        "  settings:",
        "    theme: dark",
        "    defaultProvider: openai-codex",
        "    defaultModel: gpt-5.5",
        "    subagents:",
        "      agentOverrides:",
        "        scout:",
        "          model: openai-codex/gpt-5.4-mini",
        "          thinking: low",
        ""
      ].join("\n"),
      "utf8"
    );
    await mkdir(path.join(home, ".pi", "agent"), { recursive: true });
    await writeFile(
      path.join(home, ".pi", "agent", "settings.json"),
      '{"theme":"light"}\n',
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "pi", "--no-link"]);

    const snapshot = JSON.parse(
      await readFile(configsPath(home, "personal", "pi", "settings.json"), "utf8")
    ) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      theme: "dark",
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.5",
      subagents: { agentOverrides: { scout: { thinking: "low" } } }
    });
    expect(await readFile(configsPath(home, "personal", "pi", "AGENTS.md"), "utf8")).toContain(
      "# Test Agents"
    );
    expect(await readFile(path.join(home, ".pi", "agent", "settings.json"), "utf8")).toBe(
      '{"theme":"light"}\n'
    );
  });

  it("merges Pi settings and subagent config into local JSON files", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [pi]",
        "instructions:",
        "  - instructions/AGENTS.md",
        "pi:",
        "  settings:",
        "    theme: dark",
        "    defaultModel: gpt-5.5",
        "    nested:",
        "      generated: true",
        "  subagent_config:",
        "    toolDescriptionMode: compact",
        ""
      ].join("\n"),
      "utf8"
    );
    await mkdir(path.join(home, ".pi", "agent", "extensions", "subagent"), { recursive: true });
    await writeFile(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ theme: "light", keep: true, nested: { local: true } }, null, 2) + "\n",
      "utf8"
    );
    await writeFile(
      path.join(home, ".pi", "agent", "extensions", "subagent", "config.json"),
      JSON.stringify({ keepLocal: true, toolDescriptionMode: "full" }, null, 2) + "\n",
      "utf8"
    );

    const result = await cli("mfz", root, home, ["apply", "--agent", "pi"]);

    expect(result.stdout).toContain("wrote local");
    const localSettings = JSON.parse(
      await readFile(path.join(home, ".pi", "agent", "settings.json"), "utf8")
    ) as Record<string, unknown>;
    expect(localSettings).toMatchObject({
      theme: "dark",
      keep: true,
      defaultModel: "gpt-5.5",
      nested: { local: true, generated: true }
    });
    expect(await readFile(path.join(home, ".pi", "agent", "AGENTS.md"), "utf8")).toContain(
      "# Test Agents"
    );
    const localSubagentConfig = JSON.parse(
      await readFile(
        path.join(home, ".pi", "agent", "extensions", "subagent", "config.json"),
        "utf8"
      )
    ) as Record<string, unknown>;
    expect(localSubagentConfig).toEqual({ keepLocal: true, toolDescriptionMode: "compact" });
    const snapshotSubagentConfig = JSON.parse(
      await readFile(
        configsPath(home, "personal", "pi", "extensions", "subagent", "config.json"),
        "utf8"
      )
    ) as Record<string, unknown>;
    expect(snapshotSubagentConfig).toEqual({ toolDescriptionMode: "compact" });
  });

  it("merges Codex config into local TOML without replacing unrelated keys", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "agents: [codex]",
        "instructions:",
        "  - instructions/AGENTS.md",
        "codex:",
        "  config:",
        "    model: test/codex",
        ""
      ].join("\n"),
      "utf8"
    );
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "config.toml"), 'user_key = "kept"\n', "utf8");

    await cli("mfz", root, home, ["apply", "--agent", "codex"]);

    const localConfig = parse(
      await readFile(path.join(home, ".codex", "config.toml"), "utf8")
    ) as Record<string, unknown>;
    expect(localConfig.user_key).toBe("kept");
    expect(localConfig.model).toBe("test/codex");
    expect(await exists(path.join(home, ".codex", "AGENTS.override.md"))).toBe(false);
    expect(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).toContain(
      "# Test Agents"
    );
  });

  it("replaces local Codex plugins while preserving unrelated local keys", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "agents: [codex]",
        "codex:",
        "  config:",
        "    model: test/codex",
        "  plugins:",
        '    "github@openai-curated":',
        "      enabled: true",
        ""
      ].join("\n"),
      "utf8"
    );
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(
      path.join(home, ".codex", "config.toml"),
      ['user_key = "kept"', "", '[plugins."slack@openai-curated"]', "enabled = true", ""].join(
        "\n"
      ),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "codex"]);

    const localConfig = parse(
      await readFile(path.join(home, ".codex", "config.toml"), "utf8")
    ) as Record<string, unknown>;
    expect(localConfig.user_key).toBe("kept");
    expect(localConfig.model).toBe("test/codex");
    expect(localConfig.plugins).toEqual({ "github@openai-curated": { enabled: true } });
  });

  it("removes the local Codex plugins table when the declared set is empty", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "agents: [codex]",
        "codex:",
        "  config:",
        "    model: test/codex",
        ""
      ].join("\n"),
      "utf8"
    );
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(
      path.join(home, ".codex", "config.toml"),
      ['[plugins."slack@openai-curated"]', "enabled = true", ""].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "codex"]);

    const localConfig = parse(
      await readFile(path.join(home, ".codex", "config.toml"), "utf8")
    ) as Record<string, unknown>;
    expect(localConfig).not.toHaveProperty("plugins");
  });

  it("sync promotes unmanaged Codex config keys and ignores generated tables", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "agents: [codex]",
        "codex:",
        "  config:",
        "    model: test/codex",
        ""
      ].join("\n"),
      "utf8"
    );
    await cli("mfz", root, home, ["apply", "--agent", "codex", "--no-link"]);

    const codexPath = configsPath(home, "personal", "codex", "config.toml");
    await writeFile(
      codexPath,
      [
        'model = "test/codex"',
        'model_verbosity = "low"',
        'default_permissions = "mfz"',
        "",
        "[mcp_servers.generated]",
        'url = "https://example.invalid/mcp"',
        "",
        "[permissions.mfz.filesystem]",
        `"${path.join(home, "references")}" = "read"`,
        ""
      ].join("\n"),
      "utf8"
    );

    const syncResult = await cli("mfz", root, home, ["sync"], {}, "personal\n");
    expect(syncResult.stdout).toContain(
      "Updated personal/profile.yml: codex.config.model_verbosity"
    );
    const profileYaml = await readFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      "utf8"
    );
    expect(profileYaml).toContain("model_verbosity: low");
    expect(profileYaml).not.toContain("mcp_servers");
  });

  it("sync promotes undeclared enabled Codex plugins and ignores declared plugins", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "agents: [codex]",
        "codex:",
        "  plugins:",
        '    "github@openai-curated":',
        "      enabled: true",
        ""
      ].join("\n"),
      "utf8"
    );
    await cli("mfz", root, home, ["apply", "--agent", "codex", "--no-link"]);

    const codexDir = path.join(home, ".codex");
    await mkdir(codexDir, { recursive: true });
    const codexPath = path.join(codexDir, "config.toml");
    await writeFile(
      codexPath,
      [
        '[plugins."github@openai-curated"]',
        "enabled = true",
        "",
        '[plugins."teams@openai-curated"]',
        "enabled = true",
        "",
        '[plugins."slack@openai-curated"]',
        "enabled = false",
        ""
      ].join("\n"),
      "utf8"
    );

    const syncResult = await cli("mfz", root, home, ["sync"], {}, "personal\n");
    expect(syncResult.stdout).toContain(
      "Updated personal/profile.yml: codex.plugins.teams@openai-curated"
    );
    expect(syncResult.stdout).not.toContain("github@openai-curated");
    expect(syncResult.stdout).not.toContain("slack@openai-curated");
    const profileYaml = await readFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      "utf8"
    );
    expect(profileYaml).toContain("teams@openai-curated");
    expect(profileYaml).toContain("enabled: true");
    expect(profileYaml).not.toContain("slack@openai-curated");
  });

  it("machine.opencode overrides folder-generated permissions", async () => {
    const workPath = path.join(home, "code", "work");
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      [
        "profile: personal",
        "references_dir: ~/references",
        "extra_folders:",
        `  - path: ~/code/work`,
        `    description: Work code`,
        "opencode:",
        "  permission:",
        "    external_directory:",
        `      ${workPath}/**: ask`,
        "    websearch: allow",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    const opencode = await readFile(
      configsPath(home, "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );
    expect(opencode).toContain(`"${workPath}/**": "ask"`);
    expect(opencode).toContain("websearch");
  });

  it("merges generated OpenCode permissions with profile permissions", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "opencode:",
        "  config:",
        "    permission:",
        "      bash:",
        "        rm *: deny",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    const opencode = await readFile(
      configsPath(home, "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );
    const config = JSON.parse(opencode) as {
      permission: { bash: Record<string, string>; edit: Record<string, string> };
    };
    expect(config.permission.bash["rm *"]).toBe("deny");
    expect(config.permission.edit[`${path.join(home, ".mindframe-z", "references")}/**`]).toBe(
      "deny"
    );
  });

  it("sync promotes unmanaged rendered OpenCode config keys to the chosen profile", async () => {
    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    const opencodePath = configsPath(home, "personal", "opencode", "opencode.jsonc");
    const opencode = JSON.parse(await readFile(opencodePath, "utf8")) as Record<string, unknown>;
    opencode.small_model = "test/small-model";
    await writeFile(opencodePath, JSON.stringify(opencode, null, 2) + "\n", "utf8");

    const syncResult = await cli("mfz", root, home, ["sync"], {}, "personal\n");
    expect(syncResult.stdout).toContain(
      "Updated personal/profile.yml: opencode.config.small_model"
    );

    const profileYaml = await readFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      "utf8"
    );
    expect(profileYaml).toContain("small_model: test/small-model");

    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);
    const rerendered = JSON.parse(await readFile(opencodePath, "utf8")) as Record<string, unknown>;
    expect(rerendered.small_model).toBe("test/small-model");
  });

  it("merges Claude settings into the machine-local file without linking", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode, claude-code]",
        "claude:",
        "  model: sonnet",
        "  settings:",
        "    includeGitInstructions: true",
        "    permissions:",
        "      deny:",
        "        - Bash(curl *)",
        "    env:",
        '      CLAUDE_CODE_ENABLE_TELEMETRY: "1"',
        ""
      ].join("\n"),
      "utf8"
    );
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify(
        {
          env: {
            AWS_PROFILE: "ClaudeCodeUnix",
            AWS_REGION: "us-west-2"
          },
          awsAuthRefresh: "/work/credential-process"
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const result = await cli("mfz", root, home, ["apply", "--agent", "claude-code"]);

    expect(result.stdout).toContain("wrote local");
    expect((await lstat(path.join(home, ".claude", "settings.json"))).isSymbolicLink()).toBe(false);

    const localSettings = JSON.parse(
      await readFile(path.join(home, ".claude", "settings.json"), "utf8")
    ) as Record<string, unknown>;
    expect(localSettings).toMatchObject({
      includeGitInstructions: true,
      model: "sonnet",
      awsAuthRefresh: "/work/credential-process",
      env: {
        AWS_PROFILE: "ClaudeCodeUnix",
        AWS_REGION: "us-west-2",
        CLAUDE_CODE_ENABLE_TELEMETRY: "1"
      }
    });

    const snapshot = JSON.parse(
      await readFile(configsPath(home, "personal", "claude", "settings.json"), "utf8")
    ) as Record<string, unknown>;
    expect(snapshot).toEqual({
      includeGitInstructions: true,
      permissions: {
        allow: [`Read(/${path.join(home, ".mindframe-z", "references")}/**)`],
        deny: ["Bash(curl *)", `Edit(/${path.join(home, ".mindframe-z", "references")}/**)`]
      },
      env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1" },
      model: "sonnet"
    });
  });

  it("replaces an old Claude settings symlink with a machine-local file", async () => {
    const snapshotPath = configsPath(home, "personal", "claude", "settings.json");
    const settingsPath = path.join(home, ".claude", "settings.json");
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(snapshotPath, '{"awsAuthRefresh":"/work/credential-process"}\n', "utf8");
    await symlink(snapshotPath, settingsPath);

    await cli("mfz", root, home, ["apply", "--agent", "claude-code"]);

    expect((await lstat(settingsPath)).isSymbolicLink()).toBe(false);
    expect(await readFile(settingsPath, "utf8")).toContain("/work/credential-process");
    expect(await readFile(settingsPath, "utf8")).toContain("includeGitInstructions");
  });

  it("does not write machine-local Claude settings with --no-link", async () => {
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(path.join(home, ".claude", "settings.json"), "{}\n", "utf8");
    await writeFile(path.join(home, ".claude.json"), '{"mcpServers":{}}\n', "utf8");

    const result = await cli("mfz", root, home, ["apply", "--agent", "claude-code", "--no-link"]);

    expect(result.stdout).not.toContain("wrote local");
    expect(await readFile(path.join(home, ".claude", "settings.json"), "utf8")).toBe("{}\n");
    expect(await readFile(path.join(home, ".claude.json"), "utf8")).toBe('{"mcpServers":{}}\n');
  });

  it("merges Claude MCP into top-level .claude.json and prunes non-targeted managed servers", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "mcp:",
        "  context7:",
        "    agents: [opencode]",
        "  local-helper:",
        "    agents: [claude-code]",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify(
        {
          installMethod: "native",
          mcpServers: {
            context7: { type: "http", url: "https://old.invalid" },
            executor: {
              type: "stdio",
              command: "executor",
              args: ["mcp", "--scope", "/tmp/mfz-generated-executor"],
              env: { EXECUTOR_DATA_DIR: "/tmp/mfz-generated-executor-data" }
            },
            manual: { type: "http", url: "https://manual.invalid" }
          },
          projects: {
            [path.join(home, "src")]: {
              disabledMcpServers: ["local-helper"]
            }
          }
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "claude-code"]);

    const localClaudeJson = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8")) as {
      installMethod?: string;
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, unknown>;
    };
    expect(localClaudeJson.installMethod).toBe("native");
    expect(localClaudeJson.projects).toBeDefined();
    expect(localClaudeJson.mcpServers).toEqual({
      manual: { type: "http", url: "https://manual.invalid" },
      context7: { type: "http", url: "https://mcp.context7.com/mcp" },
      "local-helper": { type: "stdio", command: "tool-helper", args: ["--serve"] }
    });
  });

  it("preserves a user-owned all-direct Claude MCP entry named executor", async () => {
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          executor: { type: "stdio", command: "executor" },
          manual: { type: "http", url: "https://manual.invalid" }
        }
      }) + "\n",
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "claude-code"]);

    const localClaudeJson = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(localClaudeJson.mcpServers).toMatchObject({
      executor: { type: "stdio", command: "executor" },
      manual: { type: "http", url: "https://manual.invalid" }
    });
  });

  it("does not render Claude config for an opencode-only profile", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "instructions:",
        "  - instructions/AGENTS.md",
        "mcp:",
        "  context7:",
        "    agents: [opencode]",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--no-link"]);

    await expect(
      readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    ).resolves.toContain("context7");
    await expect(
      readFile(configsPath(home, "personal", "claude", "CLAUDE.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("renders MCP entries for declared agents", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "instructions:",
        "  - instructions/AGENTS.md",
        "mcp:",
        "  context7:",
        "    agents: [opencode]",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--no-link"]);
    const opencode = await readFile(
      configsPath(home, "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );
    expect(opencode).toContain("context7");
  });

  it("transforms env-referenced MCP headers per target", async () => {
    await writeFile(
      path.join(root, "catalog", "mcp.yml"),
      [
        "servers:",
        "  exa:",
        "    description: Search.",
        "    type: remote",
        "    transport: http",
        "    url: https://mcp.exa.ai/mcp",
        "    headers:",
        '      Authorization: "{env:EXA_API_KEY}"',
        "      X-Client: literal-value",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "agents: [opencode, claude-code, codex]",
        "mcp:",
        "  exa:",
        "    agents: [opencode, claude-code, codex]",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--no-link"]);

    // OpenCode passes the {env:NAME} reference through untouched.
    const opencode = JSON.parse(
      await readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    ) as { mcp: Record<string, unknown> };
    expect(opencode.mcp).toMatchObject({
      exa: { headers: { Authorization: "{env:EXA_API_KEY}", "X-Client": "literal-value" } }
    });

    // Claude rewrites the reference to shell-style ${NAME} interpolation.
    const claudeMcp = JSON.parse(
      await readFile(configsPath(home, "personal", "claude", "mcp.json"), "utf8")
    ) as Record<string, unknown>;
    expect(claudeMcp).toMatchObject({
      exa: { headers: { Authorization: "${EXA_API_KEY}", "X-Client": "literal-value" } }
    });

    // Codex splits literal headers from env-referenced ones into distinct tables.
    const codex = parse(
      await readFile(configsPath(home, "personal", "codex", "config.toml"), "utf8")
    ) as { mcp_servers: Record<string, unknown> };
    expect(codex.mcp_servers).toMatchObject({
      exa: {
        env_http_headers: { Authorization: "EXA_API_KEY" },
        http_headers: { "X-Client": "literal-value" }
      }
    });
  });

  it("filters agent rendering with --agent", async () => {
    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    await expect(
      readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    ).resolves.toContain("test/model");
    await expect(
      readFile(configsPath(home, "personal", "claude", "CLAUDE.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("translates {env:NAME} MCP header refs per agent without leaking literals", async () => {
    await writeFile(
      path.join(root, "catalog", "mcp.yml"),
      [
        "servers:",
        "  secured:",
        "    description: Secured remote.",
        "    type: remote",
        "    transport: http",
        "    url: https://secure.example.invalid/mcp",
        "    headers:",
        '      Authorization: "{env:SECURED_TOKEN}"',
        "      X-Client: literal-value",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "base", "profile.yml"),
      ["name: base", "mcp:", "  secured:", "    agents: [claude-code, codex]", ""].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [claude-code, codex]",
        "instructions:",
        "  - instructions/AGENTS.md",
        "mcp:",
        "  secured:",
        "    agents: [claude-code, codex]",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--no-link"]);

    const codexConfig = parse(
      await readFile(configsPath(home, "personal", "codex", "config.toml"), "utf8")
    ) as { mcp_servers: { secured: Record<string, unknown> } };
    // Codex keeps the env-ref name in env_http_headers and only literals in http_headers.
    expect(codexConfig.mcp_servers.secured.env_http_headers).toEqual({
      Authorization: "SECURED_TOKEN"
    });
    expect(codexConfig.mcp_servers.secured.http_headers).toEqual({ "X-Client": "literal-value" });

    const claudeMcp = JSON.parse(
      await readFile(configsPath(home, "personal", "claude", "mcp.json"), "utf8")
    ) as { secured: { headers: Record<string, string> } };
    // Claude rewrites the env-ref into ${NAME} while passing literals through verbatim.
    expect(claudeMcp.secured.headers).toEqual({
      Authorization: "${SECURED_TOKEN}",
      "X-Client": "literal-value"
    });

    // The raw token literal must never reach either rendered config.
    const codexRaw = await readFile(configsPath(home, "personal", "codex", "config.toml"), "utf8");
    const claudeRaw = await readFile(configsPath(home, "personal", "claude", "mcp.json"), "utf8");
    expect(codexRaw).not.toContain("{env:SECURED_TOKEN}");
    expect(claudeRaw).not.toContain("{env:SECURED_TOKEN}");
  });

  it("links skills to the rendered snapshot and keeps source edits inactive until apply", async () => {
    await cli("mfz", root, home, ["apply", "--no-link"]);
    const snapshotSkill = configsPath(home, "personal", "skills", "local-skill", "SKILL.md");
    const oldContent = await readFile(snapshotSkill, "utf8");
    const sourceSkill = path.join(root, "skills", "local-skill", "SKILL.md");
    await writeFile(
      sourceSkill,
      oldContent.replace("Local test skill.", "Changed test skill."),
      "utf8"
    );
    expect(await readFile(snapshotSkill, "utf8")).toBe(oldContent);

    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);
    await expect(realpath(path.join(home, ".agents", "skills", "local-skill"))).resolves.toBe(
      snapshotSkill.replace(/\/SKILL\.md$/, "")
    );
    expect(await readFile(snapshotSkill, "utf8")).toContain("Changed test skill.");
  });

  it("keeps skill runtime state unchanged during apply dry-run", async () => {
    const result = await cli("mfz", root, home, ["apply", "--dry-run"]);
    expect(result.stdout).toContain("would render skill");
    await expect(
      readFile(
        path.join(
          home,
          ".mindframe-z",
          "engine-skills",
          "skills",
          "skill-update-review",
          "SKILL.md"
        )
      )
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(configsPath(home, "personal", "skills", ".mfz-manifest.yml"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails before replacing a snapshot when an unmanaged skill path conflicts", async () => {
    await cli("mfz", root, home, ["apply", "--no-link"]);
    const snapshotSkill = configsPath(home, "personal", "skills", "local-skill", "SKILL.md");
    const prior = await readFile(snapshotSkill, "utf8");
    await mkdir(path.join(home, ".agents", "skills", "local-skill"), { recursive: true });

    const result = await cli("mfz", root, home, ["apply", "--agent", "opencode"]).catch(
      (error) => error
    );
    expect(result.stderr).toContain("Unmanaged skill link conflict");
    expect(await readFile(snapshotSkill, "utf8")).toBe(prior);
  });

  it("removes stale owned links when a target has no remaining skills", async () => {
    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);
    const link = path.join(home, ".agents", "skills", "local-skill");
    await expect(realpath(link)).resolves.toBe(
      configsPath(home, "personal", "skills", "local-skill")
    );

    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      ["name: personal", "extends: base", "agents: [opencode]", ""].join("\n"),
      "utf8"
    );
    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);

    await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(configsPath(home, "personal", "skills", "local-skill"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not rewrite a matching snapshot", async () => {
    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);
    const snapshotSkill = configsPath(home, "personal", "skills", "local-skill", "SKILL.md");
    const before = (await stat(snapshotSkill)).ino;
    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);
    expect((await stat(snapshotSkill)).ino).toBe(before);
  });

  it("renders explicit shared-directory runtime restrictions", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode, codex]",
        "skills:",
        "  local-skill:",
        "    agents: { opencode: true }",
        ""
      ].join("\n"),
      "utf8"
    );
    await cli("mfz", root, home, ["apply", "--agent", "all"]);

    const opencode = JSON.parse(
      await readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    ) as { permission?: { skill?: Record<string, string> } };
    expect(opencode.permission?.skill?.["local-skill"]).toBe("allow");
    const codex = parse(
      await readFile(configsPath(home, "personal", "codex", "config.toml"), "utf8")
    ) as { skills?: { config?: Array<{ path: string; enabled: boolean }> } };
    expect(codex.skills?.config).toContainEqual({
      path: path.join(home, ".agents", "skills", "local-skill", "SKILL.md"),
      enabled: false
    });
  });

  it("preserves the OpenCode/Codex physical skill union for targeted apply", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode, codex]",
        "skills:",
        "  local-skill:",
        "    agents: { opencode: true }",
        "  all-skill:",
        "    agents: { codex: true }",
        ""
      ].join("\n"),
      "utf8"
    );
    await cli("mfz", root, home, ["apply", "--agent", "all"]);
    await expect(lstat(path.join(home, ".agents", "skills", "all-skill"))).resolves.toBeDefined();

    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);
    await expect(lstat(path.join(home, ".agents", "skills", "all-skill"))).resolves.toBeDefined();
  });
});
