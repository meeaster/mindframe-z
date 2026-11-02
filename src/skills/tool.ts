import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { execa } from "execa";
import YAML from "yaml";
import { z } from "zod";
import { pathExists, readDirEntries, readTextFile, writeTextFile } from "../core/fs-util.js";
import type { ToolSkillEntry } from "../core/manifests.js";
import type {
  OperationCompletion,
  OperationOutcome,
  PlannedOperationEffect
} from "../core/operations.js";
import { toolSkillPoolDir, type RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile, ResolvedSkill } from "../core/profile.js";
import { fetchCommit, readGitSkillFiles } from "./git.js";
import {
  assertNoSymlinkAncestors,
  copySkillFiles,
  digestSkillFiles,
  digestSkillTree,
  readSkillFiles,
  validateSkillRecords,
  type SkillFileRecord
} from "./tree.js";

/** The machine facts a tool skill refresh depends on. */
export interface ToolSkillHost {
  /** Installed version of a Mise tool in the user's global context, or undefined when absent. */
  toolVersion(tool: string): Promise<string | undefined>;
  /** Variables that put installed tool binaries on PATH without going through Mise shims. */
  toolEnvironment(): Promise<Record<string, string>>;
  fetchRepository(
    repository: string,
    revision: string,
    subtree: string
  ): Promise<{ commit: string; files: SkillFileRecord[] }>;
}

export type EnabledToolSkill = ResolvedSkill & ToolSkillEntry;

export interface ToolSkillRefreshOptions {
  names?: readonly string[];
  tool?: string;
  dryRun?: boolean;
  host?: ToolSkillHost;
  onComplete?: OperationCompletion;
}

const poolManifestFile = ".mfz-skills.yml";

const recordedSourceSchema = z.union([
  z.object({ repo: z.string(), tag: z.string().optional(), subtree: z.string() }).strict(),
  z.object({ generate: z.object({ run: z.string(), path: z.string() }).strict() }).strict()
]);

type RecordedSource = z.infer<typeof recordedSourceSchema>;

const poolEntrySchema = z
  .object({
    tool: z.string(),
    version: z.string(),
    source: recordedSourceSchema,
    commit: z.string().optional(),
    digest: z.string()
  })
  .strict();

const poolManifestSchema = z
  .object({
    version: z.literal(1),
    skills: z.record(z.string(), poolEntrySchema).default({})
  })
  .strict();

type PoolEntry = z.infer<typeof poolEntrySchema>;

type PoolManifest = z.infer<typeof poolManifestSchema>;

const miseCurrentSchema = z.array(z.object({ version: z.string(), installed: z.boolean() }));

const miseEnvironmentSchema = z.record(z.string(), z.string());

// Generators run against an isolated home, so harness overrides must not leak real config paths.
const redirectedVariables = new Set([
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "OPENCODE_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME"
]);

export function miseToolSkillHost(paths: RuntimePaths): ToolSkillHost {
  let environment: Promise<Record<string, string>> | undefined;

  return {
    async toolVersion(tool) {
      const result = await execa("mise", ["ls", "--current", "--json", tool], {
        cwd: paths.home,
        reject: false
      });

      if (result.exitCode !== 0) return undefined;
      const parsed = miseCurrentSchema.safeParse(JSON.parse(result.stdout));

      return parsed.success ? parsed.data.find((entry) => entry.installed)?.version : undefined;
    },
    toolEnvironment() {
      environment ??= execa("mise", ["env", "--json"], { cwd: paths.home }).then((result) =>
        miseEnvironmentSchema.parse(JSON.parse(result.stdout))
      );

      return environment;
    },
    async fetchRepository(repository, revision, subtree) {
      const { cache, commit } = await fetchCommit(paths, repository, revision);

      return { commit, files: await readGitSkillFiles(cache, commit, subtree) };
    }
  };
}

export function toolSkillSourcePath(paths: RuntimePaths, name: string): string {
  return path.join(toolSkillPoolDir(paths), name);
}

function isToolSkill(skill: ResolvedSkill): skill is EnabledToolSkill {
  return skill.source === "tool";
}

/** The part of a resolved profile tool skills depend on. */
export type ToolSkillProfile = Pick<ResolvedProfile, "name" | "enabledSkills">;

export function enabledToolSkills(profile: ToolSkillProfile): EnabledToolSkill[] {
  return profile.enabledSkills.filter(isToolSkill);
}

/** Where a skill comes from, as recorded in the pool; a change forces a refresh. */
function recordedSource(skill: ToolSkillEntry): RecordedSource {
  if ("generate" in skill) return { generate: { ...skill.generate } };

  return skill.tag === undefined
    ? { repo: skill.repo, subtree: skill.subtree }
    : { repo: skill.repo, tag: skill.tag, subtree: skill.subtree };
}

async function readPoolManifest(pool: string): Promise<PoolManifest> {
  const content = await readTextFile(path.join(pool, poolManifestFile));

  if (content === undefined) return { version: 1, skills: {} };

  return poolManifestSchema.parse(YAML.parse(content));
}

async function writePoolManifest(pool: string, manifest: PoolManifest): Promise<void> {
  const file = path.join(pool, poolManifestFile);
  const temp = `${file}.${process.pid}.tmp`;

  await writeTextFile(temp, YAML.stringify(manifest));
  await rename(temp, file);
}

async function currentDigest(directory: string): Promise<string | undefined> {
  try {
    return await digestSkillTree(directory);
  } catch {
    return undefined;
  }
}

function generatorEnvironment(
  toolEnvironment: Record<string, string>,
  home: string,
  version: string
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !redirectedVariables.has(name)) environment[name] = value;
  }

  Object.assign(environment, toolEnvironment);

  // Shims resolve tools through the real home's Mise config, which the isolated HOME hides.
  environment.PATH = (environment.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => !entry.endsWith(`${path.sep}mise${path.sep}shims`))
    .join(path.delimiter);
  environment.HOME = home;
  environment.XDG_CONFIG_HOME = path.join(home, ".config");
  environment.XDG_DATA_HOME = path.join(home, ".local", "share");
  environment.XDG_CACHE_HOME = path.join(home, ".cache");
  environment.XDG_STATE_HOME = path.join(home, ".local", "state");
  environment.MFZ_TOOL_VERSION = version;

  return environment;
}

async function runGenerator(host: ToolSkillHost, run: string, version: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "mfz-tool-skill-"));
  const project = path.join(root, "project");
  const home = path.join(root, "home");

  await mkdir(project);
  await mkdir(home);

  await execa("sh", ["-c", run], {
    cwd: project,
    env: generatorEnvironment(await host.toolEnvironment(), home, version),
    extendEnv: false,
    timeout: 600_000
  });

  return root;
}

function generatedSkillPath(root: string, template: string, name: string): string {
  const relative = template.replaceAll("{name}", name);

  return relative.startsWith("~/")
    ? path.join(root, "home", relative.slice(2))
    : path.join(root, "project", relative);
}

function tagCandidates(tag: string | undefined, version: string): string[] {
  return tag === undefined ? [`v${version}`, version] : [tag.replaceAll("{version}", version)];
}

interface FetchedSkill {
  files: SkillFileRecord[];
  commit?: string;
}

interface RefreshContext {
  host: ToolSkillHost;
  /** One sandbox per generator command and tool version, shared by the skills it produces. */
  generators: Map<string, Promise<string>>;
}

async function fetchToolSkill(
  context: RefreshContext,
  skill: EnabledToolSkill,
  version: string
): Promise<FetchedSkill> {
  if ("generate" in skill) {
    const key = JSON.stringify([skill.tool, version, skill.generate.run]);
    let generated = context.generators.get(key);

    if (generated === undefined) {
      generated = runGenerator(context.host, skill.generate.run, version);
      context.generators.set(key, generated);
    }

    const root = await generated;

    return {
      files: await readSkillFiles(generatedSkillPath(root, skill.generate.path, skill.name))
    };
  }

  const failures: string[] = [];

  for (const tag of tagCandidates(skill.tag, version)) {
    try {
      return await context.host.fetchRepository(skill.repo, `refs/tags/${tag}`, skill.subtree);
    } catch (error) {
      failures.push(`${tag}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    `No usable tag for ${skill.tool}@${version} in ${skill.repo} (${failures.join("; ")})`
  );
}

async function installSkill(pool: string, name: string, files: readonly SkillFileRecord[]) {
  const target = path.join(pool, name);
  const staging = path.join(pool, `.staging-${name}-${process.pid}`);
  const retired = path.join(pool, `.retired-${name}-${process.pid}`);

  await rm(staging, { recursive: true, force: true });
  await copySkillFiles(files, staging);

  const replacing = await pathExists(target);

  if (replacing) await rename(target, retired);
  await rename(staging, target);

  if (replacing) await rm(retired, { recursive: true, force: true });
}

interface OutcomeDetails {
  before?: string | undefined;
  after?: string | undefined;
  detail?: string | undefined;
  plannedEffect?: PlannedOperationEffect | undefined;
}

function outcome(
  target: string,
  status: OperationOutcome["status"],
  details: OutcomeDetails
): OperationOutcome {
  const result: OperationOutcome = {
    category: "skill",
    action: "write",
    status,
    target,
    significance: status === "unchanged" ? "internal" : "meaningful"
  };

  if (details.before !== undefined) result.before = details.before;

  if (details.after !== undefined) result.after = details.after;

  if (details.detail !== undefined) result.detail = details.detail;

  if (details.plannedEffect !== undefined) result.plannedEffect = details.plannedEffect;

  return result;
}

async function refreshSkill(
  context: RefreshContext,
  pool: string,
  manifest: PoolManifest,
  skill: EnabledToolSkill,
  dryRun: boolean
): Promise<OperationOutcome> {
  const target = path.join(pool, skill.name);
  const recorded = manifest.skills[skill.name];
  const version = await context.host.toolVersion(skill.tool);

  if (version === undefined) {
    const detail = `${skill.tool} is not installed`;

    if (recorded === undefined && !(await pathExists(target))) {
      return outcome(target, "skipped", { detail });
    }

    if (dryRun) return outcome(target, "planned", { detail, plannedEffect: "remove" });
    await rm(target, { recursive: true, force: true });
    delete manifest.skills[skill.name];

    return outcome(target, "removed", { detail });
  }

  const source = recordedSource(skill);

  if (
    recorded?.tool === skill.tool &&
    recorded.version === version &&
    isDeepStrictEqual(recorded.source, source) &&
    (await currentDigest(target)) === recorded.digest
  ) {
    return outcome(target, "unchanged", { after: version });
  }

  const versions = { before: recorded?.version, after: version };

  if (dryRun) {
    return outcome(target, "planned", {
      ...versions,
      plannedEffect: recorded === undefined ? "add" : "update"
    });
  }

  try {
    const fetched = await fetchToolSkill(context, skill, version);

    validateSkillRecords(fetched.files);
    await installSkill(pool, skill.name, fetched.files);

    const entry: PoolEntry = {
      tool: skill.tool,
      version,
      source,
      digest: digestSkillFiles(fetched.files)
    };

    if (fetched.commit !== undefined) entry.commit = fetched.commit;
    manifest.skills[skill.name] = entry;

    return outcome(target, recorded === undefined ? "created" : "updated", versions);
  } catch (error) {
    // The previous copy stays in place; a failed refresh never leaves a skill missing.
    return outcome(target, "failed", {
      ...versions,
      detail: error instanceof Error ? error.message : String(error)
    });
  }
}

const POOL_LOCK_WAIT_MS = 10 * 60_000;

// mise runs tool postinstall hooks in parallel, so several `mfz skills refresh --tool` processes
// can update the pool at once; without this lock each rewrites the pool manifest from its own
// stale copy and drops the others' records. A crashed holder leaves the lock directory behind,
// and the timeout error names it for manual removal.
async function withPoolLock<T>(pool: string, run: () => Promise<T>): Promise<T> {
  const lock = `${pool}.lock`;
  const deadline = Date.now() + POOL_LOCK_WAIT_MS;
  await mkdir(path.dirname(lock), { recursive: true });

  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      // SAFETY: mkdir rejects with an ErrnoException carrying the filesystem error code.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for the tool skill pool lock ${lock}; remove it if no mfz process is running`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  try {
    return await run();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/**
 * Bring the machine-local tool skill pool in line with installed tool versions. A full refresh
 * also removes pool skills the profile no longer enables; a refresh narrowed by name or tool
 * touches only the selected skills.
 */
export async function refreshToolSkills(
  paths: RuntimePaths,
  profile: ToolSkillProfile,
  options: ToolSkillRefreshOptions = {}
): Promise<OperationOutcome[]> {
  if (options.dryRun) return refreshToolSkillsLocked(paths, profile, options);

  await assertNoSymlinkAncestors(paths.home, toolSkillPoolDir(paths));

  return withPoolLock(toolSkillPoolDir(paths), () =>
    refreshToolSkillsLocked(paths, profile, options)
  );
}

async function refreshToolSkillsLocked(
  paths: RuntimePaths,
  profile: ToolSkillProfile,
  options: ToolSkillRefreshOptions
): Promise<OperationOutcome[]> {
  const enabled = enabledToolSkills(profile);

  for (const name of options.names ?? []) {
    if (!enabled.some((skill) => skill.name === name)) {
      throw new Error(`Not a tool skill enabled in profile ${profile.name}: ${name}`);
    }
  }

  const selected = enabled.filter(
    (skill) =>
      (options.names === undefined || options.names.includes(skill.name)) &&
      (options.tool === undefined || skill.tool === options.tool)
  );

  const partial = options.names !== undefined || options.tool !== undefined;
  const dryRun = options.dryRun ?? false;
  const pool = toolSkillPoolDir(paths);
  const manifest = await readPoolManifest(pool);

  const context: RefreshContext = {
    host: options.host ?? miseToolSkillHost(paths),
    generators: new Map()
  };

  const outcomes: OperationOutcome[] = [];

  const complete = (result: OperationOutcome): void => {
    outcomes.push(result);
    options.onComplete?.(result);
  };

  if (!dryRun) {
    await assertNoSymlinkAncestors(paths.home, pool);
    await mkdir(pool, { recursive: true });
  }

  try {
    for (const skill of selected)
      complete(await refreshSkill(context, pool, manifest, skill, dryRun));

    if (!partial) {
      for (const name of Object.keys(manifest.skills)) {
        if (enabled.some((skill) => skill.name === name)) continue;
        const target = path.join(pool, name);

        if (dryRun) {
          complete(
            outcome(target, "planned", { detail: "no longer enabled", plannedEffect: "remove" })
          );
          continue;
        }

        await rm(target, { recursive: true, force: true });
        delete manifest.skills[name];
        complete(outcome(target, "removed", { detail: "no longer enabled" }));
      }
    }
  } finally {
    const roots = await Promise.allSettled(context.generators.values());

    for (const root of roots) {
      if (root.status === "fulfilled") await rm(root.value, { recursive: true, force: true });
    }

    if (!dryRun) await writePoolManifest(pool, manifest);
  }

  return outcomes;
}

/** `doctor` lines describing each enabled tool skill and any pool directory MFZ did not record. */
export async function toolSkillDiagnostics(
  paths: RuntimePaths,
  profile: ToolSkillProfile,
  host: ToolSkillHost = miseToolSkillHost(paths)
): Promise<string[]> {
  const pool = toolSkillPoolDir(paths);
  const manifest = await readPoolManifest(pool);
  const lines: string[] = [];

  for (const skill of enabledToolSkills(profile)) {
    const version = await host.toolVersion(skill.tool);
    const recorded = manifest.skills[skill.name];

    if (version === undefined) {
      lines.push(`tool-skill:missing\t${skill.name}\t${skill.tool} is not installed`);
    } else if (recorded === undefined) {
      lines.push(`tool-skill:missing\t${skill.name}\trun mfz skills refresh`);
    } else if (
      recorded.version !== version ||
      !isDeepStrictEqual(recorded.source, recordedSource(skill))
    ) {
      lines.push(
        `tool-skill:stale\t${skill.name}\t${recorded.version} -> ${version}\trun mfz skills refresh`
      );
    } else if ((await currentDigest(path.join(pool, skill.name))) !== recorded.digest) {
      lines.push(
        `tool-skill:modified\t${skill.name}\tfiles differ from the recorded digest; the next refresh replaces them`
      );
    } else {
      lines.push(`tool-skill:ok\t${skill.name}\t${skill.tool}@${version}`);
    }
  }

  for (const entry of await readDirEntries(pool)) {
    if (entry.name.startsWith(".") || entry.name in manifest.skills) continue;
    lines.push(`tool-skill:unmanaged\t${path.join(pool, entry.name)}\tnot recorded by mfz`);
  }

  return lines;
}
