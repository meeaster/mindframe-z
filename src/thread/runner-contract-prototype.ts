// PROTOTYPE — throwaway. Answers: "Does `rawUsage` in AgentRunResult
// justify a refactor, or is it a reasonable seam?"
//
// Run: pnpm protos runner-contract
// Question: show the coupling between parse/result/cost-span and let the
// user decide where the split should happen.

import process from "node:process";

// ---------------------------------------------------------------------------
// Pure logic — the shapes being compared
// ---------------------------------------------------------------------------

// --- Current design ---
// AgentRunResult carries rawUsage just for the cost-span emitter.
// For OpenCode, rawUsage DUPLICATES usage.input_tokens / output_tokens.
// For Claude, rawUsage is the full raw usage blob (many fields).
//
// Path: parse -> AgentRunResult (carries rawUsage) -> emitLapdogCostSpan
//       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//       rawUsage leaks observability concern into generic result type

// --- Alternative A: emit inside runner, drop rawUsage from result ---
// AgentRunResult loses rawUsage. cost-span is emitted before returning.
// Cleaner result type, but runner gains observability responsibility.
//
// Path: parse -> emitLapdogCostSpan -> AgentRunResult (clean)

// --- Alternative B: typed token breakdown ---
// parseHarnessResult returns a typed TokenBreakdown, not rawUsage.
// Cost span builder uses the same typed shape. Still in result, but typed.
//
// Path: parse -> AgentRunResult (typed usage) -> emitLapdogCostSpan

// ---------------------------------------------------------------------------
// Scenario data — real-ish trace events for each harness
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  harness: "claude-code" | "opencode";
  usageFields: string[];
  rawUsageFields: string[];
  duplicates: string[];
  coupling: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: "OpenCode dispatch",
    harness: "opencode",
    usageFields: ["cost_usd", "input_tokens", "output_tokens", "reasoning_tokens"],
    rawUsageFields: ["input_tokens", "output_tokens"],
    duplicates: ["input_tokens", "output_tokens"],
    coupling: "rawUsage.input_tokens = usage.input_tokens (duplicate)"
  },
  {
    name: "Claude Code dispatch",
    harness: "claude-code",
    usageFields: ["cost_usd", "input_tokens", "output_tokens", "reasoning_tokens"],
    rawUsageFields: ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens", "service_tier", "model"],
    duplicates: [],
    coupling: "rawUsage carries ~8 fields; only 2 used by cost-span"
  },
  {
    name: "Tester (fake runner)",
    harness: "opencode",
    usageFields: ["cost_usd", "input_tokens", "output_tokens", "reasoning_tokens"],
    rawUsageFields: ["null — must pass null or fake object"],
    duplicates: [],
    coupling: "rawUsage is null in tests — dead weight in AgentRunResult"
  }
];

// ---------------------------------------------------------------------------
// Design comparison
// ---------------------------------------------------------------------------

interface DesignVariant {
  id: string;
  name: string;
  resultShape: string;
  codeImpact: string;
  pros: string[];
  cons: string[];
}

const DESIGNS: DesignVariant[] = [
  {
    id: "current",
    name: "Current (rawUsage in result)",
    resultShape: `{
  text, rawTrace, durationMs,
  usage: ThreadDispatchRun (4 fields),
  rawUsage: Record<string,unknown> | null  // observability leak
}`,
    codeImpact: "Baseline — 0 LOC change",
    pros: [
      "simple — parse once, emit later",
      "cost-span builder can be called async/void"
    ],
    cons: [
      "rawUsage duplicates usage fields for OpenCode",
      "fake runners must supply rawUsage (null or fake)",
      "generic result type carries lapdog-specific state",
      "no type safety on rawUsage contents"
    ]
  },
  {
    id: "emit-inline",
    name: "Emit cost-span inside runner (remove rawUsage)",
    resultShape: `{
  text, rawTrace, durationMs,
  usage: ThreadDispatchRun (4 fields)
  // rawUsage removed
}`,
    codeImpact: "~15 LOC change (split emit into parse, remove rawUsage)",
    pros: [
      "clean result type — only ledger-facing fields",
      "no fake runner burden",
      "type-safe — cost-span data never escapes runner"
    ],
    cons: [
      "runner gains observability responsibility (was already floated)",
      "cost-span can't be retried from stored results"
    ]
  },
  {
    id: "typed-breakdown",
    name: "Typed token breakdown (keep in result)",
    resultShape: `{
  text, rawTrace, durationMs,
  usage: ThreadDispatchRun (4 fields),
  tokenBreakdown: {
    input_tokens, output_tokens,
    cache_read_tokens?, cache_write_tokens?,
    model?, service_tier?
  }  // typed, but still in result
}`,
    codeImpact: "~30 LOC change (typed interface + adapter per harness)",
    pros: [
      "type-safe — compiler catches drift",
      "explicit about what fields cost-span needs"
    ],
    cons: [
      "still couples generic result to observability shape",
      "more code than emit-inline",
      "fields differ between harnesses — non-uniform"
    ]
  }
];

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function bold(s: string): string { return `\x1b[1m${s}\x1b[0m`; }
function dim(s: string): string { return `\x1b[2m${s}\x1b[0m`; }
function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m`; }

let view: "scenarios" | "designs" = "scenarios";
let idx = 0;

function render(): void {
  console.clear();

  if (view === "scenarios") {
    const s = SCENARIOS[idx]!;
    console.log(`${bold("Runner Contract Prototype")}  ${dim(`Scenario ${idx + 1}/${SCENARIOS.length}`)}  [${dim("Tab")} toggle view]`);
    console.log("");
    console.log(`${bold("Scenario:")}  ${s.name} (${s.harness})`);
    console.log(`  ${dim("usage fields:")}      [${s.usageFields.join(", ")}]`);
    console.log(`  ${dim("rawUsage fields:")}   [${s.rawUsageFields.join(", ")}]`);
    console.log(`  ${dim("duplicated fields:")} [${s.duplicates.join(", ") || green("none")}]`);
    console.log(`  ${dim("coupling:")}          ${s.coupling}`);
    console.log("");
    console.log(dim("Designs:"));
    for (const d of DESIGNS) {
      const marker = idx < 3 ? "  " : "";
      console.log(`  [${d.id === "emit-inline" ? green(d.id) : d.id}] ${d.name}`);
      console.log(`      ${dim(d.resultShape.split("\n")[0] ?? "")}`);
    }
    console.log("");
    console.log(dim("─".repeat(70)));
    console.log(`  ${bold("[←]")}${dim("/→")} cycle scenarios  ${bold("[Tab]")} designs view  ${bold("[q]")} quit`);
  } else {
    const d = DESIGNS[idx]!;
    console.log(`${bold("Runner Contract Prototype")}  ${dim("Designs")}  [${dim("Tab")} toggle view]`);
    console.log("");
    console.log(`${bold(d.name)} ${d.id === "emit-inline" ? green("(recommended)") : ""}`);
    console.log("");
    console.log(`${bold("Result shape:")}`);
    for (const line of d.resultShape.split("\n")) {
      console.log(`  ${dim(line)}`);
    }
    console.log("");
    console.log(`${bold("Code impact:")} ${d.codeImpact}`);
    console.log("");
    console.log(`${green("+")} ${d.pros.map((p) => `${p}`).join(`\n${green("+")} `)}`);
    console.log(`${yellow("-")} ${d.cons.map((c) => `${c}`).join(`\n${yellow("-")} `)}`);
    console.log("");
    console.log(dim("─".repeat(70)));
    console.log(`  ${bold("[←]")}${dim("/→")} cycle designs  ${bold("[Tab]")} scenarios view  ${bold("[q]")} quit`);
  }
}

// ---------------------------------------------------------------------------
// TUI loop
// ---------------------------------------------------------------------------

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  render();

  process.stdin.on("data", (key: string) => {
    if (key === "\t") {
      view = view === "scenarios" ? "designs" : "scenarios";
      idx = 0;
    } else if (key === "\u001b[D" || key === "," || key === "h") {
      const max = view === "scenarios" ? SCENARIOS.length - 1 : DESIGNS.length - 1;
      idx = idx === 0 ? max : idx - 1;
    } else if (key === "\u001b[C" || key === "." || key === "l") {
      const max = view === "scenarios" ? SCENARIOS.length - 1 : DESIGNS.length - 1;
      idx = idx === max ? 0 : idx + 1;
    } else if (key === "q" || key === "\u0003") {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.exit(0);
    }
    render();
  });
} else {
  // Non-TTY: print summary
  for (const s of SCENARIOS) {
    console.log(`${s.name}: duplicates=[${s.duplicates.join(", ")}] coupling=${s.coupling}`);
  }
  for (const d of DESIGNS) {
    console.log(`${d.name}: ${d.codeImpact}`);
  }
}
