import { describe, expect, it } from "vitest";
import { cli, setupIntegrationFixture } from "./support.js";

describe("mcp status integration", () => {
  it("prints each server's profile state per agent", async () => {
    const { root, home } = await setupIntegrationFixture();

    const result = await cli("mfz", root, home, ["mcp", "status"]);

    expect(result.stdout.trim().split("\n")).toEqual([
      "context7\topencode\tenabled",
      "context7\tclaude-code\tenabled",
      "context7\tcodex\tenabled",
      "local-helper\tclaude-code\tenabled"
    ]);
  });
});
