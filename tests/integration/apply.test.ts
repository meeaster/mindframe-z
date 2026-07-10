import { access, lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
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
    const result = await cli("mfz", root, home, ["apply", "--target", "all"]);
    expect(result.stdout).toContain("rendered");

    const opencode = await readFile(
      configsPath(home, "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );
    expect(opencode).toContain("https://opencode.ai/config.json");
    expect(opencode).toContain("context7");
    expect(
      await readFile(
        configsPath(home, "personal", "opencode", "plugins", "config-marker.ts"),
        "utf8"
      )
    ).toContain("mindframe-z-plugin-loaded");
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
    await expect(realpath(path.join(home, ".claude", "CLAUDE.md"))).resolves.toBe(
      configsPath(home, "personal", "claude", "CLAUDE.md")
    );
    expect((await lstat(path.join(home, ".claude", "settings.json"))).isSymbolicLink()).toBe(false);

    const localClaudeJson = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(localClaudeJson.mcpServers).toMatchObject(claudeMcp);
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
        "    agents: { codex: true }",
        "  local-helper:",
        "    agents: { codex: false }",
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
    expect(await readFile(configsPath(home, "personal", "codex", "AGENTS.md"), "utf8")).toContain(
      "# Test Agents"
    );
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
        "    agents: { opencode: true }",
        "  local-helper:",
        "    agents: { claude-code: true }",
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
        "    agents: { opencode: true }",
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
        "    agents: { opencode: true }",
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

  it("filters agent rendering with --agent", async () => {
    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    await expect(
      readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    ).resolves.toContain("test/model");
    await expect(
      readFile(configsPath(home, "personal", "claude", "CLAUDE.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
