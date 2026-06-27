import { execa } from "execa";
import { ownerCliEnv } from "./config.js";

/**
 * Inputs for provisioning Agent Vault during `mfz sandbox init`. The owner
 * account creates the vault and mints the scoped agent token; the agent name is
 * generated per run so a resumed init never collides with a previously created
 * agent (the token is only returned once, at creation).
 */
export interface BrokerProvisionParams {
  readonly address: string;
  readonly ownerEmail: string;
  readonly ownerPassword: string;
  readonly vault: string;
  readonly agentName: string;
  readonly caOutputPath: string;
}

export function registerArgs(params: BrokerProvisionParams): string[] {
  return [
    "auth",
    "register",
    "--address",
    params.address,
    "--email",
    params.ownerEmail,
    "--password-stdin"
  ];
}

export function loginArgs(params: BrokerProvisionParams): string[] {
  return [
    "auth",
    "login",
    "--address",
    params.address,
    "--email",
    params.ownerEmail,
    "--password-stdin"
  ];
}

export function vaultCreateArgs(params: BrokerProvisionParams): string[] {
  return ["vault", "create", params.vault];
}

export function agentCreateArgs(params: BrokerProvisionParams): string[] {
  return [
    "agent",
    "create",
    params.agentName,
    "--role",
    "no-access",
    "--vault",
    `${params.vault}:proxy`,
    "--token-only"
  ];
}

export function caFetchArgs(params: BrokerProvisionParams): string[] {
  return ["ca", "fetch", "--address", params.address, "--output", params.caOutputPath];
}

const agentVaultBin = "agent-vault";

function isUnreachableError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.message}\n${(error as { stderr?: string }).stderr ?? ""}`
      : "";
  return /could not reach server|ECONNREFUSED|connection refused/i.test(message);
}

/**
 * Drive the Agent Vault CLI to stand up broker state for the sandbox: register
 * the first (owner) account, create the sandbox vault, mint a scoped no-access
 * agent token, and fetch the MITM CA. Returns the raw agent token.
 *
 * `register` for the first user auto-activates the owner and saves a session
 * keyed to HOME; a subsequent `login` guarantees a valid session even on a
 * resumed init where the owner already exists (register is then a no-op).
 * The first `register` doubles as the readiness gate: the server may still be
 * starting after `compose up -d`, so connection failures are retried.
 */
export async function provisionBroker(
  params: BrokerProvisionParams,
  options: {
    readonly home: string;
    readonly attempts?: number;
    readonly intervalMs?: number;
  }
): Promise<string> {
  const env = ownerCliEnv(options.home);
  const password = `${params.ownerPassword}\n`;
  const attempts = options.attempts ?? 60;
  const intervalMs = options.intervalMs ?? 1000;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await execa(agentVaultBin, registerArgs(params), { env, input: password });
      break;
    } catch (error) {
      if (attempt >= attempts || !isUnreachableError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  await execa(agentVaultBin, loginArgs(params), { env, input: password });

  // Idempotent: a resumed init finds the vault already present. A genuinely
  // missing vault surfaces loudly at agent creation below.
  try {
    await execa(agentVaultBin, vaultCreateArgs(params), { env });
  } catch {
    // vault already exists
  }

  const { stdout } = await execa(agentVaultBin, agentCreateArgs(params), { env });
  const token = stdout.trim();
  if (!token) {
    throw new Error("Agent Vault returned an empty agent token");
  }

  await execa(agentVaultBin, caFetchArgs(params), { env });
  return token;
}
