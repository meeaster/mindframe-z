import { describe, expect, it } from "vitest";
import type { McpServer } from "./manifests.js";
import { validateExecutorMcpServer } from "./profile.js";

type ServerExtras = {
  transport?: McpServer["transport"];
  headers?: McpServer["headers"];
  env?: McpServer["env"];
  executor?: McpServer["executor"];
};

const remote = (url: string, extras: ServerExtras = {}): McpServer => ({
  description: "",
  type: "remote",
  url,
  ...extras
});
const local = (command: string[], extras: ServerExtras = {}): McpServer => ({
  description: "",
  type: "local",
  command,
  ...extras
});

describe("validateExecutorMcpServer", () => {
  describe("remote servers", () => {
    it("rejects a whole-value env reference in the url", () => {
      expect(() => validateExecutorMcpServer("exa", remote("{env:MCP_URL}"))).toThrow(
        /environment reference/
      );
    });

    it("rejects an env reference embedded in the url", () => {
      expect(() =>
        validateExecutorMcpServer("exa", remote("https://api.example.com/{env:TOKEN}"))
      ).toThrow(/environment reference/);
    });

    it("rejects a stdio transport", () => {
      expect(() =>
        validateExecutorMcpServer(
          "exa",
          remote("https://api.example.com/mcp", { transport: "stdio" })
        )
      ).toThrow(/stdio transport/);
    });

    it("rejects inline headers", () => {
      expect(() =>
        validateExecutorMcpServer(
          "exa",
          remote("https://api.example.com/mcp", { headers: { Authorization: "Bearer x" } })
        )
      ).toThrow(/contains headers/);
    });

    it("rejects inline environment values", () => {
      expect(() =>
        validateExecutorMcpServer(
          "exa",
          remote("https://api.example.com/mcp", { env: { TOKEN: "x" } })
        )
      ).toThrow(/environment values/);
    });

    it("accepts a plain https url", () => {
      expect(() =>
        validateExecutorMcpServer("exa", remote("https://api.example.com/mcp"))
      ).not.toThrow();
    });
  });

  describe("local servers", () => {
    it("rejects an env reference in the command", () => {
      expect(() => validateExecutorMcpServer("fff", local(["fff", "--token={env:TOKEN}"]))).toThrow(
        /environment reference/
      );
    });

    it("rejects a remote transport", () => {
      expect(() => validateExecutorMcpServer("fff", local(["fff"], { transport: "http" }))).toThrow(
        /remote transport/
      );
    });

    it("rejects remote-only executor settings", () => {
      expect(() =>
        validateExecutorMcpServer("fff", local(["fff"], { executor: { transport: "auto" } }))
      ).toThrow(/remote-only settings/);
    });

    it("rejects OAuth authentication", () => {
      expect(() =>
        validateExecutorMcpServer(
          "fff",
          local(["fff"], {
            executor: { authentication: [{ slug: "oauth", kind: "oauth2" }] }
          })
        )
      ).toThrow(/cannot use OAuth/);
    });

    it("rejects inline environment values", () => {
      expect(() =>
        validateExecutorMcpServer("fff", local(["fff"], { env: { TOKEN: "x" } }))
      ).toThrow(/environment values/);
    });

    it("accepts a plain command", () => {
      expect(() => validateExecutorMcpServer("fff", local(["fff", "--stdio"]))).not.toThrow();
    });
  });
});
