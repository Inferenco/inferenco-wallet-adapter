import {
  Account,
  ChainId,
  EntryFunction,
  RawTransaction,
  SimpleTransaction,
  TransactionPayloadEntryFunction,
  parseTypeTag
} from "@cedra-labs/ts-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InferClient } from "../src/InferClient";
import { createInferAIP62Wallet } from "../src/aip62";
import {
  listDurableInvocations,
  pruneDurableEvidence
} from "../src/durableRecovery";
import {
  canonicalAddress,
  messagePreimage,
  normalizeSubmitInput
} from "../src/integrationContract";
import {
  acknowledgeRecoverableRequest,
  archiveRecoverableRequest,
  listArchivedRecoverableRequests,
  listRecoverableRequests,
  readRecoverableRequest,
  reconcileRecoverableInvocation
} from "../src/recovery";

const signer = Account.generate();
const hash = "0x" + "ab".repeat(32);
const scope = () => ({
  origin: window.location.origin,
  accountAddress: canonicalAddress(signer.accountAddress.toString()),
  network: "testnet",
  chainId: 2
});
const wire = () =>
  normalizeSubmitInput({
    data: {
      function: "0x1::fixture::run",
      typeArguments: [],
      functionArguments: []
    },
    options: { expireTimestamp: Math.floor(Date.now() / 1000) + 300 }
  });
function install(extra: Record<string, unknown>) {
  const provider = {
    isInferWallet: true,
    integrationContractVersion: 1,
    capabilities: {
      transactionRestrictions: true,
      messageProfile: "cedra:message:v1",
      completeResults: true,
      durableInvocationLookup: true
    },
    account: async () => ({
      address: signer.accountAddress.toString(),
      publicKey: signer.publicKey.toUint8Array()
    }),
    network: async () => ({ name: "testnet", chainId: 2 }),
    ...extra
  };
  (window as any).inferenco = provider;
  return provider;
}
function nativeResult(metadata: any, method: string, payload: unknown) {
  return { ...metadata, method, status: "approved", payload };
}
function messageResult(input: any) {
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
      .sign("0x" + Buffer.from(fullMessage).toString("hex"))
      .toString()
  };
}
afterEach(() => {
  delete (window as any).inferenco;
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("read-only native invocation recovery", () => {
  it("recovers a dropped submit through the public feature, then replays and acknowledges without redispatch", async () => {
    let metadata: any;
    const submit = vi.fn(async (_: unknown, meta: unknown) => {
      metadata = meta;
      throw new Error("native reply dropped");
    });
    const read = vi.fn(async () =>
      nativeResult(metadata, "signAndSubmitTransaction", { hash })
    );
    install({ signAndSubmitTransaction: submit, readInvocation: read });
    const feature =
      createInferAIP62Wallet().features["inferenco:transactionSubmission"];
    await expect(
      feature.signAndSubmitTransaction(wire())
    ).rejects.toMatchObject({ code: "REQUEST_OUTCOME_UNKNOWN" });
    window.sessionStorage.clear();
    const recovered = await reconcileRecoverableInvocation(
      metadata.invocationId
    );
    expect(recovered).toMatchObject({
      status: "approved",
      output: { hash },
      origin: scope().origin,
      requestCommitment: metadata.requestCommitment
    });
    const [entry] = await listRecoverableRequests();
    expect(
      await new InferClient().readRecoverableRequest(entry!.recoveryId)
    ).toMatchObject({ status: "approved", output: { hash } });
    expect(read).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    await acknowledgeRecoverableRequest(entry!.recoveryId);
    expect(await listRecoverableRequests()).toHaveLength(0);
    await pruneDurableEvidence(Date.now() + 31 * 86400000);
    expect(await listDurableInvocations()).toHaveLength(0);
  });
  it("binds renewed native reads to exact identity, commitment and current approved scope", async () => {
    let metadata: any;
    const submit = vi.fn(async (_: unknown, meta: unknown) => {
      metadata = meta;
      throw new Error("lost reply");
    });
    let result: any;
    const read = vi.fn(async () => result);
    const provider = install({
      signAndSubmitTransaction: submit,
      readInvocation: read
    });
    await expect(
      new InferClient().signAndSubmitTransactionWithRestrictions(wire())
    ).rejects.toMatchObject({ code: "REQUEST_OUTCOME_UNKNOWN" });
    for (const patch of [
      { invocationId: "other" },
      { requestCommitment: "0".repeat(64) },
      { scope: { ...scope(), origin: "https://other.example" } },
      { method: "signMessage" }
    ]) {
      result = {
        ...nativeResult(metadata, "signAndSubmitTransaction", { hash }),
        ...patch
      };
      expect(
        await reconcileRecoverableInvocation(metadata.invocationId)
      ).toMatchObject({ status: "unknown" });
    }
    (provider as any).network = async () => ({ name: "testnet", chainId: 3 });
    result = nativeResult(metadata, "signAndSubmitTransaction", { hash });
    const before = read.mock.calls.length;
    expect(
      await reconcileRecoverableInvocation(metadata.invocationId)
    ).toMatchObject({
      status: "unknown",
      reason: "current_provider_scope_mismatch"
    });
    expect(read).toHaveBeenCalledTimes(before);
    expect(submit).toHaveBeenCalledOnce();
  });
  it("cryptographically checks original message input and signer before persisting a recovered native result", async () => {
    const input = {
      message: "challenge π",
      nonce: "nonce",
      address: true,
      application: true,
      chainId: true
    };
    let metadata: any;
    const output = messageResult(input);
    const sign = vi.fn(async (_: unknown, meta: unknown) => {
      metadata = meta;
      throw new Error("lost message reply");
    });
    let payload: any = { ...output, nonce: "substituted" };
    const read = vi.fn(async () =>
      nativeResult(metadata, "signMessage", payload)
    );
    install({ signMessage: sign, readInvocation: read });
    await expect(new InferClient().signMessage(input)).rejects.toMatchObject({
      code: "INTERNAL_ERROR"
    });
    expect(
      await reconcileRecoverableInvocation(metadata.invocationId)
    ).toMatchObject({ status: "unknown" });
    payload = output;
    expect(
      await reconcileRecoverableInvocation(metadata.invocationId)
    ).toMatchObject({
      status: "approved",
      output: { nonce: "nonce", fullMessage: output.fullMessage }
    });
    expect(
      (await readRecoverableRequest("invocation:" + metadata.invocationId))
        .status
    ).toBe("approved");
    expect(read).toHaveBeenCalledTimes(2);
    expect(sign).toHaveBeenCalledOnce();
  });
  it("requires the exact original signed BCS after a lost sign-only reply", async () => {
    const raw = new RawTransaction(
      signer.accountAddress,
      123n,
      new TransactionPayloadEntryFunction(
        EntryFunction.build("0x1::account", "transfer", [], [])
      ),
      25000n,
      7n,
      1900000123n,
      new ChainId(2),
      parseTypeTag("0x1::cedra_coin::CedraCoin")
    );
    const transaction = new SimpleTransaction(raw);
    const approved = {
      authenticatorHex: signer
        .signTransactionWithAuthenticator(transaction)
        .toString(),
      rawTransactionBcsHex: transaction.toString()
    };
    let metadata: any;
    const sign = vi.fn(async (_: unknown, meta: unknown) => {
      metadata = meta;
      throw new Error("lost signing reply");
    });
    let payload = {
      ...approved,
      rawTransactionBcsHex: approved.rawTransactionBcsHex + "00"
    };
    const read = vi.fn(async () =>
      nativeResult(metadata, "signTransaction", payload)
    );
    install({ signTransaction: sign, readInvocation: read });
    await expect(
      new InferClient().signTransaction(transaction)
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(
      await reconcileRecoverableInvocation(metadata.invocationId)
    ).toMatchObject({ status: "unknown" });
    payload = approved;
    const recovered = await reconcileRecoverableInvocation(
      metadata.invocationId
    );
    expect(recovered).toMatchObject({
      status: "approved",
      output: { rawTransactionBcsHex: approved.rawTransactionBcsHex }
    });
    expect(sign).toHaveBeenCalledOnce();
  });
  it.each(["signMessage", "signAndSubmitTransaction"])(
    "retains explicit %s decline without inventing an approval",
    async (method) => {
      install({ [method]: vi.fn(async () => ({ status: "Rejected" })) });
      const client = new InferClient();
      await expect(
        method === "signMessage"
          ? client.signMessage({ message: "challenge", nonce: "nonce" })
          : client.signAndSubmitTransactionWithRestrictions(wire())
      ).rejects.toMatchObject({ code: "USER_REJECTED" });
      const [entry] = await listRecoverableRequests();
      expect(await readRecoverableRequest(entry!.recoveryId)).toMatchObject({
        status: "rejected"
      });
    }
  );
  it("deduplicates concurrent original reads and retains archived uncertainty", async () => {
    let metadata: any;
    let finish: (value: unknown) => void = () => {};
    const submit = vi.fn(async (_: unknown, meta: unknown) => {
      metadata = meta;
      throw new Error("lost reply");
    });
    const read = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    install({ signAndSubmitTransaction: submit, readInvocation: read });
    await expect(
      new InferClient().signAndSubmitTransactionWithRestrictions(wire())
    ).rejects.toMatchObject({ code: "REQUEST_OUTCOME_UNKNOWN" });
    const first = reconcileRecoverableInvocation(metadata.invocationId),
      second = reconcileRecoverableInvocation(metadata.invocationId);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    finish({
      ...metadata,
      method: "signAndSubmitTransaction",
      status: "unknown"
    });
    expect((await first).status).toBe("unknown");
    expect((await second).status).toBe("unknown");
    await expect(
      acknowledgeRecoverableRequest("invocation:" + metadata.invocationId)
    ).rejects.toThrow();
    await archiveRecoverableRequest(
      "invocation:" + metadata.invocationId,
      "local-reconciliation:fixture"
    );
    expect(await listRecoverableRequests()).toHaveLength(0);
    expect(await listArchivedRecoverableRequests()).toHaveLength(1);
    expect(submit).toHaveBeenCalledOnce();
  });
});
