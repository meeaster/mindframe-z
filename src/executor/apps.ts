import { createHash } from "node:crypto";
import { z } from "zod";
import { parseJsonText } from "../core/json.js";
import type { ResolvedProfile } from "../core/profile.js";

// The SDK version Executor's own MCP import generator pins: devDependencies of packages/apps in
// the executor repository, read through appsPeerVersion in packages/app-templates/src/implementation/files.ts.
export const MCP_SDK_VERSION = "1.32.1";

// An app's package name is `mfz-<server>`; that prefix marks the app as MFZ-owned.
const ownedPackagePrefix = "mfz-";

export interface ExecutorServer {
  name: string;
  url: string;
}

export interface AppFile {
  path: string;
  content: string;
}

export interface ExistingApp {
  id: string;
  slug: string;
  name: string;
  activeVersion: string | null;
  // Text files carry content; a large or binary file Executor lists only by its object.
  files: ReadonlyArray<{ path: string; content?: string | undefined }>;
}

export type AppPlanItem =
  | { action: "create"; server: ExecutorServer; files: AppFile[] }
  | { action: "update"; server: ExecutorServer; app: ExistingApp; files: AppFile[] }
  | { action: "unchanged"; server: ExecutorServer; app: ExistingApp }
  | { action: "conflict"; server: ExecutorServer; app: ExistingApp }
  | { action: "orphan"; server: string; app: ExistingApp };

const packageNameSchema = z.object({ name: z.string() });

export function executorServers(profile: ResolvedProfile): ExecutorServer[] {
  return profile.mcpServers.flatMap((entry) =>
    // Profile resolution rejects executor entries that are not remote, so this only narrows.
    entry.executor && entry.server.type === "remote"
      ? [{ name: entry.name, url: entry.server.url }]
      : []
  );
}

// Server URLs and names decide the apps; the framework version is Executor's to move.
export function desiredSetHash(servers: readonly ExecutorServer[]): string {
  const entries = [...servers]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((server) => [server.name, server.url]);

  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function appSource(server: ExecutorServer, frameworkVersion: string): AppFile[] {
  // Executor's quick-add approval rule: tools the server marks destructive ask before running.
  const index = `import { defineApp, toolAnnotations, withApprovals } from "apps";
import { mcpRouter } from "apps/mcp";
import { always } from "apps/operations/approval";

export default defineApp({}, async ({ signal }) => ({
  tools: withApprovals(
    await mcpRouter({
      url: ${JSON.stringify(server.url)},
      ...(signal === undefined ? {} : { signal }),
    }),
    (tool) => (toolAnnotations(tool)?.destructiveHint === true ? always() : undefined),
  ),
}));
`;

  // Executor writes package.json without a trailing newline.
  const manifest = JSON.stringify(
    {
      name: `${ownedPackagePrefix}${server.name}`,
      private: true,
      type: "module",
      dependencies: { apps: frameworkVersion, "@modelcontextprotocol/sdk": MCP_SDK_VERSION }
    },
    null,
    2
  );

  return [
    { path: "index.ts", content: index },
    { path: "package.json", content: manifest }
  ];
}

// Mirrors appSlug in the executor repository's packages/sdk/src/contracts/app-slug.ts.
export function appSlug(name: string): string {
  const reserved = new Set(["search", "constructor", "prototype", "then"]);

  const normalized = name
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[̀-ͯ]/gu, "")
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");

  const label =
    normalized.length === 0 ? "app" : reserved.has(normalized) ? `app-${normalized}` : normalized;

  return label.slice(0, 63).replace(/-+$/u, "");
}

// The server an MFZ-owned app was generated for, read from its package name.
export function ownedServer(app: ExistingApp): string | undefined {
  const content = app.files.find((file) => file.path === "package.json")?.content;

  if (content === undefined) return undefined;

  const name = packageNameSchema.safeParse(parseJsonText(content)).data?.name;

  return name?.startsWith(ownedPackagePrefix) ? name.slice(ownedPackagePrefix.length) : undefined;
}

function sameSource(generated: readonly AppFile[], app: ExistingApp): boolean {
  if (generated.length !== app.files.length) return false;

  return generated.every(
    (file) =>
      app.files.find((existing) => existing.path === file.path)?.content?.trimEnd() ===
      file.content.trimEnd()
  );
}

export function planApps(
  servers: readonly ExecutorServer[],
  frameworkVersion: string,
  apps: readonly ExistingApp[]
): AppPlanItem[] {
  const owned = new Map<string, ExistingApp>();

  for (const app of apps) {
    const server = ownedServer(app);

    if (server !== undefined && !owned.has(server)) owned.set(server, app);
  }

  const plan: AppPlanItem[] = servers.map((server): AppPlanItem => {
    const files = appSource(server, frameworkVersion);
    const app = owned.get(server.name);

    if (app !== undefined) {
      return sameSource(files, app) && app.activeVersion !== null
        ? { action: "unchanged", server, app }
        : { action: "update", server, app, files };
    }

    const holder = apps.find((candidate) => candidate.slug === appSlug(server.name));

    return holder === undefined
      ? { action: "create", server, files }
      : { action: "conflict", server, app: holder };
  });

  const declared = new Set(servers.map((server) => server.name));

  for (const [server, app] of owned) {
    if (!declared.has(server)) plan.push({ action: "orphan", server, app });
  }

  return plan;
}
