import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";

const agentVaultRepo = "https://github.com/Infisical/agent-vault.git";
export const brokerImageName = "local-ai-dev-sandbox-agent-vault";
export const bedrockProxyImageName = "local-ai-dev-sandbox-bedrock-sigv4-proxy";

/**
 * Resolve the version of the locally installed `agent-vault` CLI so the broker
 * image can be pinned to the exact same version we run on the host.
 */
export async function resolveAgentVaultVersion(): Promise<string> {
  const { stdout } = await execa("agent-vault", ["--version"]);
  const version = stdout.match(/\d+\.\d+\.\d+/)?.[0];
  if (!version) {
    throw new Error(`Could not parse agent-vault version from: ${stdout.trim()}`);
  }
  return version;
}

export function brokerImageRef(version: string): string {
  return `${brokerImageName}:${version}`;
}

async function imageExists(ref: string): Promise<boolean> {
  try {
    await execa("docker", ["image", "inspect", ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the Agent Vault broker image exists for the installed CLI version.
 * There is no hosted broker image, so we clone the upstream repository at the
 * matching `v<version>` tag and build it, tagging both the version-pinned ref
 * and `:latest` (which the generated compose references). A CLI upgrade builds
 * a new version because the version-pinned image will be absent.
 */
export async function ensureBrokerImage(
  options: { readonly force?: boolean } = {}
): Promise<string> {
  const version = await resolveAgentVaultVersion();
  const ref = brokerImageRef(version);
  if (!options.force && (await imageExists(ref))) return ref;

  const workdir = await mkdtemp(path.join(os.tmpdir(), "mfz-agent-vault-"));
  try {
    await execa(
      "git",
      ["clone", "--depth", "1", "--branch", `v${version}`, agentVaultRepo, workdir],
      { stdio: "inherit" }
    );
    await execa(
      "docker",
      [
        "build",
        "--build-arg",
        `VERSION=${version}`,
        "-t",
        ref,
        "-t",
        `${brokerImageName}:latest`,
        workdir
      ],
      { stdio: "inherit" }
    );
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
  return ref;
}

/**
 * Ensure the Bedrock SigV4 signing-proxy image exists. Unlike the broker, this
 * is our own in-repo Dockerfile (it pulls the upstream signer from public ECR),
 * so it builds from the repo's `sandbox/` context rather than a version clone.
 */
export async function ensureBedrockProxyImage(
  root: string,
  options: { readonly force?: boolean } = {}
): Promise<string> {
  const ref = `${bedrockProxyImageName}:latest`;
  if (!options.force && (await imageExists(ref))) return ref;

  const context = path.join(root, "sandbox");
  await execa(
    "docker",
    [
      "build",
      "-t",
      ref,
      "-f",
      path.join(context, "proxy", "bedrock-sigv4-proxy", "Dockerfile"),
      context
    ],
    { stdio: "inherit" }
  );
  return ref;
}
