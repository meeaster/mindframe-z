import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRuntimePaths, type RuntimePaths } from "../core/paths.js";
import { resolveProfile } from "../core/profile.js";
import {
  agentVaultApiAddress,
  hasSandboxOperationalSecrets,
  sandboxSecretsFile
} from "./config.js";
import { ensureSandboxServices } from "./lifecycle.js";
import { resolveSandboxRuntimeInputs } from "./runtime.js";

export interface SeedOptions {
  readonly root?: string | undefined;
  readonly home?: string | undefined;
  readonly profile?: string | undefined;
}

export async function readOwnerSessionToken(home: string): Promise<string> {
  const file = path.join(home, ".agent-vault", "session.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { token?: string };
    if (parsed.token) return parsed.token;
  } catch {
    // Fall through to the explicit error below.
  }
  throw new Error(`Agent Vault owner session not found at ${file}. Run 'mfz sandbox init' first.`);
}

/**
 * Resolve paths, require initialization, and make sure Agent Vault is running so
 * provider-seeding calls reach a live server.
 */
export async function ensureBrokerForSeeding(options: SeedOptions): Promise<RuntimePaths> {
  const paths = createRuntimePaths(options);
  if (!(await hasSandboxOperationalSecrets(paths))) {
    throw new Error(
      `Sandbox is not initialized. Run 'mfz sandbox init' first. Expected secrets file: ${sandboxSecretsFile(paths)}`
    );
  }
  const profile = await resolveProfile(paths, options.profile);
  const runtime = await resolveSandboxRuntimeInputs(paths, profile);
  await ensureSandboxServices(paths, profile, {
    ...runtime,
    services: runtime.services.slice(0, 1)
  });
  return paths;
}

/**
 * Upload an OAuth credential. Agent Vault validates the refresh token by
 * refreshing immediately, so a non-OK response means the config (or token) is
 * wrong.
 */
export async function uploadOauthCredential(
  home: string,
  body: Record<string, string>
): Promise<void> {
  const sessionToken = await readOwnerSessionToken(home);
  const response = await fetch(`${agentVaultApiAddress()}/v1/credentials/oauth/tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(
      `Agent Vault rejected the OAuth credential (HTTP ${response.status}): ${(await response.text()).trim()}`
    );
  }
}
