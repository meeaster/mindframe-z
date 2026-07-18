import { stdin as processStdin } from "node:process";
import { Command } from "@commander-js/extra-typings";
import { createRuntimePaths } from "../core/paths.js";
import { resolveProfile } from "../core/profile.js";
import { connectExecutor } from "../executor/connect.js";

interface GlobalOptions {
  root?: string;
  home?: string;
  profile?: string;
}

export function registerExecutorCommands(program: Command): void {
  const executor = program
    .command("executor")
    .description("Inspect and connect the shared native Executor runtime");

  executor
    .command("connect")
    .description("Explicitly connect an Executor integration")
    .argument("<integration>", "Executor integration slug")
    .option("--connection <name>", "named Executor connection")
    .option("--method <method>", "authentication method slug")
    .option("--repair", "reauthorize or replace an existing connection")
    .action(async (integration, options) => {
      const global = program.opts() as GlobalOptions;
      const paths = createRuntimePaths(global);
      const profile = await resolveProfile(paths, global.profile);
      await connectExecutor(paths, profile, integration, {
        ...(options.connection ? { connection: options.connection } : {}),
        ...(options.method ? { method: options.method } : {}),
        ...(options.repair ? { repair: true } : {}),
        interactive: Boolean(processStdin.isTTY)
      });
    });
}
