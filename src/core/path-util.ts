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

// The machine config every entry point reads: the path-resolution bootstrap in
// paths.ts, the manifest loader and validator in manifests.ts, and the doctor's
// legacy-references hint. They must agree on one location, or `mfz apply` would
// resolve its root from a different file than the one it validates.
export function machineConfigPath(home: string): string {
  return path.join(mindframeZDir(home), "config.yml");
}

// Bootstrap location used by `mfz init --clone`, keyed by the alias declared in
// `mfz_home.yml#extends`. Extension resolution uses the versioned `extends.path`
// instead; this helper remains for the separate init bootstrap behavior.
export function upstreamHomeRoot(machineHome: string, alias: string): string {
  return path.join(mindframeZDir(machineHome), "homes", alias);
}
