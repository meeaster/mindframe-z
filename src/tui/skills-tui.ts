import { styleText } from "node:util";
import { getColumns, MultiSelectPrompt, isCancel } from "@clack/core";
import { limitOptions } from "@clack/prompts";
import type { Key } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile, ResolvedSkill } from "../core/profile.js";
import {
  resolveSkillConfigPaths,
  resolveSkillToggleStateForConfigPaths,
  writeChangedSkillOverridesForTargets,
  type SkillToggleState,
  type SkillToggleTarget
} from "./config-io.js";

interface SkillOption {
  value: string;
  label: string;
  hint: string;
}

interface SkillsPromptResult {
  saved: boolean;
  states: Record<SkillToggleTarget, SkillToggleState>;
}

const targets: SkillToggleTarget[] = ["opencode", "claude-code", "codex"];

function truncateText(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, Math.max(0, maxLen - 1)) + "…";
}

function skillsForTarget(profile: ResolvedProfile, target: SkillToggleTarget): ResolvedSkill[] {
  return profile.enabledSkills.filter((skill) => skill.targets.includes(target));
}

function optionsForTarget(profile: ResolvedProfile, target: SkillToggleTarget): SkillOption[] {
  return skillsForTarget(profile, target)
    .filter((skill) => skill.toggleable)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => ({
      value: skill.name,
      label: skill.name,
      hint: skill.description
    }));
}

class SkillsTogglePrompt extends MultiSelectPrompt<SkillOption> {
  saved = false;
  private target: SkillToggleTarget;
  private readonly states: Record<SkillToggleTarget, SkillToggleState>;
  private readonly profile: ResolvedProfile;
  private readonly outputStream: Writable;

  constructor(
    profile: ResolvedProfile,
    states: Record<SkillToggleTarget, SkillToggleState>,
    streams: { input?: Readable; output?: Writable } = {}
  ) {
    const initialTarget = profile.agents.includes("opencode")
      ? "opencode"
      : (profile.agents.find((agent): agent is SkillToggleTarget =>
          targets.includes(agent as SkillToggleTarget)
        ) ?? "opencode");
    const options = optionsForTarget(profile, initialTarget);
    const resolvedOutput = streams.output ?? process.stderr;
    super({
      options,
      ...(streams.input ? { input: streams.input } : {}),
      output: resolvedOutput,
      initialValues: options.filter((o) => states[initialTarget][o.value]).map((o) => o.value),
      render() {
        const value = this.value ?? [];
        const prompt = this as unknown as SkillsTogglePrompt;

        if (this.state === "cancel") {
          return `${styleText("bold", "Skill toggles")} cancelled`;
        }

        if (this.state === "submit") {
          const count = `${value.length}/${this.options.length}`;
          const title = `Skill toggles (${prompt.target}, ${count} enabled)`;
          const saved = styleText("green", "✓ saved");
          return `${styleText("bold", title)} ${saved}`;
        }

        const count = `${value.length}/${this.options.length}`;
        const title = `Skill toggles (${prompt.target}, ${count} enabled)`;
        const help = styleText(
          "dim",
          "Space toggle · a all · Tab target · Enter save · q/Esc quit"
        );

        if (this.options.length === 0) {
          return `${styleText("bold", title)}\n${styleText("dim", "No skills for this target")}\n${help}`;
        }

        const columns = getColumns(prompt.outputStream);
        const style = (option: SkillOption, active: boolean) => {
          const checked = value.includes(option.value) ? "◉" : "○";
          const prefix = `${active ? "›" : " "} ${checked} ${option.label}`;
          const available = columns - prefix.length - 1;
          const hintText = option.hint
            ? ` ${truncateText(option.hint, Math.max(0, available))}`
            : "";
          const name = active ? styleText("cyan", option.label) : option.label;
          const hint = hintText ? styleText("dim", hintText) : "";
          return `${active ? "›" : " "} ${checked} ${name}${hint}`;
        };

        const lines = limitOptions({
          cursor: this.cursor,
          options: this.options,
          style,
          output: prompt.outputStream,
          rowPadding: 2
        });

        return `${styleText("bold", title)}\n${lines.join("\n")}\n${help}`;
      }
    });
    this.outputStream = resolvedOutput;
    this.profile = profile;
    this.states = states;
    this.target = initialTarget;

    this.on("key", (char, key) => this.handleKey(char, key));
  }

  get result(): SkillsPromptResult {
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

export async function runSkillsTui(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  streams: { input?: Readable; output?: Writable } = {}
): Promise<void> {
  const configPaths = await resolveSkillConfigPaths(paths);
  const [opencodeState, claudeCodeState, codexState] = await Promise.all([
    resolveSkillToggleStateForConfigPaths(configPaths, profile, "opencode"),
    resolveSkillToggleStateForConfigPaths(configPaths, profile, "claude-code"),
    resolveSkillToggleStateForConfigPaths(configPaths, profile, "codex")
  ]);
  const states: Record<SkillToggleTarget, SkillToggleState> = {
    opencode: opencodeState,
    "claude-code": claudeCodeState,
    codex: codexState
  };
  const prompt = new SkillsTogglePrompt(profile, states, streams);
  const result = await prompt.prompt();
  if (isCancel(result) || !prompt.result.saved) return;

  await writeChangedSkillOverridesForTargets(paths, configPaths, profile, prompt.result.states);
}
