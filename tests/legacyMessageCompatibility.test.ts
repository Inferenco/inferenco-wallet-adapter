import { Account } from "@cedra-labs/ts-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InferClient } from "../src/InferClient";
import { verifySignedMessageOutput } from "../src/conversion";
import { canonicalAddress } from "../src/integrationContract";
import {
  listRecoverableRequests,
  readRecoverableRequest
} from "../src/recovery";

const signer = Account.generate();
const address = signer.accountAddress.toString();
const scope = () => ({
  origin: window.location.origin,
  accountAddress: canonicalAddress(address),
  network: "testnet",
  chainId: 2
});
const input = {
  message: JSON.stringify({
    challenge: "creator",
    nonce: "issued-nonce",
    origin: "https://fixture.example"
  }),
  nonce: "issued-nonce",
  address: false,
  application: false,
  chainId: false
};
const sign = (fullMessage: string) =>
  signer
    .sign("0x" + Buffer.from(fullMessage, "utf8").toString("hex"))
    .toString();
const desk = () => ({
  address,
  publicKey: signer.publicKey.toString(),
  signature: sign(input.message),
  fullMessage: input.message,
  message: input.message
});
const mobile = () => {
  const fullMessage = [
    "CEDRA",
    "",
    address,
    input.nonce,
    "",
    input.message
  ].join("\n");
  return {
    address,
    publicKey: signer.publicKey.toString(),
    signature: sign(fullMessage),
    fullMessage,
    message: input.message,
    nonce: input.nonce,
    prefix: "CEDRA",
    application: "Infer Wallet",
    chainId: 2
  };
};
afterEach(() => {
  delete (window as any).inferenco;
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
describe("verified baseline legacy message compatibility", () => {
  it.each([
    ["Desk raw", desk, "raw"],
    ["Wallet positional", mobile, "cedra:legacy:v0"]
  ] as const)(
    "accepts exact %s bytes through the class and durable replay",
    async (_, producer, profile) => {
      (window as any).inferenco = {
        isInferWallet: true,
        account: async () => ({
          address,
          publicKey: signer.publicKey.toUint8Array()
        }),
        network: async () => "testnet",
        signMessage: async () => producer()
      };
      const result = await new InferClient().signMessage(input);
      expect(result).toMatchObject({
        nonce: input.nonce,
        message: input.message,
        profile
      });
      expect((result as any).application).toBeUndefined();
      expect(result.chainId).toBeUndefined();
      const [entry] = await listRecoverableRequests();
      expect(await readRecoverableRequest(entry!.recoveryId)).toMatchObject({
        status: "approved",
        output: { profile, fullMessage: result.fullMessage }
      });
    }
  );
  it.each([desk, mobile])(
    "rejects changed challenge, signer and required-context downgrade",
    (producer) => {
      for (const changed of [
        { ...input, message: input.message + " " },
        { ...input, nonce: "other" },
        { ...input, application: true },
        { ...input, address: true },
        { ...input, chainId: true }
      ]) {
        expect(() =>
          verifySignedMessageOutput(
            producer(),
            changed,
            scope(),
            signer.publicKey.toString(),
            true
          )
        ).toThrow();
      }
      expect(() =>
        verifySignedMessageOutput(
          {
            ...producer(),
            address: Account.generate().accountAddress.toString()
          },
          input,
          scope(),
          signer.publicKey.toString(),
          true
        )
      ).toThrow();
      expect(() =>
        verifySignedMessageOutput(
          producer(),
          { ...input, profile: "cedra:message:v1" } as never,
          scope(),
          signer.publicKey.toString(),
          true
        )
      ).toThrow();
    }
  );
  it("does not accept incomplete unqualified envelopes or infer the unsupported embedded APTOS profile", () => {
    const old = desk();
    expect(() =>
      verifySignedMessageOutput(
        old,
        input,
        scope(),
        signer.publicKey.toString()
      )
    ).toThrow();
    const fullMessage =
      "APTOS\\nmessage: " + input.message + "\\nnonce: " + input.nonce;
    expect(() =>
      verifySignedMessageOutput(
        { ...old, fullMessage, signature: sign(fullMessage) },
        input,
        scope(),
        signer.publicKey.toString(),
        true
      )
    ).toThrow();
    expect(() =>
      verifySignedMessageOutput(
        { ...old, signature: Account.generate().sign("0x1234").toString() },
        input,
        scope(),
        signer.publicKey.toString(),
        true
      )
    ).toThrow();
  });
  it("rejects an explicitly raw response from a v1 provider", async () => {
    const old = desk();
    (window as any).inferenco = {
      isInferWallet: true,
      integrationContractVersion: 1,
      capabilities: { messageProfile: "cedra:message:v1" },
      account: async () => ({
        address,
        publicKey: signer.publicKey.toUint8Array()
      }),
      network: async () => "testnet",
      signMessage: async () => ({
        ...old,
        profile: "raw",
        prefix: "CEDRA",
        nonce: input.nonce,
        signerAddress: scope().accountAddress
      })
    };
    await expect(new InferClient().signMessage(input)).rejects.toMatchObject({
      code: "INTERNAL_ERROR"
    });
  });
});
