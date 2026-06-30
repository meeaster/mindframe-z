import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntimePaths } from "../core/paths.js";
import { makeTempDir } from "../../tests/integration/support.js";
import {
  bedrockContainerEnv,
  readBedrockHostSettings,
  writeScopedBedrockCredentials,
  type BedrockHostSettings
} from "./bedrock.js";

async function writeClaudeSettings(claudeDir: string, body: unknown): Promise<void> {
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, "settings.json"), JSON.stringify(body), "utf8");
}

describe("readBedrockHostSettings", () => {
  it("extracts only bedrock-relevant values and the auth-refresh path", async () => {
    const home = await makeTempDir();
    const paths = createRuntimePaths({ root: process.cwd(), home });
    await writeClaudeSettings(paths.claudeDir, {
      env: {
        AWS_PROFILE: "ClaudeCodeUnix",
        AWS_REGION: "us-west-2",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com",
        SOME_UNRELATED_SETTING: "ignored"
      },
      awsAuthRefresh: "/home/u/cc/credential-process",
      otelHeadersHelper: "/home/u/cc/otel-helper"
    });

    const settings = await readBedrockHostSettings(paths);

    expect(settings.awsProfile).toBe("ClaudeCodeUnix");
    expect(settings.awsRegion).toBe("us-west-2");
    expect(settings.awsAuthRefresh).toBe("/home/u/cc/credential-process");
    expect(settings.otelHeadersHelper).toBe("/home/u/cc/otel-helper");
    // Only OTEL/telemetry keys pass through, never unrelated settings.
    expect(settings.otelEnv).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com"
    });
    expect(settings.otelEnv).not.toHaveProperty("SOME_UNRELATED_SETTING");
    expect(settings.otelEnv).not.toHaveProperty("AWS_PROFILE");
  });

  it("falls back to sensible defaults when env keys are absent", async () => {
    const home = await makeTempDir();
    const paths = createRuntimePaths({ root: process.cwd(), home });
    await writeClaudeSettings(paths.claudeDir, { env: {} });

    const settings = await readBedrockHostSettings(paths);

    expect(settings.awsProfile).toBe("default");
    expect(settings.awsRegion).toBe("us-west-2");
    expect(settings.awsAuthRefresh).toBeUndefined();
  });

  it("throws a pointed error when Claude settings are missing", async () => {
    const home = await makeTempDir();
    const paths = createRuntimePaths({ root: process.cwd(), home });

    await expect(readBedrockHostSettings(paths)).rejects.toThrow(/Claude settings/);
  });
});

describe("bedrockContainerEnv", () => {
  it("enables Bedrock, scopes the SDK, and carries OTEL passthrough", async () => {
    const settings: BedrockHostSettings = {
      awsProfile: "ClaudeCodeUnix",
      awsRegion: "us-west-2",
      awsAuthRefresh: "/bin/cp",
      otelEnv: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com" },
      otelHeadersHelper: undefined
    };

    const env = await bedrockContainerEnv(settings);

    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(env.AWS_REGION).toBe("us-west-2");
    expect(env.AWS_PROFILE).toBe("ClaudeCodeUnix");
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe("/home/sandbox/.aws/credentials");
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://otel.example.com");
    // No helper configured → no attribution header, but telemetry still ships.
    expect(env).not.toHaveProperty("OTEL_EXPORTER_OTLP_HEADERS");
  });
});

describe("writeScopedBedrockCredentials", () => {
  it("writes only the named profile section into a 0600 dedicated dir", async () => {
    const home = await makeTempDir();
    const paths = createRuntimePaths({ root: process.cwd(), home });
    await mkdir(path.join(home, ".aws"), { recursive: true });
    await writeFile(
      path.join(home, ".aws", "credentials"),
      [
        "[ClaudeCodeUnix]",
        "aws_access_key_id = AKIA_BEDROCK",
        "aws_secret_access_key = secret",
        "x-expiration = 2026-01-01T00:00:00Z",
        "",
        "[ps-impl-prod]",
        "aws_access_key_id = AKIA_PROD",
        "aws_secret_access_key = prodsecret",
        ""
      ].join("\n"),
      "utf8"
    );

    const settings: BedrockHostSettings = {
      awsProfile: "ClaudeCodeUnix",
      awsRegion: "us-west-2",
      awsAuthRefresh: "/bin/cp",
      otelEnv: {},
      otelHeadersHelper: undefined
    };

    const dir = await writeScopedBedrockCredentials(paths, settings);
    const { readFile } = await import("node:fs/promises");
    const written = await readFile(path.join(dir, "credentials"), "utf8");

    expect(written).toContain("[ClaudeCodeUnix]");
    expect(written).toContain("AKIA_BEDROCK");
    // The other profiles never reach the container.
    expect(written).not.toContain("ps-impl-prod");
    expect(written).not.toContain("AKIA_PROD");
  });

  it("throws when the configured profile is absent from the credentials file", async () => {
    const home = await makeTempDir();
    const paths = createRuntimePaths({ root: process.cwd(), home });
    await mkdir(path.join(home, ".aws"), { recursive: true });
    await writeFile(path.join(home, ".aws", "credentials"), "[other]\nkey = v\n", "utf8");

    const settings: BedrockHostSettings = {
      awsProfile: "ClaudeCodeUnix",
      awsRegion: "us-west-2",
      awsAuthRefresh: "/bin/cp",
      otelEnv: {},
      otelHeadersHelper: undefined
    };

    await expect(writeScopedBedrockCredentials(paths, settings)).rejects.toThrow(/not found/);
  });
});
