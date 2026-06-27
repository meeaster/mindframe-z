#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

const [agent, ...agentArgs] = process.argv.slice(2);
const sessionCommand = agent ? [agent, ...agentArgs] : ["zsh", "-il"];

const workspace = process.env.WORKSPACE_DIR ?? "/workspace";
const brokerConfigPath = process.env.SANDBOX_MCP_BROKER_CONFIG ?? `${workspace}/mcp-broker.json`;
const opencodeConfigPath =
  process.env.SANDBOX_OPENCODE_SOURCE_CONFIG ?? `${workspace}/opencode.json`;
const generatedOpencodeConfigPath =
  process.env.SANDBOX_OPENCODE_GENERATED_CONFIG ?? "/tmp/sandbox-opencode.json";
const logDir = process.env.SANDBOX_MCP_SHIM_LOG_DIR ?? `${workspace}/.cache/mcp-shims`;
const shims = [];
const children = [];

if (process.env.SANDBOX_MCP_BROKER_ENABLED !== "0" && fs.existsSync(brokerConfigPath)) {
  const brokerConfig = JSON.parse(fs.readFileSync(brokerConfigPath, "utf8"));
  const opencodeConfig = fs.existsSync(opencodeConfigPath)
    ? JSON.parse(fs.readFileSync(opencodeConfigPath, "utf8"))
    : { $schema: "https://opencode.ai/config.json" };
  const usesNestedServers = !!opencodeConfig.mcp?.servers;
  const servers = usesNestedServers ? opencodeConfig.mcp.servers : (opencodeConfig.mcp ?? {});
  const basePort = Number(brokerConfig.basePort ?? 17301);

  let offset = 0;
  for (const [name, options] of Object.entries(brokerConfig.shims ?? {})) {
    assertSafeName(name);
    const server = servers[name];
    if (!server?.url) continue;

    const port = Number(options.port ?? basePort + offset);
    offset += 1;
    const upstream = options.upstream ?? server.url;
    const vault = options.vault ?? `local-ai-dev-sandbox-mcp-${name}`;
    const localUrl = `http://127.0.0.1:${port}${new URL(upstream).pathname || "/mcp"}`;

    shims.push({ name, port, upstream, vault });
    servers[name] = {
      ...server,
      type: server.type === "http" || server.type === "streamable-http" ? server.type : "remote",
      url: localUrl,
      headers: { ...server.headers, Authorization: "PLACEHOLDER" },
      oauth: false
    };
  }

  if (shims.length > 0) {
    opencodeConfig.mcp = usesNestedServers ? { ...opencodeConfig.mcp, servers } : servers;
    const generatedConfig = `${JSON.stringify(opencodeConfig, null, 2)}\n`;
    fs.writeFileSync(generatedOpencodeConfigPath, generatedConfig, { mode: 0o600 });
    if (!process.env.OPENCODE_CONFIG_CONTENT) {
      process.env.OPENCODE_CONFIG_CONTENT = generatedConfig;
    }
  }
}

for (const shim of shims) {
  fs.mkdirSync(logDir, { recursive: true });
  const child = spawn("node", [`${workspace}/scripts/mcp-egress-shim.mjs`], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      MCP_SHIM_NAME: shim.name,
      MCP_SHIM_LISTEN_PORT: String(shim.port),
      MCP_SHIM_UPSTREAM: shim.upstream,
      MCP_SHIM_VAULT: shim.vault,
      MCP_SHIM_PROXY_HOST: process.env.MCP_SHIM_PROXY_HOST ?? "host.docker.internal",
      MCP_SHIM_PROXY_PORT: process.env.MCP_SHIM_PROXY_PORT ?? "14322"
    }
  });
  child.stderr.pipe(fs.createWriteStream(`${logDir}/${shim.name}.log`, { flags: "a" }));
  children.push(child);
}

for (const shim of shims) {
  await waitForPort(shim.port);
}

const session = spawn(sessionCommand[0], sessionCommand.slice(1), {
  stdio: "inherit",
  env: process.env
});
children.push(session);

const shutdown = () => {
  for (const child of children) child.kill("SIGTERM");
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

session.on("exit", (code, signal) => {
  for (const child of children) {
    if (child !== session) child.kill("SIGTERM");
  }
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

function assertSafeName(name) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Unsafe MCP server name: ${name}`);
}

async function waitForPort(port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for MCP shim on port ${port}`);
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(250, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
