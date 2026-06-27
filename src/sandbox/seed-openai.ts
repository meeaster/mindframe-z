import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { ownerCliEnv, sandboxVaultName } from "./config.js";
import {
  ensureBrokerForSeeding,
  uploadOauthCredential,
  type SeedOptions
} from "./provider-seed.js";

const chatgptHost = "chatgpt.com";
const openaiServiceName = "openai-chatgpt";
// opencode's Codex/ChatGPT public OAuth constants.
const openaiTokenUrl = "https://auth.openai.com/oauth/token";
const openaiClientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const openaiOauthKey = "OPENAI_OAUTH";
const openaiAccountKey = "OPENAI_ACCOUNT_ID";

export interface OpenaiOauthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accountId: string;
}

/**
 * A `custom` service injecting both the Bearer token (auto-refreshing OAuth
 * credential) and the static ChatGPT account header for chatgpt.com.
 */
export function openaiServiceYaml(): string {
  return [
    `vault: ${sandboxVaultName}`,
    "services:",
    `  - name: ${openaiServiceName}`,
    `    host: ${chatgptHost}`,
    "    auth:",
    "      type: custom",
    "      headers:",
    `        Authorization: "Bearer {{ ${openaiOauthKey} }}"`,
    `        ChatGPT-Account-Id: "{{ ${openaiAccountKey} }}"`,
    ""
  ].join("\n");
}

export function openaiOauthUploadBody(tokens: OpenaiOauthTokens): Record<string, string> {
  return {
    vault: sandboxVaultName,
    key: openaiOauthKey,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_url: openaiTokenUrl,
    client_id: openaiClientId,
    token_auth_method: "none"
  };
}

export async function readHostOpenaiOauth(home: string): Promise<OpenaiOauthTokens> {
  const file = path.join(home, ".local", "share", "opencode", "auth.json");
  let parsed: { openai?: { access?: string; refresh?: string; accountId?: string } };
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error(
      `opencode ChatGPT credential not found at ${file}. Log in to ChatGPT with opencode on the host first.`
    );
  }
  const oauth = parsed.openai;
  if (!oauth?.access || !oauth.refresh || !oauth.accountId) {
    throw new Error(`No openai access/refresh/accountId in ${file}.`);
  }
  return { accessToken: oauth.access, refreshToken: oauth.refresh, accountId: oauth.accountId };
}

export async function runSeedOpenai(options: SeedOptions): Promise<void> {
  const paths = await ensureBrokerForSeeding(options);
  const tokens = await readHostOpenaiOauth(paths.home);
  const env = ownerCliEnv(paths.home);

  const dir = await mkdtemp(path.join(os.tmpdir(), "mfz-openai-seed-"));
  try {
    const yamlPath = path.join(dir, "openai-service.yaml");
    await writeFile(yamlPath, openaiServiceYaml(), "utf8");
    await execa(
      "agent-vault",
      ["vault", "service", "add", "-f", yamlPath, "--vault", sandboxVaultName],
      { env }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  await execa(
    "agent-vault",
    [
      "vault",
      "credential",
      "set",
      `${openaiAccountKey}=${tokens.accountId}`,
      "--vault",
      sandboxVaultName
    ],
    { env }
  );
  await uploadOauthCredential(paths.home, openaiOauthUploadBody(tokens));

  console.log(`Seeded opencode ChatGPT credential into vault ${sandboxVaultName}.`);
  console.log(
    "Agent Vault now refreshes the token automatically. Its first refresh rotates the refresh token into the vault, so re-run ChatGPT login in opencode on the host if you use it there."
  );
}
