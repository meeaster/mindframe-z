import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { renderTarget } from "../core/render.js";
import type { RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";

export const sandboxImageName = "local-ai-dev-sandbox-agent:latest";
export const sandboxBuildHashLabel = "dev.mindframe-z.sandbox.build-hash";

export interface SandboxImageBuildInputs {
  readonly dockerfile: string;
  readonly contextFiles: Record<string, string>;
  readonly resolvedMiseToml: string;
  readonly agents: readonly string[];
  readonly installerVersions: Record<string, string>;
}

export interface SandboxImageBuildPlan {
  readonly root: string;
  readonly contextDir: string;
  readonly image: string;
  readonly hash: string;
  readonly label: string;
  readonly buildArgs: Record<string, string>;
  readonly inputs: SandboxImageBuildInputs;
}

async function writeGeneratedBuildContext(plan: SandboxImageBuildPlan): Promise<void> {
  await rm(plan.contextDir, { recursive: true, force: true });
  await mkdir(path.join(plan.contextDir, "generated"), { recursive: true });
  await cp(
    path.join(plan.root, "sandbox", "image", "Dockerfile"),
    path.join(plan.contextDir, "Dockerfile")
  );
  await optionalCopyDir(
    path.join(plan.root, "sandbox", "image", "placeholders"),
    path.join(plan.contextDir, "placeholders")
  );
  await optionalCopyDir(
    path.join(plan.root, "sandbox", "scripts"),
    path.join(plan.contextDir, "scripts")
  );
  await writeFile(
    path.join(plan.contextDir, "generated", "mise.toml"),
    plan.inputs.resolvedMiseToml,
    "utf8"
  );
  await writeFile(
    path.join(plan.contextDir, "generated", "agents.txt"),
    `${plan.inputs.agents.join("\n")}\n`,
    "utf8"
  );
}

async function optionalCopyDir(source: string, target: string): Promise<void> {
  try {
    if ((await stat(source)).isDirectory()) await cp(source, target, { recursive: true });
  } catch {
    // Fixtures and future refactors may omit optional context directories.
  }
}

export async function currentSandboxImageHash(
  image = sandboxImageName
): Promise<string | undefined> {
  try {
    const result = await execa("docker", [
      "image",
      "inspect",
      image,
      "--format",
      `{{ index .Config.Labels ${JSON.stringify(sandboxBuildHashLabel)} }}`
    ]);
    const hash = result.stdout.trim();
    return hash || undefined;
  } catch {
    return undefined;
  }
}

export async function ensureSandboxImage(
  plan: SandboxImageBuildPlan,
  options: { readonly force?: boolean | undefined } = {}
): Promise<"built" | "current"> {
  const currentHash = await currentSandboxImageHash(plan.image);
  if (!options.force && currentHash === plan.hash) return "current";
  await writeGeneratedBuildContext(plan);

  await execa(
    "docker",
    [
      "build",
      "-t",
      plan.image,
      "--label",
      plan.label,
      ...Object.entries(plan.buildArgs).flatMap(([name, value]) => [
        "--build-arg",
        `${name}=${value}`
      ]),
      "-f",
      path.join(plan.contextDir, "Dockerfile"),
      plan.contextDir
    ],
    { cwd: plan.root, stdio: "inherit" }
  );
  return "built";
}

async function readContextFiles(root: string, dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, await readContextFiles(root, fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    files[path.relative(root, fullPath)] = await readFile(fullPath, "utf8");
  }
  return files;
}

async function optionalContextFiles(
  root: string,
  dirs: readonly string[]
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const dir of dirs) {
    try {
      if ((await stat(dir)).isDirectory()) Object.assign(files, await readContextFiles(root, dir));
    } catch {
      // Optional helper directories can disappear as the image is refactored.
    }
  }
  return files;
}

function hashBuildInputs(inputs: SandboxImageBuildInputs): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(inputs));
  return hash.digest("hex");
}

export async function sandboxImageBuildPlan(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<SandboxImageBuildPlan> {
  const dockerfilePath = path.join(paths.root, "sandbox", "image", "Dockerfile");
  const dockerfile = await readFile(dockerfilePath, "utf8");
  const miseRender = await renderTarget(paths, profile, "mise");
  const resolvedMiseToml =
    miseRender.files.find((file) => file.path.endsWith(path.join("mise", "config.toml")))
      ?.content ?? "";
  const inputs: SandboxImageBuildInputs = {
    dockerfile,
    contextFiles: await optionalContextFiles(paths.root, [
      path.join(paths.root, "sandbox", "image", "placeholders"),
      path.join(paths.root, "sandbox", "scripts")
    ]),
    resolvedMiseToml,
    agents: [...profile.agents].sort(),
    installerVersions: {
      claude: "install.sh",
      opencode: "install"
    }
  };
  const hash = hashBuildInputs(inputs);

  return {
    root: paths.root,
    contextDir: path.join(paths.home, ".mindframe-z", "sandbox", "build-context", profile.name),
    image: sandboxImageName,
    hash,
    label: `${sandboxBuildHashLabel}=${hash}`,
    buildArgs: {
      MFZ_SANDBOX_BUILD_HASH: hash,
      MFZ_SANDBOX_AGENTS: inputs.agents.join(",")
    },
    inputs
  };
}
