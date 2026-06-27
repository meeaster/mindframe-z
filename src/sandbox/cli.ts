import { randomBytes } from "node:crypto";
import { execa } from "execa";
import { createRuntimePaths } from "../core/paths.js";
import { resolveProfile } from "../core/profile.js";
import { provisionBroker } from "./broker.js";
import { ensureSandboxImage, sandboxImageBuildPlan } from "./build.js";
import {
  agentVaultApiAddress,
  ensureSandboxBaseSecrets,
  hasSandboxOperationalSecrets,
  readSandboxOperationalSecrets,
  sandboxAgentTokenVar,
  sandboxCaFile,
  sandboxSecretsFile,
  sandboxVaultName,
  setSandboxAgentToken
} from "./config.js";
import { ensureSandboxServices, writeSandboxCompose } from "./lifecycle.js";
import {
  ensureSandboxState,
  resolveSandboxRuntimeInputs,
  type SandboxLaunchTarget
} from "./runtime.js";

export function parseSandboxTarget(target: string | undefined): {
  target: SandboxLaunchTarget | "init";
  args: string[];
} {
  if (!target || target === "shell") return { target: "shell", args: [] };
  if (target === "cc" || target === "oc" || target === "init") return { target, args: [] };
  throw new Error(`Unknown sandbox command: ${target}`);
}

export async function runSandboxLaunch(options: {
  readonly root?: string | undefined;
  readonly home?: string | undefined;
  readonly profile?: string | undefined;
  readonly target: SandboxLaunchTarget;
  readonly args: readonly string[];
  readonly rebuild?: boolean | undefined;
}): Promise<void> {
  const paths = createRuntimePaths(options);
  if (!(await hasSandboxOperationalSecrets(paths))) {
    throw new Error(
      `Sandbox is not initialized. Run 'mfz sandbox init' first. Expected secrets file: ${sandboxSecretsFile(paths)}`
    );
  }

  const secrets = await readSandboxOperationalSecrets(paths);
  const profile = await resolveProfile(paths, options.profile);
  const buildPlan = await sandboxImageBuildPlan(paths, profile);
  await ensureSandboxImage(buildPlan, { force: options.rebuild });
  const runtime = await resolveSandboxRuntimeInputs(paths, profile, {
    target: options.target,
    args: options.args,
    agentToken: secrets[sandboxAgentTokenVar],
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY)
  });
  await ensureSandboxServices(paths, profile, runtime);
  await ensureSandboxState(paths, profile, runtime.credentialMode);
  await execa("docker", runtime.dockerRunArgs, { stdio: "inherit" });
}

export async function runSandboxInit(options: {
  readonly root?: string | undefined;
  readonly home?: string | undefined;
  readonly profile?: string | undefined;
}): Promise<void> {
  const paths = createRuntimePaths(options);
  const secretsFile = sandboxSecretsFile(paths);
  if (await hasSandboxOperationalSecrets(paths)) {
    console.log(`sandbox already initialized\t${secretsFile}`);
    return;
  }

  const base = await ensureSandboxBaseSecrets(paths);
  const profile = await resolveProfile(paths, options.profile);
  const runtime = await resolveSandboxRuntimeInputs(paths, profile);
  await writeSandboxCompose(paths, profile, runtime);

  // Start only Agent Vault so its data volume and server come up; the Bedrock
  // signer (when present) is not needed to provision broker state.
  await ensureSandboxServices(paths, profile, {
    ...runtime,
    services: runtime.services.slice(0, 1)
  });

  const token = await provisionBroker(
    {
      address: agentVaultApiAddress(),
      ownerEmail: base.ownerEmail,
      ownerPassword: base.ownerPassword,
      vault: sandboxVaultName,
      agentName: `mfz-sandbox-${randomBytes(4).toString("hex")}`,
      caOutputPath: sandboxCaFile(paths)
    },
    { home: paths.home }
  );
  await setSandboxAgentToken(paths, token);

  console.log(`sandbox initialized\t${secretsFile}`);
  console.log(`Back up ${secretsFile}; it is the sole copy of the Agent Vault recovery root.`);
  console.log(
    "Provider credential seeding is separate: add OpenAI, GitHub, Bedrock/AWS, and Claude subscription credentials to Agent Vault as needed."
  );
}
