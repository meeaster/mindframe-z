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
import YAML from "yaml";
import {
  materializeEngineSkill,
  materializeReviewSkill,
  engineSkillName,
  skillUpdateReviewName
} from "../core/engine-skill.js";
import { skillSnapshotDir, skillSnapshotManifestPath, type RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile, ResolvedSkill } from "../core/profile.js";
import { digestSkillFiles, readSkillFiles, validateSkillRecords } from "./vendor.js";
import { assertNoSymlinkAncestors } from "./tree.js";

type SkillTarget = "opencode" | "claude-code" | "codex";

interface SnapshotSkill {
  name: string;
  source: "local" | "vendored" | "engine";
  digest: string;
  targets: SkillTarget[];
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

function isManagedTarget(configsDir: string, target: string): boolean {
  const relative = path.relative(configsDir, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sourcePath(skill: ResolvedSkill): string {
  if (skill.source === "vendored")
    return path.join(skill.sourceRoot, "skills", "vendor", skill.name);
  return path.join(skill.sourceRoot, "skills", skill.skill ?? skill.name);
}

function relativeLinkTarget(linkPath: string, targetPath: string): string {
  const relative = path.relative(path.dirname(linkPath), targetPath);
  return relative || ".";
}

async function copyDirectory(source: string, destination: string): Promise<string> {
  const files = await readSkillFiles(source);
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
          : path.join(paths.home, ".agents", "skills")
      )
    )
  ];
}

async function skillLinkDir(paths: RuntimePaths, target: SkillTarget): Promise<string> {
  return target === "claude-code"
    ? path.join(paths.claudeDir, "skills")
    : path.join(paths.home, ".agents", "skills");
}

async function assertLinkDirectory(directory: string): Promise<void> {
  await assertNoSymlinkAncestors(path.parse(path.resolve(directory)).root, directory);
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Skill link directory is not a real directory: ${directory}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
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
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
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
): Promise<void> {
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
      }
    }
  }
  for (const plan of plans) {
    const status = await linkStatus(plan.linkPath);
    const relative = relativeLinkTarget(plan.linkPath, plan.targetPath);
    if (status.state === "symlink" && status.resolved === path.resolve(plan.targetPath)) continue;
    if (status.state === "symlink") await rm(plan.linkPath, { force: true });
    await symlink(relative, plan.linkPath, "dir");
  }
}

async function captureManagedLinks(
  paths: RuntimePaths,
  directories: readonly string[]
): Promise<LinkSnapshot> {
  const managed = new Map<string, string>();
  for (const directory of directories) {
    await assertLinkDirectory(directory);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
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
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
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

async function linksMatch(
  paths: RuntimePaths,
  plans: readonly LinkPlan[],
  directories: readonly string[]
): Promise<boolean> {
  const desired = new Map(plans.map((plan) => [plan.linkPath, path.resolve(plan.targetPath)]));
  const current = await captureManagedLinks(paths, directories);
  if (current.managed.size !== desired.size) return false;
  for (const [linkPath, targetPath] of desired) {
    if (current.managed.get(linkPath) !== targetPath) return false;
  }
  return true;
}

function desiredTargets(skill: ResolvedSkill, selected: readonly SkillTarget[]): SkillTarget[] {
  return selected.filter((target) => skill.targets.includes(target));
}

function engineTargets(profile: ResolvedProfile, selected: readonly SkillTarget[]): SkillTarget[] {
  return selected.filter((target) => profile.agents.includes(target));
}

export async function renderSkillSnapshot(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  selectedTargets: readonly SkillTarget[] = ["opencode", "claude-code", "codex"]
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
  const sources = new Map<string, { sourcePath: string; source: SnapshotSkill["source"] }>();
  for (const skill of profile.enabledSkills) {
    const targets = desiredTargets(skill, selectedTargets);
    if (targets.length === 0) continue;
    const source = skill.source === "vendored" ? "vendored" : "local";
    sources.set(skill.name, { sourcePath: sourcePath(skill), source });
    selected.push({
      name: skill.name,
      source,
      digest: "",
      targets,
      sourceRoot: skill.sourceRoot,
      sourcePath: sourcePath(skill),
      ...(skill.source === "vendored" && skill.vendor
        ? {
            repository: skill.vendor.repository,
            ref: skill.vendor.ref,
            subtree: skill.vendor.subtree,
            commit: skill.vendor.commit
          }
        : {})
    });
  }
  for (const entry of engineEntries) {
    const targets = engineTargets(profile, selectedTargets);
    if (targets.length === 0 || selected.some((skill) => skill.name === entry.name)) continue;
    sources.set(entry.name, {
      sourcePath: path.join(entry.sourceRoot, "skills", entry.skill),
      source: entry.source
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

  const snapshot = skillSnapshotDir(paths, profile.name);
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
      skill.digest = await copyDirectory(source.sourcePath, path.join(temporary, skill.name));
    }
    await writeFile(
      path.join(temporary, path.relative(snapshot, skillSnapshotManifestPath(paths, profile.name))),
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

async function snapshotMatches(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  manifest: SnapshotManifest,
  links: readonly LinkPlan[],
  directories: readonly string[],
  checkLinks: boolean
): Promise<boolean> {
  try {
    const existing = YAML.parse(
      await readFile(skillSnapshotManifestPath(paths, profile.name), "utf8")
    ) as SnapshotManifest;
    if (JSON.stringify(existing) !== JSON.stringify(manifest)) return false;
    for (const skill of manifest.skills) {
      const files = await readSkillFiles(
        path.join(skillSnapshotDir(paths, profile.name), skill.name)
      );
      if (digestSkillFiles(files) !== skill.digest) return false;
    }
    return !checkLinks || (await linksMatch(paths, links, directories));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function selectedSkillNames(
  profile: ResolvedProfile,
  renderTargets: readonly SkillTarget[]
): Set<string> {
  const names = new Set(
    profile.enabledSkills
      .filter((skill) => renderTargets.some((target) => skill.targets.includes(target)))
      .map((skill) => skill.name)
  );
  if (!profile.manifests.skills.some((skill) => skill.name === engineSkillName))
    names.add(engineSkillName);
  if (renderTargets.length > 0) names.add(skillUpdateReviewName);
  return names;
}

function selectedLinkPlans(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  selectedTargets: readonly SkillTarget[],
  renderTargets: readonly SkillTarget[]
): LinkPlan[] {
  const links: LinkPlan[] = [];
  for (const name of selectedSkillNames(profile, renderTargets)) {
    const declared = profile.enabledSkills.find((skill) => skill.name === name);
    const targets = declared
      ? selectedTargets.filter((target) => declared.targets.includes(target))
      : selectedTargets.filter((target) => renderTargets.includes(target));
    for (const target of targets) {
      const directory =
        target === "claude-code" ? paths.claudeDir : path.join(paths.home, ".agents");
      links.push({
        linkPath: path.join(directory, "skills", name),
        targetPath: path.join(skillSnapshotDir(paths, profile.name), name)
      });
    }
  }
  return [...new Map(links.map((link) => [link.linkPath, link])).values()];
}

export async function syncSkillSnapshot(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  options: { selectedTargets?: readonly SkillTarget[]; dryRun?: boolean; link?: boolean } = {}
): Promise<void> {
  const requestedTargets = options.selectedTargets ?? ["opencode", "claude-code", "codex"];
  const selectedTargets =
    requestedTargets.includes("opencode") || requestedTargets.includes("codex")
      ? [
          ...new Set([
            ...requestedTargets,
            ...profile.agents.filter(
              (target): target is SkillTarget => target === "opencode" || target === "codex"
            )
          ])
        ]
      : [...requestedTargets];
  const snapshot = skillSnapshotDir(paths, profile.name);
  const renderTargets = profile.agents.filter(
    (target): target is SkillTarget =>
      target === "opencode" || target === "claude-code" || target === "codex"
  );
  const directories = linkDirectories(paths, selectedTargets);
  if (options.dryRun) {
    for (const skill of profile.enabledSkills) {
      if (renderTargets.some((target) => skill.targets.includes(target))) {
        const files = await readSkillFiles(sourcePath(skill));
        validateSkillRecords(files);
      }
    }
    const names = selectedSkillNames(profile, renderTargets);
    for (const name of [...names].sort()) console.log(`would render skill\t${name}`);
    const plans = selectedLinkPlans(paths, profile, selectedTargets, renderTargets);
    if (options.link !== false) await preflightLinks(paths, plans, directories);
    const current =
      options.link !== false ? await captureManagedLinks(paths, directories) : undefined;
    const desired = new Set(plans.map((plan) => plan.linkPath));
    for (const linkPath of current?.managed.keys() ?? []) {
      if (!desired.has(linkPath)) console.log(`would unlink skill\t${linkPath}`);
    }
    if (options.link !== false) {
      for (const { linkPath, targetPath } of plans) {
        console.log(`would link skill\t${linkPath} -> ${targetPath}`);
      }
    }
    return;
  }
  const rendered = await renderSkillSnapshot(paths, profile, renderTargets);
  const universalDir = path.join(paths.home, ".agents", "skills") + path.sep;
  const claudeDir = path.join(paths.claudeDir, "skills") + path.sep;
  const useUniversal = selectedTargets.includes("opencode") || selectedTargets.includes("codex");
  const prepared = {
    ...rendered,
    links: rendered.links.filter((link) =>
      link.linkPath.startsWith(universalDir)
        ? useUniversal
        : link.linkPath.startsWith(claudeDir) && selectedTargets.includes("claude-code")
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
  if (
    await snapshotMatches(
      paths,
      profile,
      prepared.manifest,
      prepared.links,
      directories,
      options.link !== false
    )
  ) {
    await rm(temporary, { recursive: true, force: true });
    return;
  }
  let committed = false;
  try {
    await rm(backup, { recursive: true, force: true });
    try {
      await rename(snapshot, backup);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(temporary, snapshot);
    if (options.link !== false) await reconcileLinks(paths, prepared.links, directories);
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
}

export type { SkillTarget };
