import { confirm, isCancel } from "@clack/prompts";
import path from "node:path";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { hasManagedExecutorState, reconcileExecutor } from "../executor/index.js";
import {
  agentList,
  createRuntimePaths,
  infraTargetList,
  type ApplyAgent,
  type InfraTarget
} from "../core/paths.js";
import { requiresExecutorReconciliation, resolveProfile } from "../core/profile.js";
import { renderAllPayloads } from "../core/override-store.js";
import {
  removeRenderedFiles,
  renderTarget,
  writeLocalFiles,
  writeRenderedFiles,
  type RenderResult
} from "../core/render.js";
import {
  ensureGitConfigInclude,
  planGitConfigInclude,
  planGitIdentityFragment,
  writeGitIdentityFragment
} from "../core/git-config.js";
import { backupPathFor, createLink, replaceWithBackup, verifyLink } from "../core/symlinks.js";
import { planReferences, syncReferences } from "../ref-store/references.js";
import { reconcileLocalIndexes } from "../ref-store/indexes.js";
import { syncSkillSnapshot, type SkillTarget } from "../skills/snapshot.js";
import { ensureHomeGuidance } from "../core/engine-skill.js";
import { jsonFileContent, pathExists, readJsonObject } from "../core/fs-util.js";
import {
  mergeOpenCodeV2CliPlugins,
  parseOpenCodeV2PluginEntries
} from "../renderers/opencode-v2.js";
import {
  readActiveProfile,
  readOwnership,
  writeOwnership,
  activeProfilePath
} from "../core/ownership.js";
import {
  planFileOutcome,
  planRemovePathOutcome,
  removePathOutcome,
  writeFileOutcome,
  writeJsonAtomicOutcome
} from "../core/file-operations.js";
import {
  collectOperations,
  type OperationCompletion,
  type OperationOutcome,
  type OperationStartNotification
} from "../core/operations.js";

export interface ApplyOptions {
  root?: string | undefined;
  home?: string | undefined;
  profile?: string | undefined;
  agent: ApplyAgent;
  target: InfraTarget | "all";
  dryRun?: boolean | undefined;
  noLink?: boolean | undefined;
  interactive?: boolean | undefined;
  onStart?: OperationStartNotification | undefined;
  onComplete?: OperationCompletion | undefined;
  beforePrompt?: (() => void) | undefined;
}

export interface ApplyDependencies {
  reconcileExecutor?: typeof reconcileExecutor;
  renderTarget?: typeof renderTarget;
}

async function confirmReplace(
  interactive: boolean,
  linkPath: string,
  backupPath: string,
  beforePrompt?: () => void
): Promise<boolean> {
  const replaceExisting = process.env.MFZ_REPLACE_EXISTING?.trim().toLowerCase();
  if (replaceExisting === "y" || replaceExisting === "yes" || replaceExisting === "true") {
    return true;
  }
  if (replaceExisting === "n" || replaceExisting === "no" || replaceExisting === "false") {
    return false;
  }

  if (!interactive) return false;
  beforePrompt?.();
  const answer = await confirm({
    message: `Replace existing ${linkPath}? Backup: ${backupPath}`,
    initialValue: false,
    input: processStdin,
    output: processStdout
  });
  if (isCancel(answer)) throw new Error("Apply cancelled");
  return answer === true;
}

function staleManagedConfigTarget(resolvedTarget: string | undefined, configsDir: string): boolean {
  if (!resolvedTarget) return false;
  const relative = path.relative(configsDir, resolvedTarget);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function applyRenderedTarget(
  paths: ReturnType<typeof createRuntimePaths>,
  result: RenderResult,
  options: Pick<ApplyOptions, "dryRun" | "noLink" | "beforePrompt">,
  interactive: boolean,
  onComplete: OperationCompletion
): Promise<void> {
  if (options.dryRun) {
    for (const file of result.staleFiles ?? []) {
      await planRemovePathOutcome(file, { onComplete });
    }
    for (const file of result.files) {
      await planRenderedFile(file, onComplete);
    }
  } else {
    await removeRenderedFiles(result.staleFiles ?? [], onComplete);
    await writeRenderedFiles(result.files, onComplete);
  }

  if (result.localFiles && !options.noLink) {
    if (options.dryRun) {
      for (const file of result.localStaleFiles ?? []) {
        await planRemovePathOutcome(file, { onComplete });
      }
      for (const file of result.localFiles) {
        if (file.ifMissing && (await pathExists(file.path))) {
          onComplete({
            category: "file",
            action: "write",
            status: "unchanged",
            target: file.path,
            significance: "meaningful",
            detail: "preserved existing file"
          });
        } else {
          await planRenderedFile(file, onComplete);
        }
      }
    } else {
      await removeRenderedFiles(result.localStaleFiles ?? [], onComplete);
      await writeLocalFiles(result.localFiles, onComplete);
    }
  }
  if (options.noLink) return;

  for (const link of result.staleLinks ?? []) {
    const status = await verifyLink(link);
    if (status.state === "missing") {
      if (!options.dryRun) {
        await removePathOutcome(link.linkPath, { category: "link", onComplete });
      }
      continue;
    }
    if (
      status.state !== "ok" &&
      !staleManagedConfigTarget(status.resolvedTarget, paths.configsDir)
    ) {
      continue;
    }
    if (options.dryRun) {
      await planRemovePathOutcome(link.linkPath, { category: "link", onComplete });
    } else {
      await removePathOutcome(link.linkPath, { category: "link", onComplete });
    }
  }

  if (result.cliPlugins) {
    const exists = await pathExists(result.cliPlugins.path);
    const registry = await readJsonObject(result.cliPlugins.registryPath);
    const previousEntries = parseOpenCodeV2PluginEntries(registry.entries);
    if (exists || result.cliPlugins.entries.length > 0) {
      const cli = await readJsonObject(result.cliPlugins.path);
      const merged = mergeOpenCodeV2CliPlugins(
        { ...cli, ...result.cliPlugins.settings },
        result.cliPlugins.entries,
        previousEntries
      );
      if (options.dryRun) {
        await planFileOutcome(result.cliPlugins.path, jsonFileContent(merged), { onComplete });
      } else {
        await writeFileOutcome(result.cliPlugins.path, jsonFileContent(merged), { onComplete });
      }
    }
    if (!options.dryRun && (previousEntries.length > 0 || result.cliPlugins.entries.length > 0))
      await writeJsonAtomicOutcome(
        result.cliPlugins.registryPath,
        { version: 1, entries: result.cliPlugins.entries },
        { category: "bookkeeping", significance: "internal", onComplete }
      );
  }

  for (const link of result.links) {
    const status = await verifyLink(link);
    if (options.dryRun) {
      const outcome: OperationOutcome = {
        category: "link",
        action: "link",
        status: status.state === "ok" ? "unchanged" : "planned",
        target: link.linkPath,
        significance: "meaningful",
        changes: status.state === "ok" ? [] : ["destination"],
        after: link.targetPath
      };
      if (status.resolvedTarget !== undefined) outcome.before = status.resolvedTarget;
      if (status.state === "conflict") {
        outcome.detail = `would replace after backup: ${status.detail}`;
      }
      onComplete(outcome);
      continue;
    }
    if (status.state === "ok") {
      onComplete({
        category: "link",
        action: "link",
        status: "unchanged",
        target: link.linkPath,
        significance: "meaningful",
        detail: link.targetPath
      });
      continue;
    }
    if (status.state === "missing") {
      await createLink(link, onComplete);
      continue;
    }

    const backupPath = backupPathFor(link.linkPath);
    const autoReplace = staleManagedConfigTarget(status.resolvedTarget, paths.configsDir);
    if (
      !autoReplace &&
      !(await confirmReplace(interactive, link.linkPath, backupPath, options.beforePrompt))
    ) {
      onComplete({
        category: "link",
        action: "link",
        status: "skipped",
        target: link.linkPath,
        significance: "meaningful",
        detail: status.detail
      });
      continue;
    }
    await replaceWithBackup(link, backupPath, onComplete, status.resolvedTarget);
  }
}

async function planRenderedFile(
  file: RenderResult["files"][number],
  onComplete: OperationCompletion
): Promise<void> {
  const writeOptions = { onComplete };
  if (file.mode !== undefined) Object.assign(writeOptions, { mode: file.mode });
  await planFileOutcome(file.path, file.content, writeOptions);
}

export async function applyConfig(
  options: ApplyOptions,
  dependencies: ApplyDependencies = {}
): Promise<OperationOutcome[]> {
  const operations = collectOperations(options.onComplete);
  const paths = createRuntimePaths({ root: options.root, home: options.home });
  options.onStart?.({
    category: "bookkeeping",
    action: "reconcile",
    target: options.profile ?? "configured profile",
    detail: "resolve profile"
  });
  const rendersAgents = options.target === "all";
  const profile = await resolveProfile(
    paths,
    options.profile,
    !rendersAgents
      ? { evaluateAgents: [] }
      : options.agent === "all"
        ? undefined
        : { evaluateAgents: [options.agent] }
  );
  operations.complete({
    category: "bookkeeping",
    action: "reconcile",
    status: "unchanged",
    target: profile.name,
    significance: "internal",
    detail: "profile resolved"
  });
  const selectedAgents = rendersAgents ? agentList(options.agent, profile.agents) : [];
  const selectedInfraTargets = infraTargetList(options.target);
  const selectedTargets = [...selectedAgents, ...selectedInfraTargets];
  const selectedExecutorTarget = selectedAgents.some((target) => target !== "pi");
  const reconcile = dependencies.reconcileExecutor ?? reconcileExecutor;
  const render = dependencies.renderTarget ?? renderTarget;
  const usePrompts = !options.dryRun && !options.noLink;
  const previousProfile = (await readActiveProfile(paths)) ?? profile.name;
  const interactive = usePrompts && options.interactive === true;

  if (rendersAgents) {
    const referenceOptions = { onComplete: operations.complete };
    if (options.onStart) Object.assign(referenceOptions, { onStart: options.onStart });
    if (options.dryRun) {
      await planReferences(paths, profile, referenceOptions);
    } else {
      await syncReferences(paths, profile, referenceOptions);
    }
  }
  if (
    selectedExecutorTarget &&
    (requiresExecutorReconciliation(profile, selectedAgents) ||
      (await hasManagedExecutorState(paths, profile.name)))
  ) {
    options.onStart?.({
      category: "executor",
      action: "reconcile",
      target: profile.name,
      detail: "Executor integrations"
    });
    await reconcile(paths, profile, {
      dryRun: options.dryRun ?? false,
      interactive: options.interactive === true,
      onComplete: operations.complete
    });
  }
  if (rendersAgents) {
    options.onStart?.({
      category: "index",
      action: "write",
      target: profile.name,
      detail: "local indexes"
    });
    await reconcileLocalIndexes(paths, profile, {
      dryRun: options.dryRun ?? false,
      onComplete: operations.complete
    });
    if (!options.dryRun) {
      options.onStart?.({
        category: "bookkeeping",
        action: "write",
        target: profile.name,
        detail: "project override payloads"
      });
      await renderAllPayloads(paths, profile, operations.complete);
    }
  }
  if (!options.noLink && rendersAgents) {
    options.onStart?.({
      category: "file",
      action: "write",
      target: profile.name,
      detail: "Git identity configuration"
    });
    if (options.dryRun) {
      await planGitIdentityFragment(paths, profile.manifests.machine, operations.complete);
      await planGitConfigInclude(paths, operations.complete);
    } else {
      await writeGitIdentityFragment(paths, profile.manifests.machine, operations.complete);
      await ensureGitConfigInclude(paths, operations.complete);
    }
  }
  for (const target of selectedTargets) {
    options.onStart?.({
      category: "file",
      action: "write",
      target,
      detail: `render ${target}`
    });
    const previousOwnership =
      target === "mise" ? await readOwnership(paths, previousProfile, target) : undefined;
    const previousOwnedHostPaths = previousOwnership?.host.map((relative) =>
      path.resolve(paths.miseConfigDir, relative)
    );
    const renderOptions = {
      includeGlobalSkillState: !options.noLink
    };
    if (previousOwnedHostPaths !== undefined)
      Object.assign(renderOptions, { previousOwnedHostPaths });
    const result = await render(paths, profile, target, renderOptions);
    await applyRenderedTarget(paths, result, options, interactive, operations.complete);
    if (!options.dryRun && result.ownership) {
      await writeOwnership(paths, profile.name, result.ownership, operations.complete);
    }
  }
  if (!options.dryRun) {
    await writeFileOutcome(activeProfilePath(paths), `${profile.name}\n`, {
      category: "bookkeeping",
      significance: "internal",
      onComplete: operations.complete
    });
  }
  if (rendersAgents && !options.dryRun) {
    options.onStart?.({
      category: "guidance",
      action: "write",
      target: path.join(paths.root, "AGENTS.md"),
      detail: "home guidance"
    });
    await ensureHomeGuidance(paths.root, operations.complete);
  }
  if (!rendersAgents) return operations.outcomes;
  options.onStart?.({
    category: "skill",
    action: "snapshot",
    target: profile.name,
    detail: "skill snapshot"
  });
  await syncSkillSnapshot(paths, profile, {
    selectedTargets: selectedAgents.filter(
      (target): target is SkillTarget =>
        target === "opencode-v2" || target === "claude-code" || target === "codex"
    ),
    dryRun: options.dryRun ?? false,
    link: !options.noLink,
    onComplete: operations.complete
  });
  return operations.outcomes;
}
