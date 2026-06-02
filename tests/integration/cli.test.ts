import { lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, cliWithMachineRepoPath, makeTempDir, writeFixture } from "./support.js";

describe("CLI integration", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await makeTempDir();
    home = await makeTempDir();
    await writeFixture(root, home);
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

  it("uses machine repo_path when root is not provided", async () => {
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      ["profile: personal", `repo_path: ${root}`, "references_dir: ~/references", ""].join("\n"),
      "utf8"
    );

    const result = await cliWithMachineRepoPath(home, ["doctor"]);

    expect(result.stdout).toContain(`root\t${root}`);
    expect(result.stdout).toContain("manifest:✓\tshared/refs.yml");
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

  it("writes extra_folders index to machine-local path", async () => {
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      [
        "profile: personal",
        "references_dir: ~/references",
        "extra_folders:",
        `  - path: ~/code/work/proj`,
        `    description: Work project`,
        `  - path: ~/code/archived`,
        `    read: deny`,
        `    edit: deny`,
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--no-link"]);

    const index = await readFile(path.join(home, ".mindframe-z", "extra_folders.md"), "utf8");
    expect(index).toContain("Additional directories");
    expect(index).toContain(path.join(home, "code", "work", "proj"));
    expect(index).toContain("Work project");
    expect(index).toContain("read: allow, edit: allow");
    expect(index).toContain(path.join(home, "code", "archived"));
    expect(index).toContain("read: deny, edit: deny");
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

  it("denies managed zsh secrets in OpenCode config", async () => {
    await writeFile(
      path.join(root, "profiles", "base", ".zshrc"),
      "alias gs='git status'\n",
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    const config = JSON.parse(
      await readFile(path.join(root, "configs", "personal", "opencode", "opencode.jsonc"), "utf8")
    ) as {
      permission: { external_directory: Record<string, string>; edit: Record<string, string> };
    };
    const secretsPattern = path.join(home, ".mindframe-z", "secrets", "**");
    expect(config.permission.external_directory[secretsPattern]).toBe("deny");
    expect(config.permission.edit[secretsPattern]).toBe("deny");
    expect(config.permission.edit[path.join(home, ".zshrc")]).toBeUndefined();
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

  it("denies managed zsh secrets in Claude settings", async () => {
    await writeFile(
      path.join(root, "profiles", "base", ".zshrc"),
      "alias gs='git status'\n",
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "claude-code", "--no-link"]);

    const settings = JSON.parse(
      await readFile(path.join(root, "configs", "personal", "claude", "settings.json"), "utf8")
    ) as { permissions: { deny?: string[] } };
    const secretsPattern = `/${path.join(home, ".mindframe-z", "secrets")}/**`;
    expect(settings.permissions.deny).toContain(`Read(${secretsPattern})`);
    expect(settings.permissions.deny).toContain(`Edit(${secretsPattern})`);
  });

  it("auto-adds references_dir permissions without extra_folders", async () => {
    await cli("mfz", root, home, ["apply", "--no-link"]);

    const refsAbs = path.join(home, "references");

    const opencode = await readFile(
      path.join(root, "configs", "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );
    expect(opencode).toContain(`${refsAbs}/**`);

    const settings = JSON.parse(
      await readFile(path.join(root, "configs", "personal", "claude", "settings.json"), "utf8")
    ) as Record<string, unknown>;
    const perms = settings.permissions as { allow?: string[]; deny?: string[] };
    expect(perms.allow).toContain(`Read(/${refsAbs}/**)`);
    expect(perms.deny).toContain(`Edit(/${refsAbs}/**)`);
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

  it("does not write extra_folders.md or reference it when extra_folders is empty", async () => {
    await cli("mfz", root, home, ["apply", "--no-link"]);

    const indexPath = path.join(home, ".mindframe-z", "extra_folders.md");
    await expect(readFile(indexPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const opencode = await readFile(
      path.join(root, "configs", "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );
    expect(opencode).not.toContain("extra_folders.md");

    const claudeMd = await readFile(
      path.join(root, "configs", "personal", "claude", "CLAUDE.md"),
      "utf8"
    );
    expect(claudeMd).not.toContain("extra_folders.md");
  });

  it("renders mise config from base profile and links it", async () => {
    const result = await cli("mfz", root, home, ["apply", "--target", "all"]);
    expect(result.stdout).toContain("rendered");

    const mise = await readFile(
      path.join(root, "configs", "personal", "mise", "config.toml"),
      "utf8"
    );
    expect(mise).toContain('jq = "latest"');
    expect(mise).toContain("[settings]");
    expect(mise).toContain('minimum_release_age = "3d"');
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

  it("writes a reference index from profile references", async () => {
    await cli("mfz", root, home, ["refs", "index"]);
    const index = await readFile(path.join(home, ".mindframe-z", "references.md"), "utf8");
    expect(index).toContain("local-ref");
    expect(index).toContain("Local test reference");
    expect(index).toContain("read-only");
    expect(index).toContain("do not edit");
  });

  it("uses MFZ_REFERENCES_DIR as the reference clone directory", async () => {
    const referencesDir = path.join(home, "custom-reference-cache");
    const result = await cli("mfz", root, home, ["refs", "list"], {
      MFZ_REFERENCES_DIR: referencesDir
    });

    expect(result.stdout).toContain(`${referencesDir}/local-ref`);
    expect(result.stdout).not.toContain(`${home}/references/local-ref`);
  });

  it("verifies rendered OpenCode config shows mise", async () => {
    const result = await cli("mfz", root, home, ["apply", "--target", "all"]);
    expect(result.stdout).toContain("mise");
  });

  it("sync detects unmanaged mise tools and promotes them to base profile mise.toml", async () => {
    await cli("mfz", root, home, ["apply", "--target", "mise", "--no-link"]);

    const misePath = path.join(root, "configs", "personal", "mise", "config.toml");
    // Simulate mise use -g rust@latest: write TOML with an unmanaged tool
    await writeFile(
      misePath,
      '[tools]\njq = "latest"\nrust = "latest"\n\n[settings]\nminimum_release_age = "3d"\n',
      "utf8"
    );

    const syncResult = await cli("mfz", root, home, ["sync"], {}, "base\n");
    expect(syncResult.stdout).toContain("Updated base/mise.toml");

    const baseMise = await readFile(path.join(root, "profiles", "base", "mise.toml"), "utf8");
    expect(baseMise).toContain("rust");

    // Re-render and verify rust is still there
    await cli("mfz", root, home, ["apply", "--target", "mise", "--no-link"]);
    const miseAfter = await readFile(misePath, "utf8");
    expect(miseAfter).toContain('rust = "latest"');
    expect(miseAfter).toContain('jq = "latest"');
  });

  it("sync detects unmanaged mise settings and promotes them to base profile mise.toml", async () => {
    await cli("mfz", root, home, ["apply", "--target", "mise", "--no-link"]);

    const misePath = path.join(root, "configs", "personal", "mise", "config.toml");
    await writeFile(
      misePath,
      '[tools]\njq = "latest"\n\n[settings]\nminimum_release_age = "3d"\nidiomatic_version_file_enable_tools = ["node"]\n',
      "utf8"
    );

    const syncResult = await cli("mfz", root, home, ["sync"], {}, "base\n");
    expect(syncResult.stdout).toContain(
      "Updated base/mise.toml: settings.idiomatic_version_file_enable_tools"
    );

    const baseMise = await readFile(path.join(root, "profiles", "base", "mise.toml"), "utf8");
    expect(baseMise).toMatch(/idiomatic_version_file_enable_tools\s*=\s*\[\s*"node"\s*\]/);

    await cli("mfz", root, home, ["apply", "--target", "mise", "--no-link"]);
    const miseAfter = await readFile(misePath, "utf8");
    expect(miseAfter).toMatch(/idiomatic_version_file_enable_tools\s*=\s*\[\s*"node"\s*\]/);
    expect(miseAfter).toContain('minimum_release_age = "3d"');
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

  it("defaults omitted skill targets to profile agents", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "skills:",
        "  local-skill:",
        "  all-skill: [all]",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["skills", "list"]);
    expect(result.stdout).toContain("local-skill\topencode\tLocal test skill.");
    expect(result.stdout).toContain("all-skill\topencode\tAll agents test skill.");
    expect(result.stdout).not.toContain("claude-code");
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

  it("sync removes extra installed skills not in profile", async () => {
    await mkdir(path.join(home, ".agents", "skills", "extra-skill"), { recursive: true });
    await writeFile(
      path.join(home, ".agents", "skills", "extra-skill", "SKILL.md"),
      "# Extra\n",
      "utf8"
    );

    const result = await cli("mfz", root, home, ["skills", "sync", "--dry-run"]);
    expect(result.stdout).toContain("skills remove extra-skill -g -y");
    expect(result.stdout).toContain("skills add");
  });

  it("upgrade updates git skills for all configured targets", async () => {
    await writeFile(
      path.join(root, "shared", "skills.yml"),
      [
        "skills:",
        "  - name: shared-git-skill",
        "    source: git",
        "    repo: https://github.com/example/skills",
        "    skill: shared-git-skill",
        "    description: Shared git skill.",
        "    installer: skills",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      ["name: personal", "extends: base", "skills:", "  shared-git-skill: [all]", ""].join("\n"),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["skills", "upgrade", "--dry-run"]);
    const lines = result.stdout.split("\n").filter((line) => line.includes("skills update"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("skills update shared-git-skill -g -y");
  });

  it("deep merges inherited skill config", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "skills:",
        "  local-skill:",
        "    targets: [claude-code]",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "base", "profile.yml"),
      [
        "name: base",
        "skills:",
        "  local-skill:",
        "    enabled: false",
        "    targets: [opencode]",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["skills", "list"]);
    expect(result.stdout).toContain("local-skill\tclaude-code\tLocal test skill.");
    expect(result.stdout).not.toContain("local-skill\topencode");
  });

  it("accepts legacy empty skill target arrays as no targets", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      ["name: personal", "extends: base", "skills:", "  local-skill: []", ""].join("\n"),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["doctor"]);
    expect(result.stdout).toContain("manifest:✓\tprofiles/personal/profile.yml");

    const listResult = await cli("mfz", root, home, ["skills", "list"]);
    expect(listResult.stdout).not.toContain("local-skill");
  });

  it("accepts legacy null skill entries", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "skills:",
        "  local-skill:",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["skills", "list"]);
    expect(result.stdout).toContain("local-skill\topencode\tLocal test skill.");
  });

  it("prints enabled commands in status output", async () => {
    const result = await cli("mfz", root, home, ["status"]);
    expect(result.stdout).toContain("commands\ttest-cmd");
  });

  it("doctor reports valid manifests", async () => {
    const result = await cli("mfz", root, home, ["doctor"]);
    expect(result.stdout).toContain("manifest:✓\tshared/refs.yml");
    expect(result.stdout).toContain("manifest:✓\tshared/skills.yml");
    expect(result.stdout).toContain("manifest:✓\tshared/mcp.yml");
    expect(result.stdout).toContain("manifest:✓\tprofiles/personal/profile.yml");
  });

  it("doctor reports invalid manifests without throwing", async () => {
    await writeFile(
      path.join(root, "shared", "mcp.yml"),
      ["servers:", "  broken:", "    type: websocket", "    url: https://example.invalid", ""].join(
        "\n"
      ),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["doctor"]);
    expect(result.stdout).toContain("manifest:✗\tshared/mcp.yml");
    expect(result.stdout).toContain("Invalid input");
    expect(result.stdout).toContain("remote");
    expect(result.stdout).toContain("local");
  });

  it("throws when a profile references a missing command file", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      ["name: personal", "extends: base", "opencode:", "  commands:", "    - missing-cmd", ""].join(
        "\n"
      ),
      "utf8"
    );

    await expect(cli("mfz", root, home, ["apply", "--no-link"])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown command: missing-cmd")
    });
  });

  it("merges and deduplicates commands from parent and child profiles", async () => {
    await writeFile(
      path.join(root, "opencode", "commands", "base-cmd.md"),
      "Base command.\n",
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "base", "profile.yml"),
      ["name: base", "opencode:", "  commands:", "    - base-cmd", "    - test-cmd", ""].join("\n"),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["status"]);
    expect(result.stdout).toContain("commands\tbase-cmd, test-cmd");
  });

  it("sync detects unmanaged commands and promotes them to the chosen profile", async () => {
    await writeFile(
      path.join(root, "opencode", "commands", "new-cmd.md"),
      "New command.\n",
      "utf8"
    );

    const syncResult = await cli("mfz", root, home, ["sync"], {}, "personal\n");
    expect(syncResult.stdout).toContain("Unmanaged command: new-cmd");
    expect(syncResult.stdout).toContain("Updated personal/profile.yml: opencode.commands.new-cmd");

    const profileYaml = await readFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      "utf8"
    );
    expect(profileYaml).toContain("- test-cmd");
    expect(profileYaml).toContain("- new-cmd");
  });

  it("renders and links .npmrc dotfile from profile folder", async () => {
    const result = await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);
    expect(result.stdout).toContain("rendered");

    const npmrc = await readFile(
      path.join(root, "configs", "personal", "dotfiles", ".npmrc"),
      "utf8"
    );
    expect(npmrc).toContain("min-release-age=3");
    expect(npmrc).toContain("minimum-release-age=4320");

    await expect(realpath(path.join(home, ".npmrc"))).resolves.toBe(
      path.join(root, "configs", "personal", "dotfiles", ".npmrc")
    );
  });

  it("renders and links managed .zshrc with guarded local includes", async () => {
    await writeFile(
      path.join(root, "profiles", "base", ".zshrc"),
      "alias gs='git status'\n",
      "utf8"
    );

    const result = await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);
    expect(result.stdout).toContain("rendered");

    const zshrc = await readFile(
      path.join(root, "configs", "personal", "dotfiles", ".zshrc"),
      "utf8"
    );
    expect(zshrc).toContain(path.join(home, ".mindframe-z", "secrets", "zsh.env"));
    expect(zshrc).toContain("alias gs='git status'");
    expect(zshrc).toContain(path.join(home, ".zshrc.local"));

    await expect(realpath(path.join(home, ".zshrc"))).resolves.toBe(
      path.join(root, "configs", "personal", "dotfiles", ".zshrc")
    );
  });

  it("keeps managed .zshrc safe when local include files are absent", async () => {
    await writeFile(path.join(root, "profiles", "base", ".zshrc"), "export TEST_ZSH=1\n", "utf8");

    await cli("mfz", root, home, ["apply", "--target", "dotfiles", "--no-link"]);

    const zshrc = await readFile(
      path.join(root, "configs", "personal", "dotfiles", ".zshrc"),
      "utf8"
    );
    expect(zshrc).toContain("if [ -r ");
    expect(zshrc).toContain("source ");
    expect(zshrc).not.toContain("API_KEY=");
    expect(zshrc).not.toContain("TOKEN=");
  });

  it("creates an empty zsh secrets file only when missing", async () => {
    await writeFile(path.join(root, "profiles", "base", ".zshrc"), "export TEST_ZSH=1\n", "utf8");

    await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);

    const secretsPath = path.join(home, ".mindframe-z", "secrets", "zsh.env");
    expect(await readFile(secretsPath, "utf8")).toBe("");

    await writeFile(secretsPath, "export TOKEN=kept\n", "utf8");
    await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);

    expect(await readFile(secretsPath, "utf8")).toBe("export TOKEN=kept\n");
  });

  it("does not create a zsh secrets file with --no-link", async () => {
    await writeFile(path.join(root, "profiles", "base", ".zshrc"), "export TEST_ZSH=1\n", "utf8");

    await cli("mfz", root, home, ["apply", "--target", "dotfiles", "--no-link"]);

    await expect(
      readFile(path.join(home, ".mindframe-z", "secrets", "zsh.env"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("concatenates dotfile content from parent and child profiles", async () => {
    // Add a .npmrc to the personal profile folder
    await writeFile(
      path.join(root, "profiles", "personal", ".npmrc"),
      "minimum-release-age-exclude[]=test-pkg\n",
      "utf8"
    );

    const result = await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);
    expect(result.stdout).toContain("rendered");

    const npmrc = await readFile(
      path.join(root, "configs", "personal", "dotfiles", ".npmrc"),
      "utf8"
    );
    expect(npmrc).toContain("min-release-age=3");
    expect(npmrc).toContain("minimum-release-age=4320");
    expect(npmrc).toContain("minimum-release-age-exclude[]=test-pkg");
  });
});
