import * as readline from "node:readline/promises";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { Command } from "@commander-js/extra-typings";
import { execa } from "execa";
import { createRuntimePaths, targetList, type ApplyTarget } from "../core/paths.js";
import { resolveProfile } from "../core/profile.js";
import { renderTarget, writeRenderedFiles } from "../core/render.js";
import { backupPathFor, createLink, replaceWithBackup, verifyLink } from "../core/symlinks.js";
import { referenceRows, syncReference, writeReferenceIndex } from "../ref-store/references.js";
import { applySkill } from "../skills/npx-skills.js";
import { runSync } from "../sync/index.js";

async function confirmReplace(
  rl: readline.Interface | null,
  linkPath: string,
  backupPath: string,
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
  target: ApplyTarget;
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
    if (!options.dryRun) await writeReferenceIndex(paths, profile);
    for (const target of targetList(options.target)) {
      const result = await renderTarget(paths, profile, target);
      if (!options.dryRun) await writeRenderedFiles(result.files);
      for (const file of result.files)
        console.log(`${options.dryRun ? "would render" : "rendered"}\t${file.path}`);
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
  const profile = await resolveProfile(paths, options.profile);
  console.log(`root\t${paths.root}`);
  console.log(`home\t${paths.home}`);
  console.log(`profile\t${profile.name}`);
  console.log(`configs\t${paths.configsDir}`);
  console.log(`opencode config dir\t${paths.opencodeConfigDir}`);
  console.log(`claude dir\t${paths.claudeDir}`);
  console.log(`mise config dir\t${paths.miseConfigDir}`);
  for (const target of targetList("all")) {
    const result = await renderTarget(paths, profile, target);
    for (const link of result.links) {
      const status = await verifyLink(link);
      console.log(`link:${status.state}\t${status.linkPath}\t${status.detail}`);
    }
  }
}

async function statusFn(options: {
  root?: string | undefined;
  home?: string | undefined;
  profile?: string | undefined;
}): Promise<void> {
  const paths = createRuntimePaths({ root: options.root, home: options.home });
  const profile = await resolveProfile(paths, options.profile);
  console.log(`profile\t${profile.name}`);
  console.log(
    `references\t${profile.enabledReferences.map((ref) => ref.name).join(", ") || "none"}`,
  );
  console.log(`skills\t${profile.enabledSkills.map((skill) => skill.name).join(", ") || "none"}`);
  console.log(
    `mcp\t${profile.mcpServers.map((server) => `${server.name}:${server.enabled ? "enabled" : "disabled"}`).join(", ") || "none"}`,
  );
}

async function opencodeSmoke(options: {
  root?: string | undefined;
  home?: string | undefined;
  profile?: string | undefined;
}): Promise<void> {
  const paths = createRuntimePaths({ root: options.root, home: options.home });
  const profile = await resolveProfile(paths, options.profile);
  await applyConfig({ ...options, target: "opencode", noLink: true });
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
        XDG_STATE_HOME: `${isolated}/state`,
      },
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
  .name("mindframe-z")
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
  .option("--target <target>", "opencode, claude-code, mise, dotfiles, or all", "all")
  .option("--dry-run", "show planned writes and links")
  .option("--no-link", "render without creating global links")
  .action(async (options) =>
    applyConfig({
      ...program.opts(),
      target: options.target as ApplyTarget,
      dryRun: options.dryRun,
      noLink: !options.link,
    }),
  );

const skills = program.command("skills").description("Manage skills through npx skills");

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
  .command("apply")
  .description("Install profile-enabled skills with npx skills")
  .option("--target <target>", "opencode or claude-code", "opencode")
  .option("--dry-run", "print npx skills commands without running them")
  .action(async (options) => {
    const paths = createRuntimePaths(program.opts());
    const profile = await resolveProfile(paths, program.opts().profile);
    const target = options.target as "opencode" | "claude-code";
    for (const skill of profile.enabledSkills.filter((entry) => entry.targets.includes(target))) {
      console.log(await applySkill(paths, skill, target, options.dryRun ?? false));
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
