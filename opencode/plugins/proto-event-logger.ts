// PROTOTYPE — throwaway. Answers: does the OpenCode hook `event`
// input carry sessionID at `input.event.sessionID` (top-level) or
// `input.event.properties.sessionID` (nested)?
//
// Usage:
//   1. Copy to ~/.opencode/plugin/proto-event-logger.ts (or use --plugin flag)
//   2. Run: opencode run -p "say hello" --agent thread-readonly --model haiku 2>&1 | grep PROTO_EVENT
//   3. Each PROTO_EVENT line shows top_sessionID vs nested_sessionID

import type { Hooks, PluginInput } from "@opencode-ai/plugin";

export default async function protoEventLogger(_input: PluginInput): Promise<Hooks> {
  return {
    event: async (input) => {
      const event = input.event as Record<string, unknown>;
      const line = JSON.stringify({
        ts: Date.now(),
        event_type: event.type,
        // What the current lapdog plugin reads (top-level):
        top_sessionID: event.sessionID,
        // Where it actually lives (nested in properties):
        nested_sessionID:
          typeof event.properties === "object" && event.properties !== null
            ? (event.properties as Record<string, unknown>).sessionID
            : undefined,
        // All top-level keys for inspection:
        keys: Object.keys(event).sort()
      });
      // Write to stderr so it doesn't mix with stdout output
      process.stderr.write(`PROTO_EVENT\t${line}\n`);
    }
  };
}
