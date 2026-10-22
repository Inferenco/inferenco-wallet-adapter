import {
  Account, ChainId, Ed25519Signature, EntryFunction, RawTransaction,
  SimpleTransaction, TransactionPayloadEntryFunction, parseTypeTag
} from "@cedra-labs/ts-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InferClient } from "../src/InferClient";
import { createInferAIP62Wallet } from "../src/aip62";
import { storeExternalSession } from "../src/bridge";
import { _resetBridgeTokenForTesting, _setBridgeTokenForTesting } from "../src/bridge/token";
import {
  listDurableInvocations, listDurableRequests, prepareDurableInvocation,
  saveDurableFinal, saveDurableRequest, updateInjectedInvocationEvidence
} from "../src/durableRecovery";
import {
  canonicalAddress, messagePreimage, normalizeSubmitInput, requestCommitment
} from "../src/integrationContract";
import {
  acknowledgeRecoverableRequest, listRecoverableRequests,
  readRecoverableRequest, reconcileRecoverableInvocation,
  type RecoverableInvocation
} from "../src/recovery";
import type { PendingDesktopBridgeRequest, RecoverableMethod } from "../src/desktopRequests";
import type { InferExternalSession, InferProvider } from "../src/types";
const signer = Account.generate();
const hash = "0x" + "ab".repeat(32);
const otherHash = "0x" + "cd".repeat(32);
const token = "0123456789abcdef".repeat(4);
const endpoint = "http://127.0.0.1:21984";
const scope = () => ({
  origin: window.location.origin,
  accountAddress: canonicalAddress(signer.accountAddress.toString()),
  network: "testnet", chainId: 2
});
const wire = () => normalizeSubmitInput({
  data: { function: "0x1::fixture::run", typeArguments: [], functionArguments: [] },
  options: { expireTimestamp: Math.floor(Date.now() / 1000) + 300 }
});
const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { "Content-Type": "application/json" }
});
function desktop(sessionId: string): InferExternalSession {
  return {
    transport: "desktop-bridge", sessionId, address: scope().accountAddress,
    publicKey: signer.publicKey.toString(), network: "testnet", chainId: 2,
    bridgeUrl: endpoint + "/" + token, integrationContractVersion: 1,
    capabilities: { completeResults: true, durableInvocationLookup: true, transactionRestrictions: true }
  };
}
async function seedDesktop(method: RecoverableMethod = "signAndSubmitTransaction", payload: unknown = wire(), sessionId = "renewed", legacy = false) {
  const original = desktop("original");
  const current = desktop(sessionId);
  if (legacy) {
    delete original.integrationContractVersion; delete original.capabilities;
    delete current.integrationContractVersion; delete current.capabilities;
  }
  storeExternalSession(current);
  _setBridgeTokenForTesting(token);
  const commitment = requestCommitment(method, scope(), payload);
  const invocation = await prepareDurableInvocation(original, method, {
    requestCommitment: commitment, requestPayload: payload, endpoint,
    ...(method === "signMessage" ? { signerPublicKey: signer.publicKey.toString() } : {})
  });
  const pending: PendingDesktopBridgeRequest = {
    version: 2, transport: "desktop-bridge", requestId: "request-" + invocation.id,
    invocationId: invocation.id, requestCommitment: commitment, requestPayload: payload,
    origin: scope().origin, sessionId: original.sessionId, address: original.address,
    network: original.network, chainId: original.chainId, bridgeOrigin: endpoint, method,
    ...(method === "signMessage" ? {
      expectedMessageInput: payload as any, signerPublicKey: signer.publicKey.toString()
    } : {}),
    ...(method === "signTransaction" ? { expectedTransactionBcsHex: (payload as any).rawTransactionBcsHex } : {})
  };
  const row = await saveDurableRequest(pending, invocation.id);
  const envelope = (status: string, result?: unknown) => ({
    contractVersion: 1, invocationId: invocation.id, requestId: row.requestId,
    requestCommitment: commitment, originalSessionId: original.sessionId,
    sessionId: current.sessionId, method,
    scope: { ...scope(), transport: "desktop-bridge", method }, status,
    ...(status === "approved" || status === "rejected" ? {
      finalizedAt: new Date().toISOString(), ...(result === undefined ? {} : { payload: result })
    } : {})
  });
  return { row, current, invocation, envelope };
}
async function seedNative(remoteAcknowledgementRequired?: boolean) {
  const payload = wire();
  const commitment = requestCommitment("signAndSubmitTransaction", scope(), payload);
  const row = await prepareDurableInvocation({
    transport: "injected", sessionId: "native-original", address: scope().accountAddress,
    network: "testnet", chainId: 2
  }, "signAndSubmitTransaction", { requestCommitment: commitment, requestPayload: payload, endpoint: scope().origin, remoteAcknowledgementRequired });
  let response: unknown;
  const read = vi.fn(async () => response);
  const submit = vi.fn(async () => { throw new Error("Recovery must not sign or submit"); });
  const provider: InferProvider = {
    isInferWallet: true, integrationContractVersion: 1,
    capabilities: { durableInvocationLookup: true, completeResults: true, transactionRestrictions: true },
    account: async () => ({ address: scope().accountAddress, publicKey: signer.publicKey.toUint8Array() }),
    network: async () => ({ name: "testnet" as any, chainId: 2 }),
    readInvocation: read, signAndSubmitTransaction: submit
  };
  (window as any).inferenco = provider;
  const envelope = (status: string, payload?: unknown) => ({
    contractVersion: 1, invocationId: row.id, requestId: "native-" + row.id,
    requestCommitment: commitment, scope: scope(), method: row.method, status,
    ...(payload === undefined ? {} : { payload })
  });
  return { row, provider, read, submit, envelope, setResponse: (value: unknown) => { response = value; } };
}
function transaction(sequence = 123n) {
  return new SimpleTransaction(new RawTransaction(
    signer.accountAddress, sequence,
    new TransactionPayloadEntryFunction(EntryFunction.build("0x1::account", "transfer", [], [])),
    25000n, 7n, 1900000123n, new ChainId(2), parseTypeTag("0x1::cedra_coin::CedraCoin")
  ));
}
function signedMessage(input: any) {
  const fullMessage = messagePreimage(input, scope());
  return {
    profile: "cedra:message:v1", prefix: "CEDRA", message: input.message,
    nonce: input.nonce, fullMessage, signerAddress: scope().accountAddress,
    publicKey: signer.publicKey.toString(), address: scope().accountAddress,
    application: scope().origin, chainId: 2,
    signature: signer.sign("0x" + Buffer.from(fullMessage, "utf8").toString("hex")).toString()
  };
}
afterEach(() => {
  delete (window as any).inferenco;
  window.localStorage.clear(); window.sessionStorage.clear();
  vi.restoreAllMocks(); _resetBridgeTokenForTesting();
});
describe("original execution evidence and complete Desktop recovery", () => {
  it.each(["original", "renewed"])("preserves the signed/submitting hash through %s session recovery and a later outage", async (sessionId) => {
    const saved = await seedDesktop("signAndSubmitTransaction", wire(), sessionId);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({
      ...saved.envelope("unknown"), executionPhase: "submitting", hash
    }));
    expect(await readRecoverableRequest(saved.row.id)).toMatchObject({ status: "unknown", transactionHash: hash });
    expect(fetch.mock.calls[0]![0].toString()).toContain("/read-result/");
    expect((await listDurableRequests())[0]).toMatchObject({ transactionHash: hash });
    expect((await listDurableRequests())[0]?.final).toBeUndefined();
    fetch.mockRejectedValue(new TypeError("Desk unavailable"));
    expect(await readRecoverableRequest(saved.row.id)).toMatchObject({ status: "unknown", transactionHash: hash });
    expect(fetch.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });
  it("does not expose malformed or substituted uncertain execution evidence", async () => {
    const saved = await seedDesktop();
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const patch of [
      { hash: "0x1234" }, { invocationId: "other", hash },
      { requestCommitment: "0".repeat(64), hash },
      { scope: { ...scope(), transport: "desktop-bridge", method: "signMessage" }, hash },
      { scope: { ...scope(), origin: "https://other.example", transport: "desktop-bridge", method: saved.row.method }, hash }
    ]) {
      fetch.mockImplementation(async () => json({ ...saved.envelope("unknown"), ...patch }));
      const outcome = await readRecoverableRequest(saved.row.id);
      expect(outcome.status).toBe("unknown");
      expect(outcome).not.toHaveProperty("transactionHash");
    }
    expect((await listDurableRequests())[0]).not.toHaveProperty("transactionHash");
  });
  it("retains one immutable hash when later reads substitute an execution or terminal result", async () => {
    const saved = await seedDesktop();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ ...saved.envelope("unknown"), hash }));
    await readRecoverableRequest(saved.row.id);
    for (const response of [
      { ...saved.envelope("unknown"), hash: otherHash },
      saved.envelope("approved", { hash: otherHash })
    ]) {
      fetch.mockImplementation(async () => json(response));
      expect(await readRecoverableRequest(saved.row.id)).toMatchObject({ status: "unknown", transactionHash: hash });
    }
    const [row] = await listDurableRequests();
    expect(row?.transactionHash).toBe(hash); expect(row?.final).toBeUndefined();
  });
  it("verifies the original message and signature before returning hydrated renewed-session output", async () => {
    const input = { profile: "cedra:message:v1", message: "challenge π", nonce: "nonce", address: true, application: true, chainId: true };
    const saved = await seedDesktop("signMessage", input);
    const approved = signedMessage(input);
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const payload of [
      { ...approved, nonce: "substituted" },
      { ...approved, application: "https://other.example" },
      { ...approved, signature: Account.generate().sign("0x1234").toString() }
    ]) {
      fetch.mockImplementation(async () => json(saved.envelope("approved", payload)));
      expect((await readRecoverableRequest(saved.row.id)).status).toBe("unknown");
      expect((await listDurableRequests())[0]?.final).toBeUndefined();
    }
    fetch.mockImplementation(async () => json(saved.envelope("approved", approved)));
    const outcome = await readRecoverableRequest(saved.row.id);
    if (outcome.status !== "approved") throw new Error("Expected verified message");
    expect((outcome.output as any).signature).toBeInstanceOf(Ed25519Signature);
    const calls = fetch.mock.calls.length;
    const replay = await readRecoverableRequest(saved.row.id);
    if (replay.status !== "approved") throw new Error("Expected verified replay");
    expect((replay.output as any).signature).toBeInstanceOf(Ed25519Signature);
    expect(fetch).toHaveBeenCalledTimes(calls);
  });
  it("checks exact original BCS before returning hydrated renewed-session sign-only output", async () => {
    const original = transaction();
    const saved = await seedDesktop("signTransaction", { rawTransactionBcsHex: original.toString(), bcsHex: original.toString() });
    const approved = {
      authenticatorHex: signer.signTransactionWithAuthenticator(original).toString(),
      rawTransactionBcsHex: original.toString()
    };
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const rawTransactionBcsHex of [transaction(124n).toString(), original.toString() + "00"]) {
      fetch.mockImplementation(async () => json(saved.envelope("approved", { ...approved, rawTransactionBcsHex })));
      expect((await readRecoverableRequest(saved.row.id)).status).toBe("unknown");
      expect((await listDurableRequests())[0]?.final).toBeUndefined();
    }
    fetch.mockImplementation(async () => json(saved.envelope("approved", approved)));
    const outcome = await readRecoverableRequest(saved.row.id);
    if (outcome.status !== "approved") throw new Error("Expected exact signed bytes");
    expect(typeof (outcome.output as any).authenticator.bcsToBytes).toBe("function");
    expect(typeof (outcome.output as any).rawTransaction.bcsToBytes).toBe("function");
  });
  it("accepts Desk's explicit rejected payload but not an operational error", async () => {
    const saved = await seedDesktop();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(saved.envelope("rejected", { error: "shutdown" })));
    expect((await readRecoverableRequest(saved.row.id)).status).toBe("unknown");
    fetch.mockImplementation(async () => json(saved.envelope("rejected", { error: "user_rejected" })));
    expect((await readRecoverableRequest(saved.row.id)).status).toBe("rejected");
  });
});
describe("native producer envelopes and retention acknowledgement", () => {
  it("recovers durable native execution evidence without approving or invoking signing", async () => {
    const saved = await seedNative();
    saved.setResponse({ ...saved.envelope("unknown"), hash, executionPhase: "signed" });
    expect(await reconcileRecoverableInvocation(saved.row.id)).toMatchObject({ status: "unknown", transactionHash: hash });
    expect((await listDurableInvocations())[0]).toMatchObject({ transactionHash: hash });
    expect((await listDurableInvocations())[0]?.final).toBeUndefined();
    saved.read.mockRejectedValue(new Error("native bridge unavailable"));
    expect(await reconcileRecoverableInvocation(saved.row.id)).toMatchObject({ status: "unknown", transactionHash: hash });
    expect(saved.submit).not.toHaveBeenCalled();
    await expect(acknowledgeRecoverableRequest("invocation:" + saved.row.id)).rejects.toThrow();
  });
  it("refuses native hashes with substituted commitment or invalid bytes", async () => {
    const saved = await seedNative();
    for (const patch of [{ hash: "0x1234" }, { hash, requestCommitment: "0".repeat(64) }, { hash, scope: { ...scope(), chainId: 3 } }]) {
      saved.setResponse({ ...saved.envelope("unknown"), ...patch });
      expect(await reconcileRecoverableInvocation(saved.row.id)).not.toHaveProperty("transactionHash");
    }
    expect((await listDurableInvocations())[0]).not.toHaveProperty("transactionHash");
  });
  it("recovers actual Desk rejection and rejects malformed or operational rejection payloads", async () => {
    const saved = await seedNative();
    for (const payload of [{ error: "timeout" }, { error: "user_rejected", hash }, { hash }]) {
      saved.setResponse(saved.envelope("rejected", payload));
      expect((await reconcileRecoverableInvocation(saved.row.id)).status).toBe("unknown");
    }
    saved.setResponse(saved.envelope("rejected", { error: "user_rejected" }));
    expect((await reconcileRecoverableInvocation(saved.row.id)).status).toBe("rejected");
    expect((await listDurableInvocations())[0]?.final).toEqual({ status: "rejected" });
    expect(saved.submit).not.toHaveBeenCalled();
  });
  it("keeps native acknowledgement retryable and checks its original binding", async () => {
    const saved = await seedNative();
    await updateInjectedInvocationEvidence(saved.row.id, { final: { status: "approved", method: saved.row.method as "signAndSubmitTransaction", hash } });
    const ack = vi.fn(async () => ({ ...saved.envelope("acknowledged"), requestCommitment: "0".repeat(64) }));
    saved.provider.acknowledgeInvocation = ack;
    await expect(acknowledgeRecoverableRequest("invocation:" + saved.row.id)).rejects.toThrow();
    expect(await listRecoverableRequests()).toHaveLength(1);
    ack.mockImplementation(async () => saved.envelope("acknowledged"));
    await acknowledgeRecoverableRequest("invocation:" + saved.row.id);
    expect(ack).toHaveBeenLastCalledWith(saved.row.id, saved.row.requestCommitment);
    expect(await listRecoverableRequests()).toHaveLength(0);
    expect(saved.submit).not.toHaveBeenCalled();
  });
  it("rejects native acknowledgement after the current account/network changes", async () => {
    const saved = await seedNative();
    await updateInjectedInvocationEvidence(saved.row.id, { final: { status: "approved", method: "signAndSubmitTransaction", hash } });
    const ack = vi.fn(async () => saved.envelope("acknowledged"));
    saved.provider.acknowledgeInvocation = ack;
    saved.provider.network = async () => ({ name: "testnet" as any, chainId: 3 });
    await expect(acknowledgeRecoverableRequest("invocation:" + saved.row.id)).rejects.toThrow();
    expect(ack).not.toHaveBeenCalled(); expect(await listRecoverableRequests()).toHaveLength(1);
  });
  it("uses the renewed HTTP session and only hides local delivery after Desk acknowledgement", async () => {
    const saved = await seedDesktop();
    await saveDurableFinal(saved.row.id, { status: "approved", method: "signAndSubmitTransaction", hash });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("ack reply lost"));
    await expect(acknowledgeRecoverableRequest(saved.row.id)).rejects.toThrow();
    expect(await listRecoverableRequests()).toHaveLength(1);
    fetch.mockImplementation(async (url, init) => {
      expect(String(url)).toContain("/acknowledge-result/" + saved.row.requestId);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        sessionId: saved.current.sessionId, invocationId: saved.invocation.id,
        requestCommitment: saved.row.requestCommitment, method: saved.row.method,
        origin: scope().origin, accountAddress: scope().accountAddress, network: "testnet", chainId: 2
      });
      return json(saved.envelope("acknowledged"));
    });
    await acknowledgeRecoverableRequest(saved.row.id);
    expect(await listRecoverableRequests()).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not accept an HTTP acknowledgement for another invocation", async () => {
    const saved = await seedDesktop();
    await saveDurableFinal(saved.row.id, { status: "approved", method: "signAndSubmitTransaction", hash });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ ...saved.envelope("acknowledged"), invocationId: "other" }));
    await expect(acknowledgeRecoverableRequest(saved.row.id)).rejects.toThrow();
    expect(await listRecoverableRequests()).toHaveLength(1);
  });
  it("proves no dispatch when a legacy injected peer cannot preserve exact u64 gas", async () => {
    const submit = vi.fn(async () => ({ hash }));
    (window as any).inferenco = {
      isInferWallet: true,
      account: async () => ({ address: scope().accountAddress, publicKey: signer.publicKey.toUint8Array() }),
      network: async () => ({ name: "testnet", chainId: 2 }), signAndSubmitTransaction: submit
    };
    let invocation: RecoverableInvocation | undefined;
    const client = new InferClient({ onInvocationPrepared: (value) => { invocation = value; } });
    const error = await client.signAndSubmitTransaction({
      data: wire().data, options: { maxGasAmount: 18446744073709551615n }
    } as any).catch((cause) => cause);
    expect(error.code).toBe("REQUEST_NOT_INVOKED");
    expect(invocation).toBeDefined();
    expect(createInferAIP62Wallet().features["inferenco:transactionSubmission"].isNotInvoked(error, invocation!)).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    client.dispose();
  });
});

it("keeps new-adapter acknowledgement local for a legacy Desktop peer", async () => {
  const saved = await seedDesktop("signAndSubmitTransaction", wire(), "renewed", true);
  await saveDurableFinal(saved.row.id, { status: "approved", method: "signAndSubmitTransaction", hash });
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Legacy acknowledgement must remain local"));
  await acknowledgeRecoverableRequest(saved.row.id);
  expect(fetch).not.toHaveBeenCalled();
  expect(await listRecoverableRequests()).toHaveLength(0);
});
it("deduplicates simultaneous v1 durable reads without polling a weaker route", async () => {
  const saved = await seedDesktop();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    expect(String(url)).toContain("/read-result/");
    await barrier;
    return json({ ...saved.envelope("unknown"), hash });
  });
  const reads = Promise.all([readRecoverableRequest(saved.row.id), readRecoverableRequest(saved.row.id)]);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  release();
  expect(await reads).toHaveLength(2);
  expect(fetch).toHaveBeenCalledOnce();
});

describe("acknowledgement obligations survive peer loss", () => {
  it.each(["absent", "downgraded", "no method"])("retains required native acknowledgement with %s peer until a matching peer returns", async (change) => {
    const saved = await seedNative(true);
    await updateInjectedInvocationEvidence(saved.row.id, { final: { status: "approved", method: "signAndSubmitTransaction", hash } });
    const ack = vi.fn(async () => saved.envelope("acknowledged"));
    saved.provider.acknowledgeInvocation = ack;
    if (change === "absent") delete (window as any).inferenco;
    else if (change === "downgraded") delete saved.provider.integrationContractVersion;
    else delete saved.provider.acknowledgeInvocation;
    await expect(acknowledgeRecoverableRequest("invocation:" + saved.row.id)).rejects.toThrow();
    expect((await listDurableInvocations())[0]?.deliveryState).toBeUndefined();
    expect(ack).not.toHaveBeenCalled();
    (window as any).inferenco = saved.provider;
    saved.provider.integrationContractVersion = 1;
    saved.provider.acknowledgeInvocation = ack;
    await acknowledgeRecoverableRequest("invocation:" + saved.row.id);
    expect(ack).toHaveBeenCalledOnce();
    delete (window as any).inferenco;
    await acknowledgeRecoverableRequest("invocation:" + saved.row.id);
    expect(ack).toHaveBeenCalledOnce();
  });
  it.each(["absent", "downgraded"])("retains original Desktop acknowledgement with %s session", async (change) => {
    const saved = await seedDesktop();
    await saveDurableFinal(saved.row.id, { status: "approved", method: "signAndSubmitTransaction", hash });
    if (change === "absent") window.localStorage.clear();
    else storeExternalSession({ ...saved.current, integrationContractVersion: undefined, capabilities: undefined });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(saved.envelope("acknowledged")));
    await expect(acknowledgeRecoverableRequest(saved.row.id)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect((await listDurableRequests())[0]?.state).toBe("active");
    storeExternalSession(saved.current);
    await acknowledgeRecoverableRequest(saved.row.id);
    expect(fetch).toHaveBeenCalledOnce();
    window.localStorage.clear();
    await acknowledgeRecoverableRequest(saved.row.id);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("retains historical Desktop v1 acknowledgement debt when its capability marker was not saved", async () => {
    const saved = await seedDesktop();
    await saveDurableFinal(saved.row.id, { status: "rejected" });
    const [row] = await listDurableRequests();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("inferenco:infer-recovery", 1);
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("requests", "readwrite");
      const historical = { ...row }; delete historical.remoteAcknowledgementRequired;
      tx.objectStore("requests").put(historical);
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    db.close();
    window.localStorage.clear();
    await expect(acknowledgeRecoverableRequest(saved.row.id)).rejects.toThrow();
    expect((await listDurableRequests())[0]?.state).toBe("active");
    storeExternalSession(saved.current);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(saved.envelope("acknowledged")));
    await acknowledgeRecoverableRequest(saved.row.id);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("does not treat an absent native provider as evidence a historical peer lacked acknowledgement", async () => {
    const saved = await seedNative();
    await updateInjectedInvocationEvidence(saved.row.id, { final: { status: "rejected" } });
    delete (window as any).inferenco;
    await expect(acknowledgeRecoverableRequest("invocation:" + saved.row.id)).rejects.toThrow();
    (window as any).inferenco = saved.provider; // Matching older mobile peer without optional ack.
    await acknowledgeRecoverableRequest("invocation:" + saved.row.id);
    expect((await listDurableInvocations())[0]?.deliveryState).toBe("acknowledged");
  });
});
