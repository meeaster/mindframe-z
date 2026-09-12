import { chmod, lstat, readFile, rm, unlink } from "node:fs/promises";
import { jsonFileContent, writeJsonFileAtomic, writeTextFile } from "./fs-util.js";
import type {
  OperationCategory,
  OperationChange,
  OperationCompletion,
  OperationOutcome
} from "./operations.js";

export interface WriteFileOptions {
  category?: OperationCategory;
  mode?: number;
  significance?: OperationOutcome["significance"];
  onComplete?: OperationCompletion;
}

interface ExistingFile {
  kind: "missing" | "file" | "symlink" | "other";
  content?: Buffer;
  mode?: number;
}

async function inspectFile(file: string): Promise<ExistingFile> {
  try {
    const info = await lstat(file);

    if (info.isSymbolicLink()) return { kind: "symlink" };

    if (!info.isFile()) return { kind: "other" };

    return { kind: "file", content: await readFile(file), mode: info.mode & 0o777 };
  } catch (error) {
    // SAFETY: Node filesystem failures expose their stable errno code on thrown errors.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}

export async function writeFileOutcome(
  file: string,
  content: string,
  options: WriteFileOptions = {}
): Promise<OperationOutcome> {
  const existing = await inspectFile(file);
  const intended = Buffer.from(content);
  const changes: OperationChange[] = [];

  if (existing.kind !== "file") changes.push("path-type");

  if (existing.kind !== "file" || !existing.content?.equals(intended)) changes.push("content");

  if (
    existing.kind === "file" &&
    options.mode !== undefined &&
    existing.mode !== (options.mode & 0o777)
  ) {
    changes.push("permissions");
  }

  const base = {
    category: options.category ?? "file",
    action: "write" as const,
    target: file,
    significance: options.significance ?? "meaningful"
  };

  if (changes.length === 0) {
    const outcome = { ...base, status: "unchanged" as const };
    options.onComplete?.(outcome);

    return outcome;
  }

  if (existing.kind === "symlink") await unlink(file);
  await writeTextFile(file, content);

  if (options.mode !== undefined) await chmod(file, options.mode);

  const outcome = {
    ...base,
    status: existing.kind === "missing" ? ("created" as const) : ("updated" as const),
    changes
  };

  options.onComplete?.(outcome);

  return outcome;
}

export async function planFileOutcome(
  file: string,
  content: string,
  options: WriteFileOptions = {}
): Promise<OperationOutcome> {
  const existing = await inspectFile(file);
  const intended = Buffer.from(content);
  const changes: OperationChange[] = [];

  if (existing.kind !== "file") changes.push("path-type");

  if (existing.kind !== "file" || !existing.content?.equals(intended)) changes.push("content");

  if (
    existing.kind === "file" &&
    options.mode !== undefined &&
    existing.mode !== (options.mode & 0o777)
  ) {
    changes.push("permissions");
  }

  const outcome: OperationOutcome = {
    category: options.category ?? "file",
    action: "write",
    status: changes.length === 0 ? "unchanged" : "planned",
    target: file,
    significance: options.significance ?? "meaningful",
    changes
  };

  options.onComplete?.(outcome);

  return outcome;
}

export async function removePathOutcome(
  target: string,
  options: Pick<WriteFileOptions, "category" | "significance" | "onComplete"> = {}
): Promise<OperationOutcome> {
  const existing = await inspectFile(target);

  const base = {
    category: options.category ?? "file",
    action: "remove" as const,
    target,
    significance: options.significance ?? "meaningful"
  };

  if (existing.kind === "missing") {
    const outcome = { ...base, status: "unchanged" as const, detail: "already absent" };
    options.onComplete?.(outcome);

    return outcome;
  }

  await rm(target, { force: true, recursive: true });
  const outcome = { ...base, status: "removed" as const };
  options.onComplete?.(outcome);

  return outcome;
}

export async function planRemovePathOutcome(
  target: string,
  options: Pick<WriteFileOptions, "category" | "significance" | "onComplete"> = {}
): Promise<OperationOutcome> {
  const existing = await inspectFile(target);

  const outcome: OperationOutcome = {
    category: options.category ?? "file",
    action: "remove",
    status: existing.kind === "missing" ? "unchanged" : "planned",
    target,
    significance: options.significance ?? "meaningful"
  };

  if (existing.kind === "missing") outcome.detail = "already absent";
  options.onComplete?.(outcome);

  return outcome;
}

export async function writeJsonAtomicOutcome<T>(
  file: string,
  value: T,
  options: Pick<WriteFileOptions, "category" | "significance" | "onComplete"> = {}
): Promise<OperationOutcome> {
  const existing = await inspectFile(file);
  const content = Buffer.from(jsonFileContent(value));
  const unchanged = existing.kind === "file" && existing.content?.equals(content);

  const base = {
    category: options.category ?? "file",
    action: "write" as const,
    target: file,
    significance: options.significance ?? "meaningful"
  };

  if (unchanged) {
    const outcome = { ...base, status: "unchanged" as const };
    options.onComplete?.(outcome);

    return outcome;
  }

  if (existing.kind === "symlink") await unlink(file);
  await writeJsonFileAtomic(file, value);

  const outcome: OperationOutcome = {
    ...base,
    status: existing.kind === "missing" ? "created" : "updated",
    changes: existing.kind === "file" ? ["content"] : ["path-type", "content"]
  };

  options.onComplete?.(outcome);

  return outcome;
}
