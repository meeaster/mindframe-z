import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cli, setupIntegrationFixture } from "./support.js";

describe("context command", () => {
  it("reports static context without writing configs or reading history stores", async () => {
    const { root, home } = await setupIntegrationFixture();
    const result = await cli(
      "mfz",
      root,
      home,
      ["context", "--agent", "opencode"],
      {},
      undefined,
      root
    );

    expect(result.stdout).toContain("Context | personal");
    expect(result.stdout).not.toContain("history:");
    expect(result.stdout).not.toContain("Notes:");
    await expect(access(`${home}/.mindframe-z/configs`)).rejects.toThrow();
  });

  it("reports all active supported harnesses when no agent filter is supplied", async () => {
    const { root, home } = await setupIntegrationFixture();
    const result = await cli("mfz", root, home, ["context"], {}, undefined, root);

    expect(result.stdout).toContain("opencode");
    expect(result.stdout).toContain("claude-code");
  });

  it("reports named Executor connections as shared routing metadata", async () => {
    const { root, home } = await setupIntegrationFixture();
    const catalogPath = path.join(root, "catalog", "mcp.yml");
    await writeFile(
      catalogPath,
      `${await readFile(catalogPath, "utf8")}  datadog:\n    description: Datadog.\n    type: remote\n    transport: http\n    url: https://example.invalid/mcp\n    executor:\n      authentication:\n        - slug: oauth\n          kind: oauth2\n`,
      "utf8"
    );
    const profilePath = path.join(root, "profiles", "personal", "profile.yml");
    const profile = await readFile(profilePath, "utf8");
    await writeFile(
      profilePath,
      profile.replace(
        "opencode:\n",
        [
          "  datadog:",
          "    route: executor",
          "    connections:",
          "      publicsafety: oauth",
          "      tylertech: oauth",
          "opencode:",
          ""
        ].join("\n")
      ),
      "utf8"
    );

    const result = await cli(
      "mfz",
      root,
      home,
      ["context", "--agent", "opencode"],
      {},
      undefined,
      root
    );
    expect(result.stdout).toContain("datadog [publicsafety, tylertech]");
  });

  it("validates history before attempting a store read", async () => {
    const { root, home } = await setupIntegrationFixture();
    await expect(
      cli("mfz", root, home, ["context", "history", "--days", "0"], {}, undefined, root)
    ).rejects.toThrow(/Invalid history window/);
  });

  it("keeps history telemetry-only and does not expose a nested probe command", async () => {
    const { root, home } = await setupIntegrationFixture();

    const history = await cli(
      "mfz",
      root,
      home,
      ["context", "history", "--days", "1"],
      {},
      undefined,
      root
    );
    expect(history.stdout).toContain("Telemetry only");
    expect(history.stdout).not.toContain("Instructions/indexes");
    await expect(
      cli("mfz", root, home, ["context", "probe-mcp"], {}, undefined, root)
    ).rejects.toThrow(/too many arguments/);
    await expect(
      cli(
        "mfz",
        root,
        home,
        ["context", "history", "--days", "1", "--probe-mcp"],
        {},
        undefined,
        root
      )
    ).rejects.toThrow(/only available with mfz context/);
  });

  it("rejects a selected harness that is inactive in the profile", async () => {
    const { root, home } = await setupIntegrationFixture();
    await mkdir(path.join(root, "profiles", "claude-only"), { recursive: true });
    await writeFile(
      path.join(root, "profiles", "claude-only", "profile.yml"),
      "name: claude-only\nagents: [claude-code]\n",
      "utf8"
    );
    await expect(
      cli(
        "mfz",
        root,
        home,
        ["--profile", "claude-only", "context", "--agent", "opencode"],
        {},
        undefined,
        root
      )
    ).rejects.toThrow(/not active in profile/);
  });
});
