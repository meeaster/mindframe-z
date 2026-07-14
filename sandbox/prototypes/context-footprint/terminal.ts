// PROTOTYPE SHELL: the report model is in model.ts; this file is disposable.

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { formatReport, scenarioNames, scenarioReport, type HarnessName } from "./model.js";

type View = HarnessName | "all";

interface State {
  scenarioIndex: number;
  view: View;
}

function clearAndRender(state: State): void {
  const report = scenarioReport(state.scenarioIndex);
  process.stdout.write("\x1b[2J\x1b[H");
  console.log(formatReport(report, state.view));
  console.log("");
  console.log("[1-4] scenario  [a] all  [o] OpenCode  [c] Claude Code  [q] quit");
}

async function main(): Promise<void> {
  const state: State = { scenarioIndex: 0, view: "all" };
  const rl = readline.createInterface({ input: stdin, output: stdout });
  clearAndRender(state);

  try {
    process.stdout.write("\ncommand> ");
    for await (const line of rl) {
      const answer = line.trim().toLowerCase();
      if (answer === "q" || answer === "quit") break;
      if (answer === "a") state.view = "all";
      if (answer === "o") state.view = "opencode";
      if (answer === "c") state.view = "claude-code";
      const scenario = Number(answer) - 1;
      if (Number.isInteger(scenario) && scenario >= 0 && scenario < scenarioNames().length) {
        state.scenarioIndex = scenario;
      }
      clearAndRender(state);
      process.stdout.write("\ncommand> ");
    }
  } finally {
    rl.close();
  }
}

await main();
