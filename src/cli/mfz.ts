import * as readline from "node:readline/promises";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { Command } from "@commander-js/extra-typings";
import { execa } from "execa";
import { generateSchemas } from "../core/generate-schemas.js";
import { validateManifests } from "../core/manifests.js";
import {
  agentList,
  createRuntimePaths,
  infraTargetList,
  type AgentName,
  type ApplyAgent,
  type InfraTarget
} from "../core/paths.js";
import { resolveProfile } from "../core/profile.js";
import { renderTarget, writeLocalFiles, writeRenderedFiles } from "../core/render.js";
import { backupPathFor, createLink, replaceWithBackup, verifyLink } from "../core/symlinks.js";
import {
  referenceRows,
  syncReference,
  writeExtraFoldersIndex,
  writeReferenceIndex
} from "../ref-store/references.js";
import {
  applySkill,
  listInstalledSkills,
  removeSkill,
  updateSkill
} from "../skills/skills-adapter.js";
import type { SkillEntry } from "../core/manifests.js";
import { runSync } from "../sync/index.js";
import { setLocalSkillState, type SkillToggleTarget } from "../tui/config-io.js";
import { runSkillsTui } from "../tui/skills-tui.js";

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

async function applyConfig(options: {
  root?: string | undefined;
  home?: string | undefined;
  profile?: string | undefined;
  agent: ApplyAgent;
  target: InfraTarget | "all";
  dryRun?: boolean | undefined;
  noLink?: boolean | undefined;
}): Promise<void> {
  const paths = createRuntimePaths({ root: options.root, home: options.home });
  const profile = await resolveProfile(paths, options.profile);
  const usePrompts = !options.dryRun && !options.noLink;
  const rl =
    usePrompts && processStdin.isTTY
      ? readline.createInterface({ input: processStdin, output: processStdout })
      : null;

  try {
    if (!options.dryRun) {
      await writeReferenceIndex(paths, profile);
      await writeExtraFoldersIndex(paths, profile);
    }
    for (const target of [
      ...agentList(options.agent, profile.agents),
      ...infraTargetList(options.target)
    ]) {
      const result = await renderTarget(paths, profile, target, {
        includeGlobalSkillState: !options.noLink
      });
      if (!options.dryRun) await writeRenderedFiles(result.files);
      for (const file of result.files)
        console.log(`${options.dryRun ? "would render" : "rendered"}\t${file.path}`);
      if (result.localFiles && !options.noLink) {
        if (!options.dryRun) await writeLocalFiles(result.localFiles);
        for (const file of result.localFiles)
          console.log(`${options.dryRun ? "would write local" : "wrote local"}\t${file.path}`);
      }
      if (!options.noLink) {
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
          if (!(await confirmReplace(rl, link.linkPath, backupPath))) {
            console.log(`skipped\t${link.linkPath} (${status.detail})`);
            continue;
          }

          await replaceWithBackup(link, backupPath);
          console.log(`backed up\t${link.linkPath} -> ${backupPath}`);
          console.log(`linked\t${link.linkPath} -> ${link.targetPath}`);
        }
      }
    }
  } finally {
    rl?.close();
  }
}

async function doctor(options: {
  root?: string | undefined;
  home?: string | undefined;
  profile?: string | undefined;
}): Promise<void> {
  const paths = createRuntimePaths({ root: options.root, home: options.home });
  console.log(`root\t${paths.root}`);
  console.log(`home\t${paths.home}`);
  console.log(`configs\t${paths.configsDir}`);
  console.log(`opencode config dir\t${paths.opencodeConfigDir}`);
  console.log(`claude dir\t${paths.claudeDir}`);
  console.log(`mise config dir\t${paths.miseConfigDir}`);
  const manifestResults = await validateManifests(paths.root, paths.home);
  const hasInvalidManifest = manifestResults.some((result) => !result.ok);
  for (const result of manifestResults) {
    console.log(`manifest:${result.ok ? "✓" : "✗"}\t${path.relative(paths.root, result.file)}`);
    if (result.error) console.log(result.error);
  }
  if (hasInvalidManifest) return;

  const profile = await resolveProfile(paths, options.profile);
  console.log(`profile\t${profile.name}`);
  for (const target of [...profile.agents, ...infraTargetList("all")]) {
    const result = await renderTarget(paths, profile, target);
    for (const link of result.links) {
      const status = await verifyLink(link);
      console.log(`link:${status.state}\t${status.linkPath}\t${status.detail}`);
    }
  }
}

async function schemas(options: { root?: string | undefined }): Promise<void> {
  for (const file of await generateSchemas(options.root)) console.log(`wrote\t${file}`);
}

async function statusFn(options: {
  root?: string | undefined;
  home?: string | undefined;
  profile?: string | undefined;
}): Promise<void> {
  const paths = createRuntimePaths({ root: options.root, home: options.home });
  const profile = await resolveProfile(paths, options.profile);
  console.log(`profile\t${profile.name}`);
  console.log(`agents\t${profile.agents.join(", ") || "none"}`);
  console.log(
    `references\t${profile.enabledReferences.map((ref) => ref.name).join(", ") || "none"}`
  );
  console.log(`skills\t${profile.enabledSkills.map((skill) => skill.name).join(", ") || "none"}`);
  console.log(`commands\t${profile.enabledCommands.join(", ") || "none"}`);
  console.log(
    `mcp\t${profile.mcpServers.map((server) => `${server.name}:${server.enabled ? "enabled" : "disabled"}`).join(", ") || "none"}`
  );
}

async function opencodeSmoke(options: {
  root?: string | undefined;
  home?: string | undefined;
  profile?: string | undefined;
}): Promise<void> {
  const paths = createRuntimePaths({ root: options.root, home: options.home });
  const profile = await resolveProfile(paths, options.profile);
  await applyConfig({ ...options, agent: "opencode", target: "all", noLink: true });
  const isolated = `${paths.home}/.mindframe-z-opencode-smoke`;
  await mkdir(isolated, { recursive: true });
  const configsOpencode = path.join(paths.configsDir, profile.name, "opencode");
  try {
    const result = await execa("opencode", ["debug", "config"], {
      cwd: paths.root,
      env: {
        ...process.env,
        OPENCODE_CONFIG_DIR: configsOpencode,
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        XDG_CONFIG_HOME: `${isolated}/config`,
        XDG_DATA_HOME: `${isolated}/data`,
        XDG_CACHE_HOME: `${isolated}/cache`,
        XDG_STATE_HOME: `${isolated}/state`
      }
    });
    console.log(result.stdout);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      console.log("opencode not found; skipped smoke check");
      return;
    }
    throw error;
  }
}

const program = new Command()
  .name("mfz")
  .description("Render profile-aware AI coding tool configuration")
  .version("0.1.0")
  .option("--root <path>", "AI config root")
  .option("--home <path>", "home directory override for safe tests")
  .option("--profile <profile>", "profile name");

program
  .command("doctor")
  .description("Verify manifests, profile, and symlink status")
  .action(async () => doctor(program.opts()));

program
  .command("status")
  .description("Print resolved profile status")
  .action(async () => statusFn(program.opts()));

program
  .command("schemas")
  .description("Generate JSON Schemas for YAML manifests")
  .action(async () => schemas(program.opts()));

program
  .command("sync")
  .description("Detect unmanaged changes and promote them to profile YAML")
  .option("--profile <profile>", "target profile to write changes to (skip interactive prompt)")
  .action(async (options) => {
    const paths = createRuntimePaths(program.opts());
    const profile = await resolveProfile(paths, program.opts().profile);
    await runSync(paths, profile, options.profile);
  });

program
  .command("apply")
  .description("Render runtime files and safely link tool globals")
  .option("--agent <agent>", "opencode, claude-code, or all", "all")
  .option("--target <target>", "mise, dotfiles, or all", "all")
  .option("--dry-run", "show planned writes and links")
  .option("--no-link", "render without creating global links")
  .action(async (options) =>
    applyConfig({
      ...program.opts(),
      agent: options.agent as ApplyAgent,
      target: options.target as InfraTarget | "all",
      dryRun: options.dryRun,
      noLink: !options.link
    })
  );

const skills = program
  .command("skills")
  .description("Manage skills through skills")
  .action(async () => {
    const paths = createRuntimePaths(program.opts());
    const profile = await resolveProfile(paths, program.opts().profile);
    await runSkillsTui(paths, profile);
  });

const skillTargets = ["opencode", "claude-code"] as const;

function parseSkillTarget(target: string | undefined): SkillToggleTarget | undefined {
  if (!target) return undefined;
  if (target === "opencode" || target === "claude-code") return target;
  throw new Error(`Unknown skill target: ${target}`);
}

async function setSkillEnabled(
  name: string,
  enabled: boolean,
  options: { target?: string | undefined }
): Promise<void> {
  const paths = createRuntimePaths(program.opts());
  const profile = await resolveProfile(paths, program.opts().profile);
  const skill = profile.enabledSkills.find((entry) => entry.name === name);
  if (!skill) throw new Error(`Profile ${profile.name} does not declare skill: ${name}`);
  if (!skill.toggleable) throw new Error(`Skill "${name}" is not toggleable`);
  const requestedTarget = parseSkillTarget(options.target);
  const targets = requestedTarget ? [requestedTarget] : skill.targets;
  for (const target of targets) {
    await setLocalSkillState(paths, profile, target, name, enabled);
    console.log(`${enabled ? "Enabled" : "Disabled"} ${name} for ${target}`);
  }
}

skills
  .command("enable")
  .description("Enable a skill for this project")
  .argument("<name>", "skill name")
  .option("--target <target>", "opencode or claude-code")
  .action(async (name, options) => setSkillEnabled(name, true, options));

skills
  .command("disable")
  .description("Disable a skill for this project")
  .argument("<name>", "skill name")
  .option("--target <target>", "opencode or claude-code")
  .action(async (name, options) => setSkillEnabled(name, false, options));

skills
  .command("list")
  .description("List profile-enabled skills")
  .action(async () => {
    const paths = createRuntimePaths(program.opts());
    const profile = await resolveProfile(paths, program.opts().profile);
    for (const skill of profile.enabledSkills)
      console.log(`${skill.name}\t${skill.targets.join(",")}\t${skill.description}`);
  });

skills
  .command("sync")
  .description("Mirror installed global skills to match the resolved profile")
  .option("--agent <agent>", "opencode or claude-code")
  .option("--dry-run", "print skills commands without running them")
  .action(async (options) => {
    const paths = createRuntimePaths(program.opts());
    const profile = await resolveProfile(paths, program.opts().profile);
    const requestedAgent = options.agent as AgentName | undefined;
    const targets = requestedAgent ? [requestedAgent] : profile.agents;
    const dryRun = options.dryRun ?? false;
    const installedByTarget = new Map<(typeof skillTargets)[number], Set<string>>();
    const desiredByTarget = new Map<(typeof skillTargets)[number], Set<string>>();
    const allSkillNames = new Set<string>();

    for (const target of targets) {
      const installed = await listInstalledSkills(paths, target);
      const desired = new Set(
        profile.enabledSkills
          .filter((entry) => entry.targets.includes(target))
          .map((entry) => entry.name)
      );
      installedByTarget.set(target, installed);
      desiredByTarget.set(target, desired);
      for (const name of installed) allSkillNames.add(name);
      for (const name of desired) allSkillNames.add(name);
    }

    const skillEntryFor = (name: string): SkillEntry =>
      profile.manifests.skills.find((skill) => skill.name === name) ?? {
        name,
        source: "git",
        installer: "skills",
        description: ""
      };

    for (const name of allSkillNames) {
      const installedTargets = targets.filter((target) => installedByTarget.get(target)?.has(name));
      const desiredTargets = targets.filter((target) => desiredByTarget.get(target)?.has(name));
      const skillEntry = skillEntryFor(name);

      if (installedTargets.length > 0 && desiredTargets.length === 0) {
        console.log(await removeSkill(paths, skillEntry, undefined, dryRun));
        continue;
      }

      if (installedTargets.includes("opencode") && !desiredTargets.includes("opencode")) {
        console.log(await removeSkill(paths, skillEntry, undefined, dryRun));
        for (const target of desiredTargets) {
          console.log(await applySkill(paths, skillEntry, target, dryRun));
        }
        continue;
      }

      for (const target of installedTargets) {
        if (!desiredByTarget.get(target)?.has(name)) {
          console.log(
            await removeSkill(paths, skillEntry, target, dryRun, installedByTarget.get(target))
          );
        }
      }

      for (const target of desiredTargets) {
        if (!installedByTarget.get(target)?.has(name)) {
          console.log(
            await applySkill(paths, skillEntry, target, dryRun, installedByTarget.get(target))
          );
        }
      }
    }
  });

skills
  .command("upgrade")
  .description("Update profile-enabled git skills to latest versions")
  .option("--agent <agent>", "opencode or claude-code")
  .option("--dry-run", "print skills commands without running them")
  .action(async (options) => {
    const paths = createRuntimePaths(program.opts());
    const profile = await resolveProfile(paths, program.opts().profile);
    const requestedAgent = options.agent as AgentName | undefined;
    const targets = requestedAgent ? [requestedAgent] : profile.agents;
    const updatedGitSkills = new Set<string>();
    for (const target of targets) {
      for (const skill of profile.enabledSkills.filter((entry) => entry.targets.includes(target))) {
        if (skill.source === "git" && updatedGitSkills.has(skill.name)) continue;
        console.log(await updateSkill(paths, skill, target, options.dryRun ?? false));
        if (skill.source === "git") updatedGitSkills.add(skill.name);
      }
    }
  });

program
  .command("smoke-opencode")
  .description("Render OpenCode config and verify it with isolated opencode debug config")
  .action(async () => opencodeSmoke(program.opts()));

const refs = program.command("refs").description("Manage AI reference repositories");

refs
  .command("list")
  .description("List available references")
  .action(async () => {
    const paths = createRuntimePaths(program.opts());
    const profile = await resolveProfile(paths, program.opts().profile);
    for (const row of referenceRows(profile)) console.log(row);
  });

refs
  .command("sync")
  .description("Clone or update references")
  .argument("[name]", "reference name")
  .action(async (name) => {
    const paths = createRuntimePaths(program.opts());
    const profile = await resolveProfile(paths, program.opts().profile);
    const names = name ? [name] : profile.enabledReferences.map((ref) => ref.name);
    for (const refName of names) console.log(await syncReference(profile, refName));
  });

refs
  .command("index")
  .description("Generate the runtime reference index")
  .action(async () => {
    const paths = createRuntimePaths(program.opts());
    const profile = await resolveProfile(paths, program.opts().profile);
    console.log(await writeReferenceIndex(paths, profile));
  });

refs
  .command("status")
  .description("Print enabled reference names")
  .action(async () => {
    const paths = createRuntimePaths(program.opts());
    const profile = await resolveProfile(paths, program.opts().profile);
    for (const ref of profile.enabledReferences) console.log(`${ref.name}\t${ref.url}`);
  });

await program.parseAsync();
