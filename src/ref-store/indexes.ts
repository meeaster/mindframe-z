import type { RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import {
  collectOperations,
  type OperationCompletion,
  type OperationOutcome
} from "../core/operations.js";
import { planCapabilityIndexes, writeCapabilityIndexes } from "./capabilities.js";
import {
  planExtraFoldersIndex,
  planReferenceIndex,
  writeExtraFoldersIndex,
  writeReferenceIndex
} from "./references.js";

export interface LocalIndexOptions {
  dryRun?: boolean;
  onComplete?: OperationCompletion;
}

export async function reconcileLocalIndexes(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  options: LocalIndexOptions = {}
): Promise<OperationOutcome[]> {
  const operations = collectOperations(options.onComplete);
  if (options.dryRun) {
    await planReferenceIndex(paths, profile, operations.complete);
    await planExtraFoldersIndex(paths, profile, operations.complete);
    await planCapabilityIndexes(paths, profile, operations.complete);
    return operations.outcomes;
  }
  await writeReferenceIndex(paths, profile, operations.complete);
  await writeExtraFoldersIndex(paths, profile, operations.complete);
  await writeCapabilityIndexes(paths, profile, operations.complete);
  return operations.outcomes;
}
