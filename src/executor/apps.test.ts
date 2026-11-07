import { describe, expect, it } from "vitest";
import { MCP_SDK_VERSION, appSlug, appSource, planApps, type ExistingApp } from "./apps.js";

const framework = "0.0.1-beta.120";

const deepwiki = { name: "deepwiki", url: "https://mcp.deepwiki.com/mcp" };

function app(slug: string, files: ExistingApp["files"], activeVersion: string | null = "dpl_1") {
  return { id: `app_${slug}`, slug, name: slug, activeVersion, files };
}

function ownedApp(server: string, url: string, activeVersion: string | null = "dpl_1") {
  return app(server, appSource({ name: server, url }, framework), activeVersion);
}

describe("appSource", () => {
  it("generates an MFZ-owned app that routes the server's tools", () => {
    const [index, manifest] = appSource(deepwiki, framework);

    expect(index?.path).toBe("index.ts");
    expect(index?.content).toContain('url: "https://mcp.deepwiki.com/mcp",');
    expect(index?.content).toContain('import { mcpRouter } from "apps/mcp";');
    expect(manifest?.path).toBe("package.json");
    expect(JSON.parse(manifest?.content ?? "")).toEqual({
      name: "mfz-deepwiki",
      private: true,
      type: "module",
      dependencies: { apps: framework, "@modelcontextprotocol/sdk": MCP_SDK_VERSION }
    });
  });
});

describe("appSlug", () => {
  it("derives the address Executor gives a name", () => {
    expect(appSlug("DeepWiki")).toBe("deepwiki");
    expect(appSlug("Exa Research!")).toBe("exa-research");
    expect(appSlug("Café")).toBe("cafe");
    expect(appSlug("search")).toBe("app-search");
    expect(appSlug("---")).toBe("app");
  });
});

describe("planApps", () => {
  it("creates a declared server that has no app", () => {
    expect(planApps([deepwiki], framework, [])).toEqual([
      { action: "create", server: deepwiki, files: appSource(deepwiki, framework) }
    ]);
  });

  it("leaves an owned, deployed app with the same source unchanged", () => {
    const existing = ownedApp("deepwiki", deepwiki.url);

    expect(planApps([deepwiki], framework, [existing])).toEqual([
      { action: "unchanged", server: deepwiki, app: existing }
    ]);
  });

  it("tolerates Executor trimming a trailing newline from stored source", () => {
    const existing = app(
      "deepwiki",
      appSource(deepwiki, framework).map((file) => ({ ...file, content: file.content.trimEnd() }))
    );

    expect(planApps([deepwiki], framework, [existing])[0]?.action).toBe("unchanged");
  });

  it.each([
    ["a changed URL", ownedApp("deepwiki", "https://old.example/mcp")],
    ["a new framework version", app("deepwiki", appSource(deepwiki, "0.0.1-beta.1"))],
    ["no active version", ownedApp("deepwiki", deepwiki.url, null)]
  ])("updates an owned app with %s", (_reason, existing) => {
    expect(planApps([deepwiki], framework, [existing])).toEqual([
      { action: "update", server: deepwiki, app: existing, files: appSource(deepwiki, framework) }
    ]);
  });

  it("finds an owned app by its package name even after the app was renamed", () => {
    const renamed = { ...ownedApp("deepwiki", deepwiki.url), slug: "wiki", name: "Wiki" };

    expect(planApps([deepwiki], framework, [renamed])[0]?.action).toBe("unchanged");
  });

  it("refuses a slug held by an app MFZ does not own", () => {
    const handMade = app("deepwiki", [
      { path: "index.ts", content: "export default {};\n" },
      { path: "package.json", content: '{\n  "name": "deepwiki"\n}' }
    ]);

    expect(planApps([{ ...deepwiki, name: "DeepWiki" }], framework, [handMade])).toEqual([
      { action: "conflict", server: { ...deepwiki, name: "DeepWiki" }, app: handMade }
    ]);
  });

  it("reports an owned app whose server is no longer declared without touching others", () => {
    const orphan = ownedApp("exa", "https://mcp.exa.ai/mcp");
    const handMade = app("bookmarks", [{ path: "package.json", content: '{"name":"bookmarks"}' }]);

    expect(planApps([], framework, [orphan, handMade])).toEqual([
      { action: "orphan", server: "exa", app: orphan }
    ]);
  });
});
