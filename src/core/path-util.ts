import path from "node:path";

export function expandHome(value: string, home = process.env.HOME ?? ""): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

// Canonical location of the per-home `.mindframe-z` state directory, and the base
// every store path built through paths.ts hangs off (the store-path contract in
// paths.test.ts pins the resulting layout). It lives here rather than in paths.ts
// so modules that paths.ts itself depends on can share the layout without an
// import cycle; paths.ts re-exports it.
export function mindframeZDir(home: string): string {
  return path.join(home, ".mindframe-z");
}

// Where an upstream home clone lives on this machine, keyed by the alias declared
// in `mfz_home.yml#extends`. `mfz init --clone`, the apply-time clone/fast-forward,
// and skill vendoring must all agree on this directory or a home gets cloned to one
// place and read from another.
export function upstreamHomeRoot(machineHome: string, alias: string): string {
  return path.join(mindframeZDir(machineHome), "homes", alias);
}
