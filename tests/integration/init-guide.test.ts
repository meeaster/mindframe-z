import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { makeTempDir, projectRoot } from "./support.js";

function mfz(home: string, args: string[]) {
  return execa(
    process.execPath,
    ["--import", "tsx", path.join(projectRoot, "src", "cli", "mfz.ts"), "--home", home, ...args],
    {
      cwd: projectRoot,
      env: { ...process.env, MFZ_HOME: home, MFZ_ROOT: undefined }
    }
  );
}

describe("init and guide integration", () => {
  it("prints the home guide", async () => {
    const home = await makeTempDir();
    const result = await mfz(home, ["guide"]);
    expect(result.stdout).toContain("# mindframe-z Home Guide");
    expect(result.stdout).toContain("catalog/references.yml");
  });

  it("scaffolds a valid home and records home_path", async () => {
    const machineHome = await makeTempDir();
    const homeRoot = path.join(await makeTempDir(), "my-home");

    const result = await mfz(machineHome, ["init", "--create", homeRoot, "--agents", "opencode"]);

    expect(result.stdout).toContain(`home_path\t${homeRoot}`);
    expect(await readFile(path.join(homeRoot, "mfz_home.yml"), "utf8")).toContain(
      "mfz_home.schema.json"
    );
    expect(await readFile(path.join(homeRoot, "catalog", "skills.yml"), "utf8")).toContain(
      "name: mindframe-z"
    );
    expect(await readFile(path.join(machineHome, ".mindframe-z", "config.yml"), "utf8")).toContain(
      `home_path: ${homeRoot}`
    );

    const apply = await mfz(machineHome, ["apply", "--no-link"]);
    expect(apply.stdout).toContain("rendered");
  });
});
