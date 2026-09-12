import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { z } from "zod";
import {
  materializeEngineSkill,
  materializeReviewSkill,
  engineSkillName,
  skillUpdateReviewName
} from "../core/engine-skill.js";
import { readDirEntries } from "../core/fs-util.js";
import {
  opencodeSkillSnapshotDir,
  providerSkillSnapshotDir,
  skillSnapshotDir,
  type AgentName,
  type RuntimePaths
} from "../core/paths.js";
import {
  vendoredSkillTargetSchema,
  type CapabilityAgentName,
  type VendoredSkillTarget
} from "../core/manifests.js";
import type { ResolvedProfile, ResolvedSkill } from "../core/profile.js";
import {
  digestSkillFiles,
  readSkillFiles,
  validateSkillRecords,
  vendoredSkillSourcePath
} from "./vendor.js";
import { assertNoSymlinkAncestors } from "./tree.js";
import { readPinnedGitSkillFiles } from "./git.js";
import type { OperationCompletion, OperationOutcome } from "../core/operations.js";

type SkillTarget = Exclude<AgentName, "pi">;

type NonOpenCodeSkillTarget = Exclude<SkillTarget, "opencode">;

type ManagedSnapshotOptions = { dryRun?: boolean; onComplete?: OperationCompletion };

function capabilityTarget(target: SkillTarget): CapabilityAgentName {
  return target;
}

const snapshotManifestSchema = z
  .object({
    version: z.literal(1),
    profile: z.string(),
    skills: z.array(
      z
        .object({
          name: z.string(),
          source: z.enum(["local", "vendored", "git", "engine"]),
          digest: z.string(),
          targets: z.array(z.enum(["opencode", "claude-code", "codex"])),
          variant: vendoredSkillTargetSchema.optional(),
          repository: z.string().optional(),
          ref: z.string().optional(),
          subtree: z.string().optional(),
          commit: z.string().optional(),
          sourceRoot: z.string(),
          sourcePath: z.string()
        })
        .strict()
    )
  })
  .strict();

function errorCode(error: Error): string | undefined {
  // SAFETY: Node filesystem failures expose their stable errno code on Error objects.
  return (error as NodeJS.ErrnoException).code;
}

interface SnapshotSkill {
  name: string;
  source: "local" | "vendored" | "git" | "engine";
  digest: string;
  targets: SkillTarget[];
  variant?: VendoredSkillTarget;
  repository?: string;
  ref?: string;
  subtree?: string;
  commit?: string;
  sourceRoot: string;
  sourcePath: string;
}

interface SnapshotManifest {
  version: 1;
  profile: string;
  skills: SnapshotSkill[];
}

interface LinkPlan {
  linkPath: string;
  targetPath: string;
}

interface LinkSnapshot {
  directories: string[];
  managed: Map<string, string>;
}

interface SnapshotInspection {
  previousManifest: SnapshotManifest | undefined;
  outcomes: OperationOutcome[];
  replacementRequired: boolean;
}

interface SnapshotRenderOptions {
  snapshotDir?: string;
  excludeProviderVariants?: boolean;
}

function isManagedTarget(configsDir: string, target: string): boolean {
  const relative = path.relative(configsDir, target);

  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sourcePath(skill: ResolvedSkill, target?: SkillTarget): string {
  if (skill.source === "vendored") {
    if ("variants" in skill) {
      if (target === undefined) {
        throw new Error(`Provider variant skill ${skill.name} requires a target snapshot`);
      }

      return vendoredSkillSourcePath(skill.sourceRoot, skill.name, target);
    }

    return vendoredSkillSourcePath(skill.sourceRoot, skill.name);
  }

  if (skill.source === "git") return `git:${skill.repo}#${skill.subtree}@${skill.commit}`;

  return path.join(skill.sourceRoot, "skills", skill.skill ?? skill.name);
}

function snapshotManifestPath(snapshot: string): string {
  return path.join(snapshot, ".mfz-manifest.yml");
}

function relativeLinkTarget(linkPath: string, targetPath: string): string {
  const relative = path.relative(path.dirname(linkPath), targetPath);

  return relative || ".";
}

type GitSkill = Extract<ResolvedSkill, { source: "git" }>;

interface SnapshotSource {
  sourcePath: string;
  git?: GitSkill;
}

async function copySource(
  paths: RuntimePaths,
  source: SnapshotSource,
  destination: string
): Promise<string> {
  const files = source.git
    ? await readPinnedGitSkillFiles(paths, source.git)
    : await readSkillFiles(source.sourcePath);

  validateSkillRecords(files);
  await mkdir(destination, { recursive: true });

  for (const file of files) {
    const target = path.join(destination, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes, { mode: file.mode === "100755" ? 0o755 : 0o644 });
  }

  return digestSkillFiles(files);
}

function linkDirectories(paths: RuntimePaths, targets: readonly SkillTarget[]): string[] {
  return [
    ...new Set(
      targets.map((target) =>
        target === "claude-code"
          ? path.join(paths.claudeDir, "skills")
          : target === "opencode"
            ? path.join(paths.opencodeConfigDir, "skills")
            : path.join(paths.home, ".agents", "skills")
      )
    )
  ];
}

async function skillLinkDir(paths: RuntimePaths, target: SkillTarget): Promise<string> {
  if (target === "claude-code") return path.join(paths.claudeDir, "skills");

  if (target === "opencode") return path.join(paths.opencodeConfigDir, "skills");

  return path.join(paths.home, ".agents", "skills");
}

async function assertLinkDirectory(directory: string): Promise<void> {
  await assertNoSymlinkAncestors(path.parse(path.resolve(directory)).root, directory);

  try {
    const stat = await lstat(directory);

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Skill link directory is not a real directory: ${directory}`);
    }
  } catch (error) {
    if (!(error instanceof Error) || errorCode(error) !== "ENOENT") throw error;
  }
}

async function linkStatus(
  linkPath: string
): Promise<
  | { state: "missing" }
  | { state: "directory" | "file" }
  | { state: "symlink"; target: string; resolved: string }
> {
  try {
    const stat = await lstat(linkPath);

    if (!stat.isSymbolicLink()) return { state: stat.isDirectory() ? "directory" : "file" };
    const target = await readlink(linkPath);

    return { state: "symlink", target, resolved: path.resolve(path.dirname(linkPath), target) };
  } catch (error) {
    if (error instanceof Error && errorCode(error) === "ENOENT") return { state: "missing" };
    throw error;
  }
}

async function preflightLinks(
  paths: RuntimePaths,
  plans: readonly LinkPlan[],
  directories: readonly string[] = [...new Set(plans.map((plan) => path.dirname(plan.linkPath)))]
): Promise<void> {
  for (const directory of directories) await assertLinkDirectory(directory);
  const desired = new Set(plans.map((plan) => plan.linkPath));

  for (const directory of directories) {
    for (const entry of await readDirEntries(directory)) {
      const linkPath = path.join(directory, entry.name);
      const status = await linkStatus(linkPath);

      if (status.state === "symlink" && isManagedTarget(paths.configsDir, status.resolved)) {
        continue;
      }

      if (desired.has(linkPath)) {
        throw new Error(`Unmanaged skill link conflict: ${linkPath}`);
      }
    }
  }

  for (const plan of plans) {
    const status = await linkStatus(plan.linkPath);

    if (status.state === "missing") continue;

    if (status.state !== "symlink" || !isManagedTarget(paths.configsDir, status.resolved)) {
      throw new Error(`Unmanaged skill link conflict: ${plan.linkPath}`);
    }
  }
}

async function reconcileLinks(
  paths: RuntimePaths,
  plans: readonly LinkPlan[],
  directories: readonly string[]
): Promise<OperationOutcome[]> {
  const outcomes: OperationOutcome[] = [];
  await preflightLinks(paths, plans, directories);
  const desired = new Set(plans.map((plan) => plan.linkPath));

  for (const directory of directories) {
    await mkdir(directory, { recursive: true });

    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const linkPath = path.join(directory, entry.name);
      const status = await linkStatus(linkPath);

      if (
        status.state === "symlink" &&
        isManagedTarget(paths.configsDir, status.resolved) &&
        !desired.has(linkPath)
      ) {
        await rm(linkPath, { force: true });
        outcomes.push({
          category: "link",
          action: "remove",
          status: "removed",
          target: linkPath,
          significance: "meaningful"
        });
      }
    }
  }

  for (const plan of plans) {
    const status = await linkStatus(plan.linkPath);
    const relative = relativeLinkTarget(plan.linkPath, plan.targetPath);

    if (status.state === "symlink" && status.resolved === path.resolve(plan.targetPath)) {
      outcomes.push({
        category: "link",
        action: "link",
        status: "unchanged",
        target: plan.linkPath,
        significance: "meaningful",
        detail: plan.targetPath
      });
      continue;
    }

    if (status.state === "symlink") await rm(plan.linkPath, { force: true });
    await symlink(relative, plan.linkPath, "dir");
    outcomes.push({
      category: "link",
      action: "link",
      status: status.state === "missing" ? "linked" : "relinked",
      target: plan.linkPath,
      significance: "meaningful",
      changes: ["destination"],
      detail:
        status.state === "symlink"
          ? `${status.resolved} -> ${path.resolve(plan.targetPath)}`
          : plan.targetPath
    });
  }

  return outcomes;
}

async function captureManagedLinks(
  paths: RuntimePaths,
  directories: readonly string[]
): Promise<LinkSnapshot> {
  const managed = new Map<string, string>();

  for (const directory of directories) {
    await assertLinkDirectory(directory);

    for (const entry of await readDirEntries(directory)) {
      const linkPath = path.join(directory, entry.name);
      const status = await linkStatus(linkPath);

      if (status.state === "symlink" && isManagedTarget(paths.configsDir, status.resolved)) {
        managed.set(linkPath, status.resolved);
      }
    }
  }

  return { directories: [...directories], managed };
}

async function restoreManagedLinks(paths: RuntimePaths, snapshot: LinkSnapshot): Promise<void> {
  for (const directory of snapshot.directories) {
    await assertLinkDirectory(directory);

    for (const entry of await readDirEntries(directory)) {
      const linkPath = path.join(directory, entry.name);
      const status = await linkStatus(linkPath);

      if (status.state === "symlink" && isManagedTarget(paths.configsDir, status.resolved)) {
        await rm(linkPath, { force: true });
      }
    }
  }

  for (const [linkPath, targetPath] of snapshot.managed) {
    const status = await linkStatus(linkPath);

    if (status.state !== "missing") {
      if (status.state === "symlink" && status.resolved === targetPath) continue;
      throw new Error(`Cannot restore managed skill link: ${linkPath}`);
    }

    await mkdir(path.dirname(linkPath), { recursive: true });
    await symlink(relativeLinkTarget(linkPath, targetPath), linkPath, "dir");
  }
}

function linksMatch(plans: readonly LinkPlan[], current: LinkSnapshot): boolean {
  const desired = new Map(plans.map((plan) => [plan.linkPath, path.resolve(plan.targetPath)]));

  if (current.managed.size !== desired.size) return false;

  for (const [linkPath, targetPath] of desired) {
    if (current.managed.get(linkPath) !== targetPath) return false;
  }

  return true;
}

function desiredTargets(skill: ResolvedSkill, selected: readonly SkillTarget[]): SkillTarget[] {
  return selected.filter((target) => skill.targets.includes(capabilityTarget(target)));
}

function selectedVariantTarget(
  skill: ResolvedSkill,
  targets: readonly SkillTarget[]
): SkillTarget | undefined {
  if (!("variants" in skill)) return undefined;

  if (targets.length !== 1) {
    throw new Error(`Provider variant skill ${skill.name} requires one target snapshot`);
  }

  return targets[0];
}

function engineTargets(profile: ResolvedProfile, selected: readonly SkillTarget[]): SkillTarget[] {
  return selected.filter((target) => profile.agents.includes(target));
}

function hasProviderVariant(profile: ResolvedProfile, target: NonOpenCodeSkillTarget): boolean {
  return profile.enabledSkills.some(
    (skill) => "variants" in skill && skill.targets.includes(capabilityTarget(target))
  );
}

function nonOpenCodeVariantTargets(profile: ResolvedProfile): NonOpenCodeSkillTarget[] {
  return profile.agents.filter(
    (target): target is NonOpenCodeSkillTarget =>
      isNonOpenCodeSkillTarget(target) && hasProviderVariant(profile, target)
  );
}

export async function renderSkillSnapshot(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  selectedTargets: readonly SkillTarget[] = ["opencode", "claude-code", "codex"],
  options: SnapshotRenderOptions = {}
): Promise<{ manifest: SnapshotManifest; links: LinkPlan[]; temporaryPath: string }> {
  const engineEntries: Array<{
    name: string;
    sourceRoot: string;
    skill: string;
    source: "engine";
  }> = [];

  if (!profile.manifests.skills.some((skill) => skill.name === engineSkillName)) {
    const engine = await materializeEngineSkill(paths);
    engineEntries.push({
      name: engine.name,
      sourceRoot: engine.sourceRoot,
      skill: engineSkillName,
      source: "engine"
    });
  }

  const review = await materializeReviewSkill(paths);
  engineEntries.push({
    name: review.name,
    sourceRoot: review.sourceRoot,
    skill: skillUpdateReviewName,
    source: "engine"
  });

  const selected: SnapshotSkill[] = [];
  const sources = new Map<string, SnapshotSource>();

  for (const skill of profile.enabledSkills) {
    if (options.excludeProviderVariants && "variants" in skill) continue;
    const targets = desiredTargets(skill, selectedTargets);

    if (targets.length === 0) continue;
    const variantTarget = selectedVariantTarget(skill, targets);
    const source = skill.source;
    const skillSourcePath = sourcePath(skill, variantTarget);
    const snapshotSource: SnapshotSource = { sourcePath: skillSourcePath };

    if (skill.source === "git") snapshotSource.git = skill;
    sources.set(skill.name, snapshotSource);

    const selectedSkill: SnapshotSkill = {
      name: skill.name,
      source,
      digest: "",
      targets,
      sourceRoot: skill.sourceRoot,
      sourcePath: skillSourcePath
    };

    if (skill.source === "vendored" && skill.vendor) {
      if ("variants" in skill) {
        if (variantTarget === undefined || !("variants" in skill.vendor)) {
          throw new Error(`Provider variant skill ${skill.name} has incomplete vendor provenance`);
        }

        Object.assign(selectedSkill, {
          repository: skill.vendor.repository,
          ref: skill.vendor.ref,
          variant: variantTarget,
          subtree: skill.vendor.variants[variantTarget].subtree,
          commit: skill.vendor.commit
        });
      } else {
        if ("variants" in skill.vendor) {
          throw new Error(`Single-subtree skill ${skill.name} has variant vendor provenance`);
        }

        Object.assign(selectedSkill, {
          repository: skill.vendor.repository,
          ref: skill.vendor.ref,
          subtree: skill.vendor.subtree,
          commit: skill.vendor.commit
        });
      }
    }

    if (skill.source === "git") {
      Object.assign(selectedSkill, {
        repository: skill.repo,
        subtree: skill.subtree,
        commit: skill.commit
      });
    }

    selected.push(selectedSkill);
  }

  for (const entry of engineEntries) {
    const targets = engineTargets(profile, selectedTargets);

    if (targets.length === 0 || selected.some((skill) => skill.name === entry.name)) continue;
    sources.set(entry.name, {
      sourcePath: path.join(entry.sourceRoot, "skills", entry.skill)
    });
    const entrySourcePath = path.join(entry.sourceRoot, "skills", entry.skill);
    selected.push({
      name: entry.name,
      source: entry.source,
      digest: "",
      targets,
      sourceRoot: entry.sourceRoot,
      sourcePath: entrySourcePath
    });
  }

  selected.sort((a, b) => a.name.localeCompare(b.name));

  const snapshot = options.snapshotDir ?? skillSnapshotDir(paths, profile.name);
  await assertNoSymlinkAncestors(paths.home, snapshot);
  const temporary = `${snapshot}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const backup = `${snapshot}.bak-${process.pid}`;
  await rm(temporary, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await mkdir(path.dirname(snapshot), { recursive: true });
  await mkdir(temporary, { recursive: true });
  const manifest: SnapshotManifest = { version: 1, profile: profile.name, skills: selected };

  try {
    for (const skill of selected) {
      const source = sources.get(skill.name);

      if (!source) throw new Error(`Missing source for skill ${skill.name}`);
      skill.digest = await copySource(paths, source, path.join(temporary, skill.name));
    }

    await writeFile(
      path.join(temporary, path.relative(snapshot, snapshotManifestPath(snapshot))),
      YAML.stringify(manifest),
      "utf8"
    );
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }

  const links: LinkPlan[] = [];

  for (const skill of selected) {
    for (const target of skill.targets) {
      const directory = await skillLinkDir(paths, target);
      links.push({
        linkPath: path.join(directory, skill.name),
        targetPath: path.join(snapshot, skill.name)
      });
    }
  }

  // OpenCode and Codex intentionally share one physical directory.
  const uniqueLinks = [...new Map(links.map((link) => [link.linkPath, link])).values()];

  return { manifest, links: uniqueLinks, temporaryPath: temporary };
}

async function readSnapshotManifest(snapshot: string): Promise<SnapshotManifest | undefined> {
  try {
    const parsed = snapshotManifestSchema.parse(
      YAML.parse(await readFile(snapshotManifestPath(snapshot), "utf8"))
    );

    return {
      version: parsed.version,
      profile: parsed.profile,
      skills: parsed.skills.map((skill) => {
        const exact: SnapshotSkill = {
          name: skill.name,
          source: skill.source,
          digest: skill.digest,
          targets: skill.targets,
          sourceRoot: skill.sourceRoot,
          sourcePath: skill.sourcePath
        };

        if (skill.variant !== undefined) exact.variant = skill.variant;

        if (skill.repository !== undefined) exact.repository = skill.repository;

        if (skill.ref !== undefined) exact.ref = skill.ref;

        if (skill.subtree !== undefined) exact.subtree = skill.subtree;

        if (skill.commit !== undefined) exact.commit = skill.commit;

        return exact;
      })
    };
  } catch (error) {
    if (error instanceof Error && errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function removeManagedSkillSnapshot(
  paths: RuntimePaths,
  snapshot: string,
  options: ManagedSnapshotOptions = {}
): Promise<OperationOutcome[]> {
  await assertNoSymlinkAncestors(paths.home, snapshot);
  let stat;

  try {
    stat = await lstat(snapshot);
  } catch (error) {
    if (error instanceof Error && errorCode(error) === "ENOENT") return [];
    throw error;
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Skill snapshot is not a real directory: ${snapshot}`);
  }

  if (!(await readSnapshotManifest(snapshot))) {
    throw new Error(`Cannot remove unmanaged skill snapshot: ${snapshot}`);
  }

  if (!options.dryRun) await rm(snapshot, { recursive: true, force: true });

  const outcome: OperationOutcome = {
    category: "bookkeeping",
    action: "snapshot",
    status: options.dryRun ? "planned" : "removed",
    target: snapshot,
    significance: "internal"
  };

  if (options.dryRun && !options.onComplete)
    console.log(`would remove skill snapshot\t${snapshot}`);
  options.onComplete?.(outcome);

  return [outcome];
}

async function inspectSnapshot(
  snapshot: string,
  next: SnapshotManifest
): Promise<SnapshotInspection> {
  const previous = await readSnapshotManifest(snapshot);
  const before = new Map(previous?.skills.map((skill) => [skill.name, skill]));
  const after = new Map(next.skills.map((skill) => [skill.name, skill]));
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  let treeDrift = false;
  const outcomes: OperationOutcome[] = [];

  for (const name of names) {
    const oldSkill = before.get(name);
    const newSkill = after.get(name);

    if (!oldSkill) {
      if (!newSkill) throw new Error(`Skill ${name} is absent from both snapshots`);
      outcomes.push({
        category: "skill",
        action: "snapshot",
        status: "created",
        target: name,
        significance: "meaningful",
        detail: newSkill.digest
      });
      continue;
    }

    if (!newSkill) {
      outcomes.push({
        category: "skill",
        action: "snapshot",
        status: "removed",
        target: name,
        significance: "meaningful",
        detail: oldSkill.digest
      });
      continue;
    }

    let installedDigest: string | undefined;

    try {
      installedDigest = digestSkillFiles(await readSkillFiles(path.join(snapshot, name)));
    } catch (error) {
      if (!(error instanceof Error) || errorCode(error) !== "ENOENT") throw error;
    }

    const installedChanged = installedDigest !== newSkill.digest;
    treeDrift ||= installedChanged;

    const changed =
      oldSkill.digest !== newSkill.digest ||
      JSON.stringify(oldSkill.targets) !== JSON.stringify(newSkill.targets) ||
      installedChanged;

    outcomes.push({
      category: "skill",
      action: "snapshot",
      status: changed ? "updated" : "unchanged",
      target: name,
      significance: "meaningful",
      detail: changed ? `${installedDigest ?? "missing"} -> ${newSkill.digest}` : newSkill.digest
    });
  }

  return {
    previousManifest: previous,
    outcomes,
    replacementRequired: !isDeepStrictEqual(previous, next) || treeDrift
  };
}

function selectedSkillNames(
  profile: ResolvedProfile,
  renderTargets: readonly SkillTarget[],
  options: Pick<SnapshotRenderOptions, "excludeProviderVariants"> = {}
): Set<string> {
  const names = new Set<string>();

  for (const skill of profile.enabledSkills) {
    if (options.excludeProviderVariants && "variants" in skill) continue;

    if (renderTargets.some((target) => skill.targets.includes(capabilityTarget(target)))) {
      names.add(skill.name);
    }
  }

  if (!profile.manifests.skills.some((skill) => skill.name === engineSkillName))
    names.add(engineSkillName);

  if (renderTargets.length > 0) names.add(skillUpdateReviewName);

  return names;
}

function selectedLinkPlans(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  snapshot: string,
  selectedTargets: readonly SkillTarget[],
  renderTargets: readonly SkillTarget[],
  options: Pick<SnapshotRenderOptions, "excludeProviderVariants"> = {}
): LinkPlan[] {
  const links: LinkPlan[] = [];

  for (const name of selectedSkillNames(profile, renderTargets, options)) {
    const declared = profile.enabledSkills.find((skill) => skill.name === name);

    const targets = declared
      ? selectedTargets.filter((target) => declared.targets.includes(capabilityTarget(target)))
      : selectedTargets.filter((target) => renderTargets.includes(target));

    for (const target of targets) {
      const directory =
        target === "claude-code"
          ? paths.claudeDir
          : target === "opencode"
            ? paths.opencodeConfigDir
            : path.join(paths.home, ".agents");

      links.push({
        linkPath: path.join(directory, "skills", name),
        targetPath: path.join(snapshot, name)
      });
    }
  }

  return [...new Map(links.map((link) => [link.linkPath, link])).values()];
}

async function syncSkillSnapshotGroup(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  selectedTargets: readonly SkillTarget[],
  renderTargets: readonly SkillTarget[],
  snapshot: string,
  options: {
    dryRun?: boolean;
    link?: boolean;
    onComplete?: OperationCompletion;
    excludeProviderVariants?: boolean;
  }
): Promise<OperationOutcome[]> {
  if (selectedTargets.length === 0) return [];
  const directories = linkDirectories(paths, selectedTargets);

  if (options.dryRun) {
    for (const skill of profile.enabledSkills) {
      if (renderTargets.some((target) => skill.targets.includes(capabilityTarget(target)))) {
        if (options.excludeProviderVariants && "variants" in skill) continue;

        if (skill.source === "git") {
          if (!options.onComplete) {
            console.log(`would acquire git commit\t${skill.name}\t${skill.commit}`);
          }

          continue;
        } else {
          const skillTargets = desiredTargets(skill, renderTargets);

          const files = await readSkillFiles(
            sourcePath(skill, selectedVariantTarget(skill, skillTargets))
          );

          validateSkillRecords(files);
        }
      }
    }

    const names = selectedSkillNames(profile, renderTargets, options);

    if (!options.onComplete) {
      for (const name of [...names].sort()) console.log(`would render skill\t${name}`);
    }

    const completed: OperationOutcome[] = [...names].sort().map((name) => ({
      category: "skill",
      action: "snapshot",
      status: "planned",
      target: name,
      significance: "meaningful"
    }));

    const plans = selectedLinkPlans(
      paths,
      profile,
      snapshot,
      selectedTargets,
      renderTargets,
      options
    );

    if (options.link !== false) await preflightLinks(paths, plans, directories);

    const current =
      options.link !== false ? await captureManagedLinks(paths, directories) : undefined;

    const desired = new Set(plans.map((plan) => plan.linkPath));

    for (const linkPath of current?.managed.keys() ?? []) {
      if (!desired.has(linkPath)) {
        if (!options.onComplete) console.log(`would unlink skill\t${linkPath}`);
        completed.push({
          category: "link",
          action: "remove",
          status: "planned",
          target: linkPath,
          significance: "meaningful",
          detail: "skill link"
        });
      }
    }

    if (options.link !== false) {
      for (const { linkPath, targetPath } of plans) {
        if (!options.onComplete) console.log(`would link skill\t${linkPath} -> ${targetPath}`);
        completed.push({
          category: "link",
          action: "link",
          status: "planned",
          target: linkPath,
          significance: "meaningful",
          changes: ["destination"],
          after: targetPath,
          detail: "skill link"
        });
      }
    }

    for (const outcome of completed) options.onComplete?.(outcome);

    return completed;
  }

  const rendered = await renderSkillSnapshot(
    paths,
    profile,
    renderTargets,
    options.excludeProviderVariants
      ? { snapshotDir: snapshot, excludeProviderVariants: true }
      : { snapshotDir: snapshot }
  );

  const inspection = await inspectSnapshot(snapshot, rendered.manifest);
  const universalDir = path.join(paths.home, ".agents", "skills") + path.sep;
  const claudeDir = path.join(paths.claudeDir, "skills") + path.sep;
  const opencodeDir = path.join(paths.opencodeConfigDir, "skills") + path.sep;
  const useUniversal = selectedTargets.includes("codex");
  const useOpenCode = selectedTargets.includes("opencode");

  const prepared = {
    ...rendered,
    links: rendered.links.filter((link) =>
      link.linkPath.startsWith(universalDir)
        ? useUniversal
        : link.linkPath.startsWith(claudeDir)
          ? selectedTargets.includes("claude-code")
          : link.linkPath.startsWith(opencodeDir) && useOpenCode
    )
  };

  const temporary = prepared.temporaryPath;

  try {
    if (options.link !== false) await preflightLinks(paths, prepared.links, directories);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }

  const backup = `${snapshot}.bak-${process.pid}`;

  const previousLinks =
    options.link !== false ? await captureManagedLinks(paths, directories) : undefined;

  const linksAreCurrent = previousLinks ? linksMatch(prepared.links, previousLinks) : true;

  if (!inspection.replacementRequired && linksAreCurrent) {
    await rm(temporary, { recursive: true, force: true });

    const unchangedLinks =
      options.link === false
        ? []
        : prepared.links.map(
            (plan): OperationOutcome => ({
              category: "link",
              action: "link",
              status: "unchanged",
              target: plan.linkPath,
              significance: "meaningful",
              detail: plan.targetPath
            })
          );

    const completed = [
      ...inspection.outcomes,
      ...unchangedLinks,
      {
        category: "bookkeeping",
        action: "snapshot",
        status: "unchanged",
        target: snapshot,
        significance: "internal"
      } satisfies OperationOutcome
    ];

    for (const outcome of completed) options.onComplete?.(outcome);

    return completed;
  }

  let committed = false;
  let linkOutcomes: OperationOutcome[] = [];

  try {
    await rm(backup, { recursive: true, force: true });

    try {
      await rename(snapshot, backup);
    } catch (error) {
      if (!(error instanceof Error) || errorCode(error) !== "ENOENT") throw error;
    }

    await rename(temporary, snapshot);

    if (options.link !== false) {
      linkOutcomes = await reconcileLinks(paths, prepared.links, directories);
    }

    committed = true;
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (previousLinks) await restoreManagedLinks(paths, previousLinks);
    await rm(snapshot, { recursive: true, force: true });

    try {
      await rename(backup, snapshot);
    } catch {
      // Preserve the original error when rollback itself has no prior snapshot.
    }

    throw error;
  } finally {
    if (!committed) await rm(temporary, { recursive: true, force: true });
  }

  const completed = [
    ...inspection.outcomes,
    ...linkOutcomes,
    {
      category: "bookkeeping",
      action: "snapshot",
      status: inspection.previousManifest ? "updated" : "created",
      target: snapshot,
      significance: "internal"
    } satisfies OperationOutcome
  ];

  for (const outcome of completed) options.onComplete?.(outcome);

  return completed;
}

export async function syncSkillSnapshot(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  options: {
    selectedTargets?: readonly SkillTarget[];
    dryRun?: boolean;
    link?: boolean;
    onComplete?: OperationCompletion;
  } = {}
): Promise<OperationOutcome[]> {
  const outcomes: OperationOutcome[] = [];
  const requestedTargets = options.selectedTargets ?? profile.agents.filter(isSkillTarget);
  const nonOpenCodeRequested = requestedTargets.filter(isNonOpenCodeSkillTarget);
  const variantTargets = nonOpenCodeVariantTargets(profile);

  const sharedRenderTargets = profile.agents.filter(
    (target): target is NonOpenCodeSkillTarget =>
      isNonOpenCodeSkillTarget(target) && !variantTargets.includes(target)
  );

  const sharedSelected = nonOpenCodeRequested.filter((target) =>
    sharedRenderTargets.includes(target)
  );

  if (sharedSelected.length > 0) {
    outcomes.push(
      ...(await syncSkillSnapshotGroup(
        paths,
        profile,
        sharedSelected,
        sharedRenderTargets,
        skillSnapshotDir(paths, profile.name),
        { ...options, excludeProviderVariants: true }
      ))
    );
  }

  for (const target of variantTargets) {
    if (!nonOpenCodeRequested.includes(target)) continue;
    outcomes.push(
      ...(await syncSkillSnapshotGroup(
        paths,
        profile,
        [target],
        [target],
        providerSkillSnapshotDir(paths, profile.name, target),
        options
      ))
    );
  }

  const allNonOpenCodeTargetsSelected = profile.agents
    .filter(isNonOpenCodeSkillTarget)
    .every((target) => nonOpenCodeRequested.includes(target));

  if (allNonOpenCodeTargetsSelected) {
    const staleSnapshots: string[] = [];

    if (sharedRenderTargets.length === 0) {
      staleSnapshots.push(skillSnapshotDir(paths, profile.name));
    }

    for (const target of ["claude-code", "codex"] as const) {
      if (!variantTargets.includes(target)) {
        staleSnapshots.push(providerSkillSnapshotDir(paths, profile.name, target));
      }
    }

    for (const snapshot of staleSnapshots) {
      const cleanupOptions: ManagedSnapshotOptions = {};

      if (options.dryRun) cleanupOptions.dryRun = true;

      if (options.onComplete) cleanupOptions.onComplete = options.onComplete;
      outcomes.push(...(await removeManagedSkillSnapshot(paths, snapshot, cleanupOptions)));
    }
  }

  const openCodeSelected = requestedTargets.includes("opencode") ? (["opencode"] as const) : [];

  const openCodeRenderTargets =
    profile.agents.includes("opencode") || openCodeSelected.length > 0
      ? (["opencode"] as const)
      : [];

  outcomes.push(
    ...(await syncSkillSnapshotGroup(
      paths,
      profile,
      openCodeSelected,
      openCodeRenderTargets,
      opencodeSkillSnapshotDir(paths, profile.name),
      options
    ))
  );

  return outcomes;
}

function isNonOpenCodeSkillTarget(target: AgentName): target is NonOpenCodeSkillTarget {
  return target === "claude-code" || target === "codex";
}

function isSkillTarget(target: string): target is SkillTarget {
  return target === "opencode" || target === "claude-code" || target === "codex";
}

export type { SkillTarget };
