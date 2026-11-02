import { execa } from "execa";
import { machineSchema, readYaml } from "../core/manifests.js";
import { createRuntimePaths, machineConfigPath, type PathOptions } from "../core/paths.js";
import { resolveProfile } from "../core/profile.js";
import { toolRequirementLines } from "../core/tool-requirements.js";
import { fastForwardRepository } from "../workspace/repositories.js";
import { runWorkspaceSync } from "../workspace/cli.js";
import { runApply } from "./apply.js";
import { buildEngineCheckout, engineSourceCheckout } from "./engine.js";
import { initHome } from "./init.js";
import { commandIsInteractive, createOperationReporter } from "./operation-report.js";
import { runReferenceSync } from "./refs-sync.js";

export interface SetupOptions extends PathOptions {
  clone?: string | undefined;
  path?: string | undefined;
  profile?: string | undefined;
  verbose?: boolean | undefined;
}

async function head(checkout: string): Promise<string | undefined> {
  const result = await execa("git", ["rev-parse", "HEAD"], { cwd: checkout, reject: false });

  return result.exitCode === 0 ? result.stdout : undefined;
}

async function updateHome(root: string, verbose: boolean): Promise<boolean> {
  const reporter = createOperationReporter({
    command: "mfz setup",
    scope: "home",
    verbose,
    interactive: commandIsInteractive()
  });

  reporter.complete(await fastForwardRepository(root));

  return reporter.finish();
}

// Upgrades stay within the versions the home declares; prune removes versions no layer uses.
async function installTools(): Promise<boolean> {
  for (const args of [
    ["install", "--yes"],
    ["upgrade", "--yes"],
    ["prune", "--tools", "--yes"]
  ]) {
    const result = await execa("mise", args, { stdio: "inherit", reject: false });

    if (result.exitCode !== 0) return false;
  }

  return true;
}

// Brings this machine to the state its home declares. Each step is safe to repeat, so the same
// command bootstraps a new machine and updates an existing one.
export async function runSetup(options: SetupOptions): Promise<boolean> {
  const machineHome = createRuntimePaths(options).home;

  const machine = await readYaml(
    machineConfigPath(machineHome),
    machineSchema,
    machineSchema.parse({})
  );

  const engineCheckout = await engineSourceCheckout(machineHome);
  const engineBefore = engineCheckout ? await head(engineCheckout) : undefined;
  let healthy = true;

  if (machine.home_path === undefined) {
    if (!options.clone) {
      throw new Error("No home is configured on this machine; run mfz setup --clone <home-url>.");
    }

    await initHome({
      clone: options.clone,
      path: options.path,
      profile: options.profile,
      home: options.home
    });
  } else {
    if (options.clone) {
      console.log(`home\t${machine.home_path} is already configured; ignoring --clone`);
    }

    healthy =
      (await updateHome(createRuntimePaths(options).root, options.verbose ?? false)) && healthy;
  }

  // The home may have changed above, so everything below resolves it fresh.
  const paths = createRuntimePaths(options);
  const profile = await resolveProfile(paths, options.profile);

  healthy = (await runReferenceSync(paths, profile, { verbose: options.verbose })) && healthy;

  // Apply renders config that points into workspace checkouts, such as folder plugins, so the
  // declared repositories must be cloned first.
  healthy = (await runWorkspaceSync({ ...options, verbose: options.verbose })) && healthy;

  const apply = (target: "dotfiles" | "mise" | "all") =>
    runApply({
      root: options.root,
      home: options.home,
      profile: options.profile,
      agent: "all",
      target,
      verbose: options.verbose
    });

  // Tools come before the full apply, which can need them (Executor reconciliation, tool skills).
  // Dotfiles go first so a home's mise wrapper is in place before anything installs, and the
  // infra-only applies render no agent configuration, so they need no tools themselves. Without
  // rendered mise config there is nothing to install.
  if (!(await apply("dotfiles")) || !(await apply("mise"))) return false;

  healthy = (await installTools()) && healthy;

  if (!(await apply("all"))) return false;

  if (engineCheckout && (await head(engineCheckout)) !== engineBefore) {
    await buildEngineCheckout(engineCheckout);
  }

  for (const line of await toolRequirementLines(profile)) {
    if (line.startsWith("tool:missing")) console.log(line);
  }

  return healthy;
}
