import { execa } from "execa";

/**
 * Resolve the Git repository root enclosing a directory, or undefined when there
 * is none. This is the canonical "which project am I in" seam behind the CLI's
 * project overrides, the MCP and skill-toggle TUIs, and the context report, so
 * project scope is decided identically wherever it is asked. A nested directory
 * answers with the repository root, not itself. Anything that stops Git from
 * answering — no repository above the directory, a missing `git` binary, an
 * unreadable path — reads as "not in a project" rather than failing the command.
 */
export async function findProjectRoot(cwd = process.cwd()): Promise<string | undefined> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "--show-toplevel"], { cwd });
    const root = stdout.trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
}
