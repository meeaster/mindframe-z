import type { RuntimePaths } from "../core/paths.js";
import { writeRunTrace } from "./observability.js";
import type { AgentRunner, AgentRunRequest, AgentRunResult } from "./runner.js";
import type { ThreadDispatchRun } from "./schema.js";

export function toDispatch(
  role: ThreadDispatchRun["role"],
  harness: ThreadDispatchRun["harness"],
  model: string,
  result: AgentRunResult
): ThreadDispatchRun {
  return { role, harness, model, duration_ms: result.durationMs, ...result.usage };
}

// One dispatch = run the agent, persist its raw trace under the run id, and
// summarize it into a ledger row. Folding the trace-name bookkeeping in here keeps
// the bare `${id}-gather` string conventions from drifting out of sync.
export async function dispatch(
  runner: AgentRunner,
  paths: RuntimePaths,
  runId: string,
  traceName: string,
  request: AgentRunRequest
): Promise<{ result: AgentRunResult; dispatch: ThreadDispatchRun }> {
  const result = await runner.run(request);
  await writeRunTrace(paths, runId, traceName, result.rawTrace);
  return {
    result,
    dispatch: toDispatch(request.role, request.harness, request.model, result)
  };
}
