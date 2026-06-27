import { lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, setupIntegrationFixture } from "./support.js";

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

  it("renders and links OpenCode and Claude config into temporary homes", async () => {
    const result = await cli("mfz", root, home, ["apply", "--target", "all"]);
    expect(result.stdout).toContain("rendered");

    const opencode = await readFile(
      path.join(root, "configs", "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );
    expect(opencode).toContain("https://opencode.ai/config.json");
    expect(opencode).toContain("context7");
    expect(
      await readFile(
        path.join(root, "configs", "personal", "opencode", "plugins", "config-marker.ts"),
        "utf8"
      )
    ).toContain("mindframe-z-plugin-loaded");
    expect(
      await readFile(
        path.join(root, "configs", "personal", "opencode", "commands", "test-cmd.md"),
        "utf8"
      )
    ).toContain("Run the test command.");

    const claude = await readFile(
      path.join(root, "configs", "personal", "claude", "CLAUDE.md"),
      "utf8"
    );
    expect(claude).toContain("@" + path.join(root, "configs", "personal", "AGENTS.md"));

    const claudeMcp = JSON.parse(
      await readFile(path.join(root, "configs", "personal", "claude", "mcp.json"), "utf8")
    ) as Record<string, unknown>;
    expect(claudeMcp).toMatchObject({
      context7: { type: "http", url: "https://mcp.context7.com/mcp" },
      "local-helper": { type: "stdio", command: "tool-helper", args: ["--serve"] }
    });

    await expect(realpath(path.join(home, ".config", "opencode", "opencode.jsonc"))).resolves.toBe(
      path.join(root, "configs", "personal", "opencode", "opencode.jsonc")
    );
    await expect(realpath(path.join(home, ".config", "opencode", "commands"))).resolves.toBe(
      path.join(root, "configs", "personal", "opencode", "commands")
    );
    await expect(realpath(path.join(home, ".claude", "CLAUDE.md"))).resolves.toBe(
      path.join(root, "configs", "personal", "claude", "CLAUDE.md")
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
      path.join(root, "configs", "personal", "opencode", "opencode.jsonc"),
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
      path.join(root, "configs", "personal", "opencode", "opencode.jsonc"),
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
      await readFile(path.join(root, "configs", "personal", "claude", "settings.json"), "utf8")
    ) as Record<string, unknown>;
    expect(settings).toHaveProperty("permissions");
    expect(settings).toHaveProperty("additionalDirectories");
    expect(settings.additionalDirectories).toContain(codePath);
    expect((settings.permissions as { allow?: string[] }).allow).toContain(`Read(/${codePath}/**)`);
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
      path.join(root, "configs", "personal", "opencode", "opencode.jsonc"),
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
      path.join(root, "configs", "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );
    const config = JSON.parse(opencode) as {
      permission: { bash: Record<string, string>; edit: Record<string, string> };
    };
    expect(config.permission.bash["rm *"]).toBe("deny");
    expect(config.permission.edit[`${path.join(home, "references")}/**`]).toBe("deny");
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
      await readFile(path.join(root, "configs", "personal", "claude", "settings.json"), "utf8")
    ) as Record<string, unknown>;
    expect(snapshot).toEqual({
      includeGitInstructions: true,
      permissions: {
        allow: [`Read(/${path.join(home, "references")}/**)`],
        deny: ["Bash(curl *)", `Edit(/${path.join(home, "references")}/**)`]
      },
      env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1" },
      model: "sonnet"
    });
  });

  it("replaces an old Claude settings symlink with a machine-local file", async () => {
    const snapshotPath = path.join(root, "configs", "personal", "claude", "settings.json");
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
        "    targets: [opencode]",
        "    enabled: true",
        "  local-helper:",
        "    targets: [claude-code]",
        "    enabled: false",
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
        "  - shared/AGENTS.global.md",
        "mcp:",
        "  context7:",
        "    enabled: true",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--no-link"]);

    await expect(
      readFile(path.join(root, "configs", "personal", "opencode", "opencode.jsonc"), "utf8")
    ).resolves.toContain("context7");
    await expect(
      readFile(path.join(root, "configs", "personal", "claude", "CLAUDE.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("defaults omitted MCP targets to profile agents", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "instructions:",
        "  - shared/AGENTS.global.md",
        "mcp:",
        "  context7:",
        "    enabled: true",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--no-link"]);
    const opencode = await readFile(
      path.join(root, "configs", "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );
    expect(opencode).toContain("context7");
  });

  it("filters agent rendering with --agent", async () => {
    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    await expect(
      readFile(path.join(root, "configs", "personal", "opencode", "opencode.jsonc"), "utf8")
    ).resolves.toContain("test/model");
    await expect(
      readFile(path.join(root, "configs", "personal", "claude", "CLAUDE.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
