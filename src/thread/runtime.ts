import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { mindframeZDir, threadRuntimeRoot, type RuntimePaths } from "../core/paths.js";

export interface RuntimeMigrationConflict {
  source: string;
  target: string;
}

export interface RuntimeMigrationReport {
  moved: string[];
  conflicts: RuntimeMigrationConflict[];
}

/** Move predecessor runtime state into the organized namespace. */
export async function migrateThreadRuntimeState(
  paths: RuntimePaths
): Promise<RuntimeMigrationReport> {
  const root = threadRuntimeRoot(paths);
  const oldRoot = mindframeZDir(paths.home);
  const mappings: Array<[string, string]> = [
    [path.join(oldRoot, "thread-runs", "runs"), path.join(root, "runs")],
    [path.join(oldRoot, "thread-runs", "locks"), path.join(root, "locks")],
    [path.join(oldRoot, "thread-runs", "cli.log"), path.join(root, "cli.log")],
    [path.join(oldRoot, "thread-sweep"), path.join(root, "sweep")]
  ];
  const report: RuntimeMigrationReport = { moved: [], conflicts: [] };
  for (const [source, target] of mappings) {
    if (!(await exists(source))) continue;
    await moveRuntimeEntry(source, target, report);
  }
  await removeEmptyDirectory(path.join(oldRoot, "thread-runs"));
  await removeEmptyDirectory(path.join(oldRoot, "thread-sweep"));
  return report;
}

async function moveRuntimeEntry(
  source: string,
  target: string,
  report: RuntimeMigrationReport
): Promise<void> {
  const sourceInfo = await lstat(source);
  if (sourceInfo.isDirectory()) {
    if (!(await exists(target))) {
      await mkdir(path.dirname(target), { recursive: true });
      await rename(source, target);
      report.moved.push(target);
      return;
    }
    const targetInfo = await lstat(target);
    if (!targetInfo.isDirectory()) {
      report.conflicts.push({ source, target });
      return;
    }
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      await moveRuntimeEntry(path.join(source, entry.name), path.join(target, entry.name), report);
    }
    if ((await readdir(source)).length === 0) await rm(source, { recursive: true, force: true });
    return;
  }
  if (await exists(target)) {
    const targetInfo = await lstat(target);
    if (sourceInfo.isFile() && targetInfo.isFile()) {
      const [sourceContent, targetContent] = await Promise.all([
        readFile(source),
        readFile(target)
      ]);
      if (sourceContent.equals(targetContent)) {
        await rm(source);
        return;
      }
      if (path.basename(source) === "cli.log") {
        if (targetContent.subarray(0, sourceContent.length).equals(sourceContent)) {
          await rm(source);
          return;
        }
        if (sourceContent.subarray(0, targetContent.length).equals(targetContent)) {
          await writeFile(target, sourceContent);
          await rm(source);
          return;
        }
      }
    }
    report.conflicts.push({ source, target });
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await rename(source, target);
  report.moved.push(target);
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  if (!(await exists(directory))) return;
  if ((await readdir(directory)).length === 0)
    await rm(directory, { recursive: true, force: true });
}
