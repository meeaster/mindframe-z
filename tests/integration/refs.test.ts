import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, setupIntegrationFixture } from "./support.js";

describe("refs integration", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());
  });

  afterEach(() => {
    root = "";
    home = "";
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
});
