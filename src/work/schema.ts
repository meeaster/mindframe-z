import { z } from "zod";

export const workSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Invalid work unit slug");
export const workPhaseSchema = z.enum(["explore", "design", "prototype", "implement", "validate"]);
export const sessionSourceSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, "Invalid session source");

export const sourceQualifiedSessionSchema = z.object({
  source: sessionSourceSchema,
  id: z.string().min(1)
});

export const workPhaseEntrySchema = z.object({
  phase: workPhaseSchema,
  at: z.string().min(1)
});

export const workContextPointerSchema = z.object({
  target: z.string().min(1),
  role: z.string().min(1),
  status: z.string().min(1)
});

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const workOrientationSchema = z.object({
  revision: z.number().int().positive(),
  outcome: z.string(),
  direction: z.string(),
  constraints: z.array(z.string()),
  questions: z.array(z.string()),
  next_action: z.string()
});

export const workScopeSchema = z.enum(["project", "global"]);

export const workUnitSchema = z
  .object({
    schema_version: z.literal(1),
    domain: z.literal("personal").default("personal"),
    scope: workScopeSchema.default("global"),
    project: workSlugSchema.optional(),
    slug: workSlugSchema,
    title: z.string().min(1),
    objective: z.string(),
    phase: workPhaseSchema,
    phase_history: z.array(workPhaseEntrySchema).min(1),
    repositories: z.array(workContextPointerSchema),
    context: z.array(workContextPointerSchema),
    thread: z.string().min(1).optional(),
    orientation: workOrientationSchema,
    orientation_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    context_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    checkpoint_hashes: z.record(z.string(), sha256Schema).default({}),
    created_at: z.string().min(1),
    updated_at: z.string().min(1)
  })
  .superRefine((unit, context) => {
    if (unit.scope === "project" && !unit.project) {
      context.addIssue({
        code: "custom",
        path: ["project"],
        message: "is required for project scope"
      });
    }
    if (unit.scope === "global" && unit.project) {
      context.addIssue({
        code: "custom",
        path: ["project"],
        message: "is not allowed for global scope"
      });
    }
  });

export const deliveryStateSchema = z.object({
  state: z.enum(["pending", "delivered", "stale", "failed"]),
  orientation_revision: z.number().int().positive(),
  boundary: z.string().min(1),
  updated_at: z.string().min(1),
  error: z.string().min(1).optional()
});

export const sessionBindingSchema = z.object({
  session: sourceQualifiedSessionSchema,
  unit: workSlugSchema,
  attached_at: z.string().min(1),
  delivery: deliveryStateSchema
});

export const workBindingIndexSchema = z.object({
  schema_version: z.literal(1),
  bindings: z.record(z.string(), sessionBindingSchema)
});

export const workCheckpointSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Invalid checkpoint id"),
  unit: workSlugSchema,
  session: sourceQualifiedSessionSchema,
  boundary: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Invalid checkpoint boundary"),
  text: z.string().min(1),
  created_at: z.string().min(1)
});

export const workReceiptSchema = z.object({
  unit: workSlugSchema,
  session: sourceQualifiedSessionSchema,
  boundary: z.string().min(1),
  orientation_revision: z.number().int().positive(),
  reminder: z.string(),
  orientation: z.string().nullable(),
  outcome: z.enum(["delivered", "failed"]),
  error: z.string().nullable(),
  created_at: z.string().min(1)
});

export type WorkPhase = z.infer<typeof workPhaseSchema>;
export type WorkScope = z.infer<typeof workScopeSchema>;
export type SourceQualifiedSession = z.infer<typeof sourceQualifiedSessionSchema>;
export type WorkContextPointer = z.infer<typeof workContextPointerSchema>;
export type WorkOrientation = z.infer<typeof workOrientationSchema>;
export type WorkUnit = z.infer<typeof workUnitSchema>;
export type DeliveryState = z.infer<typeof deliveryStateSchema>;
export type SessionBinding = z.infer<typeof sessionBindingSchema>;
export type WorkBindingIndex = z.infer<typeof workBindingIndexSchema>;
export type WorkCheckpoint = z.infer<typeof workCheckpointSchema>;
export type WorkReceipt = z.infer<typeof workReceiptSchema>;
