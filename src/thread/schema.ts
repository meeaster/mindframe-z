import { z } from "zod";

const watermarkFields = ["message_count", "last_message_id", "last_activity_at"] as const;

export const threadSessionSchema = z
  .object({
    id: z.string().min(1),
    source: z.enum(["claude-code", "opencode"]),
    title: z.string().optional(),
    project: z.string().optional(),
    time_range: z.string().optional(),
    synthesizer: z.string().optional(),
    message_count: z.number().int().nonnegative().optional(),
    last_message_id: z.string().min(1).optional(),
    last_activity_at: z.string().min(1).optional()
  })
  .strict()
  .superRefine((session, context) => {
    const present = watermarkFields.filter((field) => session[field] !== undefined);
    if (present.length === 0 || present.length === watermarkFields.length) return;
    for (const field of watermarkFields) {
      if (session[field] === undefined) {
        context.addIssue({
          code: "custom",
          message: "watermark fields must be present together",
          path: [field]
        });
      }
    }
  });

export const threadExclusionSchema = z
  .object({
    id: z.string().min(1),
    source: z.enum(["claude-code", "opencode"]).optional(),
    title: z.string().optional(),
    project: z.string().optional(),
    reason: z.string().optional()
  })
  .strict();

export const threadManifestSchema = z
  .object({
    slug: z.string().min(1),
    title: z.string().min(1).optional(),
    charter: z.string().min(1),
    store: z.string().min(1),
    created_at: z.string().min(1),
    read_subagents: z.boolean().optional(),
    sessions: z.array(threadSessionSchema).default([]),
    excluded: z.array(threadExclusionSchema).default([]),
    synthesis: z
      .object({
        discover: z.string().optional(),
        gather: z.string().optional(),
        synthesize: z.string().optional(),
        digest: z.string().optional()
      })
      .strict()
      .default({})
  })
  .strict();

export const threadDispatchRunSchema = z
  .object({
    role: z.enum(["discover", "gather", "synthesize", "digest", "triage"]),
    harness: z.enum(["claude-code", "opencode"]),
    model: z.string(),
    cost_usd: z.number().nullable(),
    input_tokens: z.number().nullable(),
    output_tokens: z.number().nullable(),
    reasoning_tokens: z.number().nullable(),
    duration_ms: z.number()
  })
  .strict();

const nativeThreadRunRecordSchema = z
  .object({
    kind: z.literal("native"),
    id: z.string().min(1),
    thread: z.string().min(1),
    started_at: z.string().min(1),
    finished_at: z.string().min(1),
    sessions: z.array(z.string()).default([]),
    dispatches: z.array(threadDispatchRunSchema).default([]),
    total_cost_usd: z.number().nullable()
  })
  .strict();

const importedThreadRunRecordSchema = z
  .object({
    kind: z.literal("imported"),
    id: z.string().min(1),
    thread: z.string().min(1),
    at: z.string().min(1),
    mode: z.string().min(1),
    sessions: z.array(z.string()).default([]),
    model: z.string().optional(),
    duration_ms: z.number().nonnegative().optional(),
    num_turns: z.number().nonnegative().optional(),
    usage: z.record(z.string(), z.number()).optional(),
    cost_usd: z.number().nullable().optional()
  })
  .strict();

export const threadRunRecordSchema = z.discriminatedUnion("kind", [
  nativeThreadRunRecordSchema,
  importedThreadRunRecordSchema
]);

export const threadRunsSchema = z
  .object({ runs: z.array(threadRunRecordSchema).default([]) })
  .strict();

export type ThreadManifest = z.infer<typeof threadManifestSchema>;
export type ThreadSession = z.infer<typeof threadSessionSchema>;
export type ThreadExclusion = z.infer<typeof threadExclusionSchema>;
export type ThreadRuns = z.infer<typeof threadRunsSchema>;
export type ThreadRunRecord = z.infer<typeof threadRunRecordSchema>;
export type ThreadDispatchRun = z.infer<typeof threadDispatchRunSchema>;

const tokenUsageSchema = z
  .object({
    input_tokens: z.number().finite().optional(),
    cache_read_input_tokens: z.number().finite().optional(),
    cache_creation_input_tokens: z.number().finite().optional(),
    output_tokens: z.number().finite().optional(),
    reasoning: z.number().finite().optional()
  })
  .passthrough();

const harnessPartSchema = z
  .object({
    type: z.string().optional(),
    text: z.string().optional(),
    cost: z.number().finite().optional(),
    tokens: z
      .object({
        input: z.number().finite().optional(),
        output: z.number().finite().optional(),
        reasoning: z.number().finite().optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

export const harnessEventSchema = z
  .object({
    type: z.string().optional(),
    session_id: z.string().optional(),
    result: z.string().optional(),
    error: z
      .union([
        z.string(),
        z
          .object({
            name: z.string().optional(),
            data: z
              .object({
                message: z.string().optional(),
                providerID: z.string().optional(),
                statusCode: z.number().finite().optional()
              })
              .passthrough()
              .optional()
          })
          .passthrough()
      ])
      .optional(),
    subtype: z.string().optional(),
    error_status: z.number().finite().optional(),
    total_cost_usd: z.number().finite().nullable().optional(),
    usage: tokenUsageSchema.optional(),
    part: harnessPartSchema.optional()
  })
  .passthrough();

export type HarnessEvent = z.infer<typeof harnessEventSchema>;

export const lockRecordSchema = z
  .object({ pid: z.number().int().positive(), command: z.string(), started_at: z.string() })
  .strict();

export const watermarkClaudeRecordSchema = z
  .object({
    type: z.string().optional(),
    uuid: z.string().optional(),
    timestamp: z.string().optional()
  })
  .passthrough();

export const watermarkExportSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            info: z
              .object({
                id: z.string().optional(),
                time: z.object({ created: z.number().finite().optional() }).optional()
              })
              .optional()
          })
          .passthrough()
      )
      .optional()
  })
  .passthrough();
