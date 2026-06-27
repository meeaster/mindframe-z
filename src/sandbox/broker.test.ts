import { describe, expect, it } from "vitest";
import {
  agentCreateArgs,
  caFetchArgs,
  loginArgs,
  registerArgs,
  vaultCreateArgs,
  type BrokerProvisionParams
} from "./broker.js";

const params: BrokerProvisionParams = {
  address: "http://127.0.0.1:14321",
  ownerEmail: "sandbox-abcd1234@local.invalid",
  ownerPassword: "owner-secret",
  vault: "local-ai-dev-sandbox",
  agentName: "mfz-sandbox-deadbeef",
  caOutputPath: "/home/u/.mindframe-z/secrets/mitm-ca.pem"
};

describe("agent vault provisioning args", () => {
  it("registers the owner non-interactively against the running server", () => {
    expect(registerArgs(params)).toEqual([
      "auth",
      "register",
      "--address",
      "http://127.0.0.1:14321",
      "--email",
      "sandbox-abcd1234@local.invalid",
      "--password-stdin"
    ]);
  });

  it("logs in to guarantee a session on a resumed init", () => {
    expect(loginArgs(params)).toEqual([
      "auth",
      "login",
      "--address",
      "http://127.0.0.1:14321",
      "--email",
      "sandbox-abcd1234@local.invalid",
      "--password-stdin"
    ]);
  });

  it("creates the sandbox vault", () => {
    expect(vaultCreateArgs(params)).toEqual(["vault", "create", "local-ai-dev-sandbox"]);
  });

  it("mints a scoped no-access agent token with a proxy grant", () => {
    expect(agentCreateArgs(params)).toEqual([
      "agent",
      "create",
      "mfz-sandbox-deadbeef",
      "--role",
      "no-access",
      "--vault",
      "local-ai-dev-sandbox:proxy",
      "--token-only"
    ]);
  });

  it("fetches the MITM CA to the machine-local secrets path", () => {
    expect(caFetchArgs(params)).toEqual([
      "ca",
      "fetch",
      "--address",
      "http://127.0.0.1:14321",
      "--output",
      "/home/u/.mindframe-z/secrets/mitm-ca.pem"
    ]);
  });
});
