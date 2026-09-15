import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  appendWorkReceipt,
  attachWorkSession,
  createWorkUnit,
  readWorkCheckpoints,
  readWorkReceipts,
  resolveWorkContext,
  setWorkPhase,
  switchWorkSession,
  validateWorkUnit,
  workAuthoringPaths
} from "../../src/work/storage.js";
import { runWorkCheckpointInstructions } from "../../src/work/cli.js";
import { cli, makeTempDir, parseJson, testRuntimePaths } from "./support.js";

const WorkJson = z
  .object({
    ok: z.boolean().optional(),
    unit: z
      .union([
        z.string(),
        z.object({
          phase_history: z.array(z.object({ phase: z.string() })),
          slug: z.string().optional(),
          phase: z.string().optional()
        })
      ])
      .optional(),
    files: z.object({ orientation: z.string() }).optional(),
    status: z
      .object({
        valid: z.boolean(),
        synchronized: z.boolean(),
        orientation: z.object({ state: z.string() }),
        context_map: z.object({ state: z.string() })
      })
      .optional(),
    context: z
      .object({
        bound: z.boolean(),
        session: z.object({ source: z.string(), id: z.string() }).optional(),
        freshness: z.string().optional(),
        unit: z.object({ slug: z.string(), phase: z.string() }).optional(),
        pending_orientation: z.union([z.object({ revision: z.number() }), z.null()]).optional()
      })
      .optional(),
    error: z.object({ message: z.string() }).optional(),
    checkpoints: z.array(z.object({}).passthrough()).optional(),
    receipts: z
      .array(z.object({ reminder: z.string(), orientation: z.string(), outcome: z.string() }))
      .optional()
  })
  .passthrough();

function json(stdout: string) {
  return parseJson(WorkJson, stdout);
}

async function authorWorkUnit(
  paths: ReturnType<typeof testRuntimePaths>,
  slug: string,
  input: {
    outcome?: string;
    repositories?: string[];
    context?: string[];
  } = {}
): Promise<void> {
  const files = workAuthoringPaths(paths, slug);
  await writeFile(
    files.orientation,
    `# Orientation

## Outcome

${input.outcome ?? `Ship ${slug}.`}

## Current Direction

Use the validated design.

## Constraints

- Keep mutations explicit.

## Open Questions


## Next Action

Run the next test.
`,
    "utf8"
  );

  const table = (rows: string[] = []) =>
    ["| Target | Role | Status |", "| --- | --- | --- |", ...rows].join("\n");

  await writeFile(
    files.context_map,
    `# Context Map

## Repositories

${table(input.repositories)}

## Context

${table(input.context)}
`,
    "utf8"
  );
  expect((await validateWorkUnit(paths, slug)).valid).toBe(true);
}

async function captureWorkOutput(action: () => Promise<void>): Promise<string> {
  const logs: string[] = [];

  const log = vi.spyOn(console, "log").mockImplementation((value?: string) => {
    logs.push(String(value));
  });

  try {
    await action();
  } finally {
    log.mockRestore();
  }

  return logs.join("\n");
}

describe("work commands", () => {
  it("keeps sessions unbound until explicit attachment and exposes context as JSON", async () => {
    const root = await makeTempDir();
    const home = await makeTempDir();
    const paths = testRuntimePaths(home, root);

    const create = await cli("mfz", root, home, [
      "work",
      "create",
      "alpha",
      "--title",
      "Alpha work",
      "--phase",
      "design",
      "--thread",
      "passive-thread",
      "--json"
    ]);

    expect(json(create.stdout).files?.orientation).toMatch(/orientation\.md$/);
    const instructions = await cli("mfz", root, home, ["work", "instructions", "update", "alpha"]);
    expect(instructions.stdout).toContain("Required orientation sections:");

    const checkpointInstructions = await captureWorkOutput(() =>
      runWorkCheckpointInstructions("alpha", { root, home })
    );

    expect(checkpointInstructions).toContain("Required frontmatter:");
    expect(checkpointInstructions).toContain("  id");
    expect(checkpointInstructions).toContain("Authoring guidance:");
    expect(checkpointInstructions).toContain("meaningful boundary");
    expect(checkpointInstructions).toContain("## Decisions And Rationale");
    expect(checkpointInstructions).toContain("## Evidence Pointers");
    await authorWorkUnit(paths, "alpha", {
      outcome: "Ship the work runtime.",
      repositories: ["| /code/alpha | source | current |", "| /code/shared | source | current |"],
      context: ["| alpha:design.md | design | accepted |"]
    });
    const status = await cli("mfz", root, home, ["work", "status", "alpha", "--json"]);
    expect(json(status.stdout).status).toMatchObject({
      valid: true,
      synchronized: true,
      orientation: { state: "current" },
      context_map: { state: "current" }
    });

    const unbound = await cli("mfz", root, home, [
      "work",
      "context",
      "--session",
      "opencode:session-a",
      "--json"
    ]);

    expect(json(unbound.stdout).context).toMatchObject({
      bound: false,
      session: { source: "opencode", id: "session-a" }
    });

    await attachWorkSession(paths, "alpha", { source: "opencode", id: "session-a" });

    const context = await cli("mfz", root, home, [
      "work",
      "context",
      "--session",
      "opencode:session-a",
      "--json"
    ]);

    expect(json(context.stdout).context).toMatchObject({
      bound: true,
      freshness: "pending",
      unit: { slug: "alpha", phase: "design" },
      pending_orientation: { revision: 1 }
    });
  }, 60_000);

  it("requires switch to replace bindings, retains checkpoints, and reports failed JSON operations", async () => {
    const root = await makeTempDir();
    const home = await makeTempDir();
    const paths = testRuntimePaths(home, root);
    const session = { source: "opencode", id: "session-a" } as const;

    for (const [slug, title] of [
      ["alpha", "Alpha"],
      ["beta", "Beta"]
    ] as const) {
      await createWorkUnit(paths, { slug, title, objective: "", phase: "design" });
      await authorWorkUnit(paths, slug, { outcome: `${title} objective.` });
    }

    await attachWorkSession(paths, "alpha", session);

    const rejected = await cli("mfz", root, home, [
      "work",
      "attach",
      "beta",
      "--session",
      "opencode:session-a",
      "--json"
    ]);

    expect(json(rejected.stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/already bound to alpha/) }
    });

    await setWorkPhase(paths, "alpha", "implement");
    const reversed = await setWorkPhase(paths, "alpha", "design");

    expect(reversed.phase_history.map((entry) => entry.phase)).toEqual([
      "design",
      "implement",
      "design"
    ]);

    const checkpointDirectory = workAuthoringPaths(paths, "alpha").checkpoints;

    await writeFile(
      path.join(checkpointDirectory, "compaction.md"),
      `---
id: compaction-test
session: opencode:session-a
boundary: compaction
created_at: 2026-07-23T04:00:00.000Z
---

Completed compaction summary.
`,
      "utf8"
    );
    await validateWorkUnit(paths, "alpha");
    await switchWorkSession(paths, "beta", session);

    expect(await readWorkCheckpoints(paths, "alpha")).toHaveLength(1);

    const context = await resolveWorkContext(paths, session);

    expect(context).toMatchObject({ bound: true, unit: { slug: "beta" } });
  }, 30_000);

  it("records exact delivery receipts and makes successful delivery fresh", async () => {
    const root = await makeTempDir();
    const home = await makeTempDir();
    const paths = testRuntimePaths(home, root);
    const session = { source: "opencode", id: "receipt-session" } as const;
    await createWorkUnit(paths, {
      slug: "receipt-unit",
      title: "Receipt unit",
      objective: ""
    });
    await authorWorkUnit(paths, "receipt-unit", { outcome: "Observe delivery." });
    await attachWorkSession(paths, "receipt-unit", session);

    const receipt = await appendWorkReceipt(paths, session, {
      boundary: "request",
      orientation_revision: 1,
      reminder: "Exact compact reminder.",
      orientation: "Exact orientation.",
      outcome: "delivered",
      error: null
    });

    expect(receipt).toMatchObject({
      reminder: "Exact compact reminder.",
      orientation: "Exact orientation.",
      outcome: "delivered"
    });

    const receipts = await readWorkReceipts(paths, "receipt-unit");
    expect(receipts[0]).toMatchObject({
      reminder: "Exact compact reminder.",
      orientation: "Exact orientation.",
      outcome: "delivered"
    });

    const context = await resolveWorkContext(paths, session);

    expect(context).toMatchObject({
      freshness: "delivered",
      pending_orientation: null
    });
  }, 30_000);
});
