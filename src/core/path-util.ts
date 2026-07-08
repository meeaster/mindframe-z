import path from "node:path";

export function expandHome(value: string, home = process.env.HOME ?? ""): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}
