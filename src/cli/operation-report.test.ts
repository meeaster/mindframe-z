import { Writable } from "node:stream";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
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

const projectRoot = path.resolve(import.meta.dirname, "../..");

async function runFullPty(
  mode: "layout" | "interrupt",
  columns: number,
  rows: number,
  interruptAfter = -1
) {
  const operationReport = pathToFileURL(path.join(projectRoot, "src/cli/operation-report.ts")).href;

  const script = [
    `import { commandIsInteractive, createOperationReporter } from ${JSON.stringify(operationReport)};`,
    "const mode = process.argv[1];",
    "const interactive = commandIsInteractive();",
    'if (!interactive) throw new Error("full PTY was not detected");',
    "const reporter = createOperationReporter({",
    '  command: "pty-test",',
    "  scope: mode,",
    "  verbose: true,",
    "  interactive,",
    "  output: process.stdout,",
    "  diagnostics: process.stderr",
    "});",
    'if (mode === "layout") {',
    "  const rows = [",
    '    ["created", "created 世界"],',
    '    ["updated", "updated label with a wide 🙂 marker"],',
    '    ["removed", "removed"],',
    '    ["planned", "planned"],',
    '    ["blocked", "blocked"],',
    '    ["failed", "first line\\nsecond line"]',
    "  ];",
    '  rows.push(["removed", "12345678901234567"]);',
    "  for (const [ordinal, [status, detail]] of rows.entries()) {",
    '    reporter.lifecycle({ type: "start", key: `row:${ordinal}`, ordinal, operation: { category: "reference", action: "reconcile", target: `/refs/${ordinal}`, detail } });',
    "  }",
    '  reporter.complete({ category: "file", action: "write", status: "created", target: "/diagnostic", significance: "meaningful", detail: "diagnostic during activity" });',
    "  for (const [ordinal, [status, detail]] of rows.entries()) {",
    '    const outcome = { category: "reference", action: "reconcile", status, target: `/refs/${ordinal}`, significance: "meaningful", detail };',
    '    reporter.lifecycle({ type: "complete", key: `row:${ordinal}`, ordinal, outcome });',
    "    reporter.complete(outcome);",
    "  }",
    "  reporter.finish();",
    '  process.stdout.write("PTY-LAYOUT-DONE\\n");',
    "} else {",
    '  process.once("SIGINT", () => {',
    '    reporter.fail(new Error("interrupt first line\\ninterrupt second line"));',
    '    process.stdout.write("PTY-INTERRUPTED\\n");',
    "    setTimeout(() => process.exit(1), 20);",
    "  });",
    '  process.stdout.write("\\u001b]PTY-READY\\u0007");',
    '  reporter.lifecycle({ type: "start", key: "interrupt-row", ordinal: 0, operation: { category: "reference", action: "reconcile", target: "/refs/interrupt", detail: "interrupting a long row" } });',
    "  setTimeout(() => process.exit(0), 5000);",
    "}"
  ].join("\n");

  const runner = [
    "import errno, fcntl, os, pty, select, signal, struct, subprocess, sys, termios, time",
    "columns = int(sys.argv[1])",
    "rows = int(sys.argv[2])",
    "interrupt_after = float(sys.argv[3])",
    "master, slave = pty.openpty()",
    "fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))",
    "child = subprocess.Popen(sys.argv[4:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)",
    "os.close(slave)",
    "chunks = []",
    "started = time.monotonic()",
    "deadline = started + 10",
    "interrupted = False",
    "ready_at = None",
    "while child.poll() is None:",
    "    now = time.monotonic()",
    "    if interrupt_after >= 0 and ready_at is not None and not interrupted and now - ready_at >= interrupt_after:",
    "        os.killpg(child.pid, signal.SIGINT)",
    "        interrupted = True",
    "    if now > deadline:",
    "        child.kill()",
    "        break",
    "    readable, _, _ = select.select([master], [], [], 0.02)",
    "    if readable:",
    "        try:",
    "            chunk = os.read(master, 65536)",
    "            chunks.append(chunk)",
    "            if ready_at is None and b'PTY-READY' in b''.join(chunks): ready_at = time.monotonic()",
    "        except OSError as error:",
    "            if error.errno != errno.EIO: raise",
    "            break",
    "drain_until = time.monotonic() + 0.2",
    "while time.monotonic() < drain_until:",
    "    readable, _, _ = select.select([master], [], [], 0.02)",
    "    if not readable: break",
    "    try: chunks.append(os.read(master, 65536))",
    "    except OSError as error:",
    "        if error.errno != errno.EIO: raise",
    "        break",
    "os.close(master)",
    "sys.stdout.buffer.write(b''.join(chunks))",
    "try:",
    "    return_code = child.wait(timeout=2)",
    "except subprocess.TimeoutExpired:",
    "    child.kill()",
    "    return_code = child.wait(timeout=2)",
    "raise SystemExit(return_code)"
  ].join("\n");

  return execa(
    "python3",
    [
      "-c",
      runner,
      String(columns),
      String(rows),
      String(interruptAfter),
      process.execPath,
      "--import",
      path.join(projectRoot, "node_modules", "tsx", "dist", "loader.mjs"),
      "--input-type=module",
      "--eval",
      script,
      mode
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, TERM: "xterm-256color" },
      reject: false,
      stripFinalNewline: false
    }
  );
}

interface ScreenCell {
  text: string;
  start: number;
  width: number;
}

interface ScreenCursor {
  row: number;
  column: number;
}

interface VirtualScreenSnapshot {
  rows: readonly string[];
  cursor: ScreenCursor;
  cursorVisible: boolean;
}

const screenGraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const screenCombiningMark = /^\p{Mark}$/u;

function screenCellWidth(value: string): number {
  let width = 0;

  for (const { segment } of screenGraphemeSegmenter.segment(value)) {
    const characters = [...segment];

    const regionalIndicators = characters.filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;

      return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
    });

    if (regionalIndicators.length >= 2) {
      width += 2;
      continue;
    }

    width += Math.max(
      ...characters.map((character) => {
        const codePoint = character.codePointAt(0) ?? 0;

        if (
          codePoint === 0 ||
          codePoint < 0x20 ||
          (codePoint >= 0x7f && codePoint <= 0x9f) ||
          codePoint === 0x200d ||
          (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
          (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
          screenCombiningMark.test(character)
        ) {
          return 0;
        }

        if (
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
        ) {
          return 2;
        }

        return 1;
      }),
      0
    );
  }

  return width;
}

class VirtualScreen {
  readonly #columns: number;
  readonly #rows: number;
  readonly #cells: Array<Array<ScreenCell | undefined>>;
  readonly #history: VirtualScreenSnapshot[] = [];
  #row = 0;
  #column = 0;
  #wrapPending = false;
  #cursorVisible = true;
  #savedCursor: ScreenCursor | undefined;

  constructor(columns: number, rows: number) {
    this.#columns = columns;
    this.#rows = rows;
    this.#cells = Array.from({ length: rows }, () => Array(columns));
  }

  replay(value: string): void {
    let index = 0;

    while (index < value.length) {
      const character = value[index]!;

      if (character === "\u001b") {
        index = this.#replayEscape(value, index);
        continue;
      }

      if (character === "\r") {
        this.#column = 0;
        this.#wrapPending = false;
        index += 1;
        continue;
      }

      if (character === "\n") {
        this.#lineFeed();
        index += 1;
        continue;
      }

      if (character === "\b") {
        this.#column = Math.max(0, this.#column - 1);
        this.#wrapPending = false;
        index += 1;
        continue;
      }

      if (character === "\t") {
        this.#column = Math.min(this.#columns, (Math.floor(this.#column / 8) + 1) * 8);
        this.#wrapPending = false;
        index += 1;
        continue;
      }

      if (character < " ") {
        index += 1;
        continue;
      }

      let end = index + 1;

      while (end < value.length) {
        const next = value[end]!;

        if (next === "\u001b" || next === "\r" || next === "\n" || next < " ") break;
        end += 1;
      }

      for (const { segment } of screenGraphemeSegmenter.segment(value.slice(index, end))) {
        this.#write(segment);
      }

      index = end;
    }

    this.#record();
  }

  visibleRows(): string[] {
    return this.#cells.map((row) =>
      row
        .map((cell, column) => (cell ? (cell.start === column ? cell.text : "") : " "))
        .join("")
        .replace(/\s+$/u, "")
    );
  }

  history(): readonly VirtualScreenSnapshot[] {
    return this.#history;
  }

  cursor(): ScreenCursor {
    return { row: this.#row, column: this.#column };
  }

  cursorVisible(): boolean {
    return this.#cursorVisible;
  }

  #replayEscape(value: string, index: number): number {
    const next = value[index + 1];

    if (next === "[") {
      let end = index + 2;

      while (end < value.length) {
        const codePoint = value.charCodeAt(end);

        if (codePoint >= 0x40 && codePoint <= 0x7e) break;
        end += 1;
      }

      if (end >= value.length) throw new Error("Incomplete CSI sequence in PTY transcript");

      this.#csi(value.slice(index + 2, end), value[end]!);

      return end + 1;
    }

    if (next === "]") {
      let end = index + 2;

      while (end < value.length && value[end] !== "\u0007") {
        if (value[end] === "\u001b" && value[end + 1] === "\\") {
          return end + 2;
        }

        end += 1;
      }

      return end < value.length ? end + 1 : end;
    }

    if (next === "7") {
      this.#savedCursor = this.cursor();

      return index + 2;
    }

    if (next === "8") {
      if (this.#savedCursor) {
        this.#row = this.#savedCursor.row;
        this.#column = this.#savedCursor.column;
      }

      this.#wrapPending = false;

      return index + 2;
    }

    throw new Error(`Unsupported escape sequence in PTY transcript: ${JSON.stringify(next)}`);
  }

  #csi(parameters: string, final: string): void {
    const privateMode = parameters.startsWith("?");

    const values = parameters
      .replace(/^\?/u, "")
      .split(";")
      .map((value) => (value === "" ? undefined : Number(value)));

    const first = values[0] ?? 1;
    const mode = values[0] ?? 0;

    switch (final) {
      case "A":
        this.#row = Math.max(0, this.#row - first);
        this.#wrapPending = false;

        return;
      case "B":
        this.#row = Math.min(this.#rows - 1, this.#row + first);
        this.#wrapPending = false;

        return;
      case "C":
        this.#column = Math.min(this.#columns, this.#column + first);
        this.#wrapPending = false;

        return;
      case "D":
        this.#column = Math.max(0, this.#column - first);
        this.#wrapPending = false;

        return;
      case "G":
        this.#column = Math.max(0, Math.min(this.#columns, first - 1));
        this.#wrapPending = false;

        return;
      case "H":
      case "f":
        this.#row = Math.max(0, Math.min(this.#rows - 1, (values[0] ?? 1) - 1));
        this.#column = Math.max(0, Math.min(this.#columns, (values[1] ?? 1) - 1));
        this.#wrapPending = false;

        return;
      case "J":
        this.#eraseDisplay(mode);

        return;
      case "K":
        this.#eraseLine(mode);

        return;
      case "m":
        return;
      case "h":
      case "l":
        if (!privateMode || mode !== 25) {
          throw new Error(`Unsupported CSI mode in PTY transcript: ${parameters}${final}`);
        }

        this.#cursorVisible = final === "h";

        return;
      case "s":
        this.#savedCursor = this.cursor();

        return;
      case "u":
        if (this.#savedCursor) {
          this.#row = this.#savedCursor.row;
          this.#column = this.#savedCursor.column;
        }

        this.#wrapPending = false;

        return;
      default:
        throw new Error(`Unsupported CSI sequence in PTY transcript: ${parameters}${final}`);
    }
  }

  #write(segment: string): void {
    const width = screenCellWidth(segment);

    if (width === 0) {
      const previous = this.#cells[this.#row]?.[Math.max(0, this.#column - 1)];

      if (previous) previous.text += segment;

      return;
    }

    if (this.#wrapPending || this.#column + width > this.#columns) {
      this.#lineFeed();
      this.#column = 0;
      this.#wrapPending = false;
    }

    const cell: ScreenCell = { text: segment, start: this.#column, width };

    for (let offset = 0; offset < width; offset += 1) {
      this.#clearCell(this.#row, this.#column + offset);
      this.#cells[this.#row]![this.#column + offset] = cell;
    }

    this.#column += width;
    this.#wrapPending = this.#column >= this.#columns;
  }

  #lineFeed(): void {
    this.#wrapPending = false;

    if (this.#row === this.#rows - 1) {
      this.#cells.shift();
      this.#cells.push(Array(this.#columns));
    } else {
      this.#row += 1;
    }

    this.#record();
  }

  #eraseDisplay(mode: number): void {
    if (mode === 0) {
      for (let column = this.#column; column < this.#columns; column += 1) {
        this.#cells[this.#row]![column] = undefined;
      }

      for (let row = this.#row + 1; row < this.#rows; row += 1) {
        this.#cells[row]!.fill(undefined);
      }

      return;
    }

    if (mode === 2) {
      for (const row of this.#cells) row.fill(undefined);

      return;
    }

    if (mode === 1) {
      for (let row = 0; row < this.#row; row += 1) this.#cells[row]!.fill(undefined);

      for (let column = 0; column <= this.#column; column += 1) {
        this.#cells[this.#row]![column] = undefined;
      }

      return;
    }

    throw new Error(`Unsupported erase-display mode in PTY transcript: ${mode}`);
  }

  #eraseLine(mode: number): void {
    if (mode === 0) {
      for (let column = this.#column; column < this.#columns; column += 1) {
        this.#cells[this.#row]![column] = undefined;
      }

      return;
    }

    if (mode === 2) {
      this.#cells[this.#row]!.fill(undefined);

      return;
    }

    if (mode === 1) {
      for (let column = 0; column <= this.#column; column += 1) {
        this.#cells[this.#row]![column] = undefined;
      }

      return;
    }

    throw new Error(`Unsupported erase-line mode in PTY transcript: ${mode}`);
  }

  #clearCell(row: number, column: number): void {
    const cell = this.#cells[row]?.[column];

    if (!cell) return;

    for (let offset = 0; offset < cell.width; offset += 1) {
      if (cell.start + offset < this.#columns) {
        this.#cells[row]![cell.start + offset] = undefined;
      }
    }
  }

  #record(): void {
    this.#history.push({
      rows: this.visibleRows(),
      cursor: this.cursor(),
      cursorVisible: this.#cursorVisible
    });
  }
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

describe("interactive reference lifecycle reporting", () => {
  it("keeps keyed changed rows and removes unchanged rows without duplicate receipts", () => {
    const output = capture();
    Object.assign(output.stream, { columns: 40, rows: 10 });

    const reporter = createOperationReporter({
      command: "mfz refs sync",
      scope: "personal · all",
      interactive: true,
      output: output.stream,
      diagnostics: capture().stream
    });

    reporter.lifecycle({
      type: "start",
      key: "reference:0:alpha",
      ordinal: 0,
      operation: {
        category: "reference",
        action: "reconcile",
        target: "/refs/alpha",
        detail: "alpha"
      }
    });
    reporter.lifecycle({
      type: "start",
      key: "reference:1:beta",
      ordinal: 1,
      operation: {
        category: "reference",
        action: "reconcile",
        target: "/refs/beta",
        detail: "beta"
      }
    });
    reporter.lifecycle({
      type: "complete",
      key: "reference:1:beta",
      ordinal: 1,
      outcome: {
        ...outcome("updated", "/refs/beta"),
        category: "reference",
        detail: "beta updated"
      }
    });
    reporter.complete({
      ...outcome("updated", "/refs/beta"),
      category: "reference",
      detail: "beta updated"
    });
    reporter.lifecycle({
      type: "complete",
      key: "reference:0:alpha",
      ordinal: 0,
      outcome: outcome("unchanged", "/refs/alpha")
    });
    reporter.complete(outcome("unchanged", "/refs/alpha"));
    reporter.complete({
      ...outcome("unchanged", "/state", "internal"),
      category: "bookkeeping"
    });
    reporter.finish();

    expect(output.text()).toContain("beta updated");
    expect(output.text()).not.toContain("Changes");
    expect(output.text()).not.toContain("updated\treference");
  });

  it("retains planned reference rows during an interactive dry-run", () => {
    const output = capture();

    const reporter = createOperationReporter({
      command: "mfz apply",
      scope: "personal · all",
      dryRun: true,
      interactive: true,
      output: output.stream,
      diagnostics: capture().stream
    });

    const operation = {
      category: "reference" as const,
      action: "reconcile" as const,
      target: "/refs/alpha",
      detail: "alpha"
    };

    const planned = {
      ...outcome("planned", "/refs/alpha"),
      category: "reference" as const,
      plannedEffect: "add" as const,
      detail: "alpha: checkout would be cloned"
    };

    reporter.lifecycle({
      type: "start",
      key: "reference:0:alpha",
      ordinal: 0,
      operation
    });
    reporter.lifecycle({
      type: "complete",
      key: "reference:0:alpha",
      ordinal: 0,
      outcome: planned
    });
    reporter.complete(planned);
    reporter.finish();

    expect(output.text()).toContain("alpha: checkout would be cloned");
    expect(output.text()).toContain("planned change");
  });

  it("marks failed rows and keeps plain lifecycle output control-free", () => {
    const output = capture();

    const reporter = createOperationReporter({
      command: "mfz refs sync",
      scope: "personal · all",
      interactive: false,
      output: output.stream,
      diagnostics: capture().stream
    });

    reporter.lifecycle({
      type: "start",
      key: "reference:0:broken",
      ordinal: 0,
      operation: {
        category: "reference",
        action: "reconcile",
        target: "/refs/broken",
        detail: "broken"
      }
    });
    reporter.lifecycle({
      type: "complete",
      key: "reference:0:broken",
      ordinal: 0,
      outcome: { ...outcome("failed", "/refs/broken"), category: "reference" }
    });
    reporter.complete({ ...outcome("failed", "/refs/broken"), category: "reference" });
    reporter.fail(new Error("broken remote"));

    expect(output.text()).toContain("failed\treference\t/refs/broken");
    expect(output.text()).not.toContain(String.fromCharCode(27));
    expect(output.text()).not.toContain(String.fromCharCode(155));
  });

  it("does not duplicate retained reference rows when an interactive run fails", () => {
    const output = capture();

    const reporter = createOperationReporter({
      command: "mfz refs sync",
      scope: "personal · all",
      interactive: true,
      output: output.stream,
      diagnostics: capture().stream
    });

    const changed = {
      ...outcome("updated", "/refs/beta"),
      category: "reference" as const,
      detail: "beta updated"
    };

    reporter.lifecycle({
      type: "start",
      key: "reference:0:beta",
      ordinal: 0,
      operation: {
        category: "reference",
        action: "reconcile",
        target: "/refs/beta",
        detail: "beta"
      }
    });
    reporter.lifecycle({
      type: "complete",
      key: "reference:0:beta",
      ordinal: 0,
      outcome: changed
    });
    reporter.complete(changed);
    reporter.fail(new Error("later failure"));

    expect(output.text()).not.toContain("updated  reference: beta updated");
  });
});

describe("interactive reporter PTY regression", () => {
  it("keeps multiline, wide, exact-width, and short-viewport rows recoverable", async () => {
    const result = await runFullPty("layout", 28, 20);
    const screen = new VirtualScreen(28, 20);
    screen.replay(result.stdout);
    const shortResult = await runFullPty("layout", 28, 7);
    const shortScreen = new VirtualScreen(28, 7);
    shortScreen.replay(shortResult.stdout);

    expect(result.exitCode).toBe(0);
    expect(shortResult.exitCode).toBe(0);
    expect(screen.visibleRows()).toEqual([
      "│",
      "◆  created  file: diagnostic",
      " during activity",
      "│  /diagnostic",
      "✓ created created 世界",
      "✓ updated updated label wit",
      "h a wide 🙂 marker",
      "✓ removed removed",
      "✓ planned planned",
      "! blocked blocked",
      "! failed first line",
      "second line",
      "✓ removed 12345678901234567",
      "│",
      "└  pty-test blocked — earlie",
      "r changes were not rolled ba",
      "ck",
      "",
      "PTY-LAYOUT-DONE",
      ""
    ]);
    expect(screen.cursor()).toEqual({ row: 19, column: 0 });
    expect(screen.cursorVisible()).toBe(true);

    const diagnosticIndex = screen
      .history()
      .findIndex((snapshot) => snapshot.rows.join("\n").includes("diagnostic\n during activity"));

    expect(diagnosticIndex).toBeGreaterThanOrEqual(0);

    const resumed = screen
      .history()
      .slice(diagnosticIndex + 1)
      .find((snapshot) => snapshot.rows.includes("⠋ active created 世界"));

    expect(resumed).toMatchObject({ cursor: { column: 0 } });
    expect(screenCellWidth("✓ removed 12345678901234567")).toBe(27);

    const clipped = shortScreen
      .history()
      .find((snapshot) => snapshot.rows.some((row) => row === "… 7 more"));

    expect(clipped).toBeDefined();
    expect(shortScreen.visibleRows()).toEqual([
      "│",
      "└  pty-test blocked — earlie",
      "r changes were not rolled ba",
      "ck",
      "",
      "PTY-LAYOUT-DONE",
      ""
    ]);
    expect(shortScreen.cursor()).toEqual({ row: 6, column: 0 });
  }, 15_000);

  it("restores the cursor region and marks an interrupted row failed", async () => {
    const result = await runFullPty("interrupt", 32, 12, 0.15);
    const screen = new VirtualScreen(32, 12);
    screen.replay(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(screen.visibleRows()).toEqual([
      "┌  pty-test · interrupt",
      "! failed interrupting a long ro",
      "w (interrupted)",
      "│",
      "■  interrupt first line",
      "│  interrupt second line",
      "│",
      "└  pty-test failed — earlier cha",
      "nges were not rolled back",
      "",
      "PTY-INTERRUPTED",
      ""
    ]);
    expect(screen.cursor()).toEqual({ row: 11, column: 0 });
    expect(screen.cursorVisible()).toBe(true);

    const interrupted = screen.visibleRows();
    expect(interrupted[1]).toContain("! failed");
    expect(interrupted[2]).toBe("w (interrupted)");
    expect(interrupted[4]).toContain("interrupt first line");
    expect(interrupted[5]).toContain("interrupt second line");
  }, 15_000);
});
