import { z } from "zod";

export const threadSessionSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["claude-code", "opencode"]),
  title: z.string().optional(),
  // The synthesizer that produced this session's file, as `<harness>:<model>@<effort>`.
  // TS owns it — the dispatch knows the truth; the agent only guesses.
  extracted_by: z.string().optional()
});

export const threadManifestSchema = z.object({
  slug: z.string().min(1),
  charter: z.string().min(1),
  destination: z.string().min(1),
  created_at: z.string().min(1),
  sessions: z.array(threadSessionSchema).default([]),
  synthesis: z
    .object({
      discover: z.string().optional(),
      gather: z.string().optional(),
      synthesize: z.string().optional(),
      digest: z.string().optional()
    })
    .default({})
});

export const threadDispatchRunSchema = z.object({
  role: z.enum(["discover", "gather", "synthesize", "digest"]),
  harness: z.enum(["claude-code", "opencode"]),
  model: z.string(),
  cost_usd: z.number().nullable(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  reasoning_tokens: z.number().nullable(),
  duration_ms: z.number()
});

export const threadRunRecordSchema = z.object({
  id: z.string().min(1),
  thread: z.string().min(1),
  started_at: z.string().min(1),
  finished_at: z.string().min(1),
  sessions: z.array(z.string()).default([]),
  dispatches: z.array(threadDispatchRunSchema).default([]),
  total_cost_usd: z.number().nullable()
});

export const threadRunsSchema = z.object({
  runs: z.array(threadRunRecordSchema).default([])
});

export type ThreadManifest = z.infer<typeof threadManifestSchema>;
export type ThreadRuns = z.infer<typeof threadRunsSchema>;
export type ThreadRunRecord = z.infer<typeof threadRunRecordSchema>;
export type ThreadDispatchRun = z.infer<typeof threadDispatchRunSchema>;
