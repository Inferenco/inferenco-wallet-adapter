import { Account } from "@cedra-labs/ts-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InferAdapterError, InferErrorCode } from "../src/errors";
import { tryLocalBridgeSignMessage } from "../src/bridge";
import {
  _setBridgeTokenForTesting,
  _resetBridgeTokenForTesting
} from "../src/bridge/token";
import { InferClient } from "../src/InferClient";
import { createInferAIP62Wallet } from "../src/aip62";
import { canonicalAddress, messagePreimage } from "../src/integrationContract";
const signer = Account.generate();
const scope = () => ({
  origin: window.location.origin,
  accountAddress: canonicalAddress(signer.accountAddress.toString()),
  network: "testnet",
  chainId: 2
});
const output = (input: any) => {
  const fullMessage = messagePreimage(input, scope());
  return {
    profile: "cedra:message:v1",
    prefix: "CEDRA",
    message: input.message,
    nonce: input.nonce,
    fullMessage,
    signerAddress: scope().accountAddress,
    publicKey: signer.publicKey.toString(),
    ...(input.address ? { address: scope().accountAddress } : {}),
    ...(input.application ? { application: scope().origin } : {}),
    ...(input.chainId ? { chainId: 2 } : {}),
    signature: signer
      .sign("0x" + Buffer.from(fullMessage, "utf8").toString("hex"))
      .toString()
  };
};
function provider(signMessage: any) {
  (window as any).inferenco = {
    isNovaWallet: true,
    integrationContractVersion: 1,
    capabilities: { messageProfile: "cedra:message:v1" },
    account: async () => ({
      address: scope().accountAddress,
      publicKey: signer.publicKey.toUint8Array()
    }),
    network: async () => "testnet",
    signMessage
  };
}
afterEach(() => {
  delete (window as any).inferenco;
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
describe("real Ed25519 message bindings and truthful outcomes", () => {
  for (let flags = 0; flags < 8; flags++)
    it("context combination " + flags, async () => {
      const input = {
        message: "challenge\nUTF8 π",
        nonce: "nonce",
        address: !!(flags & 1),
        application: !!(flags & 2),
        chainId: !!(flags & 4)
      };
      provider(async () => ({ status: "Approved", args: output(input) }));
      expect(await new InferClient().signMessageAndVerify(input)).toBe(true);
    });
  for (const field of [
    "message",
    "nonce",
    "fullMessage",
    "address",
    "application",
    "chainId",
    "signerAddress",
    "publicKey"
  ])
    it("rejects changed " + field, async () => {
      const input = {
        message: "challenge",
        nonce: "nonce",
        address: true,
        application: true,
        chainId: true
      };
      const result = {
        ...output(input),
        [field]:
          field === "chainId"
            ? 3
            : field === "publicKey"
              ? Account.generate().publicKey.toString()
              : "altered"
      };
      provider(async () => ({ status: "Approved", args: result }));
      expect(await new InferClient().signMessageAndVerify(input)).toBe(false);
    });
  it("distinguishes explicit decline from signing/HTTP/text failures", async () => {
    provider(async () => ({ status: "Rejected" }));
    expect(
      await createInferAIP62Wallet().features["cedra:signMessage"]!.signMessage(
        { message: "challenge", nonce: "nonce" }
      )
    ).toEqual({ status: "Rejected" });
    for (const error of [
      new Error("rejected upstream"),
      { status: 401 },
      new Error("signing unavailable"),
      new InferAdapterError(InferErrorCode.UserRejected, "provider throw")
    ]) {
      provider(async () => {
        throw error;
      });
      await expect(
        createInferAIP62Wallet().features["cedra:signMessage"]!.signMessage({
          message: "challenge",
          nonce: "nonce"
        })
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    }
  });
  it("rejects malformed Approved rather than inventing nonce/signature", async () => {
    provider(async () => ({
      status: "Approved",
      args: { message: "challenge" }
    }));
    await expect(
      new InferClient().signMessage({ message: "challenge", nonce: "nonce" })
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
  for (let flags = 0; flags < 8; flags++)
    for (const versioned of [false, true])
    it("external Desktop complete context combination " + flags + " versioned=" + versioned, async () => {
      const input = {
        message: "challenge π",
        nonce: "nonce",
        address: !!(flags & 1),
        application: !!(flags & 2),
        chainId: !!(flags & 4),
        profile: "cedra:message:v1"
      };
      const token = "0123456789abcdef".repeat(4);
      _setBridgeTokenForTesting(token);
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async (url, init) =>
          new Response(
            JSON.stringify(
              init?.method === "POST"
                ? { requestId: "message-1" }
                : {
                    status: "approved",
                    requestId: "message-1",
                    ...(versioned ? { integrationContractVersion: 1, capabilities: { messageProfile: "cedra:message:v1", completeResults: true } } : {}),
                    ...output(input)
                  }
            ),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      );
      const result = await tryLocalBridgeSignMessage(input, {
        transport: "desktop-bridge",
        address: scope().accountAddress,
        publicKey: signer.publicKey.toString(),
        network: "testnet",
        chainId: 2,
        sessionId: "fixture-session",
        bridgeUrl: "http://127.0.0.1:21984/" + token,
        integrationContractVersion: 1,
        capabilities: {
          messageProfile: "cedra:message:v1",
          completeResults: true,
          durableInvocationLookup: true
        }
      });
      expect(result.fullMessage).toBe(output(input).fullMessage);
      _resetBridgeTokenForTesting();
    });
});

it.each([["profile"], ["publicKey"], ["profile", "publicKey"]])("rejects a signed v1 response missing %j", async (...missing) => {
  const input = { message: "challenge", nonce: "nonce" };
  const result: Record<string, unknown> = output(input);
  for (const field of missing) delete result[field];
  provider(async () => ({ status: "Approved", args: result }));
  const client = new InferClient();
  try {
    await expect(client.signMessage(input)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  } finally { client.dispose(); }
});
