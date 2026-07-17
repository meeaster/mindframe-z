import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, cliWithMachineHomePath, setupIntegrationFixture } from "./support.js";

describe("doctor integration", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());
  });

  afterEach(() => {
    root = "";
    home = "";
  });

  it("uses machine home_path when root is not provided", async () => {
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      [
        "profile: personal",
        `home_path: ${root}`,
        "references_dir: ~/.mindframe-z/references",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await cliWithMachineHomePath(home, ["doctor"]);

    expect(result.stdout).toContain(`root\t${root}`);
    expect(result.stdout).toContain("manifest:✓\tcatalog/references.yml");
  });

  it("prints enabled commands in status output", async () => {
    const result = await cli("mfz", root, home, ["status"]);
    expect(result.stdout).toContain("commands\ttest-cmd");
  });

  it("doctor reports valid manifests", async () => {
    const result = await cli("mfz", root, home, ["doctor"]);
    expect(result.stdout).toContain("manifest:✓\tmfz_home.yml");
    expect(result.stdout).toContain("manifest:✓\tcatalog/references.yml");
    expect(result.stdout).toContain("manifest:✓\tcatalog/skills.yml");
    expect(result.stdout).toContain("manifest:✓\tcatalog/mcp.yml");
    expect(result.stdout).toContain("manifest:✓\tprofiles/personal/profile.yml");
  });

  it("doctor reports invalid manifests without throwing", async () => {
    await writeFile(
      path.join(root, "catalog", "mcp.yml"),
      ["servers:", "  broken:", "    type: websocket", "    url: https://example.invalid", ""].join(
        "\n"
      ),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["doctor"]);
    expect(result.stdout).toContain("manifest:✗\tcatalog/mcp.yml");
    expect(result.stdout).toContain("Invalid input");
    expect(result.stdout).toContain("remote");
    expect(result.stdout).toContain("local");
  });

  it("hints when legacy references exist without an override", async () => {
    await mkdir(path.join(home, "references"), { recursive: true });
    await writeFile(path.join(home, ".mindframe-z", "config.yml"), "profile: personal\n", "utf8");

    const result = await cli("mfz", root, home, ["doctor"]);

    expect(result.stdout).toContain("hint\tlegacy references directory exists");
    expect(result.stdout).toContain(path.join(home, "references"));
    expect(result.stdout).toContain(path.join(home, ".mindframe-z", "references"));
  });

  it("reports Executor diagnostics without starting a daemon", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "mcp:",
        "  context7:",
        "    route: executor",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["doctor"], { PATH: "/definitely-missing" });
    expect(result.stdout).toContain("executor version\tmissing");
    expect(result.stdout).toContain("executor runtime\tabsent\tmanaged absent");
    expect(result.stdout).toContain("executor blocker\tExecutor runtime is not attachable");
    await expect(access(path.join(home, ".mindframe-z", "executor"))).rejects.toMatchObject({
      code: "ENOENT"
    });

    const status = await cli("mfz", root, home, ["status"], { PATH: "/definitely-missing" });
    expect(status.stdout).toContain("executor runtime\tabsent\tmanaged absent");
  });
});
