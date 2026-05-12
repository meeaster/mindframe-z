import { lstat, mkdir, readlink, symlink } from "node:fs/promises";
import path from "node:path";

export interface LinkPlan {
  linkPath: string;
  targetPath: string;
}

export interface LinkStatus extends LinkPlan {
  state: "missing" | "ok" | "conflict";
  detail: string;
}

export async function verifyLink(plan: LinkPlan): Promise<LinkStatus> {
  try {
    const stat = await lstat(plan.linkPath);
    if (!stat.isSymbolicLink()) {
      return { ...plan, state: "conflict", detail: "path exists and is not a symlink" };
    }
    const current = await readlink(plan.linkPath);
    const resolved = path.resolve(path.dirname(plan.linkPath), current);
    if (resolved === path.resolve(plan.targetPath)) {
      return { ...plan, state: "ok", detail: "already linked" };
    }
    return { ...plan, state: "conflict", detail: `symlink points to ${resolved}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...plan, state: "missing", detail: "missing" };
    }
    throw error;
  }
}

export async function ensureLink(plan: LinkPlan, dryRun = false): Promise<LinkStatus> {
  const status = await verifyLink(plan);
  if (status.state === "conflict")
    throw new Error(`Refusing to overwrite ${plan.linkPath}: ${status.detail}`);
  if (status.state === "missing" && !dryRun) {
    await mkdir(path.dirname(plan.linkPath), { recursive: true });
    await symlink(plan.targetPath, plan.linkPath);
  }
  return status;
}
