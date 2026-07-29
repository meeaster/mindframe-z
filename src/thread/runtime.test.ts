import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir, testRuntimePaths } from "../../tests/integration/support.js";
import { migrateThreadRuntimeState } from "./runtime.js";

describe("thread runtime state migration", () => {
  it("moves predecessor state into the unified namespace", async () => {
    const home = await makeTempDir();
    const oldRuns = path.join(home, ".mindframe-z", "thread-runs", "runs", "run-1");
    const oldSweep = path.join(home, ".mindframe-z", "thread-sweep");
    await mkdir(oldRuns, { recursive: true });
    await mkdir(oldSweep, { recursive: true });
    await writeFile(path.join(oldRuns, "status.json"), "status\n");
    await writeFile(path.join(oldSweep, "ledger.json"), "ledger\n");

    const report = await migrateThreadRuntimeState(testRuntimePaths(home));
    expect(report.conflicts).toEqual([]);
    await expect(
      readFile(path.join(home, ".mindframe-z", "threads", "runs", "run-1", "status.json"), "utf8")
    ).resolves.toBe("status\n");
    await expect(
      readFile(path.join(home, ".mindframe-z", "threads", "sweep", "ledger.json"), "utf8")
    ).resolves.toBe("ledger\n");
    await expect(readFile(path.join(oldRuns, "status.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(access(path.join(home, ".mindframe-z", "thread-runs"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("removes identical predecessor files after the organized copy already exists", async () => {
    const home = await makeTempDir();
    const oldLog = path.join(home, ".mindframe-z", "thread-runs", "cli.log");
    const newLog = path.join(home, ".mindframe-z", "threads", "cli.log");
    await mkdir(path.dirname(oldLog), { recursive: true });
    await mkdir(path.dirname(newLog), { recursive: true });
    await writeFile(oldLog, "same\n");
    await writeFile(newLog, "same\n");

    const report = await migrateThreadRuntimeState(testRuntimePaths(home));

    expect(report.conflicts).toEqual([]);
    await expect(readFile(newLog, "utf8")).resolves.toBe("same\n");
    await expect(readFile(oldLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes an older log when the organized log contains it as a prefix", async () => {
    const home = await makeTempDir();
    const oldLog = path.join(home, ".mindframe-z", "thread-runs", "cli.log");
    const newLog = path.join(home, ".mindframe-z", "threads", "cli.log");
    await mkdir(path.dirname(oldLog), { recursive: true });
    await mkdir(path.dirname(newLog), { recursive: true });
    await writeFile(oldLog, "old\n");
    await writeFile(newLog, "old\nnew\n");

    const report = await migrateThreadRuntimeState(testRuntimePaths(home));

    expect(report.conflicts).toEqual([]);
    await expect(readFile(newLog, "utf8")).resolves.toBe("old\nnew\n");
    await expect(readFile(oldLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports conflicts instead of overwriting the organized state", async () => {
    const home = await makeTempDir();
    const oldLog = path.join(home, ".mindframe-z", "thread-runs", "cli.log");
    const newLog = path.join(home, ".mindframe-z", "threads", "cli.log");
    await mkdir(path.dirname(oldLog), { recursive: true });
    await mkdir(path.dirname(newLog), { recursive: true });
    await writeFile(oldLog, "old\n");
    await writeFile(newLog, "new\n");
    const report = await migrateThreadRuntimeState(testRuntimePaths(home));
    expect(report.conflicts).toEqual([{ source: oldLog, target: newLog }]);
    await expect(readFile(newLog, "utf8")).resolves.toBe("new\n");
  });
});
