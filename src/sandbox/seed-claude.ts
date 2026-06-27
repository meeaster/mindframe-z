import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { ownerCliEnv, sandboxVaultName } from "./config.js";
import {
  ensureBrokerForSeeding,
  uploadOauthCredential,
  type SeedOptions
} from "./provider-seed.js";

const anthropicHost = "api.anthropic.com";
const anthropicServiceName = "anthropic-subscription";
// Claude Code's public OAuth constants (PKCE client, no secret).
const anthropicTokenUrl = "https://console.anthropic.com/v1/oauth/token";
const claudeCodeOauthClientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const claudeOauthCredentialKey = "CLAUDE_AI_OAUTH";

export interface ClaudeOauthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

/** Argv to upsert the Anthropic bearer service without touching other services. */
export function anthropicServiceAddArgs(): string[] {
  return [
    "vault",
    "service",
    "add",
    "--name",
    anthropicServiceName,
    "--host",
    anthropicHost,
    "--auth-type",
    "bearer",
    "--token-key",
    claudeOauthCredentialKey,
    "--vault",
    sandboxVaultName
  ];
}

/**
 * Body for the OAuth credential upload. Agent Vault stores the refresh token and
 * refreshes the access token itself, so the brokered credential stays valid
 * without re-seeding.
 */
export function claudeOauthUploadBody(tokens: ClaudeOauthTokens): Record<string, string> {
  return {
    vault: sandboxVaultName,
    key: claudeOauthCredentialKey,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_url: anthropicTokenUrl,
    client_id: claudeCodeOauthClientId,
    token_auth_method: "none"
  };
}

export async function readHostClaudeOauth(home: string): Promise<ClaudeOauthTokens> {
  const file = path.join(home, ".claude", ".credentials.json");
  let parsed: { claudeAiOauth?: { accessToken?: string; refreshToken?: string } };
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error(
      `Claude subscription credential not found at ${file}. Log in with Claude Code on the host first.`
    );
  }
  const oauth = parsed.claudeAiOauth;
  if (!oauth?.accessToken || !oauth.refreshToken) {
    throw new Error(`No claudeAiOauth access/refresh tokens in ${file}.`);
  }
  return { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken };
}

export async function runSeedClaude(options: SeedOptions): Promise<void> {
  const paths = await ensureBrokerForSeeding(options);
  const tokens = await readHostClaudeOauth(paths.home);

  await execa("agent-vault", anthropicServiceAddArgs(), { env: ownerCliEnv(paths.home) });
  await uploadOauthCredential(paths.home, claudeOauthUploadBody(tokens));

  console.log(`Seeded Claude subscription credential into vault ${sandboxVaultName}.`);
  console.log(
    "Agent Vault now refreshes the token automatically. Its first refresh rotates the refresh token into the vault, so re-run /login if you also use Claude Code on the host."
  );
}
