import * as readline from "node:readline/promises";
import path from "node:path";
import { access, mkdir, readFile, unlink } from "node:fs/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { Command } from "@commander-js/extra-typings";
import { execa } from "execa";
import YAML from "yaml";
import { generateSchemas } from "../core/generate-schemas.js";
import { eachUpstream, validateManifests } from "../core/manifests.js";
import type { LoadedManifests } from "../core/manifests.js";
import {
  agentList,
  createRuntimePaths,
  infraTargetList,
  type AgentName,
  type ApplyAgent,
  type InfraTarget
} from "../core/paths.js";
import { resolveProfile } from "../core/profile.js";
import {
  effectiveProjectState,
  findProjectRoot,
  projectOverrides,
  readOverrideStore,
  renderAllPayloads,
  writeProjectOverrideDelta
} from "../core/override-store.js";
import {
  removeRenderedFiles,
  renderTarget,
  writeLocalFiles,
  writeRenderedFiles
} from "../core/render.js";
import {
  ensureGitConfigInclude,
  gitIdentityFragmentPath,
  globalGitConfigPath,
  writeGitIdentityFragment
} from "../core/git-config.js";
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
  skillsCliAvailable,
  updateSkill
} from "../skills/skills-adapter.js";
import type { SkillEntry } from "../core/manifests.js";
import { runSync } from "../sync/index.js";
import { parseSandboxTarget, runSandboxInit, runSandboxLaunch } from "../sandbox/cli.js";
import { runSeedClaude } from "../sandbox/seed-claude.js";
import { runSeedOpenai } from "../sandbox/seed-openai.js";
import { runSessionsBackup } from "../sessions/backup.js";
import {
  runThreadCreate,
  runThreadConclude,
  runThreadDelete,
  runThreadDestinations,
  runThreadDiscover,
  runThreadIngest,
  runThreadPending,
  runThreadRefresh,
  runThreadReject,
  runThreadList,
  runThreadObserveDown,
  runThreadObserveStatus,
  runThreadObserveUp,
  runThreadRegenerate,
  runThreadRuns,
  runThreadShow,
  runThreadSweep,
  runThreadSync,
  runThreadToolsBuild
} from "../thread/cli.js";
import { setLocalSkillState, type SkillToggleTarget } from "../tui/config-io.js";
import { runMcpTui } from "../tui/mcp-tui.js";
import { runSkillsTui } from "../tui/skills-tui.js";
import { guide, initHome } from "./init.js";
import {
  engineSkillName,
  ensureHomeGuidance,
  hasHomeGuidance,
  materializeEngineSkill
} from "../core/engine-skill.js";

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
      await renderAllPayloads(paths, profile);
    }
    if (!options.noLink) {
      const fragmentPath = gitIdentityFragmentPath(paths);
      const configPath = globalGitConfigPath(paths);
      if (!options.dryRun) {
        await writeGitIdentityFragment(paths, profile.manifests.machine);
        await ensureGitConfigInclude(paths);
      }
      console.log(`${options.dryRun ? "would write local" : "wrote local"}\t${fragmentPath}`);
      console.log(`${options.dryRun ? "would update" : "updated"}\t${configPath}`);
    }
    for (const target of [
      ...agentList(options.agent, profile.agents),
      ...infraTargetList(options.target)
    ]) {
      const result = await renderTarget(paths, profile, target, {
        includeGlobalSkillState: !options.noLink
      });
      if (!options.dryRun) await removeRenderedFiles(result.staleFiles ?? []);
      if (!options.dryRun) await writeRenderedFiles(result.files);
      for (const file of result.files)
        console.log(`${options.dryRun ? "would render" : "rendered"}\t${file.path}`);
      if (result.localFiles && !options.noLink) {
        if (!options.dryRun) await removeRenderedFiles(result.localStaleFiles ?? []);
        if (!options.dryRun) await writeLocalFiles(result.localFiles);
        for (const file of result.localFiles)
          console.log(`${options.dryRun ? "would write local" : "wrote local"}\t${file.path}`);
      }
      if (!options.noLink) {
        for (const link of result.staleLinks ?? []) {
          const status = await verifyLink(link);
          if (
            status.state === "ok" ||
            staleManagedConfigTarget(status.resolvedTarget, paths.configsDir)
          ) {
            if (!options.dryRun) await unlink(link.linkPath);
            console.log(`${options.dryRun ? "would unlink" : "unlinked"}\t${link.linkPath}`);
          }
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
    }
    if (!options.dryRun && (await ensureHomeGuidance(paths.root)) === "wrote") {
      console.log(`wrote\t${path.join(paths.root, "AGENTS.md")} (home guidance block)`);
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
  console.log(`codex dir\t${paths.codexDir}`);
  console.log(`pi dir\t${paths.piDir}`);
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
  if (await hasHomeGuidance(paths.root)) {
    console.log(`home-guidance:ok\t${path.join(paths.root, "AGENTS.md")}`);
  } else {
    console.log(
      `home-guidance:missing\t${path.join(paths.root, "AGENTS.md")}\trun mfz apply to write it`
    );
  }
  if (await shouldHintLegacyReferences(paths.home)) {
    console.log(
      `hint\tlegacy references directory exists at ${path.join(paths.home, "references")}; default is now ${path.join(paths.home, ".mindframe-z", "references")}. Set references_dir to keep using the legacy path.`
    );
  }
  for (const upstream of eachUpstream(profile.manifests)) {
    for (const line of await upstreamDoctorLines(upstream)) console.log(line);
  }
  for (const target of [...profile.agents, ...infraTargetList("all")]) {
    const result = await renderTarget(paths, profile, target);
    for (const link of result.links) {
      const status = await verifyLink(link);
      console.log(`link:${status.state}\t${status.linkPath}\t${status.detail}`);
    }
  }
  const projectRoot = await findProjectRoot();
  if (projectRoot) {
    for (const file of [
      path.join(projectRoot, ".opencode", "opencode.jsonc"),
      path.join(projectRoot, ".claude", "settings.local.json"),
      path.join(projectRoot, ".codex", "config.toml")
    ]) {
      if (await fileExists(file)) {
        console.log(
          `stale-project-toggle\t${file}\tproject toggles now live in ~/.mindframe-z/overrides.json`
        );
      }
    }
  }
}

async function gitStdout(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execa("git", args, { cwd });
    return stdout;
  } catch {
    return null;
  }
}

async function upstreamDoctorLines(upstream: LoadedManifests): Promise<string[]> {
  const label = upstream.aliasPath.join("/");
  const lines: string[] = [];
  const dirty = (await gitStdout(upstream.root, ["status", "--porcelain"]))?.trim();
  if (dirty) lines.push(`upstream:dirty\t${label}\t${upstream.root}`);

  const ahead = Number(
    (await gitStdout(upstream.root, ["rev-list", "--count", "@{u}..HEAD"])) ?? "0"
  );
  if (ahead > 0) lines.push(`upstream:ahead\t${label}\t${ahead} commit(s) unpushed`);

  await gitStdout(upstream.root, ["fetch", "--quiet"]);
  const behind = Number(
    (await gitStdout(upstream.root, ["rev-list", "--count", "HEAD..@{u}"])) ?? "0"
  );
  if (behind > 0) lines.push(`upstream:stale\t${label}\t${behind} commit(s) behind`);
  return lines;
}

async function shouldHintLegacyReferences(home: string): Promise<boolean> {
  if (process.env.MFZ_REFERENCES_DIR) return false;
  try {
    const parsed = YAML.parse(
      await readFile(path.join(home, ".mindframe-z", "config.yml"), "utf8")
    ) as unknown;
    if (parsed && typeof parsed === "object" && "references_dir" in parsed) return false;
  } catch {
    // Missing or unreadable machine config means there is no references_dir override.
  }
  return fileExists(path.join(home, "references"));
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
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
    `mcp\t${
      profile.mcpServers
        .map(
          (server) =>
            `${server.name}:${Object.entries(server.agents)
              .map(([agent, enabled]) => `${agent}=${enabled ? "enabled" : "disabled"}`)
              .join("|")}`
        )
        .join(", ") || "none"
    }`
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
  .command("guide")
  .description("Print the mindframe-z home conventions guide")
  .argument("[topic]", "topic guide: skills")
  .action(async (topic) => guide(topic));

program
  .command("init")
  .description("Initialize machine config and create, clone, or point at a home")
  .option("--create <path>", "scaffold a new home at path")
  .option("--clone <repo>", "clone an existing home repository")
  .option("--point <path>", "point machine config at an existing home")
  .option("--name <name>", "clone destination name under ~/.mindframe-z/homes")
  .option("--agents <agents>", "comma-separated starter agents", "opencode,claude-code,codex")
  .action(async (options) => initHome({ ...program.opts(), ...options }));

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
  .option("--agent <agent>", "opencode, claude-code, codex, pi, or all", "all")
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

const sandbox = program
  .command("sandbox")
  .description("Launch the active profile inside the credential-brokered sandbox")
  .allowUnknownOption(true)
  .option("--rebuild", "force rebuilding the sandbox image before launch")
  .argument("[target]", "shell, cc, oc, or init", "shell")
  .argument("[args...]", "arguments forwarded to the sandbox command")
  .action(async (target, args, options) => {
    const parsed = parseSandboxTarget(target);
    const forwarded = target === "shell" || target === "cc" || target === "oc" ? args : [];
    if (parsed.target === "init") {
      await runSandboxInit(program.opts());
      return;
    }
    await runSandboxLaunch({
      ...program.opts(),
      target: parsed.target,
      args: forwarded,
      rebuild: options.rebuild
    });
  });

sandbox
  .command("init")
  .description("Initialize sandbox broker state if needed")
  .action(async () => runSandboxInit(program.opts()));

sandbox
  .command("seed-claude")
  .description("Seed the Claude subscription OAuth credential (auto-refreshing) into the broker")
  .action(async () => runSeedClaude(program.opts()));

sandbox
  .command("seed-openai")
  .description("Seed the opencode ChatGPT OAuth credential (auto-refreshing) into the broker")
  .action(async () => runSeedOpenai(program.opts()));

const sessions = program
  .command("sessions")
  .description("Back up and restore raw harness sessions");

sessions
  .command("backup")
  .description("Upload local Claude and OpenCode sessions to the default archive (skip-unchanged)")
  .action(async () => runSessionsBackup(program.opts()));

const thread = program
  .command("thread")
  .description("Create, ingest, read, and inspect thread logs");

thread
  .command("destinations")
  .description("List resolved thread destinations")
  .option("--json", "emit structured JSON")
  .action(async (options) =>
    runThreadDestinations({ ...program.opts(), json: Boolean(options.json) })
  );

thread
  .command("tools")
  .description("Manage the local thread tools image")
  .command("build")
  .description("Build or refresh the bundled local Docker image used by thread dispatch")
  .option("--force", "rebuild even when the image hash is current")
  .action(async (options) =>
    runThreadToolsBuild({ ...program.opts(), force: Boolean(options.force) })
  );

thread
  .command("create")
  .description("Create a deterministic thread manifest")
  .argument("<slug>", "thread slug")
  .requiredOption("--charter <charter>", "synthesis lens for the thread")
  .option("--dest <destination>", "thread destination")
  .option("--discover-model <id>", "discover model (harness:model@effort)")
  .option("--gather-model <id>", "gather model (harness:model@effort)")
  .option("--synthesize-model <id>", "synthesize model (harness:model@effort)")
  .action(async (slug, options) =>
    runThreadCreate(slug, {
      ...program.opts(),
      dest: options.dest,
      charter: options.charter,
      discover: options.discoverModel,
      gather: options.gatherModel,
      synthesize: options.synthesizeModel
    })
  );

thread
  .command("discover")
  .description("Find candidate sessions matching a prompt")
  .argument("<prompt>", "free-text session search prompt")
  .option("--model <id>", "model (harness:model@effort)")
  .option("--sources <sources>", "comma-separated session sources: claude-code,opencode")
  .option("--json", "emit structured JSON")
  .action(async (prompt, options) =>
    runThreadDiscover(prompt, {
      ...program.opts(),
      json: Boolean(options.json),
      discover: options.model,
      sources: options.sources?.split(",").map((s) => s.trim())
    })
  );

thread
  .command("ingest")
  .description("Ingest named sessions, also refreshing any drifted existing sessions")
  .argument("<ids...>", "source-qualified session ids (claude-code:<id> or opencode:<id>)")
  .requiredOption("--thread <slug>", "thread slug")
  .option("--no-push", "commit locally without pushing")
  .option("--gather-model <id>", "gather model (harness:model@effort)")
  .option("--synthesize-model <id>", "synthesize model (harness:model@effort)")
  .action(async (ids, options) =>
    runThreadIngest(ids, {
      ...program.opts(),
      thread: options.thread,
      noPush: !options.push,
      gather: options.gatherModel,
      synthesize: options.synthesizeModel
    })
  );

thread
  .command("refresh")
  .description("Refresh drifted sessions in a thread and rebuild its digest")
  .requiredOption("--thread <slug>", "thread slug")
  .option("--all", "force a full re-gather + re-synthesis of every session, ignoring watermarks")
  .option("--no-push", "commit locally without pushing")
  .option("--gather-model <id>", "gather model (harness:model@effort)")
  .option("--synthesize-model <id>", "synthesize model (harness:model@effort)")
  .action(async (options) =>
    runThreadRefresh({
      ...program.opts(),
      thread: options.thread,
      all: Boolean(options.all),
      noPush: !options.push,
      gather: options.gatherModel,
      synthesize: options.synthesizeModel
    })
  );

thread
  .command("sweep")
  .description("Detect and triage new or changed sessions without writing thread repos")
  .option("--include-hot", "triage sessions active inside the quiescence window")
  .option("--triage-model <id>", "triage model (harness:model@effort)")
  .option("--json", "emit structured JSON")
  .action(async (options) =>
    runThreadSweep({
      ...program.opts(),
      includeHot: Boolean(options.includeHot),
      triageModel: options.triageModel,
      json: Boolean(options.json)
    })
  );

thread
  .command("pending")
  .description("List pending thread proposals from the local sweep ledger")
  .option("--json", "emit structured JSON")
  .action(async (options) => runThreadPending({ ...program.opts(), json: Boolean(options.json) }));

thread
  .command("reject")
  .description("Record a sticky human rejection for a pending proposal")
  .argument("<id>", "source-qualified session id")
  .requiredOption("--thread <slug>", "thread slug")
  .action(async (id, options) =>
    runThreadReject(id, { ...program.opts(), thread: options.thread })
  );

thread
  .command("conclude")
  .description("Pass all remaining pending proposals and stamp review time")
  .action(async () => runThreadConclude(program.opts()));

thread
  .command("regenerate")
  .description("Rebuild a thread's log and digest from its existing session files (no re-gather)")
  .argument("<slug>", "thread slug")
  .option("--no-push", "commit locally without pushing")
  .option("--synthesize-model <id>", "synthesize model (harness:model@effort)")
  .action(async (slug, options) =>
    runThreadRegenerate(slug, {
      ...program.opts(),
      noPush: !options.push,
      synthesize: options.synthesizeModel
    })
  );

thread
  .command("list")
  .description("List known threads")
  .option("--json", "emit structured JSON")
  .action(async (options) => runThreadList({ ...program.opts(), json: Boolean(options.json) }));

thread
  .command("show")
  .description("Print a thread digest")
  .argument("<slug>", "thread slug")
  .action(async (slug) => runThreadShow(slug, program.opts()));

thread
  .command("runs")
  .description("Inspect thread run state")
  .argument("[run-id]", "run id")
  .option("--thread <slug>", "show durable run ledger for one thread")
  .option("--trace", "print raw trace for a run id")
  .option("--json", "emit structured JSON")
  .action(async (runId, options) =>
    runThreadRuns({
      ...program.opts(),
      runId,
      thread: options.thread,
      trace: Boolean(options.trace),
      json: Boolean(options.json)
    })
  );

thread
  .command("delete")
  .description("Delete a thread locally and from its destination")
  .argument("<slug>", "thread slug")
  .option("--no-push", "commit deletion locally without pushing")
  .action(async (slug, options) =>
    runThreadDelete(slug, { ...program.opts(), noPush: !options.push })
  );

thread
  .command("sync")
  .description("Pull latest from thread destination remotes")
  .argument("[slug...]", "thread slugs to sync")
  .option("--all", "sync all thread destinations")
  .action(async (slugs, options) =>
    runThreadSync({ ...program.opts(), slugs, all: Boolean(options.all) })
  );

const observe = thread
  .command("observe")
  .description("Manage the optional lapdog dashboard overlay");

observe
  .command("up")
  .description("Start the local lapdog container and mfz-net network")
  .action(async () => runThreadObserveUp(program.opts()));

observe
  .command("down")
  .description("Stop the lapdog container and remove the mfz-net network")
  .action(async () => runThreadObserveDown(program.opts()));

observe
  .command("status")
  .description("Report lapdog reachability from the /info probe")
  .option("--json", "emit structured JSON")
  .action(async (options) =>
    runThreadObserveStatus({ ...program.opts(), json: Boolean(options.json) })
  );

program
  .command("cc")
  .description("Launch Claude Code inside the sandbox")
  .allowUnknownOption(true)
  .option("--rebuild", "force rebuilding the sandbox image before launch")
  .argument("[args...]", "arguments forwarded to Claude Code")
  .action(async (args, options) =>
    runSandboxLaunch({ ...program.opts(), target: "cc", args, rebuild: options.rebuild })
  );

program
  .command("oc")
  .description("Launch opencode inside the sandbox")
  .allowUnknownOption(true)
  .option("--rebuild", "force rebuilding the sandbox image before launch")
  .argument("[args...]", "arguments forwarded to opencode")
  .action(async (args, options) =>
    runSandboxLaunch({ ...program.opts(), target: "oc", args, rebuild: options.rebuild })
  );

const skills = program
  .command("skills")
  .description("Manage skills through skills")
  .action(async () => {
    const paths = createRuntimePaths(program.opts());
    const profile = await resolveProfile(paths, program.opts().profile);
    await runSkillsTui(paths, profile);
  });

const skillTargets = ["opencode", "claude-code", "codex"] as const;

function parseSkillTarget(target: string | undefined): SkillToggleTarget | undefined {
  if (!target) return undefined;
  if (target === "opencode" || target === "claude-code" || target === "codex") return target;
  throw new Error(`Unknown skill target: ${target}`);
}

function parseSkillAgentOption(agent: string | undefined): SkillToggleTarget | undefined {
  if (!agent || agent === "all") return undefined;
  return parseSkillTarget(agent);
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
  const targets = (requestedTarget ? [requestedTarget] : skill.targets).filter(
    (target): target is SkillToggleTarget =>
      skillTargets.includes(target as (typeof skillTargets)[number])
  );
  for (const target of targets) {
    await setLocalSkillState(paths, profile, target, name, enabled);
    console.log(`${enabled ? "Enabled" : "Disabled"} ${name} for ${target}`);
  }
}

skills
  .command("enable")
  .description("Enable a skill for this project")
  .argument("<name>", "skill name")
  .option("--target <target>", "opencode, claude-code, or codex")
  .action(async (name, options) => setSkillEnabled(name, true, options));

skills
  .command("disable")
  .description("Disable a skill for this project")
  .argument("<name>", "skill name")
  .option("--target <target>", "opencode, claude-code, or codex")
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
  .option("--agent <agent>", "opencode, claude-code, or codex")
  .option("--dry-run", "print skills commands without running them")
  .action(async (options) => {
    const paths = createRuntimePaths(program.opts());
    const profile = await resolveProfile(paths, program.opts().profile);
    const requestedAgent = parseSkillAgentOption(options.agent);
    const targets = (requestedAgent ? [requestedAgent] : profile.agents).filter(
      (target): target is (typeof skillTargets)[number] =>
        skillTargets.includes(target as (typeof skillTargets)[number])
    );
    const dryRun = options.dryRun ?? false;
    if (!dryRun && !(await skillsCliAvailable(paths))) {
      console.log(
        "skills CLI not found; skipping skill sync. Install it (e.g. `npm install -g skills`), then re-run `mfz skills sync`."
      );
      return;
    }
    // The engine ships its own slim skill so every machine gets it via sync,
    // versioned with the binary. A home that declares a skill of the same name
    // owns it instead (including declaring-without-enabling to opt out).
    const engineOwnsSkill =
      !profile.enabledSkills.some((skill) => skill.name === engineSkillName) &&
      !profile.manifests.skills.some((skill) => skill.name === engineSkillName);
    const engineSkill = engineOwnsSkill ? await materializeEngineSkill(paths) : undefined;

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
      if (engineSkill) desired.add(engineSkill.name);
      installedByTarget.set(target, installed);
      desiredByTarget.set(target, desired);
      for (const name of installed) allSkillNames.add(name);
      for (const name of desired) allSkillNames.add(name);
    }

    // Prefer the resolved skill: it carries the true source and sourceRoot,
    // including for skills defined in an upstream home. The engine skill serves
    // its own name; the local catalog and the git fallback only serve orphaned
    // skills that are installed but no longer enabled.
    const skillEntryFor = (name: string): SkillEntry & { sourceRoot?: string } =>
      profile.enabledSkills.find((skill) => skill.name === name) ??
      profile.manifests.skills.find((skill) => skill.name === name) ??
      (name === engineSkill?.name
        ? engineSkill
        : {
            name,
            source: "git",
            installer: "skills",
            description: ""
          });

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
  .option("--agent <agent>", "opencode, claude-code, or codex")
  .option("--dry-run", "print skills commands without running them")
  .action(async (options) => {
    const paths = createRuntimePaths(program.opts());
    const profile = await resolveProfile(paths, program.opts().profile);
    const requestedAgent = parseSkillAgentOption(options.agent);
    const targets = (requestedAgent ? [requestedAgent] : profile.agents).filter(
      (target): target is (typeof skillTargets)[number] =>
        skillTargets.includes(target as (typeof skillTargets)[number])
    );
    const updatedGitSkills = new Set<string>();
    for (const target of targets) {
      for (const skill of profile.enabledSkills.filter((entry) => entry.targets.includes(target))) {
        if (skill.source === "git" && updatedGitSkills.has(skill.name)) continue;
        console.log(await updateSkill(paths, skill, target, options.dryRun ?? false));
        if (skill.source === "git") updatedGitSkills.add(skill.name);
      }
    }
  });

function parseAgentOption(agent: string | undefined): AgentName | undefined {
  if (!agent) return undefined;
  if (agent === "opencode" || agent === "claude-code" || agent === "codex" || agent === "pi")
    return agent;
  throw new Error(`Unknown agent: ${agent}`);
}

async function setMcpEnabled(
  name: string,
  enabled: boolean,
  options: { agent?: string | undefined }
): Promise<void> {
  const paths = createRuntimePaths(program.opts());
  const profile = await resolveProfile(paths, program.opts().profile);
  const server = profile.mcpServers.find((entry) => entry.name === name);
  if (!server) throw new Error(`Profile ${profile.name} does not declare MCP server: ${name}`);
  const requestedAgent = parseAgentOption(options.agent);
  if (requestedAgent === "pi") {
    throw new Error("Pi MCP toggles are not supported yet");
  }
  const targets = requestedAgent ? [requestedAgent] : (Object.keys(server.agents) as AgentName[]);
  for (const target of targets) {
    if (server.agents[target] === undefined) {
      throw new Error(`MCP server ${name} is not available for ${target}`);
    }
  }
  const projectRoot = await findProjectRoot();
  if (!projectRoot) throw new Error("mfz mcp toggles must be run inside a git repository");
  for (const target of targets) {
    await writeProjectOverrideDelta(paths, profile, projectRoot, target, "mcp", {
      [name]: enabled
    });
  }
  for (const target of targets)
    console.log(`${enabled ? "Enabled" : "Disabled"} ${name} for ${target}`);
}

async function printMcpStatus(): Promise<void> {
  const paths = createRuntimePaths(program.opts());
  const profile = await resolveProfile(paths, program.opts().profile);
  const projectRoot = await findProjectRoot();
  const store = await readOverrideStore(paths.home);
  for (const server of profile.mcpServers) {
    for (const target of Object.keys(server.agents) as AgentName[]) {
      const effective = effectiveProjectState(store, projectRoot, profile, target, "mcp");
      const overrides = projectRoot ? projectOverrides(store, projectRoot, target, "mcp") : {};
      const marker = server.name in overrides ? "\toverridden" : "";
      console.log(
        `${server.name}\t${target}\t${effective[server.name] ? "enabled" : "disabled"}${marker}`
      );
    }
  }
}

const mcp = program.command("mcp").description("Manage project-scoped MCP server toggles");

mcp
  .command("enable")
  .description("Enable an MCP server for this project")
  .argument("<name>", "MCP server name")
  .option("--agent <agent>", "opencode, claude-code, or codex")
  .action(async (name, options) => setMcpEnabled(name, true, options));

mcp
  .command("disable")
  .description("Disable an MCP server for this project")
  .argument("<name>", "MCP server name")
  .option("--agent <agent>", "opencode, claude-code, or codex")
  .action(async (name, options) => setMcpEnabled(name, false, options));

mcp
  .command("status")
  .description("Show merged MCP server state for this project")
  .action(async () => printMcpStatus());

mcp
  .command("tui")
  .description("Toggle MCP servers for this project")
  .action(async () => {
    const paths = createRuntimePaths(program.opts());
    const profile = await resolveProfile(paths, program.opts().profile);
    await runMcpTui(paths, profile);
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
