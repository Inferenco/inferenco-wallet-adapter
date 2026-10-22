import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBObjectStore } from "fake-indexeddb";
import { InferClient } from "../src/InferClient";
import { canonicalAddress, requestCommitment } from "../src/integrationContract";
import { getDurableInvocation, listDurableInvocations, prepareDurableInvocation, pruneDurableEvidence,
  saveDurableTransactionHash, updateInjectedInvocationEvidence } from "../src/durableRecovery";
import { acknowledgeRecoverableRequest, archiveRecoverableRequest, listRecoverableRequests, readRecoverableRequest } from "../src/recovery";
const hash = "0x" + "ab".repeat(32);
async function fixture() {
  const scope = { origin: window.location.origin, accountAddress: canonicalAddress("0x1"), network: "testnet", chainId: 2 };
  const payload = { contractVersion: 1, data: { function: "0x1::fixture::claim", typeArguments: [], functionArguments: [] } };
  const row = await prepareDurableInvocation({ transport: "injected", sessionId: "native", address: scope.accountAddress,
    network: scope.network, chainId: scope.chainId }, "signAndSubmitTransaction", {
    requestCommitment: requestCommitment("signAndSubmitTransaction", scope, payload), requestPayload: payload,
    endpoint: scope.origin, remoteAcknowledgementRequired: true
  });
  const proof = { contractVersion: 1, invocationId: row.id, requestCommitment: row.requestCommitment, scope,
    method: row.method, status: "unknown", submissionDisposition: "not-submitted", failureCode: "EXECUTION_FAILED_BEFORE_BROADCAST" };
  const provider = { isInferWallet: true, integrationContractVersion: 1,
    capabilities: { durableInvocationLookup: true },
    account: vi.fn(async () => ({ address: scope.accountAddress })),
    network: vi.fn(async () => ({ name: scope.network, chainId: scope.chainId })),
    readInvocation: vi.fn(async () => proof),
    acknowledgeInvocation: vi.fn(async () => ({ ...proof, status: "acknowledged", requestId: row.id })),
    signAndSubmitTransaction: vi.fn(async () => { throw new Error("Must not execute"); })
  };
  (window as any).inferenco = provider;
  return { row, scope, proof, provider, handle: "invocation:" + row.id };
}
afterEach(() => { delete (window as any).inferenco; localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); });
describe("native durable non-submission consumption", () => {
  it("persists the exact proof, rereads after consumer reload and remotely acknowledges without execution", async () => {
    const { row, handle, provider } = await fixture();
    expect(await readRecoverableRequest(handle)).toMatchObject({ status: "unknown", submissionDisposition: "not-submitted" });
    expect(await getDurableInvocation(row.id)).toHaveProperty("nativeNotSubmitted");
    expect(await listRecoverableRequests()).toHaveLength(1);
    sessionStorage.clear(); localStorage.clear();
    expect(await readRecoverableRequest(handle)).toMatchObject({ submissionDisposition: "not-submitted" });
    await acknowledgeRecoverableRequest(handle);
    expect(provider.acknowledgeInvocation).toHaveBeenCalledWith(row.id, row.requestCommitment);
    expect(await getDurableInvocation(row.id)).toMatchObject({ deliveryState: "acknowledged" });
    await acknowledgeRecoverableRequest(handle);
    expect(provider.acknowledgeInvocation).toHaveBeenCalledTimes(1);
    expect(await readRecoverableRequest(handle)).toMatchObject({ submissionDisposition: "not-submitted" });
    expect(await listRecoverableRequests()).toEqual([]);
    expect(provider.signAndSubmitTransaction).not.toHaveBeenCalled();
    await pruneDurableEvidence(Date.now() + 31 * 86400000);
    expect(await listDurableInvocations()).toEqual([]);
  });
  it.each([
    { invocationId: "other" }, { requestCommitment: "0".repeat(64) }, { contractVersion: 2 },
    { method: "signMessage" }, { status: "pending" }, { status: "approved" }, { status: "rejected" },
    { failureCode: "unspecified" }, { transactionHash: hash }, { hash }, { payload: {} },
    { submissionAcceptance: "unknown" }, { chainStatus: "unknown" }, { extra: true },
    { scope: { origin: "https://foreign.example", accountAddress: canonicalAddress("0x1"), network: "testnet", chainId: 2 } }
  ])("rejects a substituted or contradictory native proof %j", async change => {
    const { row, handle, provider, proof } = await fixture();
    provider.readInvocation.mockResolvedValue({ ...proof, ...change } as any);
    expect(await readRecoverableRequest(handle)).not.toHaveProperty("submissionDisposition");
    expect(await getDurableInvocation(row.id)).not.toHaveProperty("nativeNotSubmitted");
    await expect(acknowledgeRecoverableRequest(handle)).rejects.toThrow();
    expect(provider.acknowledgeInvocation).not.toHaveBeenCalled();
  });
  it("does not overwrite a signed identity or later invent one after a terminal proof", async () => {
    const one = await fixture(); await saveDurableTransactionHash(one.row.id, hash, true);
    expect(await readRecoverableRequest(one.handle)).not.toHaveProperty("submissionDisposition");
    const two = await fixture(); await readRecoverableRequest(two.handle);
    await expect(saveDurableTransactionHash(two.row.id, hash, true)).rejects.toThrow();
    await expect(updateInjectedInvocationEvidence(two.row.id, { final: { status: "rejected" } })).rejects.toThrow();
    await expect(archiveRecoverableRequest(two.handle, "checked")).rejects.toThrow();
  });
  it("does not rewrite identical native proof during failed acknowledgement retries", async () => {
    const { row, handle, provider } = await fixture(); await readRecoverableRequest(handle);
    const before = await getDurableInvocation(row.id);
    const writes = vi.spyOn(IDBObjectStore.prototype, "put");
    provider.acknowledgeInvocation.mockRejectedValue(new Error("wallet ack unavailable"));
    await expect(acknowledgeRecoverableRequest(handle)).rejects.toThrow();
    await expect(acknowledgeRecoverableRequest(handle)).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled();
    expect((await getDurableInvocation(row.id))?.updatedAt).toBe(before?.updatedAt);
  });
  it("retains acknowledgement debt if the local delivery write fails after remote acceptance", async () => {
    const { row, handle, provider } = await fixture(); await readRecoverableRequest(handle);
    const put = IDBObjectStore.prototype.put;
    const fail = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function(this: IDBObjectStore, value, key) {
      if (value?.deliveryState === "acknowledged") throw new Error("disk unavailable");
      return put.call(this, value, key);
    });
    await expect(acknowledgeRecoverableRequest(handle)).rejects.toThrow();
    expect(provider.acknowledgeInvocation).toHaveBeenCalledTimes(1);
    expect(await getDurableInvocation(row.id)).not.toHaveProperty("deliveryState", "acknowledged");
    fail.mockRestore(); await acknowledgeRecoverableRequest(handle);
    expect(await getDurableInvocation(row.id)).toHaveProperty("deliveryState", "acknowledged");
  });
  it("never waives native proof acknowledgement when the original peer lacked the optional capability", async () => {
    const { row, handle, provider } = await fixture(); await readRecoverableRequest(handle);
    delete (provider as any).acknowledgeInvocation;
    await expect(acknowledgeRecoverableRequest(handle)).rejects.toThrow();
    expect(await getDurableInvocation(row.id)).not.toHaveProperty("deliveryState", "acknowledged");
  });
  it("serializes a racing signed hash and terminal proof without retaining contradictory outcomes", async () => {
    const { row, handle } = await fixture();
    await Promise.allSettled([readRecoverableRequest(handle), saveDurableTransactionHash(row.id, hash, true)]);
    const retained = await getDurableInvocation(row.id);
    expect(!!retained?.transactionHash && !!retained?.nativeNotSubmitted).toBe(false);
    expect(!!retained?.transactionHash || !!retained?.nativeNotSubmitted).toBe(true);
  });
  it("retains local debt when remote acknowledgement fails or returns another invocation", async () => {
    const { row, handle, provider, proof } = await fixture(); await readRecoverableRequest(handle);
    provider.acknowledgeInvocation.mockRejectedValueOnce(new Error("reply lost"));
    await expect(acknowledgeRecoverableRequest(handle)).rejects.toThrow();
    provider.acknowledgeInvocation.mockResolvedValueOnce({ ...proof, requestId: row.id, status: "acknowledged", invocationId: "foreign" });
    await expect(acknowledgeRecoverableRequest(handle)).rejects.toThrow();
    expect(await getDurableInvocation(row.id)).not.toHaveProperty("deliveryState", "acknowledged");
    await acknowledgeRecoverableRequest(handle);
    expect(await getDurableInvocation(row.id)).toHaveProperty("deliveryState", "acknowledged");
  });
  it("keeps uncertainty if proof persistence fails and retains accepted evidence after a later wallet outage", async () => {
    const { row, handle, provider } = await fixture();
    const put = IDBObjectStore.prototype.put;
    const fail = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function(this: IDBObjectStore, value, key) {
      if (value?.nativeNotSubmitted) throw new Error("disk failure");
      return put.call(this, value, key);
    });
    expect(await readRecoverableRequest(handle)).not.toHaveProperty("submissionDisposition");
    fail.mockRestore(); await readRecoverableRequest(handle);
    provider.readInvocation.mockRejectedValueOnce(new Error("wallet unavailable"));
    expect(await readRecoverableRequest(handle)).not.toHaveProperty("submissionDisposition");
    expect(await getDurableInvocation(row.id)).toHaveProperty("nativeNotSubmitted");
  });
  it("rejects authority changes during reads and acknowledgements", async () => {
    const { handle, provider, proof, row } = await fixture();
    provider.readInvocation.mockImplementationOnce(async () => {
      provider.account.mockResolvedValue({ address: canonicalAddress("0x2") }); return proof;
    });
    expect(await readRecoverableRequest(handle)).not.toHaveProperty("submissionDisposition");
    provider.account.mockResolvedValue({ address: canonicalAddress("0x1") }); await readRecoverableRequest(handle);
    provider.acknowledgeInvocation.mockImplementationOnce(async () => {
      provider.account.mockResolvedValue({ address: canonicalAddress("0x2") });
      return { ...proof, requestId: row.id, status: "acknowledged" };
    });
    await expect(acknowledgeRecoverableRequest(handle)).rejects.toThrow();
    expect(await getDurableInvocation(row.id)).not.toHaveProperty("deliveryState", "acknowledged");
  });
  it("delivers verified failure to late consumers and never reclassifies plain uncertainty", async () => {
    const { row, handle, provider, proof } = await fixture(); await readRecoverableRequest(handle);
    const client = new InferClient();
    await client.listRecoverableRequests(); await new Promise(r => setTimeout(r, 0));
    const callback = vi.fn(); const stop = client.subscribeRecoveredOutcomes(callback);
    try {
      await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(expect.objectContaining({ submissionDisposition: "not-submitted" })));
      expect(callback).toHaveBeenCalledTimes(1);
      expect(await getDurableInvocation(row.id)).not.toHaveProperty("deliveryState", "acknowledged");
    } finally { stop(); client.dispose(); }
    provider.readInvocation.mockResolvedValue({ ...proof, submissionDisposition: undefined, failureCode: undefined } as any);
    expect(await readRecoverableRequest(handle)).not.toHaveProperty("submissionDisposition");
  });
});
