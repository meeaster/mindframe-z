import { lstat, readlink } from "node:fs/promises";
import path from "node:path";

function errorCode(error: Error): string | undefined {
  // SAFETY: Node filesystem failures expose their stable errno code on Error objects.
  return (error as NodeJS.ErrnoException).code;
}

export function isManagedTarget(configsDir: string, target: string): boolean {
  const relative = path.relative(configsDir, target);

  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export type LinkStatus =
  | { state: "missing" }
  | { state: "directory" | "file" }
  | { state: "symlink"; target: string; resolved: string };

export async function linkStatus(linkPath: string): Promise<LinkStatus> {
  try {
    const stat = await lstat(linkPath);

    if (!stat.isSymbolicLink()) return { state: stat.isDirectory() ? "directory" : "file" };
    const target = await readlink(linkPath);

    return { state: "symlink", target, resolved: path.resolve(path.dirname(linkPath), target) };
  } catch (error) {
    if (error instanceof Error && errorCode(error) === "ENOENT") return { state: "missing" };
    throw error;
  }
}
