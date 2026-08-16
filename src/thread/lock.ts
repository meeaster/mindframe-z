import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { readTextFile } from "../core/fs-util.js";
import { threadLocksRoot, type RuntimePaths } from "../core/paths.js";
import { lockRecordSchema } from "./schema.js";

interface LockRecord {
  pid: number;
  command: string;
  started_at: string;
}

function lockPath(paths: RuntimePaths, key: string): string {
  const safeKey = Buffer.from(key).toString("base64url");
  return path.join(threadLocksRoot(paths), `${safeKey}.lock`);
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function errnoCode(error: Error & { code?: string }): string | undefined {
  return error.code;
}

async function readLock(lockFile: string): Promise<LockRecord | undefined> {
  const content = await readTextFile(lockFile);
  if (content === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`lock file is unreadable: ${lockFile}`, { cause: error });
  }
  try {
    return lockRecordSchema.parse(parsed);
  } catch (error) {
    throw new Error(`lock file has invalid metadata: ${lockFile}`, { cause: error });
  }
}

async function acquire(lockFile: string, command: string): Promise<void> {
  await mkdir(path.dirname(lockFile), { recursive: true });
  const record: LockRecord = {
    pid: process.pid,
    command,
    started_at: new Date().toISOString()
  };

  try {
    await writeFile(lockFile, JSON.stringify(record) + "\n", { flag: "wx" });
    return;
  } catch (error) {
    if (!(error instanceof Error) || errnoCode(error) !== "EEXIST") throw error;
  }

  const holder = await readLock(lockFile);
  if (holder !== undefined && (await processIsAlive(holder.pid))) {
    throw new Error(
      `another mfz thread command is running (pid ${holder.pid}, ${holder.command}, since ${holder.started_at}); retry when it finishes`
    );
  }

  // A dead holder, or a lock that vanished between the failed create and the read,
  // is stale. Reclaim it once, then retry atomically. A lock file that is present
  // but corrupt is not reclaimed; readLock already surfaced it.
  try {
    await unlink(lockFile);
  } catch (error) {
    if (!(error instanceof Error) || errnoCode(error) !== "ENOENT") throw error;
  }
  try {
    await writeFile(lockFile, JSON.stringify(record) + "\n", { flag: "wx" });
  } catch (error) {
    if (error instanceof Error && errnoCode(error) === "EEXIST") {
      throw new Error(
        "another mfz thread command acquired the lock while a stale lock was reclaimed"
      );
    }
    throw error;
  }
}

export async function withAdvisoryLock<T>(
  lockFile: string,
  command: string,
  fn: () => Promise<T>
): Promise<T> {
  await acquire(lockFile, command);
  try {
    return await fn();
  } finally {
    await unlink(lockFile).catch((error) => {
      if (!(error instanceof Error) || errnoCode(error) !== "ENOENT") throw error;
    });
  }
}

export function threadLockPath(paths: RuntimePaths, slug: string): string {
  return lockPath(paths, `thread:${slug}`);
}

export function withThreadLock<T>(
  paths: RuntimePaths,
  slug: string,
  command: string,
  fn: () => Promise<T>
): Promise<T> {
  return withAdvisoryLock(threadLockPath(paths, slug), command, fn);
}
