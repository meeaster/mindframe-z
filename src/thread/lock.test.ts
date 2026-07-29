import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir, testRuntimePaths } from "../../tests/integration/support.js";
import { threadLockPath, withThreadLock } from "./lock.js";

describe("thread locks", () => {
  it("runs the callback and removes an uncontended lock", async () => {
    const home = await makeTempDir();
    const paths = testRuntimePaths(home);

    await expect(
      withThreadLock(paths, "thread-a", "thread refresh thread-a", async () => "result")
    ).resolves.toBe("result");
    await expect(access(threadLockPath(paths, "thread-a"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("allows different threads to hold locks concurrently", async () => {
    const home = await makeTempDir();
    const paths = testRuntimePaths(home);
    let active = 0;
    let maximumActive = 0;

    await Promise.all(
      ["thread-a", "thread-b"].map((slug) =>
        withThreadLock(paths, slug, `thread refresh ${slug}`, async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
        })
      )
    );

    expect(maximumActive).toBe(2);
  });

  it("reports a live lock holder without replacing it", async () => {
    const home = await makeTempDir();
    const paths = testRuntimePaths(home);
    const lockFile = threadLockPath(paths, "thread-a");
    await mkdir(path.dirname(lockFile), { recursive: true });
    await writeFile(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        command: "thread refresh thread-a",
        started_at: "2026-07-29T00:00:00.000Z"
      })
    );
    const before = await readFile(lockFile, "utf8");

    await expect(withThreadLock(paths, "thread-a", "retry", async () => undefined)).rejects.toThrow(
      `pid ${process.pid}`
    );
    await expect(readFile(lockFile, "utf8")).resolves.toBe(before);
  });

  it("reclaims a stale lock", async () => {
    const home = await makeTempDir();
    const paths = testRuntimePaths(home);
    const lockFile = threadLockPath(paths, "thread-a");
    await mkdir(path.dirname(lockFile), { recursive: true });
    await writeFile(
      lockFile,
      JSON.stringify({
        pid: 999_999_999,
        command: "crashed refresh",
        started_at: "2026-07-29T00:00:00.000Z"
      })
    );

    await expect(
      withThreadLock(paths, "thread-a", "thread refresh thread-a", async () => "reclaimed")
    ).resolves.toBe("reclaimed");
  });

  it("releases the lock when the callback throws", async () => {
    const home = await makeTempDir();
    const paths = testRuntimePaths(home);

    await expect(
      withThreadLock(paths, "thread-a", "thread refresh thread-a", async () => {
        throw new Error("dispatch failed");
      })
    ).rejects.toThrow("dispatch failed");
    await expect(access(threadLockPath(paths, "thread-a"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});
