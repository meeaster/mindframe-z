import { describe, expect, it } from "vitest";
import {
  MCP_SDK_VERSION,
  appSlug,
  appSource,
  desiredSetHash,
  frameworkMismatch,
  planApps,
  type AppFile,
  type DesiredApp,
  type ExistingApp
} from "./apps.js";

const framework = "0.0.1-beta.120";

const deepwiki = { kind: "server", name: "deepwiki", url: "https://mcp.deepwiki.com/mcp" } as const;

function app(slug: string, files: ExistingApp["files"], activeVersion: string | null = "dpl_1") {
  return { id: `app_${slug}`, slug, name: slug, activeVersion, files };
}

function ownedApp(server: string, url: string, activeVersion: string | null = "dpl_1") {
  return app(server, appSource({ kind: "server", name: server, url }, framework), activeVersion);
}

function bookmarksFiles(apps = framework): AppFile[] {
  return [
    { path: "index.ts", content: 'export { default } from "./src/app.js";\n' },
    { path: "src/app.ts", content: "export default {};\n" },
    {
      path: "package.json",
      content: JSON.stringify({ name: "mfz-bookmarks", dependencies: { apps } }, null, 2)
    }
  ];
}

function bookmarks(files = bookmarksFiles()): DesiredApp {
  return { kind: "source", name: "bookmarks", directory: "/home/executor/apps/bookmarks", files };
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

  it("deploys a hand-written app as written, whatever Executor's framework version", () => {
    expect(appSource(bookmarks(), "0.0.2")).toEqual(bookmarksFiles());
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
      { action: "create", desired: deepwiki, files: appSource(deepwiki, framework) }
    ]);
  });

  it("leaves an owned, deployed app with the same source unchanged", () => {
    const existing = ownedApp("deepwiki", deepwiki.url);

    expect(planApps([deepwiki], framework, [existing])).toEqual([
      { action: "unchanged", desired: deepwiki, existing }
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
      { action: "update", desired: deepwiki, existing, files: appSource(deepwiki, framework) }
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

    const upper = { ...deepwiki, name: "DeepWiki" };

    expect(planApps([upper], framework, [handMade])).toEqual([
      { action: "conflict", desired: upper, existing: handMade }
    ]);
  });

  it("reports an owned app whose server is no longer declared without touching others", () => {
    const orphan = ownedApp("exa", "https://mcp.exa.ai/mcp");
    const handMade = app("bookmarks", [{ path: "package.json", content: '{"name":"bookmarks"}' }]);

    expect(planApps([], framework, [orphan, handMade])).toEqual([
      { action: "orphan", name: "exa", existing: orphan }
    ]);
  });

  it("creates a hand-written app with its files, nested ones included", () => {
    expect(planApps([bookmarks()], framework, [])).toEqual([
      { action: "create", desired: bookmarks(), files: bookmarksFiles() }
    ]);
  });

  it("leaves a deployed hand-written app with the same files unchanged", () => {
    const existing = app("bookmarks", bookmarksFiles());

    expect(planApps([bookmarks()], framework, [existing])[0]?.action).toBe("unchanged");
  });

  it.each([
    [
      "an edited file",
      bookmarksFiles().map((file) =>
        file.path === "src/app.ts" ? { ...file, content: "export default { tools: {} };\n" } : file
      )
    ],
    [
      "a file only Executor still holds",
      [...bookmarksFiles(), { path: "src/old.ts", content: "export {};\n" }]
    ]
  ])("updates a hand-written app with %s", (_reason, remoteFiles) => {
    const existing = app("bookmarks", remoteFiles);

    expect(planApps([bookmarks()], framework, [existing])).toEqual([
      { action: "update", desired: bookmarks(), existing, files: bookmarksFiles() }
    ]);
  });

  it("reports a hand-written app the profile no longer declares", () => {
    const existing = app("bookmarks", bookmarksFiles());

    expect(planApps([deepwiki], framework, [existing])).toEqual([
      { action: "create", desired: deepwiki, files: appSource(deepwiki, framework) },
      { action: "orphan", name: "bookmarks", existing }
    ]);
  });
});

describe("frameworkMismatch", () => {
  it("names the version a hand-written app declares when Executor's differs", () => {
    expect(frameworkMismatch(bookmarks(bookmarksFiles("0.0.1-beta.100")), framework)).toBe(
      "0.0.1-beta.100"
    );
    expect(frameworkMismatch(bookmarks(), framework)).toBeUndefined();
    expect(frameworkMismatch(deepwiki, "0.0.2")).toBeUndefined();
  });
});

describe("desiredSetHash", () => {
  it("changes when a hand-written app's source changes", () => {
    const edited = bookmarksFiles().map((file) =>
      file.path === "src/app.ts" ? { ...file, content: "export default { tools: {} };\n" } : file
    );

    expect(desiredSetHash([deepwiki, bookmarks()])).toBe(desiredSetHash([bookmarks(), deepwiki]));
    expect(desiredSetHash([deepwiki, bookmarks(edited)])).not.toBe(
      desiredSetHash([deepwiki, bookmarks()])
    );
  });
});
