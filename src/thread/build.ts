import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { packageRootFromImport, type RuntimePaths } from "../core/paths.js";
import { buildClaudeSettingsJson } from "./claude-hooks.js";

export const threadToolsImageName = "mindframe-z-thread-tools:latest";
export const threadToolsBuildHashLabel = "dev.mindframe-z.thread-tools.build-hash";

export const threadToolsGeneratedDir = ".generated/thread-tools";
export const threadToolsClaudeSettingsPath = "claude-settings.json";

// Docker-context files, relative to the package root. embedded-assets.ts writes its
// materialized copies to the same relative paths, so a rename here breaks the bundle
// at compile time instead of shipping a binary that fails at runtime.
export const threadToolsDockerfilePath = "Dockerfile.tools";
export const threadToolsOpencodeConfigPath = "src/thread/opencode.thread.json";
export const threadToolsLapdogPluginPath = "src/thread/lapdog-plugin.ts";

export interface ThreadToolsImageBuildPlan {
  root: string;
  image: string;
  dockerfile: string;
  hash: string;
  label: string;
}

// In a compiled bun binary the docker-context files live only in the embedded
// filesystem, so the standalone entry (src/cli/mfz-bun.ts) registers a resolver that
// materializes them. That entry stays out of the tsc program because embedded-assets
// uses `type: "file"` imports Node/tsc can't parse; keeping the wiring here as a plain
// callback lets build.ts remain pure TS while bun bundles the assets into the binary.
let embeddedPackageRootResolver: (() => Promise<string>) | undefined;
let resolvedPackageRoot: Promise<string> | undefined;

export function setEmbeddedPackageRootResolver(resolver: () => Promise<string>): void {
  embeddedPackageRootResolver = resolver;
}

async function resolvePackageRoot(): Promise<string> {
  resolvedPackageRoot ??= embeddedPackageRootResolver
    ? embeddedPackageRootResolver()
    : Promise.resolve(packageRootFromImport(import.meta.url));
  return resolvedPackageRoot;
}

export async function threadToolsImageBuildPlan(
  paths: RuntimePaths,
  packageRoot?: string
): Promise<ThreadToolsImageBuildPlan> {
  const root = packageRoot ?? (await resolvePackageRoot());
  const dockerfile = await readFile(path.join(root, threadToolsDockerfilePath), "utf8");
  const opencodeConfig = await readFile(path.join(root, threadToolsOpencodeConfigPath), "utf8");
  const claudeSettings = buildClaudeSettingsJson();
  const lapdogPlugin = await readFile(path.join(root, threadToolsLapdogPluginPath), "utf8");
  const hash = createHash("sha256")
    .update(JSON.stringify({ dockerfile, opencodeConfig, claudeSettings, lapdogPlugin }))
    .digest("hex");
  return {
    root,
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
      path.join(plan.root, threadToolsDockerfilePath),
      plan.root
    ],
    { cwd: plan.root }
  );
  return "built";
}
