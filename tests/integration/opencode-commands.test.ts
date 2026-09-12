import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, configsPath, parseJson, setupIntegrationFixture } from "./support.js";

const PluginConfig = z.object({ plugins: z.array(z.unknown()).optional() });

const CliConfig = z.object({ plugins: z.array(z.unknown()).optional() });

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

  it("renders configured OpenCode TUI plugins into cli.json", async () => {
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
        path.join(home, ".config", "opencode", "plugins", "tui", "status", "index.tsx"),
        "utf8"
      )
    ).resolves.toBe("export default {}\n");
    await expect(
      readFile(path.join(home, ".config", "opencode", "cli.json"), "utf8")
    ).resolves.toContain('"plugins": [\n    "file://');
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

    const config = parseJson(
      PluginConfig,
      await readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    );

    expect(config.plugins).toEqual([`file://${path.join(root, "opencode", "plugins", "server")}`]);
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
      configsPath(home, "personal", "opencode", "plugins"),
      "legacy.ts"
    );

    await mkdir(path.dirname(stalePlugin), { recursive: true });
    await writeFile(stalePlugin, "export default {}\n", "utf8");

    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);

    const config = parseJson(
      PluginConfig,
      await readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    );

    const tui = parseJson(
      CliConfig,
      await readFile(path.join(home, ".config", "opencode", "cli.json"), "utf8")
    );

    expect(config.plugins).toEqual([
      `file://${path.join(root, "opencode", "plugins", "combined")}`
    ]);
    expect(tui.plugins).toEqual([
      `file://${path.join(
        home,
        ".mindframe-z",
        "configs",
        "personal",
        "opencode",
        "plugins",
        "tui",
        "combined"
      )}`
    ]);
    expect(
      JSON.parse(
        await readFile(
          path.join(
            home,
            ".mindframe-z",
            "configs",
            "personal",
            "opencode",
            "plugins",
            "tui",
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

    const config = parseJson(
      PluginConfig,
      await readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    );

    expect(config.plugins).toEqual([
      `file://${path.join(home, ".mindframe-z", "configs", "personal", "opencode", "plugins", "single.mjs")}`
    ]);
  });

  it("does not discover unconfigured server or TUI plugins", async () => {
    await writeFile(
      path.join(root, "opencode", "plugins", "discovered.mjs"),
      "export default {}\n",
      "utf8"
    );
    await mkdir(path.join(root, "opencode", "plugins", "bundled"), { recursive: true });
    await writeFile(
      path.join(root, "opencode", "plugins", "bundled", "index.ts"),
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
        "  cli:",
        "    theme: dark",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);

    const config = parseJson(
      PluginConfig,
      await readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    );

    expect(config.plugins).toBeUndefined();
    await expect(
      readFile(path.join(home, ".config", "opencode", "cli.json"), "utf8")
    ).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("discovers no server plugins when the plugins directory is absent", async () => {
    await rm(path.join(root, "opencode", "plugins"), { recursive: true });
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      ["name: personal", "extends: base", "agents: [opencode]", ""].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    const config = parseJson(
      PluginConfig,
      await readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    );

    expect(config.plugins).toBeUndefined();
  });

  it("does not render cli.json without TUI configuration", async () => {
    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    await expect(
      readFile(path.join(home, ".config", "opencode", "cli.json"), "utf8")
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

  it("renders a packaged command without its development metadata", async () => {
    const commandDir = path.join(root, "opencode", "commands", "packaged-cmd");
    await mkdir(path.join(commandDir, "meta"), { recursive: true });
    await writeFile(path.join(commandDir, "COMMAND.md"), "Packaged command.\n", "utf8");
    await writeFile(path.join(commandDir, "meta", "VISION.md"), "Development vision.\n", "utf8");
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "opencode:",
        "  commands:",
        "    - packaged-cmd",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    await expect(
      readFile(configsPath(home, "personal", "opencode", "commands", "packaged-cmd.md"), "utf8")
    ).resolves.toBe("Packaged command.\n");
    await expect(
      readFile(
        configsPath(home, "personal", "opencode", "commands", "packaged-cmd", "meta", "VISION.md"),
        "utf8"
      )
    ).rejects.toMatchObject({ code: "ENOENT" });
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
