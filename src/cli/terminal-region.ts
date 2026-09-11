import type { Writable } from "node:stream";
import type { OperationOutcome } from "../core/operations.js";

interface TerminalOutput extends Writable {
  columns?: number;
  rows?: number;
}

interface RegionRow {
  key: string;
  ordinal: number;
  label: string;
  status: "active" | "created" | "updated" | "removed" | "planned" | "blocked" | "failed";
}

const activeFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const attentionStatuses = new Set(["skipped", "blocked", "failed"]);

const retainedStatuses = new Set(["created", "updated", "removed", "planned", "blocked", "failed"]);

const escapeCharacter = String.fromCharCode(27);

const bellCharacter = String.fromCharCode(7);

const ansiEscape = new RegExp(
  `${escapeCharacter}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${bellCharacter}]*(?:${bellCharacter}|${escapeCharacter}\\\\))`,
  "g"
);

const combiningMark = /^\p{Mark}$/u;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isRetainedStatus(
  status: OperationOutcome["status"]
): status is Exclude<RegionRow["status"], "active"> {
  return retainedStatuses.has(status);
}

function terminalWidth(output: TerminalOutput): number {
  return output.columns && output.columns > 0 ? output.columns : 80;
}

function terminalHeight(output: TerminalOutput): number {
  return output.rows && output.rows > 0 ? output.rows : 20;
}

function terminalContentWidth(output: TerminalOutput): number {
  return Math.max(1, terminalWidth(output) - 1);
}

function wrap(value: string, width: number): string[] {
  const logicalLines = value
    .replaceAll(ansiEscape, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");

  const lines: string[] = [];

  for (const logicalLine of logicalLines) lines.push(...wrapLine(logicalLine, width));

  return lines;
}

function wrapLine(value: string, width: number): string[] {
  if (value.length === 0) return [""];

  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const { segment } of graphemeSegmenter.segment(value)) {
    const segmentWidth = displayCellWidth(segment);

    if (current.length > 0 && currentWidth + segmentWidth > width) {
      lines.push(current);
      current = "";
      currentWidth = 0;
    }

    if (segmentWidth > width) {
      lines.push("…");
      continue;
    }

    current += segment;
    currentWidth += segmentWidth;

    if (currentWidth >= width) {
      lines.push(current);
      current = "";
      currentWidth = 0;
    }
  }

  if (current.length > 0 || lines.length === 0) lines.push(current);

  return lines;
}

function displayCellWidth(value: string): number {
  let width = 0;

  for (const { segment } of graphemeSegmenter.segment(value)) {
    const characters = [...segment];

    const regionalIndicators = characters.filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;

      return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
    });

    if (regionalIndicators.length >= 2) {
      width += 2;
      continue;
    }

    width += Math.max(...characters.map(codePointWidth), 0);
  }

  return width;
}

function codePointWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;

  if (
    codePoint === 0 ||
    codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
    combiningMark.test(character)
  ) {
    return 0;
  }

  if (isWideCodePoint(codePoint)) return 2;

  return 1;
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function truncateToWidth(value: string, width: number): string {
  const normalized = value.replaceAll(ansiEscape, "");

  if (displayCellWidth(normalized) <= width) return normalized;

  let result = "";
  let used = 0;

  for (const { segment } of graphemeSegmenter.segment(normalized)) {
    const segmentWidth = displayCellWidth(segment);

    if (used + segmentWidth > width) break;
    result += segment;
    used += segmentWidth;
  }

  return result || "…";
}

function rowPrefix(row: RegionRow, frame: string): string {
  if (row.status === "active") return `${frame} active `;

  if (attentionStatuses.has(row.status)) return `! ${row.status} `;

  return `✓ ${row.status} `;
}

function rowText(row: RegionRow, frame: string, width: number): string[] {
  return wrap(`${rowPrefix(row, frame)}${row.label}`, width);
}

export class TerminalRegion {
  readonly #output: TerminalOutput;
  readonly #rows = new Map<string, RegionRow>();
  #renderedLines = 0;
  #frame = 0;
  #paused = false;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(output: TerminalOutput) {
    this.#output = output;
  }

  start(key: string, ordinal: number, label: string): void {
    this.#rows.set(key, { key, ordinal, label, status: "active" });
    this.#paused = false;
    this.#startTimer();
    this.#render();
  }

  complete(key: string, outcome: OperationOutcome): void {
    const row = this.#rows.get(key);

    if (!row) return;

    if (outcome.status === "unchanged") {
      this.#rows.delete(key);
    } else if (isRetainedStatus(outcome.status)) {
      row.status = outcome.status;
      row.label = outcome.detail ?? outcome.target;
    } else {
      this.#rows.delete(key);
    }

    if (!this.#hasActiveRows()) this.#stopTimer();
    this.#render();
  }

  remove(key: string): void {
    if (!this.#rows.delete(key)) return;

    if (!this.#hasActiveRows()) this.#stopTimer();
    this.#render();
  }

  pause(): void {
    this.#paused = true;
    this.#stopTimer();
    this.#clearRenderedRegion();
  }

  resume(): void {
    this.#paused = false;

    if (this.#hasActiveRows()) this.#startTimer();
    this.#render();
  }

  commit(interrupted = false): void {
    this.#stopTimer();
    this.#clearRenderedRegion();
    this.#paused = true;
    const rows = [...this.#rows.values()].sort((left, right) => left.ordinal - right.ordinal);

    for (const row of rows) {
      const incomplete = row.status === "active";

      const label = incomplete
        ? `${row.label} (${interrupted ? "interrupted" : "incomplete"})`
        : row.label;

      const committed: RegionRow = {
        ...row,
        label,
        status: incomplete ? "failed" : row.status
      };

      for (const line of rowText(committed, activeFrames[0]!, terminalContentWidth(this.#output))) {
        this.#output.write(`${line}\n`);
      }
    }

    this.#rows.clear();
  }

  #hasActiveRows(): boolean {
    return [...this.#rows.values()].some((row) => row.status === "active");
  }

  #startTimer(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      this.#frame = (this.#frame + 1) % activeFrames.length;
      this.#render();
    }, 120);
    this.#timer.unref?.();
  }

  #stopTimer(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #render(): void {
    if (this.#paused) return;
    const width = terminalContentWidth(this.#output);
    const frame = activeFrames[this.#frame]!;
    const lines: string[] = [];
    const rows = [...this.#rows.values()].sort((left, right) => left.ordinal - right.ordinal);

    for (const row of rows) lines.push(...rowText(row, frame, width));

    const viewport = Math.max(1, terminalHeight(this.#output) - 4);

    if (lines.length > viewport) {
      const visible = Math.max(0, viewport - 1);
      const hidden = lines.length - visible;
      lines.splice(visible, lines.length - visible, truncateToWidth(`… ${hidden} more`, width));
    }

    this.#clearRenderedRegion();

    if (lines.length === 0) return;
    this.#output.write(`${lines.join("\n")}\n`);
    this.#renderedLines = lines.length;
  }

  #clearRenderedRegion(): void {
    if (this.#renderedLines === 0) return;
    this.#output.write(`\u001b[${this.#renderedLines}A\u001b[0J`);
    this.#renderedLines = 0;
  }
}
