import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { RuntimePaths } from "../core/paths.js";

export const threadToolsImageName = "mindframe-z-thread-tools:latest";
export const threadToolsBuildHashLabel = "dev.mindframe-z.thread-tools.build-hash";

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
  const hooksConfig = await readFile(path.join(paths.root, "src", "thread", "hooks.json"), "utf8");
  const lapdogPlugin = await readFile(
    path.join(paths.root, "opencode", "plugins", "lapdog.ts"),
    "utf8"
  );
  const hash = createHash("sha256")
    .update(JSON.stringify({ dockerfile, opencodeConfig, hooksConfig, lapdogPlugin }))
    .digest("hex");
  return {
    root: paths.root,
    image: process.env.MFZ_THREAD_TOOLS_IMAGE ?? threadToolsImageName,
    dockerfile,
    hash,
    label: `${threadToolsBuildHashLabel}=${hash}`
  };
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
