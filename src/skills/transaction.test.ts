import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitVendoredPromotion } from "./transaction.js";

describe("vendored promotion transactions", () => {
  it("restores every prior file when a later replacement fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-transaction-test-"));
    const skills = path.join(root, "skills");
    await mkdir(skills, { recursive: true });
    const source = path.join(skills, "source");
    const lock = path.join(skills, "vendor.lock.yml");
    const sourceTemp = path.join(skills, "source.tmp");
    const lockTemp = path.join(skills, "missing-lock.tmp");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "old\n", "utf8");
    await writeFile(lock, "old-lock\n", "utf8");
    await mkdir(path.dirname(sourceTemp), { recursive: true });
    await mkdir(sourceTemp, { recursive: true });
    await writeFile(path.join(sourceTemp, "SKILL.md"), "new\n", "utf8");

    await expect(
      commitVendoredPromotion(root, [
        {
          destination: source,
          temporary: sourceTemp,
          backup: `${source}.bak`,
          recursive: true
        },
        {
          destination: lock,
          temporary: lockTemp,
          backup: `${lock}.bak`,
          recursive: false
        }
      ])
    ).rejects.toThrow();

    await expect(readFile(path.join(source, "SKILL.md"), "utf8")).resolves.toBe("old\n");
    await expect(readFile(lock, "utf8")).resolves.toBe("old-lock\n");
  });
});
