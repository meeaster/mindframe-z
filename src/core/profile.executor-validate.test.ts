import { describe, expect, it } from "vitest";
import type { McpServer } from "./manifests.js";
import { validateExecutorMcpServer } from "./profile.js";

const remote = (url: string): McpServer => ({ description: "", type: "remote", url });
const local = (command: string[]): McpServer => ({ description: "", type: "local", command });

describe("validateExecutorMcpServer", () => {
  describe("remote url env references", () => {
    it("rejects a whole-value env reference", () => {
      expect(() => validateExecutorMcpServer("exa", remote("{env:MCP_URL}"))).toThrow(
        /environment reference/
      );
    });

    it("rejects an env reference embedded in the url", () => {
      expect(() =>
        validateExecutorMcpServer("exa", remote("https://api.example.com/{env:TOKEN}"))
      ).toThrow(/environment reference/);
    });

    it("accepts a plain https url", () => {
      expect(() =>
        validateExecutorMcpServer("exa", remote("https://api.example.com/mcp"))
      ).not.toThrow();
    });
  });

  it("rejects an env reference in a local command", () => {
    expect(() => validateExecutorMcpServer("fff", local(["fff", "--token={env:TOKEN}"]))).toThrow(
      /environment reference/
    );
  });
});
