import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyConfig } from "../../src/cli/apply.js";
import { cli, makeTempDir, parseJson, setupIntegrationFixture } from "./support.js";

// Stands in for the executor CLI: it keeps its apps in a JSON file and prints JSON like the real one.
const fakeExecutor = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const statePath = process.env.FAKE_EXECUTOR_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const [, command, ...args] = process.argv.slice(2);
const flag = (name) => args[args.indexOf("--" + name) + 1];
const readDir = (dir, prefix = "") =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? readDir(path.join(dir, entry.name), prefix + entry.name + "/")
      : [{ path: prefix + entry.name, content: fs.readFileSync(path.join(dir, entry.name), "utf8") }]
  );
const print = (value) => {
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log(JSON.stringify(value, null, 2));
};
if (state.unreachable) {
  console.log(JSON.stringify({ error: { code: "LocalServerUnavailable", message: "service is stopped" } }));
  process.exit(1);
}
if (command === "framework") print({ version: "0.0.1-beta.120" });
if (command === "list") print(state.apps.map(({ files, ...app }) => app));
if (command === "source") print({ files: state.apps.find((app) => app.id === flag("app")).files });
if (command === "create") {
  const app = { id: "app_" + state.apps.length, slug: flag("name").toLowerCase(), name: flag("name"), activeVersion: null, files: readDir(flag("files")) };
  state.apps.push(app);
  print(app);
}
if (command === "deploy") {
  const app = state.apps.find((candidate) => candidate.id === flag("app"));
  app.files = readDir(flag("files"));
  app.activeVersion = "dpl_" + app.id;
  print({});
}
`;

const fakeStateSchema = z.object({
  apps: z.array(
    z.object({
      slug: z.string(),
      activeVersion: z.string().nullable(),
      files: z.array(z.object({ path: z.string(), content: z.string() }))
    })
  )
});

const handMadeDeepwiki = {
  id: "app_hand",
  slug: "deepwiki",
  name: "DeepWiki",
  activeVersion: "dpl_hand",
  files: [{ path: "package.json", content: '{\n  "name": "deepwiki"\n}' }]
};

interface FakeExecutorState {
  apps: (typeof handMadeDeepwiki)[];
  unreachable?: boolean;
}

async function executorFixture(state: FakeExecutorState) {
  const { root, home } = await setupIntegrationFixture();
  const bin = await makeTempDir();
  const statePath = path.join(bin, "state.json");
  const mcpPath = path.join(root, "catalog", "mcp.yml");
  const profilePath = path.join(root, "profiles", "personal", "profile.yml");

  await writeFile(path.join(bin, "executor"), fakeExecutor, "utf8");
  await chmod(path.join(bin, "executor"), 0o755);
  await writeFile(statePath, JSON.stringify(state), "utf8");
  await writeFile(
    mcpPath,
    `${await readFile(mcpPath, "utf8")}  deepwiki:\n    type: remote\n    url: https://mcp.deepwiki.com/mcp\n`,
    "utf8"
  );
  await writeFile(
    profilePath,
    (await readFile(profilePath, "utf8")).replace(
      "mcp:\n",
      "mcp:\n  deepwiki:\n    executor: true\n"
    ),
    "utf8"
  );

  const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_EXECUTOR_STATE: statePath };

  return {
    root,
    home,
    profilePath,
    readState: async () => parseJson(fakeStateSchema, await readFile(statePath, "utf8")),
    executorApply: (args: string[] = []) =>
      cli("mfz", root, home, ["executor", "apply", ...args], env).catch(
        (error: { exitCode: number; stdout: string; stderr: string }) => error
      ),
    driftNotices: async () =>
      (
        await applyConfig({
          root,
          home,
          agent: "opencode",
          target: "all",
          dryRun: true,
          noLink: true
        })
      ).filter((outcome) => outcome.category === "executor")
  };
}

describe("Executor apps", () => {
  it("does not mention Executor in apply when no server sets executor: true", async () => {
    const { root, home } = await setupIntegrationFixture();

    const outcomes = await applyConfig({
      root,
      home,
      agent: "opencode",
      target: "all",
      dryRun: true,
      noLink: true
    });

    expect(outcomes.filter((outcome) => outcome.category === "executor")).toEqual([]);
  });

  it("creates and deploys a declared app, after which apply reports no drift", async () => {
    const fixture = await executorFixture({ apps: [] });

    expect(await fixture.driftNotices()).toEqual([
      expect.objectContaining({
        status: "skipped",
        detail: "Executor apps changed; run mfz executor apply"
      })
    ]);

    const dryRun = await fixture.executorApply(["--dry-run"]);
    expect(dryRun.stdout).toContain("planned\tadd\texecutor\tdeepwiki");
    expect((await fixture.readState()).apps).toEqual([]);

    const applied = await fixture.executorApply();
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("created\texecutor\tdeepwiki");

    const [created] = (await fixture.readState()).apps;
    expect(created?.activeVersion).not.toBeNull();
    expect(created?.files.find((file) => file.path === "package.json")?.content).toContain(
      '"name": "mfz-deepwiki"'
    );
    expect(await fixture.driftNotices()).toEqual([]);

    const again = await fixture.executorApply();
    expect(again.stdout).toContain("complete — no changes");
  });

  it("refuses to take over a hand-made app and keeps the drift notice", async () => {
    const fixture = await executorFixture({ apps: [handMadeDeepwiki] });

    const result = await fixture.executorApply();

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/blocked\texecutor\tdeepwiki\t.*not managed by mfz/u);
    expect((await fixture.readState()).apps).toEqual([
      { slug: "deepwiki", activeVersion: "dpl_hand", files: handMadeDeepwiki.files }
    ]);
    expect(await fixture.driftNotices()).toHaveLength(1);
  });

  it("deploys a hand-written app from the home and reports source edits as drift", async () => {
    const fixture = await executorFixture({ apps: [] });
    const appDirectory = path.join(fixture.root, "executor", "apps", "notes");

    await mkdir(path.join(appDirectory, "src"), { recursive: true });
    await writeFile(
      path.join(appDirectory, "index.ts"),
      'export { default } from "./src/app.js";\n'
    );
    await writeFile(path.join(appDirectory, "src", "app.ts"), "export default {};\n");
    await writeFile(
      path.join(appDirectory, "package.json"),
      JSON.stringify({ name: "mfz-notes", dependencies: { apps: "0.0.1-beta.100" } })
    );
    await writeFile(
      fixture.profilePath,
      `${await readFile(fixture.profilePath, "utf8")}executor:\n  apps: [notes]\n`
    );

    const applied = await fixture.executorApply();

    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain(`created\texecutor\tnotes\t${appDirectory}`);
    expect(applied.stdout).toContain(
      "skipped\texecutor\tnotes\tpackage.json declares apps 0.0.1-beta.100, but Executor's framework is 0.0.1-beta.120; it deploys as written"
    );

    const notes = (await fixture.readState()).apps.find((app) => app.slug === "notes");
    expect(notes?.files.map((file) => file.path).sort()).toEqual([
      "index.ts",
      "package.json",
      "src/app.ts"
    ]);
    expect(await fixture.driftNotices()).toEqual([]);

    await writeFile(path.join(appDirectory, "src", "app.ts"), "export default { tools: {} };\n");
    expect(await fixture.driftNotices()).toHaveLength(1);

    const updated = await fixture.executorApply();
    expect(updated.stdout).toContain(`updated\texecutor\tnotes\t${appDirectory}`);
    expect(
      (await fixture.readState()).apps
        .find((app) => app.slug === "notes")
        ?.files.find((file) => file.path === "src/app.ts")?.content
    ).toBe("export default { tools: {} };\n");
    expect(await fixture.driftNotices()).toEqual([]);
  });

  it("fails with a start hint when the Executor service is unreachable", async () => {
    const fixture = await executorFixture({ apps: [], unreachable: true });

    const result = await fixture.executorApply();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("systemctl --user start executor");
  });
});
