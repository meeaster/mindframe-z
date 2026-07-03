import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { RuntimePaths } from "../core/paths.js";
import type { BackupItem } from "./backup-item.js";

async function statItem(file: string, relPath: string): Promise<BackupItem | undefined> {
  try {
    const info = await stat(file);
    return {
      relPath,
      sourceMs: info.mtimeMs,
      contentType: "application/x-ndjson",
      load: () => readFile(file)
    };
  } catch {
    return undefined;
  }
}

// Claude transcripts live at ~/.claude/projects/<encoded-project>/<id>.jsonl; the
// filename is the session id. A session's subagent transcripts, when it spawned any,
// sit beside it at <id>/subagents/agent-*.jsonl — backed up under the session's own
// key prefix so a future hydration pulls the whole session, never as standalone
// ledger entries. The project encoding isn't reversible from an id, so every project
// dir is scanned; anything that can't be stat'd is skipped.
export async function listClaudeItems(paths: RuntimePaths): Promise<BackupItem[]> {
  const projectsDir = path.join(paths.claudeDir, "projects");
  let projects: string[];
  try {
    projects = await readdir(projectsDir);
  } catch {
    return [];
  }
  const items: BackupItem[] = [];
  for (const project of projects) {
    const dir = path.join(projectsDir, project);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const id = entry.name.slice(0, -".jsonl".length);
        const item = await statItem(path.join(dir, entry.name), `${id}.jsonl`);
        if (item) items.push(item);
      } else if (entry.isDirectory()) {
        const subDir = path.join(dir, entry.name, "subagents");
        let subFiles: string[];
        try {
          subFiles = await readdir(subDir);
        } catch {
          continue;
        }
        for (const name of subFiles) {
          if (!name.endsWith(".jsonl")) continue;
          const item = await statItem(path.join(subDir, name), `${entry.name}/subagents/${name}`);
          if (item) items.push(item);
        }
      }
    }
  }
  return items;
}
