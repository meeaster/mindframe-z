import * as readline from "node:readline/promises";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { z } from "zod";
import {
  executorPlanSummary,
  hasManagedExecutorState,
  reconcileExecutor
} from "../executor/index.js";
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
  gitIdentityFragmentPath,
  globalGitConfigPath,
  writeGitIdentityFragment
} from "../core/git-config.js";
import { backupPathFor, createLink, replaceWithBackup, verifyLink } from "../core/symlinks.js";
import { writeExtraFoldersIndex, writeReferenceIndex } from "../ref-store/references.js";
import { syncSkillSnapshot, type SkillTarget } from "../skills/snapshot.js";
import { ensureHomeGuidance } from "../core/engine-skill.js";
import {
  jsonFileContent,
  pathExists,
  readJsonObject,
  writeJsonFileAtomic,
  writeTextFile
} from "../core/fs-util.js";
import { mergeOpenCodeV2CliPlugins } from "../renderers/opencode-v2.js";
import {
  readActiveProfile,
  readOwnership,
  writeOwnership,
  activeProfilePath
} from "../core/ownership.js";

export interface ApplyOptions {
  root?: string | undefined;
  home?: string | undefined;
  profile?: string | undefined;
  agent: ApplyAgent;
  target: InfraTarget | "all";
  dryRun?: boolean | undefined;
  noLink?: boolean | undefined;
}

export interface ApplyDependencies {
  reconcileExecutor?: typeof reconcileExecutor;
  renderTarget?: typeof renderTarget;
}

async function confirmReplace(
  rl: readline.Interface | null,
  linkPath: string,
  backupPath: string
): Promise<boolean> {
  const replaceExisting = process.env.MFZ_REPLACE_EXISTING?.trim().toLowerCase();
  if (replaceExisting === "y" || replaceExisting === "yes" || replaceExisting === "true") {
    return true;
  }
  if (replaceExisting === "n" || replaceExisting === "no" || replaceExisting === "false") {
    return false;
  }

  let answer = "";
  if (rl) {
    answer = await rl.question(`Replace existing ${linkPath}? Backup: ${backupPath} [y/N]: `);
  } else {
    return false;
  }
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

function staleManagedConfigTarget(resolvedTarget: string | undefined, configsDir: string): boolean {
  if (!resolvedTarget) return false;
  const relative = path.relative(configsDir, resolvedTarget);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function applyRenderedTarget(
  paths: ReturnType<typeof createRuntimePaths>,
  result: RenderResult,
  options: Pick<ApplyOptions, "dryRun" | "noLink">,
  rl: readline.Interface | null
): Promise<void> {
  if (!options.dryRun) {
    await removeRenderedFiles(result.staleFiles ?? []);
    await writeRenderedFiles(result.files);
  }
  for (const file of result.files) {
    console.log(`${options.dryRun ? "would render" : "rendered"}\t${file.path}`);
  }

  if (result.localFiles && !options.noLink) {
    for (const file of result.localStaleFiles ?? []) {
      console.log(`${options.dryRun ? "would remove local" : "removed local"}\t${file}`);
    }
    if (!options.dryRun) {
      await removeRenderedFiles(result.localStaleFiles ?? []);
      await writeLocalFiles(result.localFiles);
    }
    for (const file of result.localFiles) {
      console.log(`${options.dryRun ? "would write local" : "wrote local"}\t${file.path}`);
    }
  }
  if (options.noLink) return;

  for (const link of result.staleLinks ?? []) {
    const status = await verifyLink(link);
    if (
      status.state !== "ok" &&
      !staleManagedConfigTarget(status.resolvedTarget, paths.configsDir)
    ) {
      continue;
    }
    if (!options.dryRun) await unlink(link.linkPath);
    console.log(`${options.dryRun ? "would unlink" : "unlinked"}\t${link.linkPath}`);
  }

  if (result.cliPlugins) {
    const exists = await pathExists(result.cliPlugins.path);
    const registry = await readJsonObject(result.cliPlugins.registryPath);
    const previousEntries = z.array(z.string()).safeParse(registry.entries).data ?? [];
    if (exists || result.cliPlugins.entries.length > 0) {
      const cli = await readJsonObject(result.cliPlugins.path);
      const merged = mergeOpenCodeV2CliPlugins(
        { ...cli, ...result.cliPlugins.settings },
        result.cliPlugins.entries,
        previousEntries
      );
      if (!options.dryRun) await writeTextFile(result.cliPlugins.path, jsonFileContent(merged));
      console.log(
        `${options.dryRun ? "would merge" : "merged"}\t${result.cliPlugins.path} plugins`
      );
    }
    if (!options.dryRun && (previousEntries.length > 0 || result.cliPlugins.entries.length > 0))
      await writeJsonFileAtomic(result.cliPlugins.registryPath, {
        version: 1,
        entries: result.cliPlugins.entries
      });
  }

  for (const link of result.links) {
    const status = await verifyLink(link);
    if (options.dryRun) {
      const action =
        status.state === "missing"
          ? "would link"
          : status.state === "ok"
            ? "link ok"
            : "would replace after backup";
      console.log(`${action}\t${link.linkPath} -> ${link.targetPath}`);
      continue;
    }
    if (status.state === "ok") {
      console.log(`link ok\t${link.linkPath} -> ${link.targetPath}`);
      continue;
    }
    if (status.state === "missing") {
      await createLink(link);
      console.log(`linked\t${link.linkPath} -> ${link.targetPath}`);
      continue;
    }

    const backupPath = backupPathFor(link.linkPath);
    const autoReplace = staleManagedConfigTarget(status.resolvedTarget, paths.configsDir);
    if (!autoReplace && !(await confirmReplace(rl, link.linkPath, backupPath))) {
      console.log(`skipped\t${link.linkPath} (${status.detail})`);
      continue;
    }
    await replaceWithBackup(link, backupPath);
    console.log(`backed up\t${link.linkPath} -> ${backupPath}`);
    console.log(`linked\t${link.linkPath} -> ${link.targetPath}`);
  }
}

export async function applyConfig(
  options: ApplyOptions,
  dependencies: ApplyDependencies = {}
): Promise<void> {
  const paths = createRuntimePaths({ root: options.root, home: options.home });
  const rendersAgents = options.target === "all";
  const includeActiveV2 =
    rendersAgents && options.agent === "all" && paths.activeOpenCodeRuntime === "v2";
  const profile = await resolveProfile(
    paths,
    options.profile,
    !rendersAgents
      ? { evaluateAgents: [] }
      : options.agent === "all"
        ? includeActiveV2
          ? { evaluateAgents: ["opencode-v2"] }
          : undefined
        : { evaluateAgents: [options.agent] }
  );
  const selectedAgents = rendersAgents ? agentList(options.agent, profile.agents) : [];
  if (includeActiveV2 && !selectedAgents.includes("opencode-v2"))
    selectedAgents.push("opencode-v2");
  const selectedInfraTargets = infraTargetList(options.target);
  const selectedTargets = [...selectedAgents, ...selectedInfraTargets];
  const selectedExecutorTarget = selectedAgents.some((target) => target !== "pi");
  const selectedLegacyExecutorTarget = selectedAgents.some(
    (target) => target !== "pi" && target !== "opencode-v2"
  );
  const reconcile = dependencies.reconcileExecutor ?? reconcileExecutor;
  const render = dependencies.renderTarget ?? renderTarget;
  const usePrompts = !options.dryRun && !options.noLink;
  const previousProfile = (await readActiveProfile(paths)) ?? profile.name;
  const rl =
    usePrompts && processStdin.isTTY
      ? readline.createInterface({ input: processStdin, output: processStdout })
      : null;

  try {
    const executorPlan =
      selectedExecutorTarget &&
      (requiresExecutorReconciliation(profile, selectedAgents) ||
        (selectedLegacyExecutorTarget && (await hasManagedExecutorState(paths, profile.name))))
        ? await reconcile(paths, profile, {
            dryRun: options.dryRun ?? false,
            interactive: Boolean(processStdin.isTTY)
          })
        : undefined;
    if (executorPlan) console.log(`executor\t${executorPlanSummary(executorPlan)}`);
    if (!options.dryRun) {
      if (rendersAgents) {
        await writeReferenceIndex(paths, profile);
        await writeExtraFoldersIndex(paths, profile);
        await renderAllPayloads(paths, profile);
      }
    }
    if (!options.noLink && rendersAgents) {
      const fragmentPath = gitIdentityFragmentPath(paths);
      const configPath = globalGitConfigPath(paths);
      if (!options.dryRun) {
        await writeGitIdentityFragment(paths, profile.manifests.machine);
        await ensureGitConfigInclude(paths);
      }
      console.log(`${options.dryRun ? "would write local" : "wrote local"}\t${fragmentPath}`);
      console.log(`${options.dryRun ? "would update" : "updated"}\t${configPath}`);
    }
    for (const target of selectedTargets) {
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
      await applyRenderedTarget(paths, result, options, rl);
      if (!options.dryRun && result.ownership) {
        await writeOwnership(paths, profile.name, result.ownership);
      }
    }
    if (!options.dryRun) await writeTextFile(activeProfilePath(paths), `${profile.name}\n`);
    if (rendersAgents && !options.dryRun && (await ensureHomeGuidance(paths.root)) === "wrote") {
      console.log(`wrote\t${path.join(paths.root, "AGENTS.md")} (home guidance block)`);
    }
    if (!rendersAgents) return;
    await syncSkillSnapshot(paths, profile, {
      selectedTargets: selectedAgents.filter(
        (target): target is SkillTarget =>
          target === "opencode" ||
          target === "opencode-v2" ||
          target === "claude-code" ||
          target === "codex"
      ),
      dryRun: options.dryRun ?? false,
      link: !options.noLink
    });
  } finally {
    rl?.close();
  }
}
