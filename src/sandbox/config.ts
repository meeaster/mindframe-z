import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { MachineManifest, SandboxCredentialMode } from "../core/manifests.js";
import type { RuntimePaths } from "../core/paths.js";

export const sandboxVaultName = "local-ai-dev-sandbox";
export const sandboxSecretsFileName = "sandbox.env";
export const sandboxCaFileName = "mitm-ca.pem";
export const agentVaultApiPort = 14321;

export const sandboxMasterPasswordVar = "AGENT_VAULT_MASTER_PASSWORD";
export const sandboxAgentTokenVar = "AGENT_VAULT_TOKEN";
export const sandboxOwnerEmailVar = "AGENT_VAULT_OWNER_EMAIL";
export const sandboxOwnerPasswordVar = "AGENT_VAULT_OWNER_PASSWORD";

export interface SandboxBaseSecrets {
  readonly ownerEmail: string;
  readonly ownerPassword: string;
}

export function sandboxSecretsDir(paths: RuntimePaths): string {
  return path.join(paths.home, ".mindframe-z", "secrets");
}

export function sandboxSecretsFile(paths: RuntimePaths): string {
  return path.join(sandboxSecretsDir(paths), sandboxSecretsFileName);
}

export function sandboxCaFile(paths: RuntimePaths): string {
  return path.join(sandboxSecretsDir(paths), sandboxCaFileName);
}

export function agentVaultApiAddress(): string {
  return `http://127.0.0.1:${agentVaultApiPort}`;
}

/**
 * Environment for owner-level `agent-vault` CLI calls. Strips any ambient
 * `AGENT_VAULT_TOKEN`/`AGENT_VAULT_VAULT` (e.g. a proxy session in the operator's
 * shell) so the CLI authenticates with the saved owner session rather than
 * dropping into agent mode, which lacks the role to manage vault state.
 */
export function ownerCliEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.AGENT_VAULT_ADDR = agentVaultApiAddress();
  env.HOME = home;
  delete env.AGENT_VAULT_TOKEN;
  delete env.AGENT_VAULT_VAULT;
  return env;
}

function parseSecrets(content: string): Record<string, string> {
  return Object.fromEntries(
    content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return index === -1 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

async function readSecretsRecord(paths: RuntimePaths): Promise<Record<string, string>> {
  try {
    return parseSecrets(await readFile(sandboxSecretsFile(paths), "utf8"));
  } catch {
    return {};
  }
}

async function writeSecretsRecord(
  paths: RuntimePaths,
  record: Record<string, string>
): Promise<void> {
  await mkdir(sandboxSecretsDir(paths), { recursive: true });
  const content = `${Object.entries(record)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
  const file = sandboxSecretsFile(paths);
  await writeFile(file, content, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

export async function hasSandboxOperationalSecrets(paths: RuntimePaths): Promise<boolean> {
  const record = await readSecretsRecord(paths);
  return Boolean(record[sandboxMasterPasswordVar] && record[sandboxAgentTokenVar]);
}

export async function readSandboxOperationalSecrets(
  paths: RuntimePaths
): Promise<Record<string, string>> {
  return parseSecrets(await readFile(sandboxSecretsFile(paths), "utf8"));
}

function generatedSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Ensure the infrastructure secrets (broker master password and Agent Vault
 * owner account) exist without ever overwriting an existing master password.
 * The master password is the sole recovery root, so a second init resumes
 * against the already-generated values rather than regenerating them.
 */
export async function ensureSandboxBaseSecrets(paths: RuntimePaths): Promise<SandboxBaseSecrets> {
  const record = await readSecretsRecord(paths);
  if (!record[sandboxMasterPasswordVar]) {
    record[sandboxMasterPasswordVar] = generatedSecret();
  }
  if (!record[sandboxOwnerEmailVar]) {
    record[sandboxOwnerEmailVar] = `sandbox-${randomBytes(4).toString("hex")}@local.invalid`;
  }
  if (!record[sandboxOwnerPasswordVar]) {
    record[sandboxOwnerPasswordVar] = generatedSecret(24);
  }
  await writeSecretsRecord(paths, record);
  return {
    ownerEmail: record[sandboxOwnerEmailVar],
    ownerPassword: record[sandboxOwnerPasswordVar]
  };
}

export async function setSandboxAgentToken(paths: RuntimePaths, token: string): Promise<void> {
  const record = await readSecretsRecord(paths);
  record[sandboxAgentTokenVar] = token;
  await writeSecretsRecord(paths, record);
}

export async function detectSandboxCredentialMode(
  paths: RuntimePaths
): Promise<SandboxCredentialMode | undefined> {
  try {
    const settings = JSON.parse(
      await readFile(path.join(paths.claudeDir, "settings.json"), "utf8")
    ) as { env?: Record<string, unknown> };
    const env = settings.env ?? {};
    if (env.CLAUDE_CODE_USE_BEDROCK || env.ANTHROPIC_BEDROCK_BASE_URL) return "bedrock";
  } catch {
    // Missing or unreadable Claude settings means there is no detected mode.
  }
  return undefined;
}

export async function resolveSandboxCredentialMode(
  paths: RuntimePaths,
  machine: MachineManifest
): Promise<SandboxCredentialMode | undefined> {
  return machine.sandbox.credentials ?? (await detectSandboxCredentialMode(paths));
}
