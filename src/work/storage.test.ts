import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testRuntimePaths, makeTempDir } from "../../tests/integration/support.js";
import {
  attachWorkSession,
  createWorkUnit,
  readWorkAuthoringStatus,
  readWorkCheckpoints,
  readWorkUnit,
  resolveWorkContext,
  setWorkPhase,
  validateWorkUnit,
  workAuthoringPaths
} from "./storage.js";
import { renderCheckpoint } from "./authoring.js";

const orientation = {
  outcome: "Ship the work runtime.",
  direction: "Use filesystem-first authored context.",
  constraints: ["Keep mutations explicit."],
  questions: [],
  next_action: "Run validation."
};

async function createValidated(
  paths: ReturnType<typeof testRuntimePaths>,
  slug: string,
  title = slug
) {
  await createWorkUnit(paths, { slug, title, objective: orientation.outcome, orientation });
  await validateWorkUnit(paths, slug);
}

describe("work storage", () => {
  it("records Personal global and project scope", async () => {
    const paths = testRuntimePaths(await makeTempDir());
    const global = await createWorkUnit(paths, {
      slug: "global-context",
      title: "Global context",
      objective: "Coordinate Personal work."
    });
    const project = await createWorkUnit(paths, {
      slug: "project-context",
      title: "Project context",
      objective: "Coordinate one project.",
      scope: "project",
      project: "mindframe-z-engine"
    });

    expect(global).toMatchObject({ domain: "personal", scope: "global" });
    expect(project).toMatchObject({
      domain: "personal",
      scope: "project",
      project: "mindframe-z-engine"
    });
  });

  it("keeps durable units separate from runtime bindings", async () => {
    const home = await makeTempDir();
    const paths = testRuntimePaths(home);
    paths.workUnitsRoot = path.join(home, "personal-knowledge", "work-units");
    await createValidated(paths, "external-unit");
    await attachWorkSession(paths, "external-unit", { source: "opencode", id: "external" });

    await expect(
      access(path.join(paths.workUnitsRoot, "external-unit", "manifest.json"))
    ).resolves.toBeUndefined();
    await expect(access(path.join(paths.workRoot, "bindings.json"))).resolves.toBeUndefined();
  });

  it("keeps cross-repository pointers as routed references", async () => {
    const paths = testRuntimePaths(await makeTempDir());
    const unit = await createWorkUnit(paths, {
      slug: "cross-repo",
      title: "Cross repository work",
      objective: "Coordinate related changes.",
      repositories: [
        { target: "/code/project-a", role: "source", status: "current" },
        { target: "/code/project-b", role: "source", status: "current" }
      ],
      context: [{ target: "project-a:docs/design.md", role: "design", status: "accepted" }],
      thread: "optional-history"
    });

    expect(unit.repositories).toHaveLength(2);
    expect(unit.context[0]).toEqual({
      target: "project-a:docs/design.md",
      role: "design",
      status: "accepted"
    });
    expect(unit.thread).toBe("optional-history");
  });

  it("retains reverse phase transitions in order", async () => {
    const paths = testRuntimePaths(await makeTempDir());
    await createWorkUnit(paths, {
      slug: "phase-loop",
      title: "Phase loop",
      objective: "Return to design when needed.",
      phase: "design"
    });
    await setWorkPhase(paths, "phase-loop", "implement");
    const unit = await setWorkPhase(paths, "phase-loop", "design");

    expect(unit.phase).toBe("design");
    expect(unit.phase_history.map((entry) => entry.phase)).toEqual([
      "design",
      "implement",
      "design"
    ]);
  });

  it("rejects replacing an existing source-qualified binding", async () => {
    const paths = testRuntimePaths(await makeTempDir());
    await createValidated(paths, "one", "One");
    await createValidated(paths, "two", "Two");
    const session = { source: "opencode", id: "shared" };

    await attachWorkSession(paths, "one", session);
    await expect(attachWorkSession(paths, "two", session)).rejects.toThrow(/already bound to one/);
    expect((await resolveWorkContext(paths, session)).bound).toBe(true);
  });

  it("serializes concurrent attempts to bind the same session", async () => {
    const paths = testRuntimePaths(await makeTempDir());
    await createValidated(paths, "one", "One");
    await createValidated(paths, "two", "Two");
    const session = { source: "opencode", id: "concurrent" };

    const results = await Promise.allSettled([
      attachWorkSession(paths, "one", session),
      attachWorkSession(paths, "two", session)
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const context = await resolveWorkContext(paths, session);
    expect(context.bound && ["one", "two"].includes(context.unit.slug)).toBe(true);
  });

  it("advances orientation revisions and makes existing delivery stale", async () => {
    const paths = testRuntimePaths(await makeTempDir());
    await createWorkUnit(paths, {
      slug: "oriented",
      title: "Oriented",
      objective: "Keep direction.",
      orientation
    });
    await validateWorkUnit(paths, "oriented");
    const session = { source: "opencode", id: "orientation" };
    await attachWorkSession(paths, "oriented", session);

    const file = workAuthoringPaths(paths, "oriented").orientation;
    await writeFile(
      file,
      `# Orientation

## Outcome

Keep direction.

## Current Direction

Use the accepted design.

## Constraints

- Do not refresh threads.

## Open Questions

- Which plugin hook is stable?

## Next Action

Implement storage.
`,
      "utf8"
    );
    const unit = (await validateWorkUnit(paths, "oriented")).unit;
    const context = await resolveWorkContext(paths, session);

    expect(unit.orientation.revision).toBe(2);
    expect(context).toMatchObject({ bound: true, freshness: "stale" });
    if (context.bound) expect(context.pending_orientation?.revision).toBe(2);
  });

  it("scaffolds authored files and synchronizes direct edits by hash", async () => {
    const paths = testRuntimePaths(await makeTempDir());
    await createWorkUnit(paths, {
      slug: "filesystem-first",
      title: "Filesystem first",
      objective: ""
    });
    const files = workAuthoringPaths(paths, "filesystem-first");

    expect((await readWorkAuthoringStatus(paths, "filesystem-first")).valid).toBe(false);
    await expect(
      attachWorkSession(paths, "filesystem-first", { source: "opencode", id: "unvalidated" })
    ).rejects.toThrow(/run mfz work validate/);

    await writeFile(
      files.orientation,
      `# Orientation

## Outcome

Ship filesystem-first work context.

## Current Direction

Let agents edit Markdown and validate it afterward.

## Constraints

- Preserve deterministic bindings.

## Open Questions


## Next Action

Enable the lifecycle skill.
`,
      "utf8"
    );
    await writeFile(
      files.context_map,
      `# Context Map

## Repositories

| Target | Role | Status |
| --- | --- | --- |
| /code/engine | source | current |

## Context

| Target | Role | Status |
| --- | --- | --- |
| specs/change.md | plan | accepted |
`,
      "utf8"
    );

    const first = await validateWorkUnit(paths, "filesystem-first");
    expect(first.unit).toMatchObject({
      objective: "Ship filesystem-first work context.",
      orientation: { revision: 1 },
      repositories: [{ target: "/code/engine", role: "source", status: "current" }],
      context: [{ target: "specs/change.md", role: "plan", status: "accepted" }]
    });
    expect(first.orientation.state).toBe("current");

    await attachWorkSession(paths, "filesystem-first", { source: "opencode", id: "validated" });
    await writeFile(
      files.orientation,
      (await readFile(files.orientation, "utf8")).replace(
        "Enable the lifecycle skill.",
        "Dogfood the lifecycle skill."
      ),
      "utf8"
    );
    expect((await readWorkAuthoringStatus(paths, "filesystem-first")).orientation.state).toBe(
      "changed"
    );
    const second = await validateWorkUnit(paths, "filesystem-first");
    expect(second.unit.orientation).toMatchObject({
      revision: 2,
      next_action: "Dogfood the lifecycle skill."
    });
    expect(await resolveWorkContext(paths, { source: "opencode", id: "validated" })).toMatchObject({
      bound: true,
      freshness: "stale"
    });
  });

  it("rejects malformed authored context maps", async () => {
    const paths = testRuntimePaths(await makeTempDir());
    await createWorkUnit(paths, {
      slug: "malformed-context",
      title: "Malformed context",
      objective: orientation.outcome,
      orientation
    });
    const files = workAuthoringPaths(paths, "malformed-context");
    await writeFile(files.context_map, "# Context Map\n\n## Repositories\n\nnot a table\n", "utf8");

    await expect(validateWorkUnit(paths, "malformed-context")).rejects.toThrow(
      /context-map\.md: Repositories must use/
    );
  });

  it("validates new checkpoints and rejects changes to prior history", async () => {
    const paths = testRuntimePaths(await makeTempDir());
    await createWorkUnit(paths, {
      slug: "checkpointed",
      title: "Checkpointed",
      objective: "Keep segment history.",
      phase: "implement",
      orientation
    });
    const checkpointFile = path.join(
      workAuthoringPaths(paths, "checkpointed").checkpoints,
      "manual.md"
    );
    await writeFile(
      checkpointFile,
      renderCheckpoint({
        id: "manual-first",
        session: { source: "opencode", id: "checkpoint" },
        boundary: "manual",
        text: "First.",
        created_at: "2026-07-23T01:00:00.000Z"
      }),
      "utf8"
    );
    await validateWorkUnit(paths, "checkpointed");

    expect(await readWorkCheckpoints(paths, "checkpointed")).toHaveLength(1);
    await writeFile(
      checkpointFile,
      (await readFile(checkpointFile, "utf8")).replace("First.", "Changed.")
    );
    await expect(validateWorkUnit(paths, "checkpointed")).rejects.toThrow(
      /validated checkpoint was modified/
    );
    expect((await readWorkCheckpoints(paths, "checkpointed"))[0]?.text).toBe("First.");
    expect((await readWorkUnit(paths, "checkpointed")).phase).toBe("implement");

    await unlink(checkpointFile);
    await expect(validateWorkUnit(paths, "checkpointed")).rejects.toThrow(
      /validated checkpoint was removed/
    );
  });

  it("migrates legacy JSONL checkpoints to validated Markdown", async () => {
    const paths = testRuntimePaths(await makeTempDir());
    await createWorkUnit(paths, {
      slug: "legacy-checkpoints",
      title: "Legacy checkpoints",
      objective: orientation.outcome,
      orientation
    });
    const checkpoint = {
      unit: "legacy-checkpoints",
      session: { source: "opencode", id: "legacy" },
      boundary: "migration",
      text: "Preserve this checkpoint.",
      created_at: "2026-07-23T02:00:00.000Z"
    };
    await writeFile(
      path.join(paths.workRoot, "units", "legacy-checkpoints", "checkpoints.jsonl"),
      `${JSON.stringify(checkpoint)}\n`,
      "utf8"
    );

    expect((await readWorkAuthoringStatus(paths, "legacy-checkpoints")).checkpoints.state).toBe(
      "migration-needed"
    );
    const status = await validateWorkUnit(paths, "legacy-checkpoints");

    expect(status.checkpoints).toMatchObject({ state: "current", count: 1, validated: 1 });
    expect(
      await readFile(path.join(status.files.checkpoints, "legacy-0001-migration.md"), "utf8")
    ).toContain("id: legacy-0001-migration");
    expect(await readWorkCheckpoints(paths, "legacy-checkpoints")).toEqual([
      { ...checkpoint, id: "legacy-0001-migration" }
    ]);
    await expect(
      access(path.join(paths.workRoot, "units", "legacy-checkpoints", "checkpoints.jsonl"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains legacy JSONL when migrated Markdown does not validate", async () => {
    const paths = testRuntimePaths(await makeTempDir());
    await createWorkUnit(paths, {
      slug: "failed-migration",
      title: "Failed migration",
      objective: ""
    });
    const legacyPath = path.join(paths.workRoot, "units", "failed-migration", "checkpoints.jsonl");
    await writeFile(
      legacyPath,
      `${JSON.stringify({
        unit: "failed-migration",
        session: { source: "opencode", id: "legacy" },
        boundary: "migration",
        text: "Keep this until validation succeeds.",
        created_at: "2026-07-23T02:30:00.000Z"
      })}\n`,
      "utf8"
    );

    await expect(validateWorkUnit(paths, "failed-migration")).rejects.toThrow(/orientation\.md/);
    await expect(access(legacyPath)).resolves.toBeUndefined();
  });

  it("rejects duplicate checkpoint identities", async () => {
    const paths = testRuntimePaths(await makeTempDir());
    await createWorkUnit(paths, {
      slug: "duplicate-checkpoints",
      title: "Duplicate checkpoints",
      objective: orientation.outcome,
      orientation
    });
    const directory = workAuthoringPaths(paths, "duplicate-checkpoints").checkpoints;
    const content = renderCheckpoint({
      id: "duplicate",
      session: { source: "opencode", id: "duplicate" },
      boundary: "manual",
      text: "Same identity.",
      created_at: "2026-07-23T03:00:00.000Z"
    });
    await Promise.all([
      writeFile(path.join(directory, "one.md"), content, "utf8"),
      writeFile(path.join(directory, "two.md"), content, "utf8")
    ]);

    await expect(validateWorkUnit(paths, "duplicate-checkpoints")).rejects.toThrow(
      /duplicates checkpoint identity/
    );
  });

  it("does not expose unvalidated checkpoint files", async () => {
    const paths = testRuntimePaths(await makeTempDir());
    await createValidated(paths, "unvalidated-checkpoint");
    const file = path.join(
      workAuthoringPaths(paths, "unvalidated-checkpoint").checkpoints,
      "pending.md"
    );
    await writeFile(
      file,
      renderCheckpoint({
        id: "pending",
        session: { source: "opencode", id: "pending" },
        boundary: "manual",
        text: "Not effective yet.",
        created_at: "2026-07-23T03:30:00.000Z"
      }),
      "utf8"
    );

    expect((await readWorkAuthoringStatus(paths, "unvalidated-checkpoint")).checkpoints.state).toBe(
      "unvalidated"
    );
    expect(await readWorkCheckpoints(paths, "unvalidated-checkpoint")).toEqual([]);
  });

  it("rejects malformed checkpoint metadata and body", async () => {
    const paths = testRuntimePaths(await makeTempDir());
    await createValidated(paths, "malformed-checkpoint");
    await writeFile(
      path.join(workAuthoringPaths(paths, "malformed-checkpoint").checkpoints, "broken.md"),
      "---\nid: broken\nsession: opencode:test\nboundary: manual\ncreated_at: yesterday\n---\n",
      "utf8"
    );

    await expect(validateWorkUnit(paths, "malformed-checkpoint")).rejects.toThrow(
      /Invalid checkpoint created_at/
    );

    await writeFile(
      path.join(workAuthoringPaths(paths, "malformed-checkpoint").checkpoints, "broken.md"),
      "---\nid: broken\nsession: opencode:test\nboundary: manual\ncreated_at: 2026-07-23T03:45:00.000Z\n---\n",
      "utf8"
    );
    await expect(validateWorkUnit(paths, "malformed-checkpoint")).rejects.toThrow(/text/);
  });

  it("rejects malformed runtime records instead of treating them as absent", async () => {
    const paths = testRuntimePaths(await makeTempDir());
    const dir = path.join(paths.workRoot, "units", "broken");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "manifest.json"), '{"schema_version":1}\n', "utf8");

    await expect(readWorkUnit(paths, "broken")).rejects.toThrow();
  });
});
