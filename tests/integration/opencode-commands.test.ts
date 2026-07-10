import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, configsPath, setupIntegrationFixture } from "./support.js";

describe("opencode commands integration", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());
  });

  afterEach(() => {
    root = "";
    home = "";
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

  it("renders configured OpenCode agent markdown files", async () => {
    await mkdir(path.join(root, "opencode", "agents"), { recursive: true });
    await writeFile(path.join(root, "opencode", "agents", "garden.md"), "# Garden agent\n", "utf8");
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "opencode:",
        "  agents:",
        "    - garden",
        ""
      ].join("\n"),
      "utf8"
    );
    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    await expect(
      readFile(configsPath(home, "personal", "opencode", "agents", "garden.md"), "utf8")
    ).resolves.toBe("# Garden agent\n");
  });

  it("renders configured OpenCode TUI plugins into tui.json", async () => {
    await mkdir(path.join(root, "opencode", "plugins", "status"), { recursive: true });
    await writeFile(
      path.join(root, "opencode", "plugins", "status", "index.tsx"),
      "export default {}\n",
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "opencode:",
        "  tui:",
        "    leader_timeout: 2000",
        "  tui_plugins:",
        "    - status",
        ""
      ].join("\n"),
      "utf8"
    );
    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);

    await expect(
      readFile(
        path.join(home, ".config", "opencode", "plugins", "mindframe-z", "status", "index.tsx"),
        "utf8"
      )
    ).resolves.toBe("export default {}\n");
    await expect(
      readFile(configsPath(home, "personal", "opencode", "tui.json"), "utf8")
    ).resolves.toContain('"plugin": [\n    "file://');
  });

  it("renders a directory server plugin at its index module URL", async () => {
    await mkdir(path.join(root, "opencode", "plugins", "server"), { recursive: true });
    await writeFile(
      path.join(root, "opencode", "plugins", "server", "index.mts"),
      "export default {}\n",
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "opencode:",
        "  plugins:",
        "    - server",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    const config = JSON.parse(
      await readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    ) as { plugin: string[] };
    expect(config.plugin).toEqual([
      `file://${path.join(home, ".config", "opencode", "plugins", "mindframe-z", "server", "index.mts")}`
    ]);
  });

  it("renders a package directory for both server and TUI entrypoints", async () => {
    const pluginDir = path.join(root, "opencode", "plugins", "combined");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "combined",
        type: "module",
        exports: { "./server": "./server.ts", "./tui": "./tui.tsx" }
      }),
      "utf8"
    );
    await writeFile(path.join(pluginDir, "server.ts"), "export default {}\n", "utf8");
    await writeFile(path.join(pluginDir, "tui.tsx"), "export default {}\n", "utf8");
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "opencode:",
        "  plugins:",
        "    - combined",
        "  tui_plugins:",
        "    - combined",
        ""
      ].join("\n"),
      "utf8"
    );
    const stalePlugin = path.join(
      home,
      ".config",
      "opencode",
      "plugins",
      "mindframe-z",
      "legacy.ts"
    );
    await mkdir(path.dirname(stalePlugin), { recursive: true });
    await writeFile(stalePlugin, "export default {}\n", "utf8");

    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);

    const pluginDirUrl = `file://${path.join(home, ".config", "opencode", "plugins", "mindframe-z", "combined")}`;
    const config = JSON.parse(
      await readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    ) as { plugin: string[] };
    const tui = JSON.parse(
      await readFile(configsPath(home, "personal", "opencode", "tui.json"), "utf8")
    ) as { plugin: string[] };

    expect(config.plugin).toEqual([pluginDirUrl]);
    expect(tui.plugin).toEqual([pluginDirUrl]);
    expect(
      JSON.parse(
        await readFile(
          path.join(
            home,
            ".config",
            "opencode",
            "plugins",
            "mindframe-z",
            "combined",
            "package.json"
          ),
          "utf8"
        )
      )
    ).toMatchObject({ exports: { "./server": "./server.ts", "./tui": "./tui.tsx" } });
    await expect(readFile(stalePlugin, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("renders a single-file server plugin at its file URL", async () => {
    await writeFile(
      path.join(root, "opencode", "plugins", "single.mjs"),
      "export default {}\n",
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "opencode:",
        "  plugins:",
        "    - single",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    const config = JSON.parse(
      await readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    ) as { plugin: string[] };
    expect(config.plugin).toEqual([
      `file://${path.join(home, ".config", "opencode", "plugins", "mindframe-z", "single.mjs")}`
    ]);
  });

  it("does not render tui.json without TUI configuration", async () => {
    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    await expect(
      readFile(configsPath(home, "personal", "opencode", "tui.json"), "utf8")
    ).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("throws when a profile references a missing agent file", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      ["name: personal", "extends: base", "opencode:", "  agents:", "    - missing-agent", ""].join(
        "\n"
      ),
      "utf8"
    );

    await expect(cli("mfz", root, home, ["apply", "--no-link"])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown agent: missing-agent")
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
});
