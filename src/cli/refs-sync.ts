import type { RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import { reconcileLocalIndexes } from "../ref-store/indexes.js";
import {
  throwIfReferenceSyncCancelled,
  withReferenceResourceLock
} from "../ref-store/reference-lock.js";
import { syncReferenceLocked, syncReferencesLocked } from "../ref-store/references.js";
import { commandIsInteractive, createOperationReporter } from "./operation-report.js";

export async function runReferenceSync(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  options: { name?: string | undefined; verbose?: boolean | undefined }
): Promise<boolean> {
  const reporter = createOperationReporter({
    command: "mfz refs sync",
    scope: `${profile.name} · ${options.name ?? "all"}`,
    verbose: options.verbose ?? false,
    interactive: commandIsInteractive()
  });

  try {
    await withReferenceResourceLock(paths, profile.referencesDir, async (signal, scope) => {
      const lifecycle = {
        onStart: reporter.start.bind(reporter),
        onComplete: reporter.complete.bind(reporter),
        onLifecycle: reporter.lifecycle.bind(reporter),
        signal
      };

      if (options.name) await syncReferenceLocked(paths, profile, options.name, lifecycle, scope);
      else await syncReferencesLocked(paths, profile, lifecycle, scope);
      throwIfReferenceSyncCancelled(signal);
      reporter.start({
        category: "index",
        action: "write",
        target: profile.name,
        detail: "local indexes"
      });
      await reconcileLocalIndexes(paths, profile, { onComplete: lifecycle.onComplete });
    });

    return reporter.finish();
  } catch (error) {
    reporter.fail(error instanceof Error ? error : new Error(String(error)));

    return false;
  }
}
