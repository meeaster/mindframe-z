// Standalone-binary entry: `bun build --compile` targets this file so bun bundles
// embedded-assets (and its `type: "file"` docker-context assets) into the binary.
// It is excluded from the tsc program because tsc/node cannot parse those imports;
// it wires the embedded-asset resolver into build.ts, then hands off to the CLI.
import { isCompiledBinary, materializeEmbeddedPackageRoot } from "../thread/embedded-assets.js";
import { setEmbeddedPackageRootResolver } from "../thread/build.js";

if (isCompiledBinary()) setEmbeddedPackageRootResolver(materializeEmbeddedPackageRoot);

await import("./mfz.js");
