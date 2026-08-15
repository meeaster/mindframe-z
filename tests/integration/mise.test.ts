import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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

    const ownership = JSON.parse(
      await readFile(path.join(home, ".mindframe-z", "configs", "personal", ".mfz-owned.json"), "utf8")
    ) as { targets: Record<string, unknown> };
    expect(ownership.targets).toHaveProperty("mise");
    await expect(access(path.join(home, ".config", "mise", ".mfz-owned.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const mise = await readFile(configsPath(home, "personal", "mise", "10-base.toml"), "utf8");
    expect(mise).toContain('jq = "latest"');
    expect(mise).toContain('node = "24"');
    expect(mise).toContain("[settings]");
    expect(mise).toContain('minimum_release_age = "3d"');
    await expect(access(path.join(home, ".config", "mise", "conf.d", "10-base.toml"))).resolves.toBeUndefined();
    await expect(access(path.join(home, ".config", "mise", "10-base.toml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps each layer as an exact native fragment", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "mise.toml"),
      '[tools]\nnode = "22"\n\n[hooks]\npostinstall = { task = "twg-update" }\n',
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--target", "mise"]);

    const mise = await readFile(configsPath(home, "personal", "mise", "20-personal.toml"), "utf8");
    expect(mise).toBe('[tools]\nnode = "22"\n\n[hooks]\npostinstall = { task = "twg-update" }\n');
    expect(
      await readFile(path.join(home, ".config", "mise", "conf.d", "20-personal.toml"), "utf8")
    ).toBe(mise);
  });

  it("renders inherited native mise fragments without merging them", async () => {
    await writeFile(
      path.join(root, "profiles", "base", "mise.toml"),
      '[bootstrap.hooks]\npre-packages = "prepare-base"\n\n[bootstrap.packages]\n"apt:curl" = "latest"\n',
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "personal", "mise.toml"),
      '[bootstrap.packages]\n"apt:jq" = "latest"\n',
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--target", "mise", "--no-link"]);

    const base = await readFile(configsPath(home, "personal", "mise", "10-base.toml"), "utf8");
    const personal = await readFile(configsPath(home, "personal", "mise", "20-personal.toml"), "utf8");
    expect(base).toBe('[bootstrap.hooks]\npre-packages = "prepare-base"\n\n[bootstrap.packages]\n"apt:curl" = "latest"\n');
    expect(personal).toBe('[bootstrap.packages]\n"apt:jq" = "latest"\n');
  });

  it("verifies rendered OpenCode config shows mise", async () => {
    const result = await cli("mfz", root, home, ["apply", "--target", "all"]);
    expect(result.stdout).toContain("mise");
  });

  it("renders profile tasks in a native namespace", async () => {
    const task = path.join(root, "profiles", "personal", ".config", "mise", "tasks", "check.toml");
    await mkdir(path.dirname(task), { recursive: true });
    await writeFile(task, '[check]\ndescription = "Check the tree"\nrun = "true"\n', "utf8");
    await cli("mfz", root, home, ["apply", "--target", "mise"]);
    expect(await readFile(configsPath(home, "personal", "mise", "tasks", "personal", "check.toml"), "utf8")).toContain("Check the tree");
    expect(await readFile(path.join(home, ".config", "mise", "tasks", "personal", "check.toml"), "utf8")).toContain("run = \"true\"");
  });

  it("does not promote Mise edits through sync", async () => {
    await cli("mfz", root, home, ["apply", "--target", "mise", "--no-link"]);
    const result = await cli("mfz", root, home, ["sync"]);
    expect(result.stdout).toContain("No unmanaged keys found");
  });
});
