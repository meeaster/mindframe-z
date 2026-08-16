import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { cli, parseJson, setupIntegrationFixture } from "./support.js";

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
  root: string,
  home: string,
  slug: string,
  input: {
    outcome?: string;
    repositories?: string[];
    context?: string[];
  } = {}
): Promise<void> {
  const dir = path.join(home, ".mindframe-z", "work", "v1", "units", slug);
  await writeFile(
    path.join(dir, "orientation.md"),
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
    path.join(dir, "context-map.md"),
    `# Context Map

## Repositories

${table(input.repositories)}

## Context

${table(input.context)}
`,
    "utf8"
  );
  const validated = await cli("mfz", root, home, ["work", "validate", slug, "--json"]);
  expect(json(validated.stdout)).toMatchObject({ ok: true, status: { valid: true } });
}

describe("work commands", () => {
  it("keeps sessions unbound until explicit attachment and exposes context as JSON", async () => {
    const { root, home } = await setupIntegrationFixture();
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
    const checkpointInstructions = await cli("mfz", root, home, [
      "work",
      "instructions",
      "checkpoint",
      "alpha"
    ]);
    expect(checkpointInstructions.stdout).toContain("Required frontmatter:");
    expect(checkpointInstructions.stdout).toContain("  id");
    expect(checkpointInstructions.stdout).toContain("Authoring guidance:");
    expect(checkpointInstructions.stdout).toContain("meaningful boundary");
    expect(checkpointInstructions.stdout).toContain("## Decisions And Rationale");
    expect(checkpointInstructions.stdout).toContain("## Evidence Pointers");
    await authorWorkUnit(root, home, "alpha", {
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

    const attached = await cli("mfz", root, home, [
      "work",
      "attach",
      "alpha",
      "--session",
      "opencode:session-a",
      "--json"
    ]);
    expect(json(attached.stdout)).toMatchObject({ ok: true, unit: "alpha" });

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
  }, 30_000);

  it("requires switch to replace bindings, retains checkpoints, and reports failed JSON operations", async () => {
    const { root, home } = await setupIntegrationFixture();
    for (const [slug, title] of [
      ["alpha", "Alpha"],
      ["beta", "Beta"]
    ] as const) {
      await cli("mfz", root, home, ["work", "create", slug, "--title", title, "--phase", "design"]);
      await authorWorkUnit(root, home, slug, { outcome: `${title} objective.` });
    }
    await cli("mfz", root, home, ["work", "attach", "alpha", "--session", "opencode:session-a"]);

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

    await cli("mfz", root, home, ["work", "phase", "alpha", "--phase", "implement"]);
    const reversed = await cli("mfz", root, home, [
      "work",
      "phase",
      "alpha",
      "--phase",
      "design",
      "--json"
    ]);
    expect(
      z
        .object({ phase_history: z.array(z.object({ phase: z.string() })) })
        .parse(json(reversed.stdout).unit)
        .phase_history.map((entry) => entry.phase)
    ).toEqual(["design", "implement", "design"]);

    const checkpointDirectory = path.join(
      home,
      ".mindframe-z",
      "work",
      "v1",
      "units",
      "alpha",
      "checkpoints"
    );
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
    await cli("mfz", root, home, ["work", "validate", "alpha"]);
    await cli("mfz", root, home, ["work", "switch", "beta", "--session", "opencode:session-a"]);

    const checkpoints = await cli("mfz", root, home, ["work", "checkpoints", "alpha", "--json"]);
    expect(json(checkpoints.stdout).checkpoints).toHaveLength(1);
    const context = await cli("mfz", root, home, [
      "work",
      "context",
      "--session",
      "opencode:session-a",
      "--json"
    ]);
    expect(z.object({ slug: z.string() }).parse(json(context.stdout).context?.unit).slug).toBe(
      "beta"
    );
  }, 30_000);

  it("records exact delivery receipts and makes successful delivery fresh", async () => {
    const { root, home } = await setupIntegrationFixture();
    await cli("mfz", root, home, ["work", "create", "receipt-unit", "--title", "Receipt unit"]);
    await authorWorkUnit(root, home, "receipt-unit", { outcome: "Observe delivery." });
    await cli("mfz", root, home, [
      "work",
      "attach",
      "receipt-unit",
      "--session",
      "opencode:receipt-session"
    ]);
    await cli("mfz", root, home, [
      "work",
      "receipt",
      "--session",
      "opencode:receipt-session",
      "--boundary",
      "request",
      "--orientation-revision",
      "1",
      "--reminder",
      "Exact compact reminder.",
      "--orientation",
      "Exact orientation.",
      "--outcome",
      "delivered"
    ]);

    const receipts = await cli("mfz", root, home, ["work", "receipts", "receipt-unit", "--json"]);
    expect(json(receipts.stdout).receipts?.[0]).toMatchObject({
      reminder: "Exact compact reminder.",
      orientation: "Exact orientation.",
      outcome: "delivered"
    });
    const context = await cli("mfz", root, home, [
      "work",
      "context",
      "--session",
      "opencode:receipt-session",
      "--json"
    ]);
    expect(json(context.stdout).context).toMatchObject({
      freshness: "delivered",
      pending_orientation: null
    });
  }, 30_000);
});
