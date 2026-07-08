import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

const root = process.cwd();
const outDir = path.join(root, "release");
const stage = path.join(outDir, "engine");

await rm(outDir, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(path.join(root, "dist"), path.join(stage, "dist"), { recursive: true });
await cp(path.join(root, "schemas"), path.join(stage, "schemas"), { recursive: true });
await cp(path.join(root, "package.json"), path.join(stage, "package.json"));
await writeFile(
  path.join(stage, "mfz"),
  '#!/usr/bin/env bash\nset -euo pipefail\nexec node "$(dirname "$0")/dist/cli/mfz.js" "$@"\n',
  { mode: 0o755 }
);

await execa("tar", ["-czf", path.join(outDir, "mindframe-z-engine.tar.gz"), "-C", stage, "."]);
console.log(`wrote\t${path.join(outDir, "mindframe-z-engine.tar.gz")}`);
