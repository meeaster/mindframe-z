import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cli, configsPath, makeTempDir, setupIntegrationFixture } from "./support.js";

async function setupCommandFixture(
  profile: string,
  commandFiles: Record<string, string> = {}
): Promise<{ root: string; home: string }> {
  const root = await makeTempDir();
  const home = await makeTempDir();

  await mkdir(path.join(root, "catalog"), { recursive: true });
  await mkdir(path.join(root, "profiles", "base"), { recursive: true });
  await mkdir(path.join(root, "profiles", "personal"), { recursive: true });
  await mkdir(path.join(root, "opencode", "commands"), { recursive: true });
  await mkdir(path.join(home, ".mindframe-z"), { recursive: true });
  await writeFile(path.join(root, "mfz-home.yml"), "description: Command test home\n", "utf8");
  await writeFile(path.join(root, "catalog", "references.yml"), "references: []\n", "utf8");
  await writeFile(path.join(root, "catalog", "skills.yml"), "skills: []\n", "utf8");
  await writeFile(path.join(root, "catalog", "mcp.yml"), "servers: {}\n", "utf8");
  await writeFile(path.join(root, "profiles", "base", "profile.yml"), "name: base\n", "utf8");
  await writeFile(path.join(root, "profiles", "personal", "profile.yml"), profile, "utf8");
  await writeFile(path.join(home, ".mindframe-z", "config.yml"), "profile: personal\n", "utf8");

  for (const [name, content] of Object.entries(commandFiles)) {
    await writeFile(path.join(root, "opencode", "commands", name), content, "utf8");
  }

  return { root, home };
}

describe("opencode commands integration", () => {
  let root: string;
  let home: string;

  afterEach(() => {
    root = "";
    home = "";
  });

  it("throws when a profile references a missing command file", async () => {
    ({ root, home } = await setupCommandFixture(
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "opencode:",
        "  commands:",
        "    - missing-cmd",
        ""
      ].join("\n")
    ));

    await expect(cli("mfz", root, home, ["apply", "--no-link"])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown command: missing-cmd")
    });
  });

  it("applies configured commands and agents through the global OpenCode links", async () => {
    ({ root, home } = await setupIntegrationFixture());
    await mkdir(path.join(root, "opencode", "agents"), { recursive: true });
    await writeFile(path.join(root, "opencode", "commands", "base-cmd.md"), "Base command.\n");
    await writeFile(path.join(root, "opencode", "agents", "garden.md"), "# Garden agent\n");

    const baseProfile = path.join(root, "profiles", "base", "profile.yml");
    const personalProfile = path.join(root, "profiles", "personal", "profile.yml");
    await writeFile(
      baseProfile,
      `${await readFile(baseProfile, "utf8")}opencode:\n  commands:\n    - base-cmd\n`,
      "utf8"
    );
    await writeFile(
      personalProfile,
      (await readFile(personalProfile, "utf8")).replace(
        "  commands:\n    - test-cmd\n",
        "  commands:\n    - test-cmd\n  agents:\n    - garden\n"
      ),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);

    await expect(
      readFile(configsPath(home, "personal", "opencode", "commands", "base-cmd.md"), "utf8")
    ).resolves.toBe("Base command.\n");
    await expect(
      readFile(configsPath(home, "personal", "opencode", "commands", "test-cmd.md"), "utf8")
    ).resolves.toContain("Run the test command.");
    await expect(
      readFile(configsPath(home, "personal", "opencode", "agents", "garden.md"), "utf8")
    ).resolves.toBe("# Garden agent\n");
    expect((await lstat(path.join(home, ".config", "opencode", "commands"))).isSymbolicLink()).toBe(
      true
    );
    expect((await lstat(path.join(home, ".config", "opencode", "agents"))).isSymbolicLink()).toBe(
      true
    );
  });

  it("sync detects unmanaged commands and promotes them to the chosen profile", async () => {
    ({ root, home } = await setupCommandFixture(
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "opencode:",
        "  commands:",
        "    - test-cmd",
        ""
      ].join("\n"),
      { "test-cmd.md": "Test command.\n", "new-cmd.md": "New command.\n" }
    ));

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
});
