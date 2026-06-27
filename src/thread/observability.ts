import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  threadCliLogPath,
  threadRunPath,
  threadRunsRoot,
  type RuntimePaths
} from "../core/paths.js";

export interface ThreadRunStatus {
  id: string;
  thread?: string | undefined;
  mode: string;
  pid: number;
  current_step: string;
  started_at: string;
  finished_at?: string | undefined;
  cost_usd: number | null;
}

export async function appendThreadCliLog(
  paths: RuntimePaths,
  command: string,
  outcome: string
): Promise<void> {
  const file = threadCliLogPath(paths);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${new Date().toISOString()}\t${outcome}\t${command}\n`, "utf8");
}

export async function writeRunStatus(paths: RuntimePaths, status: ThreadRunStatus): Promise<void> {
  const dir = threadRunPath(paths, status.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "status.json"), JSON.stringify(status, null, 2) + "\n", "utf8");
}

export async function writeRunTrace(
  paths: RuntimePaths,
  runId: string,
  name: string,
  trace: string
): Promise<void> {
  const dir = threadRunPath(paths, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.jsonl`), trace, "utf8");
}

export async function listRunStatuses(
  paths: RuntimePaths
): Promise<Array<ThreadRunStatus & { state: string }>> {
  const root = threadRunsRoot(paths);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const statuses: Array<ThreadRunStatus & { state: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, "status.json");
      try {
        const status = JSON.parse(await readFile(file, "utf8")) as ThreadRunStatus;
        statuses.push({
          ...status,
          state: status.finished_at ? "finished" : await pidState(status.pid)
        });
      } catch {
        continue;
      }
    }
    return statuses.sort((a, b) => b.started_at.localeCompare(a.started_at));
  } catch {
    return [];
  }
}

async function pidState(pid: number): Promise<string> {
  try {
    process.kill(pid, 0);
    return "running";
  } catch {
    return "crashed";
  }
}

export async function readRunTrace(paths: RuntimePaths, runId: string): Promise<string> {
  const dir = threadRunPath(paths, runId);
  let output = "";
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      output += `# ${entry.name}\n${await readFile(path.join(dir, entry.name), "utf8")}\n`;
    }
  }
  return output;
}

// Verbatim gather dossiers for a run, kept beside its traces under the canonical
// run path (not a hand-rebuilt one).
export async function writeRunDossiers(
  paths: RuntimePaths,
  runId: string,
  dossiers: ReadonlyArray<{ source: string; id: string; text: string }>
): Promise<void> {
  const dir = path.join(threadRunPath(paths, runId), "dossiers");
  await mkdir(dir, { recursive: true });
  for (const dossier of dossiers) {
    await writeFile(path.join(dir, `${dossier.source}-${dossier.id}.md`), dossier.text, "utf8");
  }
}
