import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readDirEntries } from "../core/fs-util.js";
import { parseJsonText } from "../core/json.js";
import { ownedPackageName, type AppFile } from "./apps.js";

// What the executor CLI skips when it reads an app directory: ignoredSource in the executor
// repository's packages/app-management/src/implementation/cli-source.ts.
const ignoredSource = new Set([".git", "node_modules", ".DS_Store"]);

const utf8 = new TextDecoder("utf-8", { fatal: true });

const packageNameSchema = z.object({ name: z.string() });

async function readSourceTree(name: string, directory: string): Promise<AppFile[]> {
  const files: AppFile[] = [];

  const walk = async (relative: readonly string[]): Promise<void> => {
    const entries = (await readDirEntries(path.join(directory, ...relative)))
      .map((entry) => entry.name)
      .filter((entry) => !ignoredSource.has(entry))
      .sort();

    for (const entry of entries) {
      const segments = [...relative, entry];
      const location = path.join(directory, ...segments);
      // Like the executor CLI, follow symlinks and skip anything that is not a file or directory.
      const info = await stat(location);

      if (info.isDirectory()) await walk(segments);
      else if (info.isFile()) {
        const filePath = segments.join("/");
        const bytes = await readFile(location);
        let content: string;

        try {
          content = utf8.decode(bytes);
        } catch {
          throw new Error(
            `Executor app ${name}: ${filePath} is not UTF-8 text; app files must be text`
          );
        }

        files.push({ path: filePath, content });
      }
    }
  };

  await walk([]);

  return files;
}

// Reads the files `mfz executor apply` deploys for a hand-written app and checks it is MFZ-owned.
export async function readAppSource(name: string, directory: string): Promise<AppFile[]> {
  const files = await readSourceTree(name, directory);

  if (files.length === 0) {
    throw new Error(`Executor app ${name} has no source; create ${directory}`);
  }

  for (const required of ["index.ts", "package.json"]) {
    if (!files.some((file) => file.path === required)) {
      throw new Error(`Executor app ${name} has no ${required} in ${directory}`);
    }
  }

  const manifest = files.find((file) => file.path === "package.json")?.content ?? "";
  const packageName = packageNameSchema.safeParse(parseJsonText(manifest)).data?.name;
  const expected = ownedPackageName(name);

  if (packageName !== expected) {
    throw new Error(
      `Executor app ${name}: set "name": "${expected}" in ${path.join(directory, "package.json")}; mfz recognizes the apps it manages by that package name`
    );
  }

  return files;
}
