import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { RuntimePaths } from "../core/paths.js";

// The thread runner reaches Bedrock the same way the operator's interactive
// Claude Code does: it READS ~/.claude/settings.json (never mounts it) and
// extracts only the handful of Bedrock-relevant values plus the awsAuthRefresh
// binary path. This keeps thread dispatch byte-identical to whatever the
// operator (or a teammate) already validated for interactive Claude Code — no
// second config knob to keep in sync — while leaking none of the file's other
// settings (permissions, MCP, hooks) into the headless container.

const BEDROCK_REGION_FALLBACK = "us-west-2";

export interface BedrockHostSettings {
  /** AWS named profile the credential file is written under (default: from settings). */
  readonly awsProfile: string;
  readonly awsRegion: string;
  /** Absolute path to the credential-process binary (settings.awsAuthRefresh). */
  readonly awsAuthRefresh: string | undefined;
  /** Static OTEL env the operator configured for usage monitoring, passed through verbatim. */
  readonly otelEnv: Record<string, string>;
  /** Path to the otelHeadersHelper binary, used host-side to resolve per-user headers. */
  readonly otelHeadersHelper: string | undefined;
}

interface RawClaudeSettings {
  env?: Record<string, unknown>;
  awsAuthRefresh?: unknown;
  otelHeadersHelper?: unknown;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// OTEL_* / *TELEMETRY* env keys drive Claude Code's exporter and carry no
// secrets (the endpoint, protocol, and static resource attributes), so they are
// safe to pass straight through to the container. The per-user identity headers
// are resolved separately via the helper.
function extractOtelEnv(env: Record<string, unknown>): Record<string, string> {
  const otel: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("OTEL_") && !key.includes("TELEMETRY")) continue;
    const str = stringField(value);
    if (str) otel[key] = str;
  }
  return otel;
}

export async function readBedrockHostSettings(paths: RuntimePaths): Promise<BedrockHostSettings> {
  const settingsPath = path.join(paths.claudeDir, "settings.json");
  let raw: RawClaudeSettings;
  try {
    raw = JSON.parse(await readFile(settingsPath, "utf8")) as RawClaudeSettings;
  } catch (error) {
    throw new Error(
      `Bedrock thread dispatch needs Claude settings at ${settingsPath}: ${(error as Error).message}`
    );
  }
  const env = raw.env ?? {};
  return {
    awsProfile: stringField(env.AWS_PROFILE) ?? "default",
    awsRegion: stringField(env.AWS_REGION) ?? BEDROCK_REGION_FALLBACK,
    awsAuthRefresh: stringField(raw.awsAuthRefresh),
    otelEnv: extractOtelEnv(env),
    otelHeadersHelper: stringField(raw.otelHeadersHelper)
  };
}

// Refresh once, on the host, BEFORE launching any dispatch container. The stock
// credential-process binary checks its cache first: valid creds return instantly
// with no browser; an expired SSO session is the only case that opens a browser,
// and its :8400 port-lock serializes that against the operator's live Claude
// Code session rather than racing it. A dispatch batch must call this exactly
// once up front, not per-agent, to avoid a refresh stampede.
export async function refreshBedrockCredentials(settings: BedrockHostSettings): Promise<void> {
  if (!settings.awsAuthRefresh) {
    throw new Error("Bedrock thread dispatch needs awsAuthRefresh in Claude settings");
  }
  await execa(settings.awsAuthRefresh, ["--refresh-if-needed", "--profile", settings.awsProfile], {
    // Inherit stderr so an interactive browser prompt (expired SSO) is visible to
    // the operator; stdout carries the credential JSON we don't need here.
    stdio: ["ignore", "ignore", "inherit"]
  });
}

// Write a single-profile credentials file into a dedicated directory so the
// container sees ONLY the Bedrock profile, not every profile in ~/.aws. The
// directory (not the file) is mounted so the SDK follows the credential
// process's atomic rename and reads fresh creds per request.
export async function writeScopedBedrockCredentials(
  paths: RuntimePaths,
  settings: BedrockHostSettings
): Promise<string> {
  const source = path.join(paths.home, ".aws", "credentials");
  const profileHeader = `[${settings.awsProfile}]`;
  const credsFile = await readFile(source, "utf8");
  const section = extractProfileSection(credsFile, profileHeader);
  if (!section) {
    throw new Error(
      `AWS profile ${settings.awsProfile} not found in ${source}; run Claude Code or the credential process first`
    );
  }
  const dir = path.join(paths.home, ".mindframe-z", "bedrock");
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, "credentials");
  await writeFile(target, section, { mode: 0o600 });
  return dir;
}

// Claude Code's `otelHeadersHelper` runs a host-path binary to mint per-user
// attribution headers (x-user-email, x-department, …) from the SSO monitoring
// token. That binary does not exist in the container, so we resolve the headers
// ONCE on the host and inject them statically as OTEL_EXPORTER_OTLP_HEADERS
// (comma-separated key=value, values percent-encoded). Header resolution is
// best-effort: telemetry attribution must never block a dispatch.
export async function resolveOtelHeaders(
  settings: BedrockHostSettings
): Promise<string | undefined> {
  if (!settings.otelHeadersHelper) return undefined;
  try {
    const { stdout } = await execa(settings.otelHeadersHelper, [], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const pairs = Object.entries(parsed as Record<string, unknown>)
      .map(([key, value]) => [key, stringField(value)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
    return pairs.length > 0 ? pairs.join(",") : undefined;
  } catch {
    // Helper missing, non-JSON, or no cached token: ship telemetry without
    // per-user attribution rather than failing the dispatch.
    return undefined;
  }
}

// The full env a Bedrock dispatch container needs: tell Claude Code to use
// Bedrock, point the SDK at the scoped credential dir + region/profile, and
// carry the operator's OTEL config (static vars + resolved attribution headers)
// so company usage monitoring sees thread dispatches too.
export async function bedrockContainerEnv(
  settings: BedrockHostSettings
): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: settings.awsRegion,
    AWS_PROFILE: settings.awsProfile,
    // The credential file is mounted at this dir; the agent never gets static keys.
    AWS_SHARED_CREDENTIALS_FILE: "/home/sandbox/.aws/credentials",
    AWS_EC2_METADATA_DISABLED: "true",
    ...settings.otelEnv
  };
  const headers = await resolveOtelHeaders(settings);
  if (headers) env.OTEL_EXPORTER_OTLP_HEADERS = headers;
  return env;
}

function extractProfileSection(contents: string, header: string): string | undefined {
  const lines = contents.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => line.trim().startsWith("["));
  const body = next === -1 ? rest : rest.slice(0, next);
  return [header, ...body].join("\n").trimEnd() + "\n";
}
