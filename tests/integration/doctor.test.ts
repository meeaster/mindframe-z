import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, cliWithMachineRepoPath, setupIntegrationFixture } from "./support.js";

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
});
