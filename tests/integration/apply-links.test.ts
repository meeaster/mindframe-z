import { lstat, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, configsPath, setupIntegrationFixture } from "./support.js";

// `mfz apply` is the only code path that renames a real file out of the user's
// home directory. These tests pin when it is allowed to do that.
describe("apply link conflicts", () => {
  let root: string;
  let home: string;

  const managedNpmrc = () => configsPath(home, "personal", "dotfiles", ".npmrc");
  const userNpmrc = () => path.join(home, ".npmrc");

  async function backupsOf(filename: string): Promise<string[]> {
    const entries = await readdir(home);
    return entries.filter((entry) => entry.startsWith(`${filename}.mindframe-z.bak-`));
  }

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());
  });

  afterEach(() => {
    root = "";
    home = "";
  });

  it("leaves an unmanaged user dotfile untouched when replacement is not confirmed", async () => {
    await writeFile(userNpmrc(), "registry=https://user.example\n", "utf8");

    const result = await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);

    expect(result.stdout).toContain(`skipped\t${userNpmrc()}`);
    expect(await readFile(userNpmrc(), "utf8")).toBe("registry=https://user.example\n");
    expect((await lstat(userNpmrc())).isSymbolicLink()).toBe(false);
    expect(await backupsOf(".npmrc")).toEqual([]);
  });

  it("backs the user dotfile up before linking when replacement is confirmed", async () => {
    await writeFile(userNpmrc(), "registry=https://user.example\n", "utf8");

    const result = await cli("mfz", root, home, ["apply", "--target", "dotfiles"], {
      MFZ_REPLACE_EXISTING: "y"
    });

    expect(result.stdout).toContain("backed up\t");
    await expect(realpath(userNpmrc())).resolves.toBe(managedNpmrc());

    const backups = await backupsOf(".npmrc");
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(home, backups[0]!), "utf8")).toBe(
      "registry=https://user.example\n"
    );
  });

  it("relinks a stale managed symlink without asking", async () => {
    await symlink(configsPath(home, "personal", "dotfiles", ".npmrc-legacy"), userNpmrc());

    const result = await cli("mfz", root, home, ["apply", "--target", "dotfiles"]);

    expect(result.stdout).toContain("backed up\t");
    await expect(realpath(userNpmrc())).resolves.toBe(managedNpmrc());
    expect(await backupsOf(".npmrc")).toHaveLength(1);
  });

  it("reports a pending replacement without touching the user dotfile in dry-run", async () => {
    await writeFile(userNpmrc(), "registry=https://user.example\n", "utf8");

    const result = await cli("mfz", root, home, ["apply", "--target", "dotfiles", "--dry-run"], {
      MFZ_REPLACE_EXISTING: "y"
    });

    expect(result.stdout).toContain(`would replace after backup\t${userNpmrc()}`);
    expect(await readFile(userNpmrc(), "utf8")).toBe("registry=https://user.example\n");
    expect(await backupsOf(".npmrc")).toEqual([]);
  });
});
