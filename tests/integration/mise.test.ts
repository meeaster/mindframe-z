import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, configsPath, setupIntegrationFixture } from "./support.js";

describe("mise integration", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());
  });

  afterEach(() => {
    root = "";
    home = "";
  });

  it("renders mise config from base profile and links it", async () => {
    const result = await cli("mfz", root, home, ["apply", "--target", "all"]);
    expect(result.stdout).toContain("rendered");

    const mise = await readFile(
      configsPath(home, "personal", "mise", "config.toml"),
      "utf8"
    );
    expect(mise).toContain('jq = "latest"');
    expect(mise).toContain('node = "24"');
    expect(mise).toContain("[settings]");
    expect(mise).toContain('minimum_release_age = "3d"');
  });

  it("keeps a profile-declared node version", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "mise.toml"),
      '[tools]\nnode = "22"\n',
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--target", "mise", "--no-link"]);

    const mise = await readFile(configsPath(home, "personal", "mise", "config.toml"), "utf8");
    expect(mise).toContain('node = "22"');
    expect(mise).not.toContain('node = "24"');
  });

  it("verifies rendered OpenCode config shows mise", async () => {
    const result = await cli("mfz", root, home, ["apply", "--target", "all"]);
    expect(result.stdout).toContain("mise");
  });

  it("sync detects unmanaged mise tools and promotes them to base profile mise.toml", async () => {
    await cli("mfz", root, home, ["apply", "--target", "mise", "--no-link"]);

    const misePath = configsPath(home, "personal", "mise", "config.toml");
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

    const misePath = configsPath(home, "personal", "mise", "config.toml");
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
});
