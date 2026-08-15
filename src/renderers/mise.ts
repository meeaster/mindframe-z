import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import type { RuntimePaths } from "../core/paths.js";
import { profileConfigsDir } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import type { RenderResult, RenderedFile } from "../core/render.js";
function safeComponent(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid Mise ${label}: ${value}`);
  }
  return value;
}

export async function renderMise(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  options: { readonly sandbox?: boolean; readonly previousOwnedHostPaths?: readonly string[] } = {}
): Promise<RenderResult> {
  const configsMise = path.join(profileConfigsDir(paths, profile.name), "mise");
  const hostMise = paths.miseConfigDir;
  const files: RenderedFile[] = [];
  const ownedHostPaths: string[] = [];
  const previousOwned = new Set(options.previousOwnedHostPaths ?? []);

  const layers = profile.miseLayers;
  const layerNames = new Set<string>();
  for (const [index, layer] of layers.entries()) {
    const name = safeComponent(layer.name, "profile name");
    if (!layerNames.add(name)) throw new Error(`Duplicate Mise layer namespace: ${name}`);
    const relative = `${String((index + 1) * 10).padStart(2, "0")}-${name}.toml`;
    if (layer.content === undefined) continue;
    const snapshot = path.join(configsMise, relative);
    const host = path.join(hostMise, "conf.d", relative);
    files.push({ path: snapshot, content: layer.content });
    if (!options.sandbox) ownedHostPaths.push(host);
  }

  {
    for (const layer of layers) {
      const layerName = safeComponent(layer.name, "profile name");
      const source = path.join(layer.root, "profiles", layer.name, ".config", "mise", "tasks");
      async function walk(dir: string, relative = ""): Promise<void> {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        for (const entry of entries) {
          const rel = relative ? path.join(relative, entry.name) : entry.name;
          if (entry.isDirectory()) {
            await walk(path.join(dir, entry.name), rel);
            continue;
          }
          if (!entry.isFile() || !entry.name.endsWith(".toml")) continue;
          for (const part of rel.split(path.sep)) safeComponent(part, "task path component");
          const content = await readFile(path.join(dir, rel), "utf8");
          try {
            parse(content);
          } catch (error) {
            throw new Error(`Invalid Mise task at ${path.join(dir, rel)}`, { cause: error });
          }
          const snapshot = path.join(configsMise, "tasks", layerName, rel);
          const host = path.join(hostMise, "tasks", layerName, rel);
          files.push({ path: snapshot, content });
          if (!options.sandbox) ownedHostPaths.push(host);
        }
      }
      await walk(source);
    }
  }

  const installableHostPaths: string[] = [];
  for (const file of ownedHostPaths) {
    try {
      await access(file);
      if (previousOwned.has(file)) installableHostPaths.push(file);
    } catch {
      installableHostPaths.push(file);
    }
  }
  const current = new Set(installableHostPaths);
  const safeLocal: RenderedFile[] = [];
  if (!options.sandbox) {
    for (const [index, file] of files.entries()) {
      const host = ownedHostPaths[index];
      if (!host) continue;
      try {
        await access(host);
      } catch {
        safeLocal.push({ ...file, path: host });
        continue;
      }
      if (previousOwned.has(host)) safeLocal.push({ ...file, path: host });
    }
  }
  return {
    files,
    ...(!options.sandbox ? { localFiles: safeLocal } : {}),
    ...(!options.sandbox
      ? { localStaleFiles: [...previousOwned].filter((file) => !current.has(file)) }
      : {}),
    links: [],
    ...(!options.sandbox
      ? { ownership: { target: "mise" as const, snapshots: files.map((file) => file.path), host: installableHostPaths } }
      : {})
  };
}
