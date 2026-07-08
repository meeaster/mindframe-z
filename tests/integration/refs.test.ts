import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, configsPath, setupIntegrationFixture } from "./support.js";

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

    const refsAbs = path.join(home, ".mindframe-z", "references");

    const opencode = await readFile(
      configsPath(home, "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );
    expect(opencode).toContain(`${refsAbs}/**`);

    const settings = JSON.parse(
      await readFile(configsPath(home, "personal", "claude", "settings.json"), "utf8")
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
      configsPath(home, "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );
    expect(opencode).not.toContain("extra_folders.md");

    const claudeMd = await readFile(
      configsPath(home, "personal", "claude", "CLAUDE.md"),
      "utf8"
    );
    expect(claudeMd).not.toContain("extra_folders.md");
  });

  it("writes an extra folders index from machine config", async () => {
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      [
        "profile: personal",
        "references_dir: ~/.mindframe-z/references",
        "extra_folders:",
        "  - path: ~/code/work",
        "    description: Work code",
        "  - path: ~/code/restricted",
        "    read: deny",
        "    edit: deny",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--no-link"]);

    const index = await readFile(path.join(home, ".mindframe-z", "extra_folders.md"), "utf8");
    expect(index).toContain("# Extra Folders");
    expect(index).toContain(
      `- \`${path.join(home, "code", "work")}\` - Work code (read: allow, edit: allow)`
    );
    expect(index).toContain(
      `- \`${path.join(home, "code", "restricted")}\` (read: deny, edit: deny)`
    );

    const opencode = await readFile(
      configsPath(home, "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );
    expect(opencode).toContain("extra_folders.md");

    const claudeMd = await readFile(
      configsPath(home, "personal", "claude", "CLAUDE.md"),
      "utf8"
    );
    expect(claudeMd).toContain("extra_folders.md");
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
    expect(result.stdout).not.toContain(`${home}/.mindframe-z/references/local-ref`);
  });
});
