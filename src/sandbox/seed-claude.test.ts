import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  anthropicServiceAddArgs,
  claudeOauthUploadBody,
  readHostClaudeOauth
} from "./seed-claude.js";

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mindframe-z-seed-test-"));
}

describe("seed claude subscription", () => {
  it("upserts an anthropic bearer service scoped to the sandbox vault", () => {
    expect(anthropicServiceAddArgs()).toEqual([
      "vault",
      "service",
      "add",
      "--name",
      "anthropic-subscription",
      "--host",
      "api.anthropic.com",
      "--auth-type",
      "bearer",
      "--token-key",
      "CLAUDE_AI_OAUTH",
      "--vault",
      "local-ai-dev-sandbox"
    ]);
  });

  it("builds an OAuth upload body with refresh config from the host tokens", () => {
    expect(claudeOauthUploadBody({ accessToken: "access-1", refreshToken: "refresh-1" })).toEqual({
      vault: "local-ai-dev-sandbox",
      key: "CLAUDE_AI_OAUTH",
      access_token: "access-1",
      refresh_token: "refresh-1",
      token_url: "https://console.anthropic.com/v1/oauth/token",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      token_auth_method: "none"
    });
  });

  it("reads the host Claude OAuth tokens", async () => {
    const home = await tempHome();
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "a", refreshToken: "r", subscriptionType: "pro" }
      }),
      "utf8"
    );

    await expect(readHostClaudeOauth(home)).resolves.toEqual({
      accessToken: "a",
      refreshToken: "r"
    });
  });

  it("errors clearly when the host credential is missing", async () => {
    const home = await tempHome();
    await expect(readHostClaudeOauth(home)).rejects.toThrow(/Log in with Claude Code/);
  });

  it("errors when the credential lacks a refresh token", async () => {
    const home = await tempHome();
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "a" } }),
      "utf8"
    );

    await expect(readHostClaudeOauth(home)).rejects.toThrow(/access\/refresh tokens/);
  });
});
