import { createHash } from "node:crypto";
import { z } from "zod";
import { parseJsonText } from "../core/json.js";
import type { ResolvedProfile } from "../core/profile.js";

// The SDK version Executor's own MCP import generator pins: devDependencies of packages/apps in
// the executor repository, read through appsPeerVersion in packages/app-templates/src/implementation/files.ts.
export const MCP_SDK_VERSION = "1.32.1";

// An app's package name is `mfz-<name>`; that prefix marks the app as MFZ-owned.
const ownedPackagePrefix = "mfz-";

export interface AppFile {
  path: string;
  content: string;
}

// An app MFZ generates for an `executor: true` MCP server, or one written by hand in the home.
export type DesiredApp =
  | { kind: "server"; name: string; url: string }
  | { kind: "source"; name: string; directory: string; files: AppFile[] };

export interface ExistingApp {
  id: string;
  slug: string;
  name: string;
  activeVersion: string | null;
  // Text files carry content; a large or binary file Executor lists only by its object.
  files: ReadonlyArray<{ path: string; content?: string | undefined }>;
}

export type AppPlanItem =
  | { action: "create"; desired: DesiredApp; files: AppFile[] }
  | { action: "update"; desired: DesiredApp; existing: ExistingApp; files: AppFile[] }
  | { action: "unchanged"; desired: DesiredApp; existing: ExistingApp }
  | { action: "conflict"; desired: DesiredApp; existing: ExistingApp }
  | { action: "orphan"; name: string; existing: ExistingApp };

const packageNameSchema = z.object({ name: z.string() });

const appsDependencySchema = z.object({ dependencies: z.object({ apps: z.string() }) });

export function ownedPackageName(name: string): string {
  return `${ownedPackagePrefix}${name}`;
}

export function desiredApps(profile: ResolvedProfile): DesiredApp[] {
  const servers = profile.mcpServers.flatMap((entry): DesiredApp[] =>
    // Profile resolution rejects executor entries that are not remote, so this only narrows.
    entry.executor && entry.server.type === "remote"
      ? [{ kind: "server", name: entry.name, url: entry.server.url }]
      : []
  );

  return [
    ...servers,
    ...profile.executorApps.map((app): DesiredApp => ({ kind: "source", ...app }))
  ];
}

// Server URLs and hand-written source decide the apps; the generated apps' framework version is
// Executor's to move.
export function desiredSetHash(apps: readonly DesiredApp[]): string {
  const entries = [...apps]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((app) =>
      app.kind === "server"
        ? [app.name, app.url]
        : [app.name, app.files.map((file) => [file.path, file.content])]
    );

  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function serverSource(name: string, url: string, frameworkVersion: string): AppFile[] {
  // Executor's quick-add approval rule: tools the server marks destructive ask before running.
  const index = `import { defineApp, toolAnnotations, withApprovals } from "apps";
import { mcpRouter } from "apps/mcp";
import { always } from "apps/operations/approval";

export default defineApp({}, async ({ signal }) => ({
  tools: withApprovals(
    await mcpRouter({
      url: ${JSON.stringify(url)},
      ...(signal === undefined ? {} : { signal }),
    }),
    (tool) => (toolAnnotations(tool)?.destructiveHint === true ? always() : undefined),
  ),
}));
`;

  // Executor writes package.json without a trailing newline.
  const manifest = JSON.stringify(
    {
      name: ownedPackageName(name),
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

// Hand-written source deploys as written; only generated source follows the framework version.
export function appSource(desired: DesiredApp, frameworkVersion: string): AppFile[] {
  return desired.kind === "server"
    ? serverSource(desired.name, desired.url, frameworkVersion)
    : desired.files;
}

// The `apps` framework version a hand-written app declares, when it differs from Executor's.
export function frameworkMismatch(
  desired: DesiredApp,
  frameworkVersion: string
): string | undefined {
  if (desired.kind === "server") return undefined;

  const manifest = desired.files.find((file) => file.path === "package.json")?.content ?? "";
  const declared = appsDependencySchema.safeParse(parseJsonText(manifest)).data?.dependencies.apps;

  return declared === frameworkVersion ? undefined : (declared ?? "no version");
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

// The name an MFZ-owned app was deployed for, read from its package name.
export function ownedName(app: ExistingApp): string | undefined {
  const content = app.files.find((file) => file.path === "package.json")?.content;

  if (content === undefined) return undefined;

  const name = packageNameSchema.safeParse(parseJsonText(content)).data?.name;

  return name?.startsWith(ownedPackagePrefix) ? name.slice(ownedPackagePrefix.length) : undefined;
}

// Deploying replaces the whole source, so a file only Executor holds is a difference too.
function sameSource(files: readonly AppFile[], app: ExistingApp): boolean {
  if (files.length !== app.files.length) return false;

  return files.every(
    (file) =>
      app.files.find((existing) => existing.path === file.path)?.content?.trimEnd() ===
      file.content.trimEnd()
  );
}

export function planApps(
  desired: readonly DesiredApp[],
  frameworkVersion: string,
  apps: readonly ExistingApp[]
): AppPlanItem[] {
  const owned = new Map<string, ExistingApp>();

  for (const app of apps) {
    const name = ownedName(app);

    if (name !== undefined && !owned.has(name)) owned.set(name, app);
  }

  const plan: AppPlanItem[] = desired.map((item): AppPlanItem => {
    const files = appSource(item, frameworkVersion);
    const existing = owned.get(item.name);

    if (existing !== undefined) {
      return sameSource(files, existing) && existing.activeVersion !== null
        ? { action: "unchanged", desired: item, existing }
        : { action: "update", desired: item, existing, files };
    }

    const holder = apps.find((candidate) => candidate.slug === appSlug(item.name));

    return holder === undefined
      ? { action: "create", desired: item, files }
      : { action: "conflict", desired: item, existing: holder };
  });

  const declared = new Set(desired.map((item) => item.name));

  for (const [name, existing] of owned) {
    if (!declared.has(name)) plan.push({ action: "orphan", name, existing });
  }

  return plan;
}
