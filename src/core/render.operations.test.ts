import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { removeRenderedFiles, writeLocalFiles, writeRenderedFiles } from "./render.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mfz-render-operations-"));
}

describe("rendered file outcomes", () => {
  it("distinguishes creation, content changes, permission changes, and unchanged files", async () => {
    const root = await tempDir();
    const file = path.join(root, "nested", "config.txt");

    await expect(
      writeRenderedFiles([{ path: file, content: "first\n", mode: 0o644 }])
    ).resolves.toMatchObject([{ status: "created", changes: ["path-type", "content"] }]);

    const oldTime = new Date("2000-01-01T00:00:00.000Z");
    await utimes(file, oldTime, oldTime);
    await expect(
      writeRenderedFiles([{ path: file, content: "first\n", mode: 0o644 }])
    ).resolves.toMatchObject([{ status: "unchanged" }]);
    expect((await stat(file)).mtime.toISOString()).toBe(oldTime.toISOString());

    await expect(
      writeRenderedFiles([{ path: file, content: "second\n", mode: 0o644 }])
    ).resolves.toMatchObject([{ status: "updated", changes: ["content"] }]);
    expect(await readFile(file, "utf8")).toBe("second\n");

    await chmod(file, 0o600);
    await expect(
      writeRenderedFiles([{ path: file, content: "second\n", mode: 0o640 }])
    ).resolves.toMatchObject([{ status: "updated", changes: ["permissions"] }]);
    expect((await stat(file)).mode & 0o777).toBe(0o640);
  });

  it("replaces a symlink as a managed file and reports the path-type change", async () => {
    const root = await tempDir();
    const source = path.join(root, "source.txt");
    const destination = path.join(root, "destination.txt");
    await writeFile(source, "source\n", "utf8");
    await symlink(source, destination);

    const [outcome] = await writeLocalFiles([{ path: destination, content: "managed\n" }]);

    expect(outcome).toMatchObject({ status: "updated", changes: ["path-type", "content"] });
    expect((await lstat(destination)).isFile()).toBe(true);
    expect(await readFile(destination, "utf8")).toBe("managed\n");
    expect(await readFile(source, "utf8")).toBe("source\n");
  });

  it("reports only a successful existing removal as removed", async () => {
    const root = await tempDir();
    const file = path.join(root, "stale.txt");

    await expect(removeRenderedFiles([file])).resolves.toMatchObject([
      { status: "unchanged", detail: "already absent" }
    ]);
    await writeFile(file, "stale\n", "utf8");
    await expect(removeRenderedFiles([file])).resolves.toMatchObject([{ status: "removed" }]);
  });
});
