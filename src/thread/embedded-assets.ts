// Bun-only module: embeds the thread-tools docker context files into the
// compiled binary at build time. `with { type: "file" }` forces the file loader,
// so lapdog-plugin.ts is embedded as bytes (not bundled as TS) and Dockerfile.tools
// (no extension) is embedded verbatim. Node cannot even parse this module (it rejects
// the extensionless Dockerfile import), so it is excluded from tsconfig and reached
// only from the bun-only compile entry (src/cli/mfz-bun.ts).
import { mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  threadToolsDockerfilePath,
  threadToolsLapdogPluginPath,
  threadToolsOpencodeConfigPath
} from "./build.js";
import dockerfileAsset from "../../Dockerfile.tools" with { type: "file" };
import opencodeConfigAsset from "./opencode.thread.json" with { type: "file" };
// The opencode plugin, embedded as bytes. It is a distinct file from the host-side
// lapdog.ts helper module (which runner.ts imports normally) so bun never applies
// both the file loader and the module loader to one path.
import lapdogAsset from "./lapdog-plugin.ts" with { type: "file" };

// Materialize the embedded assets into a real directory usable as a docker build
// context, laid out like the repo. Written idempotently into a stable per-user dir
// (same MFZ_HOME precedence as createRuntimePaths) — a shared-tmp path would leak
// one dir per process and let other local users pre-create or poison the context.
export async function materializeEmbeddedPackageRoot(): Promise<string> {
  const home = process.env.MFZ_HOME ?? os.homedir();
  const dir = path.join(home, ".mindframe-z", "cache", "thread-context");
  const assets: Array<[string, string]> = [
    [threadToolsDockerfilePath, dockerfileAsset],
    [threadToolsOpencodeConfigPath, opencodeConfigAsset],
    [threadToolsLapdogPluginPath, lapdogAsset]
  ];
  for (const [relPath, asset] of assets) {
    const target = path.join(dir, relPath);
    await mkdir(path.dirname(target), { recursive: true });
    await Bun.write(target, Bun.file(asset));
  }
  return dir;
}

// True when running from a bun-compiled standalone binary (embedded filesystem).
export function isCompiledBinary(): boolean {
  return typeof Bun !== "undefined" && Bun.main.includes("$bunfs");
}
