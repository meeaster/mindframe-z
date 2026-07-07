import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MachineManifest } from "../core/manifests.js";
import type { RuntimePaths } from "../core/paths.js";
import {
  ensureSandboxBaseSecrets,
  hasSandboxOperationalSecrets,
  readSandboxOperationalSecrets,
  resolveSandboxCredentialMode,
  sandboxCaFile,
  sandboxSecretsFile,
  setSandboxAgentToken
} from "./config.js";

async function testPaths(): Promise<RuntimePaths> {
  const home = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-sandbox-test-"));
  return {
    root: home,
    home,
    configsDir: path.join(home, "configs"),
    opencodeConfigDir: path.join(home, ".config", "opencode"),
    claudeDir: path.join(home, ".claude"),
    codexDir: path.join(home, ".codex"),
    miseConfigDir: path.join(home, ".config", "mise")
  };
}

function machine(credentials?: "bedrock" | "subscription"): MachineManifest {
  return {
    references_dir: "~/references",
    extra_folders: [],
    git: {},
    sandbox: credentials ? { credentials } : {},
    thread: { destinations: [] },
    archives: [],
    opencode: {}
  };
}

describe("sandbox config", () => {
  it("uses explicit machine credential mode before Claude settings detection", async () => {
    const paths = await testPaths();
    await mkdir(paths.claudeDir, { recursive: true });
    await writeFile(
      path.join(paths.claudeDir, "settings.json"),
      JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }),
      "utf8"
    );

    await expect(resolveSandboxCredentialMode(paths, machine("subscription"))).resolves.toBe(
      "subscription"
    );
  });

  it("detects Bedrock mode from machine-local Claude settings", async () => {
    const paths = await testPaths();
    await mkdir(paths.claudeDir, { recursive: true });
    await writeFile(
      path.join(paths.claudeDir, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BEDROCK_BASE_URL: "http://localhost:8000" } }),
      "utf8"
    );

    await expect(resolveSandboxCredentialMode(paths, machine())).resolves.toBe("bedrock");
  });

  it("defines the machine-local sandbox secrets and CA files", async () => {
    const paths = await testPaths();

    expect(sandboxSecretsFile(paths)).toBe(
      path.join(paths.home, ".mindframe-z", "secrets", "sandbox.env")
    );
    expect(sandboxCaFile(paths)).toBe(
      path.join(paths.home, ".mindframe-z", "secrets", "mitm-ca.pem")
    );
  });

  it("generates base infrastructure secrets with restricted permissions", async () => {
    const paths = await testPaths();

    const base = await ensureSandboxBaseSecrets(paths);
    expect(base.ownerEmail).toMatch(/@local\.invalid$/);
    expect(base.ownerPassword.length).toBeGreaterThanOrEqual(8);

    const record = await readSandboxOperationalSecrets(paths);
    expect(record.AGENT_VAULT_MASTER_PASSWORD).toBeTruthy();
    expect(record.AGENT_VAULT_TOKEN).toBeUndefined();
    expect((await stat(sandboxSecretsFile(paths))).mode & 0o777).toBe(0o600);

    // Not fully initialized until the agent token is minted and stored.
    await expect(hasSandboxOperationalSecrets(paths)).resolves.toBe(false);
  });

  it("never overwrites an existing master password on resume", async () => {
    const paths = await testPaths();

    const first = await ensureSandboxBaseSecrets(paths);
    const masterBefore = (await readSandboxOperationalSecrets(paths)).AGENT_VAULT_MASTER_PASSWORD;

    const second = await ensureSandboxBaseSecrets(paths);
    const masterAfter = (await readSandboxOperationalSecrets(paths)).AGENT_VAULT_MASTER_PASSWORD;

    expect(masterAfter).toBe(masterBefore);
    expect(second.ownerEmail).toBe(first.ownerEmail);
    expect(second.ownerPassword).toBe(first.ownerPassword);
  });

  it("marks the sandbox initialized once the agent token is stored", async () => {
    const paths = await testPaths();

    await ensureSandboxBaseSecrets(paths);
    await setSandboxAgentToken(paths, "agent-token-value");

    await expect(hasSandboxOperationalSecrets(paths)).resolves.toBe(true);
    const content = await readFile(sandboxSecretsFile(paths), "utf8");
    expect(content).toContain("AGENT_VAULT_TOKEN=agent-token-value");
  });
});
