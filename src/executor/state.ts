import { z } from "zod";
import { readJsonObject } from "../core/fs-util.js";
import { writeJsonAtomicOutcome } from "../core/file-operations.js";
import type { OperationCompletion } from "../core/operations.js";
import { executorAppsStatePath, type RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import { desiredSetHash, executorServers } from "./apps.js";

const stateSchema = z.object({ desired: z.string() });

export async function recordExecutorApps(
  paths: RuntimePaths,
  desired: string,
  onComplete: OperationCompletion
): Promise<void> {
  await writeJsonAtomicOutcome(
    executorAppsStatePath(paths),
    { desired },
    { category: "bookkeeping", significance: "internal", onComplete }
  );
}

// Apply stays offline: it compares the profile's Executor apps with the last applied set.
export async function executorAppsDrifted(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<boolean> {
  const servers = executorServers(profile);
  const recorded = stateSchema.safeParse(await readJsonObject(executorAppsStatePath(paths))).data;

  if (recorded === undefined) return servers.length > 0;

  return recorded.desired !== desiredSetHash(servers);
}
