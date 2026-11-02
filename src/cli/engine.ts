import { copyFile, lstat, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { pathExists } from "../core/fs-util.js";
import { machineConfigPath, type RuntimePaths } from "../core/paths.js";
import { expandHome } from "../core/path-util.js";
import { machineSchema, readYaml } from "../core/manifests.js";

const ENGINE_REPOSITORY = "https://github.com/meeaster/mindframe-z.git";

function binDir(home: string): string {
  return path.join(home, ".local", "bin");
}

// The installer keeps the release binary as `mfz-release` beside `mfz`, so a broken source build
// can always be recovered with `mfz-release engine use release`.
export function releaseBinaryPath(home: string): string {
  return path.join(binDir(home), "mfz-release");
}

function activeBinaryPath(home: string): string {
  return path.join(binDir(home), "mfz");
}

// A source install is `~/.local/bin/mfz` linked to a checkout's `bin/mfz`; anything else is the
// release binary.
export async function engineSourceCheckout(home: string): Promise<string | undefined> {
  const active = activeBinaryPath(home);
  const stat = await lstat(active).catch(() => undefined);

  if (!stat?.isSymbolicLink()) return undefined;

  const target = path.resolve(binDir(home), await readlink(active));

  return path.dirname(path.dirname(target));
}

export async function buildEngineCheckout(checkout: string): Promise<void> {
  await execa("pnpm", ["install", "--frozen-lockfile"], { cwd: checkout, stdio: "inherit" });
  await execa("pnpm", ["build"], { cwd: checkout, stdio: "inherit" });
}

async function replaceActiveBinary(home: string, install: (temporary: string) => Promise<void>) {
  const active = activeBinaryPath(home);
  const temporary = `${active}.${process.pid}`;
  await rm(temporary, { force: true });
  await install(temporary);
  await rename(temporary, active);
}

async function preserveReleaseBinary(home: string): Promise<void> {
  const active = activeBinaryPath(home);
  const stat = await lstat(active).catch(() => undefined);

  if (stat?.isFile() && !(await pathExists(releaseBinaryPath(home)))) {
    await copyFile(active, releaseBinaryPath(home));
  }
}

async function defaultCheckout(paths: RuntimePaths): Promise<string> {
  const machine = await readYaml(
    machineConfigPath(paths.home),
    machineSchema,
    machineSchema.parse({})
  );

  return path.join(expandHome(machine.workspace_root, paths.home), "repos", "mindframe-z");
}

export async function useSourceEngine(paths: RuntimePaths, checkoutPath?: string): Promise<void> {
  const checkout = path.resolve(checkoutPath ?? (await defaultCheckout(paths)));

  if (!(await pathExists(checkout))) {
    await mkdir(path.dirname(checkout), { recursive: true });
    await execa("git", ["clone", ENGINE_REPOSITORY, checkout], { stdio: "inherit" });
  }

  await buildEngineCheckout(checkout);
  await mkdir(binDir(paths.home), { recursive: true });
  await preserveReleaseBinary(paths.home);
  await replaceActiveBinary(paths.home, (temporary) =>
    symlink(path.join(checkout, "bin", "mfz"), temporary)
  );
  console.log(`engine\tsource\t${checkout}`);
}

export async function useReleaseEngine(paths: RuntimePaths): Promise<void> {
  const release = releaseBinaryPath(paths.home);

  if (!(await pathExists(release))) {
    throw new Error(`No release binary at ${release}; rerun the mindframe-z installer.`);
  }

  await replaceActiveBinary(paths.home, (temporary) => copyFile(release, temporary));
  console.log(`engine\trelease\t${release}`);
}
