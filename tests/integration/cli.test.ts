import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../..");

async function makeTempDir(): Promise<string> {
  return await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(path.join(os.tmpdir(), "mindframe-z-test-"))
  );
}

async function writeFixture(root: string, home?: string): Promise<void> {
  await mkdir(path.join(root, "shared"), { recursive: true });
  await mkdir(path.join(root, "opencode", "plugins"), { recursive: true });
  await mkdir(path.join(root, "profiles", "base"), { recursive: true });
  await mkdir(path.join(root, "profiles", "personal"), { recursive: true });
  await writeFile(path.join(root, "shared", "AGENTS.global.md"), "# Test Agents\n", "utf8");
  await writeFile(
    path.join(root, "opencode", "plugins", "config-marker.ts"),
    [
      "export default async () => {",
      "  return {",
      "    config: (cfg) => {",
      "      cfg.username = 'mindframe-z-plugin-loaded';",
      "    },",
      "  };",
      "};",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "shared", "refs.yml"),
    [
      "references:",
      "  - name: local-ref",
      "    url: https://example.invalid/local-ref.git",
      "    description: Local test reference.",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "shared", "skills.yml"),
    [
      "skills:",
      "  - name: local-skill",
      "    source: local",
      "    description: Local test skill.",
      "    targets: [opencode, claude-code]",
      "    installer: npx-skills",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "shared", "mcp.yml"),
    [
      "servers:",
      "  context7:",
      "    description: Docs.",
      "    targets: [opencode, claude-code]",
      "    type: remote",
      "    transport: http",
      "    url: https://mcp.context7.com/mcp",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "profiles", "base", "profile.yml"),
    ["name: base", "mcp:", "  context7:", "    enabled: true", ""].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "profiles", "base", "mise.toml"),
    '[tools]\njq = "latest"\n',
    "utf8"
  );
  await writeFile(
    path.join(root, "profiles", "base", ".npmrc"),
    "min-release-age=3\nminimum-release-age=4320\n",
    "utf8"
  );
  await writeFile(
    path.join(root, "profiles", "personal", "profile.yml"),
    [
      "name: personal",
      "extends: base",
      "targets: [opencode, claude-code]",
      "instructions:",
      "  - shared/AGENTS.global.md",
      "references:",
      "  - local-ref",
      "skills:",
      "  - local-skill",
      "mcp:",
      "  context7:",
      "    enabled: true",
      "opencode:",
      "  model: test/model",
      "opencode_plugins:",
      "  - config-marker",
      "claude:",
      "  model: sonnet",
      "  settings:",
      "    includeGitInstructions: true",
      ""
    ].join("\n"),
    "utf8"
  );
  if (home) {
    const cfgDir = path.join(home, ".mindframe-z");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(
      path.join(cfgDir, "config.yml"),
      ["profile: personal", "references_dir: ~/references", ""].join("\n"),
      "utf8"
    );
  }
}

function cli(
  name: "mindframe-z",
  root: string,
  home: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  input?: string
) {
  const options: Record<string, unknown> = {
    cwd: projectRoot,
    env: {
      ...process.env,
      MFZ_ROOT: root,
      MFZ_HOME: home,
      OPENCODE_CONFIG_DIR: path.join(home, ".config", "opencode"),
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      ...env
    }
  };
  if (input !== undefined) options.input = input;
  return execa(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(projectRoot, "src", "cli", `${name}.ts`),
      "--root",
      root,
      "--home",
      home,
      ...args
    ],
    options
  );
}

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
    const result = await cli("mindframe-z", root, home, ["apply", "--target", "all"]);
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

    const claude = await readFile(
      path.join(root, "configs", "personal", "claude", "CLAUDE.md"),
      "utf8"
    );
    expect(claude).toContain("@" + path.join(root, "configs", "personal", "AGENTS.md"));

    await expect(realpath(path.join(home, ".config", "opencode", "opencode.jsonc"))).resolves.toBe(
      path.join(root, "configs", "personal", "opencode", "opencode.jsonc")
    );
    await expect(realpath(path.join(home, ".claude", "CLAUDE.md"))).resolves.toBe(
      path.join(root, "configs", "personal", "claude", "CLAUDE.md")
    );
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

    const result = await cli("mindframe-z", root, home, ["apply", "--target", "opencode"]);
    expect(result.stdout).toContain("rendered");

    const opencode = await readFile(
      path.join(root, "configs", "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );
    expect(opencode).toContain("permission");
    expect(opencode).toContain(workDir);
    expect(opencode).toContain(referencesDir);
  });

  it("renders mise config from base profile and links it", async () => {
    const result = await cli("mindframe-z", root, home, ["apply", "--target", "all"]);
    expect(result.stdout).toContain("rendered");

    const mise = await readFile(
      path.join(root, "configs", "personal", "mise", "config.toml"),
      "utf8"
    );
    expect(mise).toContain('jq = "latest"');
  });

  it("backs up and replaces existing config files after approval", async () => {
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(path.join(home, ".claude", "settings.json"), "{}\n", "utf8");

    const result = await cli("mindframe-z", root, home, ["apply", "--target", "claude-code"], {
      MFZ_REPLACE_EXISTING: "yes"
    });

    expect(result.stdout).toContain("backed up");
    await expect(realpath(path.join(home, ".claude", "settings.json"))).resolves.toBe(
      path.join(root, "configs", "personal", "claude", "settings.json")
    );

    const entries = await readdir(path.join(home, ".claude"));
    expect(entries.some((entry) => entry.startsWith("settings.json.mindframe-z.bak-"))).toBe(true);
  });

  it("skips existing config files when approval is denied", async () => {
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(path.join(home, ".claude", "settings.json"), "{}\n", "utf8");

    const result = await cli("mindframe-z", root, home, ["apply", "--target", "claude-code"], {
      MFZ_REPLACE_EXISTING: "no"
    });

    expect(result.stdout).toContain("skipped");
    expect(await readFile(path.join(home, ".claude", "settings.json"), "utf8")).toBe("{}\n");
  });

  it("writes a reference index from profile references", async () => {
    await cli("mindframe-z", root, home, ["refs", "index"]);
    const index = await readFile(path.join(root, "configs", "personal", "references.md"), "utf8");
    expect(index).toContain("local-ref");
    expect(index).toContain("Local test reference");
  });

  it("uses MFZ_REFERENCES_DIR as the reference clone directory", async () => {
    const referencesDir = path.join(home, "custom-reference-cache");
    const result = await cli("mindframe-z", root, home, ["refs", "list"], {
      MFZ_REFERENCES_DIR: referencesDir
    });

    expect(result.stdout).toContain(`${referencesDir}/local-ref`);
    expect(result.stdout).not.toContain(`${home}/references/local-ref`);
  });

  it("verifies rendered OpenCode config shows mise", async () => {
    const result = await cli("mindframe-z", root, home, ["apply", "--target", "all"]);
    expect(result.stdout).toContain("mise");
  });

  it("sync detects unmanaged mise tools and promotes them to base profile mise.toml", async () => {
    await cli("mindframe-z", root, home, ["apply", "--target", "mise", "--no-link"]);

    const misePath = path.join(root, "configs", "personal", "mise", "config.toml");
    // Simulate mise use -g rust@latest: write TOML with an unmanaged tool
    await writeFile(misePath, '[tools]\njq = "latest"\nrust = "latest"\n', "utf8");

    const syncResult = await cli("mindframe-z", root, home, ["sync"], {}, "base\n");
    expect(syncResult.stdout).toContain("Updated base/mise.toml");

    const baseMise = await readFile(path.join(root, "profiles", "base", "mise.toml"), "utf8");
    expect(baseMise).toContain("rust");

    // Re-render and verify rust is still there
    await cli("mindframe-z", root, home, ["apply", "--target", "mise", "--no-link"]);
    const miseAfter = await readFile(misePath, "utf8");
    expect(miseAfter).toContain('rust = "latest"');
    expect(miseAfter).toContain('jq = "latest"');
  });

  it("sync detects unmanaged git skills and promotes them to the chosen profile", async () => {
    await mkdir(path.join(home, ".agents", "skills", "remote-skill"), { recursive: true });
    await writeFile(
      path.join(home, ".agents", ".skill-lock.json"),
      JSON.stringify(
        {
          version: 3,
          skills: {
            "remote-skill": {
              source: "example/skills",
              sourceType: "github",
              sourceUrl: "https://github.com/example/skills.git",
              skillPath: "skills/remote-skill/SKILL.md"
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      path.join(home, ".agents", "skills", "remote-skill", "SKILL.md"),
      ["---", "description: Remote test skill.", "---", "", "# Remote Skill", ""].join("\n"),
      "utf8"
    );

    const syncResult = await cli("mindframe-z", root, home, ["sync"], {}, "personal\n");
    expect(syncResult.stdout).toContain(
      "Unmanaged skill: remote-skill (https://github.com/example/skills)"
    );
    expect(syncResult.stdout).toContain("Updated shared/skills.yml");
    expect(syncResult.stdout).toContain("Updated personal/profile.yml: skills.remote-skill");

    const skillsYaml = await readFile(path.join(root, "shared", "skills.yml"), "utf8");
    expect(skillsYaml).toContain("name: remote-skill");
    expect(skillsYaml).toContain("repo: https://github.com/example/skills");
    expect(skillsYaml).toContain("skill: remote-skill");
    expect(skillsYaml).toContain("description: Remote test skill.");
    expect(skillsYaml).toContain("targets:");
    expect(skillsYaml).toContain("- opencode");
    expect(skillsYaml).toContain("installer: npx-skills");

    const profileYaml = await readFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      "utf8"
    );
    expect(profileYaml).toContain("- local-skill");
    expect(profileYaml).toContain("- remote-skill");
  });

  it("renders and links .npmrc dotfile from profile folder", async () => {
    const result = await cli("mindframe-z", root, home, ["apply", "--target", "dotfiles"]);
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

  it("concatenates dotfile content from parent and child profiles", async () => {
    // Add a .npmrc to the personal profile folder
    await writeFile(
      path.join(root, "profiles", "personal", ".npmrc"),
      "minimum-release-age-exclude[]=test-pkg\n",
      "utf8"
    );

    const result = await cli("mindframe-z", root, home, ["apply", "--target", "dotfiles"]);
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
