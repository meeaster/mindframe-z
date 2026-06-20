#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const source = optionalArg("--source") ?? "opencode";
const serverFilter = optionalArg("--server");
const workspace = optionalArg("--workspace") ?? process.cwd();
const brokerConfigPath = optionalArg("--config") ?? path.join(workspace, "mcp-broker.json");
const agentVaultAddr = process.env.AGENT_VAULT_ADDR ?? "http://127.0.0.1:14321";
const dryRun = hasFlag("--dry-run");

const brokerConfig = JSON.parse(fs.readFileSync(brokerConfigPath, "utf8"));
const sourceTokens = readTokenSource(source);
const targets = Object.entries(brokerConfig.shims ?? {}).filter(([name]) => !serverFilter || name === serverFilter);
const controlSession = readAgentVaultControlSession();

if (targets.length === 0) {
  throw new Error(serverFilter ? `No shim mapping found for ${serverFilter}` : "No shim mappings found");
}

for (const [name, options] of targets) {
  const token = sourceTokens[name];
  if (!token?.accessToken || !token.refreshToken) {
    console.error(`skip ${name}: no access/refresh token pair in ${source}`);
    continue;
  }

  const tokenUrl = options.oauth?.tokenUrl ?? optionalArg("--token-url");
  if (!tokenUrl) {
    console.error(`skip ${name}: missing oauth.tokenUrl in ${brokerConfigPath}`);
    continue;
  }

  const clientId = options.oauth?.clientId ?? token.clientId ?? optionalArg("--client-id");
  if (!clientId) {
    console.error(`skip ${name}: missing OAuth client id`);
    continue;
  }

  const vault = options.vault ?? `local-ai-dev-sandbox-mcp-${name}`;
  const key = options.oauth?.key ?? `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_OAUTH`;
  const payload = {
    vault,
    key,
    access_token: token.accessToken,
    refresh_token: options.oauth?.accessTokenOnly ? "" : token.refreshToken,
    token_url: options.oauth?.accessTokenOnly ? "manual" : tokenUrl,
    client_id: clientId,
    client_secret: token.clientSecret ?? options.oauth?.clientSecret ?? "",
    token_auth_method: token.clientSecret || options.oauth?.clientSecret ? "client_secret_basic" : "none",
  };

  if (dryRun) {
    console.log(`${name}: would upload OAuth credential ${key} to vault ${vault}`);
    continue;
  }

  const response = await fetch(new URL("/v1/credentials/oauth/tokens", agentVaultAddr), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${controlSession.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`${name}: token upload failed: HTTP ${response.status} ${await response.text()}`);
  }

  console.log(`${name}: uploaded OAuth credential ${key} to vault ${vault}`);
}

function readTokenSource(name) {
  if (name === "opencode") return readOpenCodeTokens();
  if (name === "json") return readNormalizedTokens(requireArg("--token-file"));
  if (name === "claude") {
    throw new Error(
      "Claude Code does not document a stable local MCP OAuth token file. Export tokens to normalized JSON and run with --source json --token-file <path>.",
    );
  }
  throw new Error(`Unsupported source: ${name}`);
}

function readAgentVaultControlSession() {
  const explicitToken = optionalArg("--agent-vault-token") ?? process.env.AGENT_VAULT_CONTROL_TOKEN;
  if (explicitToken) return { token: explicitToken };

  const sessionPath =
    process.env.AGENT_VAULT_SESSION_PATH ?? path.join(os.homedir(), ".agent-vault", "session.json");
  const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  if (!session.token) throw new Error(`${sessionPath} does not contain a token`);
  return { token: session.token };
}

function readOpenCodeTokens() {
  const authPath =
    optionalArg("--token-file") ??
    process.env.OPENCODE_MCP_AUTH_PATH ??
    path.join(os.homedir(), ".local", "share", "opencode", "mcp-auth.json");
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  const result = {};
  for (const [name, entry] of Object.entries(auth)) {
    result[name] = {
      accessToken: entry.tokens?.accessToken,
      refreshToken: entry.tokens?.refreshToken,
      clientId: entry.clientInfo?.clientId,
      clientSecret: entry.clientInfo?.clientSecret,
    };
  }
  return result;
}

function readNormalizedTokens(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const servers = raw.servers ?? raw;
  const result = {};
  for (const [name, entry] of Object.entries(servers)) {
    result[name] = {
      accessToken: entry.accessToken ?? entry.access_token,
      refreshToken: entry.refreshToken ?? entry.refresh_token,
      clientId: entry.clientId ?? entry.client_id,
      clientSecret: entry.clientSecret ?? entry.client_secret,
    };
  }
  return result;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function requireArg(name) {
  const value = optionalArg(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
