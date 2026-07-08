import path from "node:path";
import type { RuntimePaths } from "../core/paths.js";
import { profileConfigsDir } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import type { RenderResult } from "../core/render.js";
import { hasManagedZsh, zshLocalFile, zshSecretsFile } from "../core/zsh.js";

function renderHarnessLaunchers(paths: RuntimePaths): string[] {
  const store = JSON.stringify(path.join(paths.home, ".mindframe-z", "overrides.json"));
  return [
    "_mfz_project_root() {",
    "  git rev-parse --show-toplevel 2>/dev/null || pwd",
    "}",
    "",
    "codex() {",
    `  local store=${store}`,
    "  local project=$(_mfz_project_root)",
    '  if command -v jq >/dev/null 2>&1 && [[ -r "$store" ]]; then',
    "    local -a mfz_argv",
    '    mfz_argv=( ${(f)$(jq -r --arg project "$project" \'.projects[$project].codex.payload.argv[]? // empty\' "$store" 2>/dev/null)} )',
    "    if (( ${#mfz_argv[@]} > 0 )); then",
    '      command codex "${mfz_argv[@]}" "$@"',
    "      return",
    "    fi",
    "  fi",
    '  command codex "$@"',
    "}",
    "",
    "opencode() {",
    `  local store=${store}`,
    "  local project=$(_mfz_project_root)",
    '  if command -v jq >/dev/null 2>&1 && [[ -r "$store" ]]; then',
    "    local config",
    '    config=$(jq -c --arg project "$project" \'.projects[$project].opencode.payload.config // empty\' "$store" 2>/dev/null)',
    '    if [[ -n "$config" ]]; then',
    '      OPENCODE_CONFIG_CONTENT="$config" command opencode "$@"',
    "      return",
    "    fi",
    "  fi",
    '  command opencode "$@"',
    "}",
    "",
    "claude() {",
    `  local store=${store}`,
    "  local project=$(_mfz_project_root)",
    '  if command -v jq >/dev/null 2>&1 && [[ -r "$store" ]]; then',
    "    local settings",
    '    settings=$(jq -c --arg project "$project" \'.projects[$project]["claude-code"].payload.settings // empty\' "$store" 2>/dev/null)',
    '    if [[ -n "$settings" ]]; then',
    '      command claude --settings "$settings" "$@"',
    "      return",
    "    fi",
    "  fi",
    '  command claude "$@"',
    "}"
  ];
}

function renderZshrc(paths: RuntimePaths, content: string): string {
  const engineBin = path.join(paths.home, ".mindframe-z", "bin");
  return [
    "# Managed by mindframe-z. Edit the profile-owned .zshrc source, then run mfz apply.",
    `if [[ ":$PATH:" != *":${engineBin}:"* ]]; then`,
    `  export PATH=${JSON.stringify(engineBin)}":$PATH"`,
    "fi",
    "",
    `if [ -r ${JSON.stringify(zshSecretsFile(paths))} ]; then`,
    `  source ${JSON.stringify(zshSecretsFile(paths))}`,
    "fi",
    "",
    content.trimEnd(),
    "",
    "alias mfzcc='mfz cc'",
    "alias mfzoc='mfz oc'",
    "",
    ...renderHarnessLaunchers(paths),
    "",
    `if [ -r ${JSON.stringify(zshLocalFile(paths))} ]; then`,
    `  source ${JSON.stringify(zshLocalFile(paths))}`,
    "fi",
    ""
  ].join("\n");
}

export async function renderDotfiles(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<RenderResult> {
  const configsProfile = profileConfigsDir(paths, profile.name);
  const configsDotfiles = path.join(configsProfile, "dotfiles");

  const files = Object.entries(profile.profile.dotfiles).map(([filename, content]) => ({
    path: path.join(configsDotfiles, filename),
    content: filename === ".zshrc" ? renderZshrc(paths, content) : content
  }));

  const links = Object.keys(profile.profile.dotfiles).map((filename) => ({
    linkPath: path.join(paths.home, filename),
    targetPath: path.join(configsDotfiles, filename)
  }));

  return {
    files,
    ...(hasManagedZsh(profile)
      ? { localFiles: [{ path: zshSecretsFile(paths), content: "", ifMissing: true }] }
      : {}),
    links
  };
}
