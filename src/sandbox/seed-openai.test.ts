import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openaiOauthUploadBody, openaiServiceYaml, readHostOpenaiOauth } from "./seed-openai.js";

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mindframe-z-seed-openai-"));
}

async function writeOpencodeAuth(home: string, openai: Record<string, unknown>): Promise<void> {
  const dir = path.join(home, ".local", "share", "opencode");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "auth.json"), JSON.stringify({ openai }), "utf8");
}

describe("seed openai chatgpt", () => {
  it("builds a custom service injecting bearer token and account header", () => {
    const yaml = openaiServiceYaml();
    expect(yaml).toContain("host: chatgpt.com");
    expect(yaml).toContain("type: custom");
    expect(yaml).toContain('Authorization: "Bearer {{ OPENAI_OAUTH }}"');
    expect(yaml).toContain('ChatGPT-Account-Id: "{{ OPENAI_ACCOUNT_ID }}"');
  });

  it("builds an OAuth upload body with opencode's Codex refresh config", () => {
    expect(
      openaiOauthUploadBody({ accessToken: "a", refreshToken: "r", accountId: "acct" })
    ).toEqual({
      vault: "local-ai-dev-sandbox",
      key: "OPENAI_OAUTH",
      access_token: "a",
      refresh_token: "r",
      token_url: "https://auth.openai.com/oauth/token",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      token_auth_method: "none"
    });
  });

  it("reads the host opencode ChatGPT tokens", async () => {
    const home = await tempHome();
    await writeOpencodeAuth(home, {
      type: "oauth",
      access: "a",
      refresh: "r",
      accountId: "acct-1",
      expires: 123
    });

    await expect(readHostOpenaiOauth(home)).resolves.toEqual({
      accessToken: "a",
      refreshToken: "r",
      accountId: "acct-1"
    });
  });

  it("errors clearly when the host opencode credential is missing", async () => {
    const home = await tempHome();
    await expect(readHostOpenaiOauth(home)).rejects.toThrow(/Log in to ChatGPT/);
  });

  it("errors when the opencode credential lacks an account id", async () => {
    const home = await tempHome();
    await writeOpencodeAuth(home, { type: "oauth", access: "a", refresh: "r" });
    await expect(readHostOpenaiOauth(home)).rejects.toThrow(/access\/refresh\/accountId/);
  });
});
