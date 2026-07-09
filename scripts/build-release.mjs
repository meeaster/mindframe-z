import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

const root = process.cwd();
const outDir = path.join(root, "release");
const entry = path.join(root, "src", "cli", "mfz-bun.ts");

// Cross-compile a self-contained binary per platform. `bun build --compile` embeds
// the JS runtime plus the thread-tools docker-context assets (see embedded-assets.ts),
// so the release ships no node, no dependency tree, and no install-time step.
const targets = [
  { bun: "bun-linux-x64", name: "mfz-linux-x64" },
  { bun: "bun-linux-arm64", name: "mfz-linux-arm64" },
  { bun: "bun-darwin-x64", name: "mfz-darwin-x64" },
  { bun: "bun-darwin-arm64", name: "mfz-darwin-arm64" }
];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const target of targets) {
  const outfile = path.join(outDir, target.name);
  await execa(
    "bun",
    ["build", "--compile", `--target=${target.bun}`, entry, "--outfile", outfile],
    { stdio: "inherit" }
  );
  console.log(`wrote\t${outfile}`);
}
