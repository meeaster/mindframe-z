import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimePaths, ToolTarget } from "./paths.js";
import { globalSkillStatePath, profileConfigsDir } from "./paths.js";
import type { ResolvedProfile } from "./profile.js";
import { renderClaude } from "../renderers/claude.js";
import { renderDotfiles } from "../renderers/dotfiles.js";
import { renderMise } from "../renderers/mise.js";
import { renderOpenCode } from "../renderers/opencode.js";
import type { LinkPlan } from "./symlinks.js";
import { readSkillOverridesFile } from "./skill-overrides.js";

export interface RenderedFile {
  path: string;
  content: string;
  ifMissing?: boolean;
}

export interface RenderResult {
  files: RenderedFile[];
  localFiles?: RenderedFile[];
  links: LinkPlan[];
}

export interface RenderOptions {
  readonly includeGlobalSkillState?: boolean;
}

export async function renderRuntimeInstructions(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<RenderedFile[]> {
  const files: RenderedFile[] = [];
  for (const file of profile.instructionFiles) {
    files.push({
      path: path.join(profileConfigsDir(paths, profile.name), "AGENTS.md"),
      content: await readFile(file, "utf8")
    });
  }
  return files;
}

export async function writeRenderedFiles(files: RenderedFile[]): Promise<void> {
  for (const file of files) {
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, "utf8");
  }
}

export async function writeLocalFiles(files: RenderedFile[]): Promise<void> {
  for (const file of files) {
    await mkdir(path.dirname(file.path), { recursive: true });
    try {
      const stat = await lstat(file.path);
      if (file.ifMissing) continue;
      if (stat.isSymbolicLink()) await unlink(file.path);
    } catch {
      // Missing files are created below.
    }
    await writeFile(file.path, file.content, "utf8");
  }
}

export async function renderTarget(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  target: ToolTarget,
  options: RenderOptions = {}
): Promise<RenderResult> {
  const instructions = await renderRuntimeInstructions(paths, profile);
  let rendered: RenderResult;
  switch (target) {
    case "opencode":
      rendered = await renderOpenCode(paths, profile, {
        skillOverrides: options.includeGlobalSkillState
          ? await readSkillOverridesFile(globalSkillStatePath(paths, "opencode"))
          : {}
      });
      break;
    case "claude-code":
      rendered = await renderClaude(paths, profile);
      break;
    case "mise":
      rendered = await renderMise(paths, profile);
      break;
    case "dotfiles":
      rendered = await renderDotfiles(paths, profile);
      break;
  }
  return { ...rendered, files: [...instructions, ...rendered.files] };
}
