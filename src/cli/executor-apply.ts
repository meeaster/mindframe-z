import type { OperationOutcome } from "../core/operations.js";
import type { RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import {
  desiredApps,
  desiredSetHash,
  frameworkMismatch,
  planApps,
  type AppPlanItem,
  type DesiredApp
} from "../executor/apps.js";
import { createApp, deployApp, existingApps, frameworkVersion } from "../executor/runner.js";
import { recordExecutorApps } from "../executor/state.js";
import { commandIsInteractive, createOperationReporter } from "./operation-report.js";

type ItemOutcome = Pick<OperationOutcome, "status" | "detail"> &
  Partial<Pick<OperationOutcome, "plannedEffect">>;

// Where an app comes from: the server it routes, or its hand-written folder.
function origin(desired: DesiredApp): string {
  return desired.kind === "server" ? desired.url : desired.directory;
}

async function applyItem(item: AppPlanItem, dryRun: boolean): Promise<ItemOutcome> {
  switch (item.action) {
    case "create":
      if (dryRun) return { status: "planned", plannedEffect: "add", detail: origin(item.desired) };
      await createApp(item.desired.name, item.files);

      return { status: "created", detail: origin(item.desired) };
    case "update":
      if (dryRun) {
        return { status: "planned", plannedEffect: "update", detail: origin(item.desired) };
      }

      await deployApp(item.existing.id, item.files);

      return { status: "updated", detail: origin(item.desired) };
    case "unchanged":
      return { status: "unchanged", detail: origin(item.desired) };
    case "conflict":
      return {
        status: "blocked",
        detail: `app ${item.existing.slug} (${item.existing.name}) is not managed by mfz; remove or rename it in Executor, then rerun`
      };
    case "orphan":
      return {
        status: "skipped",
        detail: `app ${item.existing.slug} is managed by mfz but the profile no longer declares it; remove it in the Executor dashboard`
      };
  }
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function scopeLabel(profile: string, apps: readonly DesiredApp[]): string {
  const servers = apps.filter((app) => app.kind === "server").length;
  const written = apps.length - servers;

  if (apps.length === 0) {
    return `${profile} · no MCP server sets executor: true and no executor.apps`;
  }

  const parts = [
    ...(servers > 0 ? [countLabel(servers, "server")] : []),
    ...(written > 0 ? [countLabel(written, "app")] : [])
  ];

  return `${profile} · ${parts.join(", ")}`;
}

export async function runExecutorApply(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  options: { dryRun?: boolean | undefined; verbose?: boolean | undefined }
): Promise<boolean> {
  const dryRun = options.dryRun ?? false;
  const apps = desiredApps(profile);

  const reporter = createOperationReporter({
    command: "mfz executor apply",
    scope: scopeLabel(profile.name, apps),
    verbose: options.verbose ?? false,
    dryRun,
    interactive: commandIsInteractive()
  });

  try {
    const framework = await frameworkVersion();
    const plan = planApps(apps, framework, await existingApps());
    let settled = true;

    for (const item of plan) {
      const target = item.action === "orphan" ? item.name : item.desired.name;
      reporter.start({ category: "executor", action: "reconcile", target });

      let outcome: ItemOutcome;

      // One app's failed build or deploy must not stop the others.
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

      // A hand-written app owns its framework version; a stale one only deserves a mention.
      const declared =
        item.action === "orphan" || item.action === "conflict"
          ? undefined
          : frameworkMismatch(item.desired, framework);

      if (declared !== undefined) {
        reporter.complete({
          category: "executor",
          action: "reconcile",
          target,
          significance: "meaningful",
          status: "skipped",
          detail: `package.json declares apps ${declared}, but Executor's framework is ${framework}; it deploys as written`
        });
      }
    }

    // Only a run that reached every declared app clears apply's drift notice.
    if (!dryRun && settled) {
      await recordExecutorApps(paths, desiredSetHash(apps), reporter.complete.bind(reporter));
    }

    return reporter.finish();
  } catch (error) {
    reporter.fail(error instanceof Error ? error : new Error(String(error)));

    return false;
  }
}
