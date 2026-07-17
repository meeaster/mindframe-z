import { styleText } from "node:util";
import { getColumns, isCancel, MultiSelectPrompt } from "@clack/core";
import { limitOptions } from "@clack/prompts";
import type { Key } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { AgentName, RuntimePaths } from "../core/paths.js";
import {
  effectiveProjectState,
  findProjectRoot,
  readOverrideStore,
  writeProjectOverrideDelta
} from "../core/override-store.js";
import { assertMcpToggleSupported, type ResolvedProfile } from "../core/profile.js";

export type McpState = Record<string, boolean>;

interface McpOption {
  value: string;
  label: string;
  hint: string;
}

const targets: AgentName[] = ["opencode", "claude-code", "codex"];

export function validateMcpTuiStates(
  profile: ResolvedProfile,
  states: Partial<Record<AgentName, McpState>>
): void {
  for (const server of profile.mcpServers) {
    if (server.route !== "direct" || server.agents["claude-code"] === undefined) continue;
    if (states["claude-code"]?.[server.name] === false) {
      assertMcpToggleSupported("claude-code", false);
    }
  }
}

function optionsForTarget(profile: ResolvedProfile, target: AgentName): McpOption[] {
  return profile.mcpServers
    .filter((server) => server.route !== "executor" && server.agents[target] !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((server) => ({
      value: server.name,
      label: server.name,
      hint: server.server.description
    }));
}

class McpTogglePrompt extends MultiSelectPrompt<McpOption> {
  saved = false;
  private target: AgentName;
  private readonly states: Record<AgentName, McpState>;
  private readonly profile: ResolvedProfile;
  private readonly outputStream: Writable;

  constructor(
    profile: ResolvedProfile,
    states: Record<AgentName, McpState>,
    streams: { input?: Readable; output?: Writable } = {}
  ) {
    const initialTarget = profile.agents.includes("opencode")
      ? "opencode"
      : (profile.agents[0] ?? "opencode");
    const options = optionsForTarget(profile, initialTarget);
    const output = streams.output ?? process.stderr;
    super({
      options,
      ...(streams.input ? { input: streams.input } : {}),
      output,
      initialValues: options.filter((o) => states[initialTarget][o.value]).map((o) => o.value),
      render() {
        const value = this.value ?? [];
        const prompt = this as unknown as McpTogglePrompt;
        if (this.state === "cancel") return `${styleText("bold", "MCP toggles")} cancelled`;
        const count = `${value.length}/${this.options.length}`;
        const title = `MCP toggles (${prompt.target}, ${count} enabled)`;
        if (this.state === "submit")
          return `${styleText("bold", title)} ${styleText("green", "✓ saved")}`;
        const help = styleText(
          "dim",
          "Space toggle · a all · Tab target · Enter save · q/Esc quit"
        );
        if (this.options.length === 0) {
          return `${styleText("bold", title)}\n${styleText("dim", "No MCP servers for this target")}\n${help}`;
        }
        const columns = getColumns(prompt.outputStream);
        const lines = limitOptions({
          cursor: this.cursor,
          options: this.options,
          output: prompt.outputStream,
          rowPadding: 2,
          style: (option, active) => {
            const checked = value.includes(option.value) ? "◉" : "○";
            const name = active ? styleText("cyan", option.label) : option.label;
            const prefix = `${active ? "›" : " "} ${checked} ${option.label}`;
            const hint = option.hint
              ? styleText(
                  "dim",
                  ` ${option.hint.slice(0, Math.max(0, columns - prefix.length - 2))}`
                )
              : "";
            return `${active ? "›" : " "} ${checked} ${name}${hint}`;
          }
        });
        return `${styleText("bold", title)}\n${lines.join("\n")}\n${help}`;
      }
    });
    this.target = initialTarget;
    this.states = states;
    this.profile = profile;
    this.outputStream = output;
    this.on("key", (char, key) => this.handleKey(char, key));
  }

  get result(): { saved: boolean; states: Record<AgentName, McpState> } {
    this.captureCurrentState();
    return { saved: this.saved, states: this.states };
  }

  protected _shouldSubmit(_char: string | undefined, key: Key): boolean {
    if (key.name === "return" || key.name === "enter") {
      this.saved = true;
      return true;
    }
    return false;
  }

  private handleKey(char: string | undefined, key: Key): void {
    if (key.name === "tab") this.switchTarget();
    if (char === "q" || key.name === "escape") this.state = "cancel";
  }

  private captureCurrentState(): void {
    const selected = new Set(this.value ?? []);
    this.states[this.target] = Object.fromEntries(
      this.options.map((option) => [option.value, selected.has(option.value)])
    );
  }

  private switchTarget(): void {
    this.captureCurrentState();
    const currentIndex = targets.indexOf(this.target);
    this.target = targets[(currentIndex + 1) % targets.length] ?? "opencode";
    this.options = optionsForTarget(this.profile, this.target);
    this.cursor = 0;
    this.value = this.options.filter((o) => this.states[this.target][o.value]).map((o) => o.value);
  }
}

export async function runMcpTui(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  streams: { input?: Readable; output?: Writable } = {}
): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) throw new Error("mfz mcp tui must be run inside a git repository");
  const store = await readOverrideStore(paths.home);
  const initialStates = Object.fromEntries(
    targets.map((target) => [
      target,
      effectiveProjectState(store, projectRoot, profile, target, "mcp")
    ])
  ) as Record<AgentName, McpState>;
  const prompt = new McpTogglePrompt(profile, initialStates, streams);
  const result = await prompt.prompt();
  if (isCancel(result) || !prompt.result.saved) return;
  const nextStates = prompt.result.states;
  validateMcpTuiStates(profile, nextStates);
  for (const target of targets) {
    await writeProjectOverrideDelta(paths, profile, projectRoot, target, "mcp", nextStates[target]);
  }
}
