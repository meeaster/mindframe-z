import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { RuntimePaths } from "../core/paths.js";
import { buildClaudeSettingsJson } from "./claude-hooks.js";

export const threadToolsImageName = "mindframe-z-thread-tools:latest";
export const threadToolsBuildHashLabel = "dev.mindframe-z.thread-tools.build-hash";

export const threadToolsGeneratedDir = ".generated/thread-tools";
export const threadToolsClaudeSettingsPath = "claude-settings.json";

export interface ThreadToolsImageBuildPlan {
  root: string;
  image: string;
  dockerfile: string;
  hash: string;
  label: string;
}

export async function threadToolsImageBuildPlan(
  paths: RuntimePaths
): Promise<ThreadToolsImageBuildPlan> {
  const dockerfile = await readFile(path.join(paths.root, "Dockerfile.tools"), "utf8");
  const opencodeConfig = await readFile(
    path.join(paths.root, "src", "thread", "opencode.thread.json"),
    "utf8"
  );
  const claudeSettings = buildClaudeSettingsJson();
  const lapdogPlugin = await readFile(
    path.join(paths.root, "opencode", "plugins", "lapdog.ts"),
    "utf8"
  );
  const hash = createHash("sha256")
    .update(JSON.stringify({ dockerfile, opencodeConfig, claudeSettings, lapdogPlugin }))
    .digest("hex");
  return {
    root: paths.root,
    image: process.env.MFZ_THREAD_TOOLS_IMAGE ?? threadToolsImageName,
    dockerfile,
    hash,
    label: `${threadToolsBuildHashLabel}=${hash}`
  };
}

export async function materializeThreadToolsGeneratedFiles(
  plan: ThreadToolsImageBuildPlan
): Promise<string> {
  const dir = path.join(plan.root, threadToolsGeneratedDir);
  await mkdir(dir, { recursive: true });
  const settingsPath = path.join(dir, threadToolsClaudeSettingsPath);
  await writeFile(settingsPath, buildClaudeSettingsJson(), "utf8");
  return path.join(threadToolsGeneratedDir, threadToolsClaudeSettingsPath);
}

export async function currentThreadToolsImageHash(
  image = threadToolsImageName
): Promise<string | undefined> {
  try {
    const result = await execa("docker", [
      "image",
      "inspect",
      image,
      "--format",
      `{{ index .Config.Labels ${JSON.stringify(threadToolsBuildHashLabel)} }}`
    ]);
    const hash = result.stdout.trim();
    return hash || undefined;
  } catch {
    return undefined;
  }
}

export async function ensureThreadToolsImage(
  plan: ThreadToolsImageBuildPlan,
  options: { force?: boolean | undefined } = {}
): Promise<"built" | "current"> {
  const currentHash = await currentThreadToolsImageHash(plan.image);
  if (!options.force && currentHash === plan.hash) return "current";

  await materializeThreadToolsGeneratedFiles(plan);
  await execa(
    "docker",
    [
      "build",
      "-t",
      plan.image,
      "--label",
      plan.label,
      "-f",
      path.join(plan.root, "Dockerfile.tools"),
      plan.root
    ],
    { cwd: plan.root }
  );
  return "built";
}
