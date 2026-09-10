import { mkdtemp, readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLink, replaceWithBackup } from "./symlinks.js";

describe("symlink outcomes", () => {
  it("reports a created link and an actual destination change", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-symlink-outcomes-"));
    const linkPath = path.join(root, "config", "active");
    const firstTarget = path.join(root, "first");
    const secondTarget = path.join(root, "second");

    await expect(createLink({ linkPath, targetPath: firstTarget })).resolves.toMatchObject({
      status: "linked",
      detail: firstTarget
    });
    await expect(
      replaceWithBackup(
        { linkPath, targetPath: secondTarget },
        path.join(root, "active.backup"),
        undefined,
        firstTarget
      )
    ).resolves.toMatchObject({
      status: "relinked",
      detail: `${firstTarget} -> ${secondTarget}`
    });
    expect(await readlink(linkPath)).toBe(secondTarget);
  });
});
