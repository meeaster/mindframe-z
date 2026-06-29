// PROTOTYPE — throwaway. Answers: "Does `startLapdogContainer`
// treat any named container as healthy?"
//
// Run: pnpm protos lapdog-lifecycle
// Question: what does the current "already_running" logic return for
// each possible container state, and what SHOULD it return?

import process from "node:process";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Pure logic module — the bit worth keeping after the prototype is deleted
// ---------------------------------------------------------------------------

type ContainerState =
  | "absent"           // no container named "lapdog" exists
  | "running-healthy"  // lapdog is running and healthy
  | "stopped"          // container exists but is stopped/exited
  | "wrong-image"      // same name but different image
  | "wrong-network";   // running but not on mfz-net

type StartResult = "started" | "already_running";

interface InspectResult {
  exists: boolean;
  running: boolean;
  image: string;
  networks: string[];
}

// Current logic (from src/thread/lapdog.ts:46-49)
function currentStartLapdogContainer(inspect: InspectResult): StartResult {
  // The current code:
  //   try { await execa("docker", ["inspect", lapdogContainerName]); return "already_running"; }
  //   catch { /* start container */ }
  if (inspect.exists) return "already_running";
  return "started";
}

// Proposed logic
function proposedStartLapdogContainer(inspect: InspectResult): StartResult {
  if (!inspect.exists) return "started";
  if (!inspect.running) return "started"; // restart stopped
  if (inspect.image !== "ghcr.io/datadog/dd-apm-test-agent/ddapm-test-agent:latest") return "started";
  if (!inspect.networks.includes("mfz-net")) return "started";
  return "already_running";
}

// ---------------------------------------------------------------------------
// Scenarios — each state the container could be in
// ---------------------------------------------------------------------------

const SCENARIOS: Array<{ state: ContainerState; inspect: InspectResult; description: string }> = [
  {
    state: "absent",
    inspect: { exists: false, running: false, image: "", networks: [] },
    description: "no container named 'lapdog' exists at all"
  },
  {
    state: "running-healthy",
    inspect: { exists: true, running: true, image: "ghcr.io/datadog/dd-apm-test-agent/ddapm-test-agent:latest", networks: ["mfz-net"] },
    description: "lapdog running, correct image, on mfz-net"
  },
  {
    state: "stopped",
    inspect: { exists: true, running: false, image: "ghcr.io/datadog/dd-apm-test-agent/ddapm-test-agent:latest", networks: ["mfz-net"] },
    description: "container exists but is stopped (exited, dead, etc.)"
  },
  {
    state: "wrong-image",
    inspect: { exists: true, running: true, image: "nginx:latest", networks: ["mfz-net"] },
    description: "container running but wrong image — e.g. a stray nginx named 'lapdog'"
  },
  {
    state: "wrong-network",
    inspect: { exists: true, running: true, image: "ghcr.io/datadog/dd-apm-test-agent/ddapm-test-agent:latest", networks: ["bridge"] },
    description: "running on bridge instead of mfz-net — can't reach other containers"
  }
];

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function bold(s: string): string { return `\x1b[1m${s}\x1b[0m`; }
function dim(s: string): string { return `\x1b[2m${s}\x1b[0m`; }
function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function red(s: string): string { return `\x1b[31m${s}\x1b[0m`; }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m`; }
function verdict(ok: boolean): string { return ok ? green("PASS") : red("FAIL"); }

function render(index: number): void {
  const scenario = SCENARIOS[index]!;
  const current = currentStartLapdogContainer(scenario.inspect);
  const proposed = proposedStartLapdogContainer(scenario.inspect);
  const bug = current !== proposed;

  console.clear();
  console.log(`${bold("Lapdog Container Lifecycle Prototype")}  ${dim(`Scenario ${index + 1}/${SCENARIOS.length}`)}`);
  console.log("");
  console.log(`${bold("State:")}       ${scenario.state}`);
  console.log(`${dim("Description:")}  ${scenario.description}`);
  console.log("");
  console.log(`${bold("Container inspect data:")}`);
  console.log(`  exists:    ${scenario.inspect.exists}`);
  console.log(`  running:   ${scenario.inspect.running}`);
  console.log(`  image:     ${scenario.inspect.image || "(none)"}`);
  console.log(`  networks:  [${scenario.inspect.networks.join(", ") || "(none)"}]`);
  console.log("");
  console.log(`${bold("Current code result:")}  ${current === "already_running" ? red("already_running") : dim("started")} ${current === "already_running" && bug ? `${red("<<< BUG")}` : ""}`);
  console.log(`${bold("Proposed code result:")} ${proposed === "already_running" ? green("already_running") : dim("started")}`);
  console.log("");
  console.log(`${bold("Verdict:")} ${bug ? `${red("BUG —")} current returns 'already_running' but container is ${scenario.state}` : `${green("OK — both agree on")} ${current}`}`);
  console.log("");
  console.log(dim("─".repeat(70)));
  console.log(`  ${bold("[←]")} prev  ${bold("[→]")} next  ${bold("[q]")} quit`);
}

// ---------------------------------------------------------------------------
// TUI loop
// ---------------------------------------------------------------------------

function run(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  const rl = createInterface({ input: process.stdin, escapeCodeTimeout: 50 });

  let index = 0;
  render(index);

  rl.on("line", (line) => {
    const key = line.trim();
    if (key === "\u001b[D" || key === ",") {
      index = (index - 1 + SCENARIOS.length) % SCENARIOS.length;
    } else if (key === "\u001b[C" || key === ".") {
      index = (index + 1) % SCENARIOS.length;
    } else if (key === "q" || key === "\u0003") {
      rl.close();
      return;
    }
    render(index);
  });

  rl.on("close", () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.exit(0);
  });
}

// Interactive stdin probing — we read raw key events by listening
// for data directly, since readline buffers on newlines
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let index = 0;
  render(index);

  process.stdin.on("data", (key: string) => {
    if (key === "\u001b[D" || key === "," || key === "h") {
      index = (index - 1 + SCENARIOS.length) % SCENARIOS.length;
    } else if (key === "\u001b[C" || key === "." || key === "l") {
      index = (index + 1) % SCENARIOS.length;
    } else if (key === "q" || key === "\u0003") {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.exit(0);
    }
    render(index);
  });
} else {
  // Non-TTY fallback: print all scenarios
  for (let i = 0; i < SCENARIOS.length; i++) {
    const s = SCENARIOS[i]!;
    const cur = currentStartLapdogContainer(s.inspect);
    const prop = proposedStartLapdogContainer(s.inspect);
    const bug = cur !== prop;
    console.log(`${s.state}: current=${cur} proposed=${prop} bug=${bug}`);
  }
}
