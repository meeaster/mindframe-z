import { intro, log, outro, spinner, type SpinnerResult } from "@clack/prompts";
import {
  stderr as processStderr,
  stdin as processStdin,
  stdout as processStdout
} from "node:process";
import type { Writable } from "node:stream";
import {
  operationChanged,
  type OperationOutcome,
  type OperationStart
} from "../core/operations.js";

interface TerminalCapability {
  isTTY?: boolean;
}

interface TerminalStream extends Writable, TerminalCapability {}

export interface OperationReporterOptions {
  command: string;
  scope: string;
  verbose?: boolean;
  dryRun?: boolean;
  output?: TerminalStream;
  diagnostics?: TerminalStream;
  interactive: boolean;
}

export interface OperationReporter {
  start(operation: OperationStart): void;
  complete(outcome: OperationOutcome): void;
  pause(): void;
  finish(): boolean;
  fail(error: Error): void;
}

const attentionStatuses = new Set(["skipped", "blocked", "failed"]);

function uniqueOutcomes(outcomes: readonly OperationOutcome[]): OperationOutcome[] {
  const unique = new Map<string, OperationOutcome>();
  for (const outcome of outcomes) unique.set(outcomeFields(outcome).join("\0"), outcome);
  return [...unique.values()];
}

function singleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function outcomeFields(outcome: OperationOutcome): string[] {
  const fields: string[] = [outcome.status];
  if (outcome.status === "planned" && outcome.plannedEffect) fields.push(outcome.plannedEffect);
  fields.push(outcome.category, outcome.target);
  if (outcome.before !== undefined || outcome.after !== undefined) {
    fields.push(`${outcome.before ?? "none"} -> ${outcome.after ?? "none"}`);
  }
  if (outcome.changes && outcome.changes.length > 0) fields.push(outcome.changes.join(","));
  if (outcome.detail) fields.push(singleLine(outcome.detail));
  return fields;
}

function terminalOutcome(outcome: OperationOutcome): string {
  const status =
    outcome.status === "planned" && outcome.plannedEffect
      ? `${outcome.status} ${outcome.plannedEffect}`
      : outcome.status;
  const lines = [`${status}  ${outcome.category}: ${outcome.detail ?? outcome.target}`];
  if (outcome.detail && outcome.detail !== outcome.target) lines.push(outcome.target);
  if (outcome.before !== undefined || outcome.after !== undefined) {
    lines.push(`${outcome.before ?? "none"} -> ${outcome.after ?? "none"}`);
  }
  if (outcome.changes && outcome.changes.length > 0) lines.push(outcome.changes.join(", "));
  return lines.join("\n");
}

class CliOperationReporter implements OperationReporter {
  readonly #output: TerminalStream;
  readonly #diagnostics: TerminalStream;
  readonly #terminal: boolean;
  readonly #verbose: boolean;
  readonly #dryRun: boolean;
  readonly #command: string;
  readonly #outcomes: OperationOutcome[] = [];
  readonly #spinner: SpinnerResult | undefined;
  #spinnerActive = false;
  #finished = false;

  constructor(options: OperationReporterOptions) {
    this.#output = options.output ?? processStdout;
    this.#diagnostics = options.diagnostics ?? processStderr;
    this.#terminal = options.interactive;
    this.#verbose = options.verbose ?? false;
    this.#dryRun = options.dryRun ?? false;
    this.#command = options.command;
    if (this.#terminal) {
      intro(`${options.command} · ${options.scope}`, { output: this.#output });
      this.#spinner = spinner({
        output: this.#output,
        onCancel: () => process.kill(process.pid, "SIGINT")
      });
    } else {
      this.#output.write(`${options.command}\t${options.scope}\n`);
    }
  }

  start(operation: OperationStart): void {
    const label = `${operation.category}: ${operation.detail ?? operation.target}`;
    if (this.#terminal) {
      if (this.#spinnerActive) this.#spinner?.message(label);
      else {
        this.#spinner?.start(label);
        this.#spinnerActive = true;
      }
      return;
    }
    if (this.#verbose) {
      const fields = ["working", operation.category, operation.action, operation.target];
      if (operation.detail !== undefined) fields.push(operation.detail);
      this.#output.write(fields.map(singleLine).join("\t") + "\n");
    }
  }

  complete(outcome: OperationOutcome): void {
    this.#outcomes.push(outcome);
    if (!this.#verbose) return;
    this.pause();
    this.#writeOutcome(outcome);
  }

  pause(): void {
    if (!this.#spinnerActive) return;
    this.#spinner?.clear();
    this.#spinnerActive = false;
  }

  finish(): boolean {
    if (this.#finished) return false;
    this.#finished = true;
    this.pause();
    const changes = uniqueOutcomes(
      this.#outcomes.filter(
        (outcome) =>
          outcome.significance === "meaningful" &&
          (this.#dryRun ? outcome.status === "planned" : operationChanged(outcome))
      )
    );
    const attention = uniqueOutcomes(
      this.#outcomes.filter(
        (outcome) => outcome.significance === "meaningful" && attentionStatuses.has(outcome.status)
      )
    );
    const blocked = attention.some(
      (outcome) => outcome.status === "blocked" || outcome.status === "failed"
    );
    if (!this.#verbose) this.#writeReceipt(changes, attention);

    const result =
      blocked && !this.#dryRun
        ? `${this.#command} blocked — earlier changes were not rolled back`
        : attention.length > 0
          ? `${this.#command} complete with attention`
          : changes.length === 0
            ? `${this.#command} complete — no changes`
            : this.#dryRun
              ? `${this.#command} complete — ${changes.length} planned change${changes.length === 1 ? "" : "s"}`
              : `${this.#command} complete — ${changes.length} change${changes.length === 1 ? "" : "s"}`;
    this.#writeResult(result);
    return this.#dryRun || !blocked;
  }

  fail(error: Error): void {
    if (this.#finished) return;
    this.#finished = true;
    this.pause();
    if (!this.#verbose) {
      this.#writeReceipt(
        uniqueOutcomes(
          this.#outcomes.filter(
            (outcome) => outcome.significance === "meaningful" && operationChanged(outcome)
          )
        ),
        uniqueOutcomes(
          this.#outcomes.filter(
            (outcome) =>
              outcome.significance === "meaningful" && attentionStatuses.has(outcome.status)
          )
        )
      );
    }
    const message = error.message;
    if (this.#terminal) log.error(message, { output: this.#diagnostics });
    else this.#diagnostics.write(`error\t${singleLine(message)}\n`);
    this.#writeResult(`${this.#command} failed — earlier changes were not rolled back`);
  }

  #writeReceipt(
    changes: readonly OperationOutcome[],
    attention: readonly OperationOutcome[]
  ): void {
    if (changes.length > 0) {
      this.#writeSection("Changes", changes);
    }
    if (attention.length > 0) {
      this.#writeSection("Attention", attention);
    }
  }

  #writeSection(title: string, outcomes: readonly OperationOutcome[]): void {
    if (this.#terminal) log.info(title, { output: this.#output });
    else this.#output.write(`${title}\n`);
    for (const outcome of outcomes) this.#writeOutcome(outcome);
  }

  #writeOutcome(outcome: OperationOutcome): void {
    if (this.#terminal) {
      const message = terminalOutcome(outcome);
      if (attentionStatuses.has(outcome.status)) log.warn(message, { output: this.#output });
      else if (operationChanged(outcome)) log.success(message, { output: this.#output });
      else log.message(message, { output: this.#output });
      return;
    }
    this.#output.write(outcomeFields(outcome).map(singleLine).join("\t") + "\n");
  }

  #writeResult(result: string): void {
    if (this.#terminal) outro(result, { output: this.#output });
    else this.#output.write(`Result\t${result}\n`);
  }
}

export function createOperationReporter(options: OperationReporterOptions): OperationReporter {
  return new CliOperationReporter(options);
}

export function commandIsInteractive(
  input: TerminalCapability = processStdin,
  output: TerminalCapability = processStdout,
  diagnostics: TerminalCapability = processStderr
): boolean {
  return input.isTTY === true && output.isTTY === true && diagnostics.isTTY === true;
}

export interface InventoryItem {
  label: string;
  detail: string;
}

export function printInventory(
  title: string,
  scope: string,
  plainRows: readonly string[],
  items: readonly InventoryItem[],
  output: TerminalStream = processStdout
): void {
  if (output.isTTY !== true) {
    for (const row of plainRows) output.write(`${row}\n`);
    return;
  }
  intro(`${title} · ${scope}`, { output });
  for (const item of items) log.message(`${item.label}\n${item.detail}`, { output });
  outro(`${items.length} reference${items.length === 1 ? "" : "s"}`, { output });
}
