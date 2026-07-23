import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { pathExists } from "../core/fs-util.js";
import { threadSweepRoot, type RuntimePaths } from "../core/paths.js";
import type { ThreadHarness } from "../core/manifests.js";
import type { Watermark } from "./watermark.js";

export const verdictGradeSchema = z.enum(["fits", "no_fit", "pass", "reject"]);

export const verdictWatermarkSchema = z.object({
  message_count: z.number(),
  last_message_id: z.string(),
  last_activity_at: z.string()
});

export const verdictRowSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["claude-code", "opencode"]),
  bare_id: z.string().min(1),
  thread: z.string().min(1),
  verdict: verdictGradeSchema,
  reason: z.string(),
  judged_at: z.string().min(1),
  watermark: verdictWatermarkSchema,
  charter_hash: z.string().min(1)
});

export const verdictLedgerSchema = z.object({
  verdicts: z.array(verdictRowSchema).default([])
});

export const sweepStateSchema = z.object({
  baseline_at: z.string().optional(),
  last_sweep_at: z.string().optional(),
  last_review_at: z.string().optional()
});

export type VerdictGrade = z.infer<typeof verdictGradeSchema>;
export type VerdictRow = z.infer<typeof verdictRowSchema>;
export type VerdictLedger = z.infer<typeof verdictLedgerSchema>;
export type SweepState = z.infer<typeof sweepStateSchema>;

export function sourceQualifiedId(source: ThreadHarness, bareId: string): string {
  return `${source}:${bareId}`;
}

export function parseSourceQualifiedId(id: string): { source: ThreadHarness; bareId: string } {
  const colon = id.indexOf(":");
  const source = id.slice(0, colon);
  const bareId = id.slice(colon + 1);
  if ((source !== "claude-code" && source !== "opencode") || colon === -1 || bareId === "") {
    throw new Error(`Invalid session id: ${id}`);
  }
  return { source, bareId };
}

export function hashCharter(charter: string): string {
  return createHash("sha256").update(charter).digest("hex");
}

export function verdictKey(row: Pick<VerdictRow, "id" | "thread">): string {
  return `${row.id}\t${row.thread}`;
}

export function isVerdictStanding(
  row: VerdictRow,
  watermark: Watermark | undefined,
  charterHash: string
): boolean {
  if (row.verdict === "reject") return true;
  return (
    watermark !== undefined &&
    row.charter_hash === charterHash &&
    row.watermark.message_count === watermark.message_count &&
    row.watermark.last_message_id === watermark.last_message_id
  );
}

function ledgerPath(paths: RuntimePaths): string {
  return path.join(threadSweepRoot(paths), "ledger.json");
}

function statePath(paths: RuntimePaths): string {
  return path.join(threadSweepRoot(paths), "sweep.json");
}

export async function readVerdictLedger(paths: RuntimePaths): Promise<VerdictLedger> {
  const file = ledgerPath(paths);
  if (!(await pathExists(file))) return { verdicts: [] };
  return verdictLedgerSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

export async function writeVerdictLedger(
  paths: RuntimePaths,
  ledger: VerdictLedger
): Promise<void> {
  await mkdir(threadSweepRoot(paths), { recursive: true });
  await writeFile(ledgerPath(paths), JSON.stringify(ledger, null, 2) + "\n", "utf8");
}

export async function readSweepState(paths: RuntimePaths): Promise<SweepState> {
  const file = statePath(paths);
  if (!(await pathExists(file))) return {};
  return sweepStateSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

export async function writeSweepState(paths: RuntimePaths, state: SweepState): Promise<void> {
  await mkdir(threadSweepRoot(paths), { recursive: true });
  await writeFile(statePath(paths), JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function upsertVerdicts(ledger: VerdictLedger, rows: readonly VerdictRow[]): VerdictLedger {
  const byKey = new Map(ledger.verdicts.map((row) => [verdictKey(row), row]));
  for (const row of rows) byKey.set(verdictKey(row), row);
  return {
    verdicts: [...byKey.values()].sort((a, b) => verdictKey(a).localeCompare(verdictKey(b)))
  };
}
