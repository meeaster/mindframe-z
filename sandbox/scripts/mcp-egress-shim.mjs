#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const listenHost = process.env.MCP_SHIM_LISTEN_HOST ?? "127.0.0.1";
const listenPort = Number(process.env.MCP_SHIM_LISTEN_PORT ?? "0");
const upstream = new URL(requireEnv("MCP_SHIM_UPSTREAM"));
const vaultHint = requireEnv("MCP_SHIM_VAULT");
const vaultToken = requireEnv("AGENT_VAULT_TOKEN");
const proxyHost = process.env.MCP_SHIM_PROXY_HOST ?? "host.docker.internal";
const proxyPort = Number(process.env.MCP_SHIM_PROXY_PORT ?? "14322");
const shimName = process.env.MCP_SHIM_NAME ?? "mcp";

if (upstream.protocol !== "https:") {
  throw new Error(`MCP_SHIM_UPSTREAM must be https, got ${upstream.protocol}`);
}

const upstreamPort = Number(upstream.port || "443");
const proxyAuthorization = `Basic ${Buffer.from(`${vaultToken}:${vaultHint}`).toString("base64")}`;
class AgentVaultTunnelAgent extends https.Agent {
  createConnection(_options, callback) {
    log("connect", {
      proxyHost,
      proxyPort,
      upstreamHost: upstream.hostname,
      upstreamPort,
      vaultHint
    });
    const proxy = net.connect(proxyPort, proxyHost);
    proxy.once("error", callback);
    proxy.once("connect", () => {
      proxy.write(
        `CONNECT ${upstream.hostname}:${upstreamPort} HTTP/1.1\r\n` +
          `Host: ${upstream.hostname}:${upstreamPort}\r\n` +
          `Proxy-Authorization: ${proxyAuthorization}\r\n` +
          "Connection: keep-alive\r\n" +
          "\r\n"
      );
    });

    let buffered = Buffer.alloc(0);
    proxy.on("data", function onData(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      proxy.off("data", onData);
      const head = buffered.subarray(0, headerEnd).toString("latin1");
      const rest = buffered.subarray(headerEnd + 4);
      const status = head.match(/^HTTP\/\d\.\d\s+(\d+)/)?.[1];

      if (status !== "200") {
        proxy.destroy();
        callback(new Error(`Agent Vault CONNECT failed with status ${status ?? "unknown"}`));
        return;
      }

      if (rest.length > 0) proxy.unshift(rest);

      const tlsSocket = tls.connect({
        socket: proxy,
        servername: upstream.hostname
      });
      tlsSocket.once("secureConnect", () => callback(null, tlsSocket));
      tlsSocket.once("error", callback);
    });
  }
}

const tunnelAgent = new AgentVaultTunnelAgent({ keepAlive: true });

const server = http.createServer((req, res) => {
  const targetPath = upstream.pathname + new URL(req.url ?? "/", "http://shim.local").search;
  const headers = filterHopByHopHeaders(req.headers);
  headers.host = upstream.host;
  log("request", {
    method: req.method,
    url: req.url,
    targetPath,
    upstreamHost: upstream.hostname,
    vaultHint: vaultHint
  });

  const upstreamReq = https.request(
    {
      agent: tunnelAgent,
      hostname: upstream.hostname,
      port: upstreamPort,
      method: req.method,
      path: targetPath,
      headers
    },
    (upstreamRes) => {
      log("response", {
        method: req.method,
        url: req.url,
        statusCode: upstreamRes.statusCode,
        upstreamHost: upstream.hostname,
        vaultHint
      });
      res.writeHead(
        upstreamRes.statusCode ?? 502,
        upstreamRes.statusMessage,
        filterHopByHopHeaders(upstreamRes.headers)
      );
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.once("error", (error) => {
    log("error", {
      method: req.method,
      url: req.url,
      message: error.message,
      upstreamHost: upstream.hostname,
      vaultHint
    });
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "mcp_shim_upstream_error", message: error.message }));
  });

  req.pipe(upstreamReq);
});

server.listen(listenPort, listenHost, () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : listenPort;
  log("listening", { listenHost, listenPort: boundPort, upstream: upstream.href, vaultHint });
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function filterHopByHopHeaders(headers) {
  const blocked = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
  ]);
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!blocked.has(key.toLowerCase()) && value !== undefined) output[key] = value;
  }
  return output;
}

function log(event, data) {
  console.error(JSON.stringify({ time: new Date().toISOString(), shim: shimName, event, ...data }));
}
