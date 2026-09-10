import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { RuntimePaths, ToolTarget } from "./paths.js";
import { profileConfigsDir } from "./paths.js";
import type { ResolvedProfile } from "./profile.js";
import type { RenderOwnership } from "./ownership.js";
import { capabilityIndexContent } from "../ref-store/capabilities.js";
import { renderClaude } from "../renderers/claude.js";
import { renderCodex } from "../renderers/codex.js";
import { renderDotfiles } from "../renderers/dotfiles.js";
import { renderMise } from "../renderers/mise.js";
import { renderOpenCodeV2 } from "../renderers/opencode-v2.js";
import { renderPi } from "../renderers/pi.js";
import type { LinkPlan } from "./symlinks.js";
import type { JsonObject } from "./json.js";
import { removePathOutcome, writeFileOutcome, type WriteFileOptions } from "./file-operations.js";
import type { OperationCompletion, OperationOutcome } from "./operations.js";
import {
  instructionReferencesDir,
  instructionReferencesSection,
  renderInstructionReferences
} from "./instruction-references.js";

export type OpenCodeV2PluginEntry = string | { package: string; options: JsonObject };

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
    entries: OpenCodeV2PluginEntry[];
    registryPath: string;
    settings?: JsonObject;
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
  if (
    profile.instructionFiles.length === 0 &&
    profile.instructionReferences.length === 0 &&
    !includeIndexes
  )
    return [];
  const contents = await Promise.all(
    profile.instructionFiles.map((file) => readFile(file, "utf8"))
  );
  const referenceSection = instructionReferencesSection(paths, profile);
  return [
    {
      path: path.join(profileConfigsDir(paths, profile.name), "AGENTS.md"),
      content:
        [
          ...contents.map((content) => content.trimEnd()),
          ...(includeIndexes ? [capabilityIndexContent(paths, profile).trimEnd()] : []),
          ...(referenceSection ? [referenceSection] : [])
        ].join("\n\n") + "\n"
    },
    ...(await renderInstructionReferences(paths, profile))
  ];
}

export async function writeRenderedFiles(
  files: RenderedFile[],
  onComplete?: OperationCompletion
): Promise<OperationOutcome[]> {
  const outcomes: OperationOutcome[] = [];
  for (const file of files) {
    const options: WriteFileOptions = {};
    if (file.mode !== undefined) options.mode = file.mode;
    if (onComplete) options.onComplete = onComplete;
    outcomes.push(await writeFileOutcome(file.path, file.content, options));
  }
  return outcomes;
}

export async function removeRenderedFiles(
  files: string[],
  onComplete?: OperationCompletion
): Promise<OperationOutcome[]> {
  const outcomes: OperationOutcome[] = [];
  for (const file of files) {
    const options: Pick<WriteFileOptions, "onComplete"> = {};
    if (onComplete) options.onComplete = onComplete;
    outcomes.push(await removePathOutcome(file, options));
  }
  return outcomes;
}

export async function writeLocalFiles(
  files: RenderedFile[],
  onComplete?: OperationCompletion
): Promise<OperationOutcome[]> {
  const outcomes: OperationOutcome[] = [];
  for (const file of files) {
    try {
      await lstat(file.path);
      if (file.ifMissing) {
        const outcome: OperationOutcome = {
          category: "file",
          action: "write",
          status: "unchanged",
          target: file.path,
          significance: "meaningful",
          detail: "preserved existing file"
        };
        outcomes.push(outcome);
        onComplete?.(outcome);
        continue;
      }
    } catch (error) {
      // SAFETY: Node filesystem failures expose their stable errno code on thrown errors.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Missing files are created below.
    }
    const options: WriteFileOptions = {};
    if (file.mode !== undefined) options.mode = file.mode;
    if (onComplete) options.onComplete = onComplete;
    outcomes.push(await writeFileOutcome(file.path, file.content, options));
  }
  return outcomes;
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
      {
        const miseOptions = {};
        if (options.sandbox !== undefined) Object.assign(miseOptions, { sandbox: options.sandbox });
        if (options.previousOwnedHostPaths !== undefined) {
          Object.assign(miseOptions, { previousOwnedHostPaths: options.previousOwnedHostPaths });
        }
        rendered = await renderMise(paths, profile, miseOptions);
      }
      break;
    case "dotfiles":
      rendered = await renderDotfiles(paths, profile);
      break;
  }
  const snapshotRoot = path.join(profileConfigsDir(paths, profile.name), snapshotName(target));
  const current = new Set<string>();
  for (const file of [...rendered.files, ...(rendered.localFiles ?? [])]) {
    if (file.path.startsWith(`${snapshotRoot}${path.sep}`)) current.add(file.path);
  }
  const staleFiles = [
    ...(rendered.staleFiles ?? []),
    ...(await staleSnapshotFiles(
      snapshotRoot,
      current,
      target === "opencode-v2" ? ["skills"] : []
    )),
    ...(isAgentTarget(target)
      ? await staleSnapshotFiles(
          instructionReferencesDir(paths, profile),
          new Set(
            instructions
              .filter((file) =>
                file.path.startsWith(`${instructionReferencesDir(paths, profile)}${path.sep}`)
              )
              .map((file) => file.path)
          )
        )
      : [])
  ];
  return { ...rendered, staleFiles, files: [...instructions, ...rendered.files] };
}

function isAgentTarget(target: ToolTarget): boolean {
  return !["mise", "dotfiles"].includes(target);
}

function snapshotName(target: ToolTarget): string {
  if (target === "opencode-v2") return "opencode-v2";
  return target;
}

async function staleSnapshotFiles(
  root: string,
  current: Set<string>,
  ignoredDirectories: readonly string[] = []
): Promise<string[]> {
  const stale: string[] = [];
  const ignored = new Set(ignoredDirectories);
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (dir === root && entry.isDirectory() && ignored.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && !current.has(file)) stale.push(file);
    }
  }
  await walk(root);
  return stale;
}
