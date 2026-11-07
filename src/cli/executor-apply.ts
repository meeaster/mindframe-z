import type { OperationOutcome } from "../core/operations.js";
import type { RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import { desiredSetHash, executorServers, planApps, type AppPlanItem } from "../executor/apps.js";
import { createApp, deployApp, existingApps, frameworkVersion } from "../executor/runner.js";
import { recordExecutorApps } from "../executor/state.js";
import { commandIsInteractive, createOperationReporter } from "./operation-report.js";

type ItemOutcome = Pick<OperationOutcome, "status" | "detail"> &
  Partial<Pick<OperationOutcome, "plannedEffect">>;

async function applyItem(item: AppPlanItem, dryRun: boolean): Promise<ItemOutcome> {
  switch (item.action) {
    case "create":
      if (dryRun) return { status: "planned", plannedEffect: "add", detail: item.server.url };
      await createApp(item.server.name, item.files);

      return { status: "created", detail: item.server.url };
    case "update":
      if (dryRun) return { status: "planned", plannedEffect: "update", detail: item.server.url };
      await deployApp(item.app.id, item.files);

      return { status: "updated", detail: item.server.url };
    case "unchanged":
      return { status: "unchanged", detail: item.server.url };
    case "conflict":
      return {
        status: "blocked",
        detail: `app ${item.app.slug} (${item.app.name}) is not managed by mfz; remove or rename it in Executor, then rerun`
      };
    case "orphan":
      return {
        status: "skipped",
        detail: `app ${item.app.slug} is managed by mfz but no profile server sets executor: true; remove it in the Executor dashboard`
      };
  }
}

export async function runExecutorApply(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  options: { dryRun?: boolean | undefined; verbose?: boolean | undefined }
): Promise<boolean> {
  const dryRun = options.dryRun ?? false;
  const servers = executorServers(profile);

  const reporter = createOperationReporter({
    command: "mfz executor apply",
    scope:
      servers.length === 0
        ? `${profile.name} · no MCP server sets executor: true`
        : `${profile.name} · ${servers.length} server${servers.length === 1 ? "" : "s"}`,
    verbose: options.verbose ?? false,
    dryRun,
    interactive: commandIsInteractive()
  });

  try {
    const plan = planApps(servers, await frameworkVersion(), await existingApps());
    let settled = true;

    for (const item of plan) {
      const target = item.action === "orphan" ? item.server : item.server.name;
      reporter.start({ category: "executor", action: "reconcile", target });

      let outcome: ItemOutcome;

      // One server's failed build or deploy must not stop the others.
      try {
        outcome = await applyItem(item, dryRun);
      } catch (error) {
        outcome = {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error)
        };
      }

      if (outcome.status === "blocked" || outcome.status === "failed") settled = false;

      reporter.complete({
        category: "executor",
        action: "reconcile",
        target,
        significance: "meaningful",
        ...outcome
      });
    }

    // Only a run that reached every declared server clears apply's drift notice.
    if (!dryRun && settled) {
      await recordExecutorApps(paths, desiredSetHash(servers), reporter.complete.bind(reporter));
    }

    return reporter.finish();
  } catch (error) {
    reporter.fail(error instanceof Error ? error : new Error(String(error)));

    return false;
  }
}
