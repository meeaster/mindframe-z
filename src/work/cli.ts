import {
  appendWorkReceipt,
  attachWorkSession,
  createWorkUnit,
  detachWorkSession,
  listWorkUnits,
  parseSession,
  readWorkCheckpoints,
  readWorkAuthoringStatus,
  readWorkReceipts,
  readWorkUnit,
  reloadWorkOrientation,
  resolveWorkContext,
  setWorkPhase,
  switchWorkSession,
  validateWorkUnit,
  workAuthoringPaths,
  workPhaseSchema,
  workScopeSchema
} from "./storage.js";
import { createRuntimePaths, type PathOptions } from "../core/paths.js";

interface WorkOptions extends PathOptions {
  json?: boolean | undefined;
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function print(value: unknown, json: boolean, human: string | string[]): void {
  if (json) console.log(JSON.stringify({ ok: true, ...((value ?? {}) as object) }, null, 2));
  else for (const line of typeof human === "string" ? [human] : human) console.log(line);
}

async function run<T>(
  options: WorkOptions,
  action: () => Promise<T>,
  display: (value: T) => string | string[]
): Promise<void> {
  try {
    const value = await action();
    print(value, Boolean(options.json), display(value));
  } catch (error) {
    if (!options.json) throw error;
    console.log(
      JSON.stringify(
        { ok: false, error: { message: error instanceof Error ? error.message : String(error) } },
        null,
        2
      )
    );
  }
}

export async function runWorkCreate(
  slug: string,
  options: WorkOptions & {
    title?: string | undefined;
    phase?: string | undefined;
    thread?: string | undefined;
    scope?: string | undefined;
    project?: string | undefined;
  }
): Promise<void> {
  await run(
    options,
    async () => {
      const paths = createRuntimePaths(options);
      const unit = await createWorkUnit(paths, {
        slug,
        title: options.title ?? titleFromSlug(slug),
        objective: "",
        ...(options.scope ? { scope: workScopeSchema.parse(options.scope) } : {}),
        ...(options.project ? { project: options.project } : {}),
        ...(options.phase ? { phase: workPhaseSchema.parse(options.phase) } : {}),
        ...(options.thread ? { thread: options.thread } : {})
      });
      return { unit, files: workAuthoringPaths(paths, slug) };
    },
    ({ unit, files }) => [
      `created\t${unit.slug}\t${unit.phase}`,
      `edit\t${files.orientation}`,
      `edit\t${files.context_map}`,
      `then\tmfz work validate ${unit.slug}`
    ]
  );
}

export async function runWorkInstructions(slug: string, options: WorkOptions): Promise<void> {
  await run(
    options,
    async () => {
      const paths = createRuntimePaths(options);
      await readWorkUnit(paths, slug);
      return {
        unit: slug,
        action: "update",
        files: workAuthoringPaths(paths, slug),
        orientation_sections: [
          "Outcome",
          "Current Direction",
          "Constraints",
          "Open Questions",
          "Next Action"
        ],
        context_map_columns: ["Target", "Role", "Status"],
        next_command: `mfz work validate ${slug}`
      };
    },
    ({ files, orientation_sections, context_map_columns, next_command }) => [
      "Edit:",
      `  ${files.orientation}`,
      `  ${files.context_map}`,
      "",
      "Required orientation sections:",
      ...orientation_sections.map((section) => `  ${section}`),
      "",
      `Context map columns: ${context_map_columns.join(", ")}`,
      "",
      "Then run:",
      `  ${next_command}`
    ]
  );
}

export async function runWorkCheckpointInstructions(
  slug: string,
  options: WorkOptions
): Promise<void> {
  await run(
    options,
    async () => {
      const paths = createRuntimePaths(options);
      await readWorkUnit(paths, slug);
      return {
        unit: slug,
        action: "checkpoint",
        directory: workAuthoringPaths(paths, slug).checkpoints,
        required_frontmatter: ["id", "session", "boundary", "created_at"],
        authoring_guidance: [
          "Create a checkpoint at a meaningful boundary where mutable orientation would otherwise lose important historical context.",
          "Make it understandable without the parent transcript.",
          "Capture why the boundary matters, material changes, decisions and rationale, remaining questions, the next action, and authoritative evidence pointers.",
          "Keep routine progress, test completion, smoke markers, and duplicated orientation in their authoritative systems instead."
        ],
        template:
          "---\nid: <checkpoint-id>\nsession: opencode:<session-id>\nboundary: <segment-boundary>\ncreated_at: <ISO-8601 timestamp>\n---\n\n## Why This Boundary Matters\n\n## Material Changes\n\n## Decisions And Rationale\n\n## Remaining Questions\n\n## Next Action\n\n## Evidence Pointers\n",
        next_command: `mfz work validate ${slug}`
      };
    },
    ({ directory, required_frontmatter, authoring_guidance, template, next_command }) => [
      "Create a new Markdown file under:",
      `  ${directory}`,
      "Name it <checkpoint-id>.md and use the same stable identity in frontmatter.",
      "",
      "Required frontmatter:",
      ...required_frontmatter.map((field) => `  ${field}`),
      "",
      "Authoring guidance:",
      ...authoring_guidance.map((item) => `  - ${item}`),
      "",
      template,
      "Create a new file for every checkpoint. Do not edit an existing checkpoint file.",
      "",
      "Then run:",
      `  ${next_command}`
    ]
  );
}

export async function runWorkStatus(slug: string, options: WorkOptions): Promise<void> {
  await run(
    options,
    async () => ({ status: await readWorkAuthoringStatus(createRuntimePaths(options), slug) }),
    ({ status }) => [
      `${status.unit.slug}\t${status.valid ? "valid" : "invalid"}\t${
        status.synchronized ? "current" : "validation needed"
      }`,
      `orientation\t${status.orientation.state}\trevision ${status.unit.orientation.revision}`,
      `context map\t${status.context_map.state}`,
      `checkpoints\t${status.checkpoints.state}\t${status.checkpoints.count}`,
      ...status.issues.map((issue) => `error\t${issue}`)
    ]
  );
}

export async function runWorkValidate(slug: string, options: WorkOptions): Promise<void> {
  await run(
    options,
    async () => ({ status: await validateWorkUnit(createRuntimePaths(options), slug) }),
    ({ status }) => [
      `valid\t${status.unit.slug}`,
      `orientation\t${status.orientation.state}\trevision ${status.unit.orientation.revision}`,
      `context map\t${status.context_map.state}`
    ]
  );
}

export async function runWorkList(options: WorkOptions): Promise<void> {
  await run(
    options,
    async () => ({ units: await listWorkUnits(createRuntimePaths(options)) }),
    ({ units }) => units.map((unit) => `${unit.slug}\t${unit.phase}\t${unit.title}`)
  );
}

export async function runWorkShow(slug: string, options: WorkOptions): Promise<void> {
  await run(
    options,
    async () => {
      const paths = createRuntimePaths(options);
      const [unit, checkpoints, receipts] = await Promise.all([
        readWorkUnit(paths, slug),
        readWorkCheckpoints(paths, slug),
        readWorkReceipts(paths, slug)
      ]);
      return { unit, checkpoint_count: checkpoints.length, receipt_count: receipts.length };
    },
    ({ unit, checkpoint_count, receipt_count }) => [
      `${unit.slug}\t${unit.phase}\t${unit.title}`,
      `objective\t${unit.objective}`,
      `orientation revision\t${unit.orientation.revision}`,
      `checkpoints\t${checkpoint_count}`,
      `receipts\t${receipt_count}`
    ]
  );
}

export async function runWorkContext(session: string, options: WorkOptions): Promise<void> {
  await run(
    options,
    async () => ({
      context: await resolveWorkContext(createRuntimePaths(options), parseSession(session))
    }),
    ({ context }) =>
      context.bound
        ? `${context.session.source}:${context.session.id}\t${context.unit.slug}\t${context.unit.phase}\t${context.freshness}`
        : `${context.session.source}:${context.session.id}\tunbound`
  );
}

export async function runWorkCheckpoints(slug: string, options: WorkOptions): Promise<void> {
  await run(
    options,
    async () => ({ checkpoints: await readWorkCheckpoints(createRuntimePaths(options), slug) }),
    ({ checkpoints }) =>
      checkpoints.map(
        (checkpoint) =>
          `${checkpoint.created_at}\t${checkpoint.session.source}:${checkpoint.session.id}\t${checkpoint.boundary}\t${checkpoint.text}`
      )
  );
}

export async function runWorkReceipts(slug: string, options: WorkOptions): Promise<void> {
  await run(
    options,
    async () => ({ receipts: await readWorkReceipts(createRuntimePaths(options), slug) }),
    ({ receipts }) =>
      receipts.map(
        (receipt) =>
          `${receipt.created_at}\t${receipt.session.source}:${receipt.session.id}\t${receipt.boundary}\t${receipt.outcome}`
      )
  );
}

export async function runWorkAttach(
  slug: string,
  options: WorkOptions & { session: string }
): Promise<void> {
  await run(
    options,
    async () => {
      const session = parseSession(options.session);
      await attachWorkSession(createRuntimePaths(options), slug, session);
      return { session, unit: slug };
    },
    ({ session, unit }) => `attached\t${session.source}:${session.id}\t${unit}`
  );
}

export async function runWorkSwitch(
  slug: string,
  options: WorkOptions & {
    session: string;
  }
): Promise<void> {
  await run(
    options,
    async () => {
      const session = parseSession(options.session);
      await switchWorkSession(createRuntimePaths(options), slug, session);
      return { session, unit: slug };
    },
    ({ session, unit }) => `switched\t${session.source}:${session.id}\t${unit}`
  );
}

export async function runWorkDetach(options: WorkOptions & { session: string }): Promise<void> {
  await run(
    options,
    async () => {
      const session = parseSession(options.session);
      await detachWorkSession(createRuntimePaths(options), session);
      return { session };
    },
    ({ session }) => `detached\t${session.source}:${session.id}`
  );
}

export async function runWorkPhase(
  slug: string,
  options: WorkOptions & { phase: string }
): Promise<void> {
  await run(
    options,
    async () => ({
      unit: await setWorkPhase(
        createRuntimePaths(options),
        slug,
        workPhaseSchema.parse(options.phase)
      )
    }),
    ({ unit }) => `phase\t${unit.slug}\t${unit.phase}`
  );
}

export async function runWorkReload(
  options: WorkOptions & { session: string; boundary?: string | undefined }
): Promise<void> {
  await run(
    options,
    async () => {
      const session = parseSession(options.session);
      await reloadWorkOrientation(createRuntimePaths(options), session, options.boundary);
      return { session };
    },
    ({ session }) => `reload pending\t${session.source}:${session.id}`
  );
}

export async function runWorkReceipt(
  options: WorkOptions & {
    session: string;
    boundary: string;
    orientationRevision: string;
    reminder: string;
    orientation?: string | undefined;
    outcome: string;
    error?: string | undefined;
  }
): Promise<void> {
  await run(
    options,
    async () => {
      if (options.outcome !== "delivered" && options.outcome !== "failed") {
        throw new Error("--outcome must be delivered or failed");
      }
      if (options.outcome === "failed" && !options.error)
        throw new Error("--error is required for a failed receipt");
      const revision = Number(options.orientationRevision);
      if (!Number.isInteger(revision) || revision < 1)
        throw new Error("--orientation-revision must be a positive whole number");
      const session = parseSession(options.session);
      return {
        receipt: await appendWorkReceipt(createRuntimePaths(options), session, {
          boundary: options.boundary,
          orientation_revision: revision,
          reminder: options.reminder,
          orientation: options.orientation ?? null,
          outcome: options.outcome,
          error: options.error ?? null
        })
      };
    },
    ({ receipt }) => `receipt\t${receipt.unit}\t${receipt.outcome}\t${receipt.boundary}`
  );
}
