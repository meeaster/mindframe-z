import { chmod, lstat, readFile, readdir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { writeTextFile } from "./fs-util.js";
import type { RuntimePaths, ToolTarget } from "./paths.js";
import { globalSkillStatePath, profileConfigsDir } from "./paths.js";
import type { ResolvedProfile } from "./profile.js";
import type { RenderOwnership } from "./ownership.js";
import { extraFoldersIndexContent, referenceIndexContent } from "../ref-store/references.js";
import { renderClaude } from "../renderers/claude.js";
import { renderCodex } from "../renderers/codex.js";
import { renderDotfiles } from "../renderers/dotfiles.js";
import { renderMise } from "../renderers/mise.js";
import { renderOpenCode } from "../renderers/opencode.js";
import { renderOpenCodeV2 } from "../renderers/opencode-v2.js";
import { renderPi } from "../renderers/pi.js";
import type { LinkPlan } from "./symlinks.js";
import { readSkillOverridesFile } from "./skill-overrides.js";

export interface RenderedFile {
  path: string;
  content: string;
  ifMissing?: boolean;
  mode?: number;
}

export interface RenderResult {
  files: RenderedFile[];
  localFiles?: RenderedFile[];
  localStaleFiles?: string[];
  cliPlugins?: {
    path: string;
    entries: string[];
    registryPath: string;
    settings?: Record<string, unknown>;
  };
  links: LinkPlan[];
  staleFiles?: string[];
  staleLinks?: LinkPlan[];
  ownership?: RenderOwnership;
}

export interface RenderOptions {
  readonly includeGlobalSkillState?: boolean;
  readonly sandbox?: boolean;
  readonly previousOwnedHostPaths?: readonly string[];
}

export async function renderRuntimeInstructions(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  includeIndexes = false
): Promise<RenderedFile[]> {
  if (profile.instructionFiles.length === 0 && !includeIndexes) return [];
  const contents = await Promise.all(
    profile.instructionFiles.map((file) => readFile(file, "utf8"))
  );
  return [
    {
      path: path.join(profileConfigsDir(paths, profile.name), "AGENTS.md"),
      content:
        [
          ...contents.map((content) => content.trimEnd()),
          ...(includeIndexes ? [referenceIndexContent(profile).trimEnd()] : []),
          ...(includeIndexes && profile.extraFolders.length > 0
            ? [extraFoldersIndexContent(paths, profile).trimEnd()]
            : [])
        ].join("\n\n") + "\n"
    }
  ];
}

export async function writeRenderedFiles(files: RenderedFile[]): Promise<void> {
  for (const file of files) {
    await writeTextFile(file.path, file.content);
    if (file.mode !== undefined) await chmod(file.path, file.mode);
  }
}

export async function removeRenderedFiles(files: string[]): Promise<void> {
  for (const file of files) await rm(file, { force: true, recursive: true });
}

export async function writeLocalFiles(files: RenderedFile[]): Promise<void> {
  for (const file of files) {
    try {
      const stat = await lstat(file.path);
      if (file.ifMissing) continue;
      if (stat.isSymbolicLink()) await unlink(file.path);
    } catch {
      // Missing files are created below.
    }
    await writeTextFile(file.path, file.content);
    if (file.mode !== undefined) await chmod(file.path, file.mode);
  }
}

export async function renderTarget(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  target: ToolTarget,
  options: RenderOptions = {}
): Promise<RenderResult> {
  const instructions = isAgentTarget(target)
    ? await renderRuntimeInstructions(
        paths,
        profile,
        profile.profile.opencode_v2.global_instructions === true
      )
    : [];
  let rendered: RenderResult;
  switch (target) {
    case "opencode":
      rendered = await renderOpenCode(paths, profile, {
        skillOverrides: options.includeGlobalSkillState
          ? await readSkillOverridesFile(globalSkillStatePath(paths, "opencode"))
          : {}
      });
      break;
    case "opencode-v2":
      rendered = await renderOpenCodeV2(paths, profile);
      break;
    case "claude-code":
      rendered = await renderClaude(paths, profile);
      break;
    case "codex":
      rendered = await renderCodex(paths, profile);
      break;
    case "pi":
      rendered = await renderPi(paths, profile);
      break;
    case "mise":
      rendered = await renderMise(paths, profile, {
        ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
        ...(options.previousOwnedHostPaths === undefined
          ? {}
          : { previousOwnedHostPaths: options.previousOwnedHostPaths })
      });
      break;
    case "dotfiles":
      rendered = await renderDotfiles(paths, profile);
      break;
  }
  const snapshotRoot = path.join(profileConfigsDir(paths, profile.name), snapshotName(target, paths));
  const current = new Set(rendered.files.filter((file) => file.path.startsWith(`${snapshotRoot}${path.sep}`)).map((file) => file.path));
  const staleFiles = [...(rendered.staleFiles ?? []), ...(await staleSnapshotFiles(snapshotRoot, current))];
  return { ...rendered, staleFiles, files: [...instructions, ...rendered.files] };
}

function isAgentTarget(target: ToolTarget): boolean {
  return !["mise", "dotfiles"].includes(target);
}

function snapshotName(target: ToolTarget, paths: RuntimePaths): string {
  if (target === "opencode") return paths.activeOpenCodeRuntime === "v2" ? "opencode-v2" : "opencode-v1";
  if (target === "opencode-v2") return "opencode-v2";
  return target;
}

async function staleSnapshotFiles(root: string, current: Set<string>): Promise<string[]> {
  const stale: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && !current.has(file)) stale.push(file);
    }
  }
  await walk(root);
  return stale;
}
