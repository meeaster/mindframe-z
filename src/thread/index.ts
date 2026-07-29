import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../core/fs-util.js";
import { readThreadManifest, type ThreadManifest } from "./storage.js";

function oneLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function latestActivity(manifest: ThreadManifest): string {
  return (
    manifest.sessions
      .flatMap((session) => (session.last_activity_at ? [session.last_activity_at] : []))
      .sort()
      .at(-1) ?? manifest.created_at
  );
}

export function threadIndexContent(manifests: readonly ThreadManifest[]): string {
  const lines = [
    "# Thread Index",
    "",
    "Threads preserve retrospective session evidence and continuity. Use their digests for prior reasoning and history; use work units and operational systems for current work state.",
    ""
  ];
  const sorted = [...manifests].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  if (sorted.length === 0) {
    lines.push("_No threads are currently available._", "");
    return lines.join("\n");
  }

  for (const manifest of sorted) {
    const sessions = `${manifest.sessions.length} session${manifest.sessions.length === 1 ? "" : "s"}`;
    const title = manifest.title ? ` **${oneLine(manifest.title)}**:` : "";
    lines.push(
      `- [\`${manifest.slug}\`](${manifest.slug}/digest.md) -${title} ${oneLine(manifest.charter)} _(${sessions}; latest activity ${latestActivity(manifest)})_`
    );
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeThreadIndex(threadRoot: string): Promise<void> {
  const manifests: ThreadManifest[] = [];
  for (const entry of await readdir(threadRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(threadRoot, entry.name);
    if (!(await pathExists(path.join(dir, "manifest.json")))) continue;
    manifests.push(await readThreadManifest(dir));
  }
  await writeFile(path.join(threadRoot, "index.md"), threadIndexContent(manifests), "utf8");
}
