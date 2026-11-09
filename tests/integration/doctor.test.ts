import { mkdir, writeFile } from "node:fs/promises";
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
    expect(result.stdout).toContain("opencode commands\ttest-cmd");
  });

  it("doctor reports valid manifests", async () => {
    const result = await cli("mfz", root, home, ["doctor"]);
    expect(result.stdout).toContain("manifest:✓\tmfz-home.yml");
    expect(result.stdout).toContain("manifest:✓\tcatalog/references.yml");
    expect(result.stdout).toContain("manifest:✓\tcatalog/skills.yml");
    expect(result.stdout).toContain("manifest:✓\tcatalog/mcp.yml");
    expect(result.stdout).toContain("manifest:✓\tprofiles/personal/profile.yml");
  });

  it("checks an external skill's standalone command and selected links", async () => {
    await writeFile(
      path.join(root, "catalog", "skills.yml"),
      "skills:\n  - name: external\n    source: external\n    command: node\n    sync: mise run external:sync\n"
    );
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      "name: personal\nagents: [codex]\nskills:\n  external:\n    agents: { codex: true }\n    select: [external-jira]\n"
    );
    const skillDir = path.join(home, ".agents", "skills", "external-jira");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: external-jira\ndescription: test\n---\n"
    );

    const result = await cli("mfz", root, home, ["doctor"]);
    expect(result.stdout).toContain("external-skill:ok\texternal\tnode\texternal-jira");
    expect(result.stdout).not.toContain("skill:unmanaged\texternal-jira");

    const missing = await cli("mfz", root, home, ["doctor"], { PATH: "/definitely-missing" });
    expect(missing.stdout).toContain("external-skill:missing\texternal\tnode is not installed");
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
});
