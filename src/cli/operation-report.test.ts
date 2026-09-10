import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { OperationOutcome } from "../core/operations.js";
import {
  commandIsInteractive,
  createOperationReporter,
  printInventory
} from "./operation-report.js";

function capture() {
  let value = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += String(chunk);
      callback();
    }
  });
  return { stream, text: () => value };
}

function outcome(
  status: OperationOutcome["status"],
  target: string,
  significance: OperationOutcome["significance"] = "meaningful"
): OperationOutcome {
  return {
    category: "file",
    action: "write",
    status,
    target,
    significance
  };
}

describe("plain operation reporting", () => {
  it("prints only meaningful changes and attention by default", () => {
    const output = capture();
    const diagnostics = capture();
    const reporter = createOperationReporter({
      command: "mfz apply",
      scope: "personal · all",
      interactive: false,
      output: output.stream,
      diagnostics: diagnostics.stream
    });

    reporter.complete(outcome("unchanged", "/unchanged"));
    reporter.complete(outcome("updated", "/internal", "internal"));
    reporter.complete(outcome("created", "/created"));
    reporter.complete(outcome("skipped", "/conflict"));
    reporter.finish();

    expect(output.text()).toBe(
      [
        "mfz apply\tpersonal · all",
        "Changes",
        "created\tfile\t/created",
        "Attention",
        "skipped\tfile\t/conflict",
        "Result\tmfz apply complete with attention",
        ""
      ].join("\n")
    );
    expect(diagnostics.text()).toBe("");
  });

  it("prints a no-change result only after clean completion", () => {
    const output = capture();
    const reporter = createOperationReporter({
      command: "mfz refs sync",
      scope: "personal · all",
      interactive: false,
      output: output.stream,
      diagnostics: capture().stream
    });
    reporter.complete(outcome("unchanged", "/checked"));
    reporter.finish();

    expect(output.text()).toBe(
      "mfz refs sync\tpersonal · all\nResult\tmfz refs sync complete — no changes\n"
    );
  });

  it("shows chronological unchanged and internal work in verbose mode", () => {
    const output = capture();
    const reporter = createOperationReporter({
      command: "mfz apply",
      scope: "personal · all",
      verbose: true,
      interactive: false,
      output: output.stream,
      diagnostics: capture().stream
    });
    reporter.start({ category: "reference", action: "reconcile", target: "/refs/alpha" });
    reporter.complete(outcome("unchanged", "/unchanged"));
    reporter.complete(outcome("updated", "/internal", "internal"));
    reporter.finish();

    expect(output.text()).toContain("working\treference\treconcile\t/refs/alpha");
    expect(output.text()).toContain("unchanged\tfile\t/unchanged");
    expect(output.text()).toContain("updated\tfile\t/internal");
    expect(output.text()).toContain("Result\tmfz apply complete — no changes");
  });

  it("preserves completed changes and separates failure diagnostics", () => {
    const output = capture();
    const diagnostics = capture();
    const reporter = createOperationReporter({
      command: "mfz apply",
      scope: "personal · all",
      interactive: false,
      output: output.stream,
      diagnostics: diagnostics.stream
    });
    reporter.complete(outcome("created", "/created"));
    reporter.complete({
      ...outcome("failed", "/refs/beta"),
      category: "reference",
      action: "reconcile",
      detail: "remote unavailable"
    });
    reporter.fail(new Error("remote unavailable"));

    expect(output.text()).toContain("created\tfile\t/created");
    expect(output.text()).toContain("failed\treference\t/refs/beta\tremote unavailable");
    expect(output.text()).toContain("earlier changes were not rolled back");
    expect(diagnostics.text()).toBe("error\tremote unavailable\n");
  });

  it("never emits terminal control sequences to captured output", () => {
    const output = capture();
    const reporter = createOperationReporter({
      command: "mfz apply",
      scope: "personal · all",
      verbose: true,
      interactive: false,
      output: output.stream,
      diagnostics: capture().stream
    });
    reporter.start({ category: "file", action: "write", target: "/tmp/example" });
    reporter.complete(outcome("created", "/tmp/example"));
    reporter.finish();

    expect(output.text()).not.toContain(String.fromCharCode(27));
    expect(output.text()).not.toContain(String.fromCharCode(155));
  });

  it("retains exact plain inventory rows", () => {
    const output = capture();
    printInventory(
      "mfz refs list",
      "personal",
      ["alpha\tenabled\t/refs/alpha\tAlpha reference"],
      [{ label: "enabled  alpha", detail: "/refs/alpha\nAlpha reference" }],
      output.stream
    );
    expect(output.text()).toBe("alpha\tenabled\t/refs/alpha\tAlpha reference\n");
  });
});

describe("command terminal policy", () => {
  it("enables interaction only when all command streams are TTYs", () => {
    expect(commandIsInteractive({ isTTY: true }, { isTTY: true }, { isTTY: true })).toBe(true);
    expect(commandIsInteractive({ isTTY: true }, { isTTY: false }, { isTTY: true })).toBe(false);
    expect(commandIsInteractive({ isTTY: false }, { isTTY: false }, { isTTY: false })).toBe(false);
  });
});
