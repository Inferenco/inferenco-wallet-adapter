import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBObjectStore } from "fake-indexeddb";
import { InferClient } from "../src/InferClient";
import { storeExternalSession } from "../src/bridge";
import { canonicalAddress, requestCommitment } from "../src/integrationContract";
import {
  listDurableInvocations, listDurableRequests, prepareDurableInvocation,
  pruneDurableEvidence, saveDurableExternalTransactionRecovery, saveDurableRequest,
  saveDurableTransactionHash, transitionDurableRequest, updateDurableInvocation
} from "../src/durableRecovery";
import { createKeyPair, deriveSharedSecret, encryptJson } from "../src/mobileCrypto";
import {
  acknowledgeRecoverableRequest, archiveRecoverableRequest,
  listRecoverableRequests, readRecoverableRequest
} from "../src/recovery";
import type { DurableRequest } from "../src/durableRecovery";
import type { InferExternalSession } from "../src/types";

const scope = { origin: window.location.origin, accountAddress: canonicalAddress("0x1"), network: "testnet", chainId: 2 };
const payload = { contractVersion: 1, data: { function: "0x1::fixture::claim", typeArguments: [], functionArguments: [] } };
const commitment = requestCommitment("signAndSubmitTransaction", scope, payload);
const hash = "0x" + "ab".repeat(32);
const retention = 31 * 24 * 60 * 60 * 1000;
function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}
async function fixture(sameSession = false, requestId = "mobile-original") {
  const dapp = createKeyPair(), wallet = createKeyPair();
  const session: InferExternalSession = {
    transport: "mobile-relay", address: "0x1", publicKey: "0x2", network: "testnet", chainId: 2,
    sessionId: "current", relayBaseUrl: "https://relay.example", dappSessionToken: "fixture-token",
    sharedSecret: deriveSharedSecret(dapp.privateKey, wallet.publicKey),
    integrationContractVersion: 1, capabilities: { durableExternalSubmissionRecovery: true }
  };
  storeExternalSession(session);
  const invocation = await prepareDurableInvocation({ ...session, sessionId: sameSession ? session.sessionId : "retired" },
    "signAndSubmitTransaction", { requestCommitment: commitment, requestPayload: payload, endpoint: session.relayBaseUrl! });
  const row = await saveDurableRequest({
    version: 1, requestId, invocationId: invocation.id, requestCommitment: commitment,
    requestPayload: payload, origin: scope.origin, sessionId: invocation.sessionId,
    address: "0x1", network: "testnet", chainId: 2, relayBaseUrl: session.relayBaseUrl!,
    method: "signAndSubmitTransaction", expiresAt: new Date(Date.now() + 60_000).toISOString()
  }, invocation.id);
  await updateDurableInvocation(invocation.id, "created", row.requestId);
  return { row, session };
}
function evidence(row: DurableRequest, extra: Record<string, unknown> = {}) {
  return {
    recoverySchema: "infer-connect-transaction-recovery-v1", requestId: row.requestId,
    invocationId: row.invocationId, requestCommitment: row.requestCommitment, scope,
    method: "signAndSubmitTransaction", status: "not-submitted",
    failureCode: "EXECUTION_FAILED_BEFORE_BROADCAST", ...extra
  };
}
async function replaceStoredRow(row: DurableRequest) {
  const db = await new Promise<IDBDatabase>((resolve) => {
    const request = indexedDB.open("inferenco:infer-recovery"); request.onsuccess = () => resolve(request.result);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("requests", "readwrite"); tx.objectStore("requests").put(row);
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
  db.close();
}
afterEach(() => { localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); });

describe("mobile terminal failure acknowledgement", () => {
  it.each([true, false])("recovers encrypted original evidence, replays offline and acknowledges locally (same session: %s)", async (sameSession) => {
    const { row, session } = await fixture(sameSession);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/read-grant")) return json({
        grantId: "original-grant", requestId: row.requestId, status: "fulfilled",
        scope: { ...scope, method: row.method, invocationId: row.invocationId },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        redeliveredEncryptedResult: encryptJson(evidence(row), session.sharedSecret!)
      });
      if (String(input).endsWith("/" + row.requestId) && init?.method !== "POST") return json({
        requestId: row.requestId, sessionId: session.sessionId, method: row.method,
        status: "pending", expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
      throw new Error("Must not create, sign, relaunch or remotely acknowledge mobile execution");
    });
    const outcome = await readRecoverableRequest(row.id);
    expect(outcome).toMatchObject({ status: "unknown", submissionDisposition: "not-submitted", invocationId: row.invocationId });
    expect(outcome).not.toHaveProperty("transactionHash");
    expect((await listDurableRequests())[0]).toMatchObject({ state: "active", externalTransactionRecovery: evidence(row) });
    expect(await listRecoverableRequests()).toHaveLength(1); // Reading is not consumer acceptance.
    localStorage.clear(); sessionStorage.clear(); fetch.mockClear();
    expect(await readRecoverableRequest(row.id)).toMatchObject({ status: "unknown", submissionDisposition: "not-submitted" });
    await acknowledgeRecoverableRequest(row.id);
    const accepted = (await listDurableRequests())[0];
    expect(accepted).toMatchObject({ state: "acknowledged", externalTransactionRecovery: evidence(row) });
    expect(accepted).not.toHaveProperty("final"); // Never fabricate approval or rejection.
    expect(await listRecoverableRequests()).toEqual([]);
    await acknowledgeRecoverableRequest(row.id);
    expect((await listDurableRequests())[0].revision).toBe(accepted.revision);
    expect(await readRecoverableRequest(row.id)).toMatchObject({ status: "unknown", submissionDisposition: "not-submitted" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("delivers a recovered failure to late consumers and retries failed consumer persistence on focus", async () => {
    const { row } = await fixture(); await saveDurableExternalTransactionRecovery(row.id, evidence(row));
    localStorage.clear(); sessionStorage.clear();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Recovery is local"));
    let persisted = false;
    const accept = vi.fn(async (outcome) => {
      if (!persisted) throw new Error("consumer journal unavailable");
      expect(outcome).toMatchObject({ recoveryId: row.id, status: "unknown", submissionDisposition: "not-submitted" });
      await acknowledgeRecoverableRequest(outcome.recoveryId);
    });
    const client = new InferClient();
    // Finish constructor startup before measuring later subscriber retries.
    await client.listRecoverableRequests();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stop = client.subscribeRecoveredOutcomes(accept);
    try {
      await vi.waitFor(() => expect(accept).toHaveBeenCalledTimes(1));
      expect((await listDurableRequests())[0].state).toBe("active");
      persisted = true;
      window.dispatchEvent(new Event("focus"));
      await vi.waitFor(() => expect((accept.mock.calls.length)).toBe(2));
      await vi.waitFor(async () => expect((await listDurableRequests())[0].state).toBe("acknowledged"));
      window.dispatchEvent(new Event("focus"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(accept).toHaveBeenCalledTimes(2);
      expect(fetch).not.toHaveBeenCalled();
    } finally { stop(); client.dispose(); }
  });

  it("does not notify subscribers of unknown execution as a terminal failure", async () => {
    const { row } = await fixture();
    await saveDurableExternalTransactionRecovery(row.id, {
      recoverySchema: "infer-connect-transaction-recovery-v1", requestId: row.requestId,
      invocationId: row.invocationId, requestCommitment: row.requestCommitment,
      scope, method: row.method, status: "unknown"
    });
    localStorage.clear(); sessionStorage.clear();
    const client = new InferClient();
    const accept = vi.fn(); const stop = client.subscribeRecoveredOutcomes(accept);
    try {
      await client.listRecoverableRequests();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(accept).not.toHaveBeenCalled();
      expect((await listDurableRequests())[0].state).toBe("active");
    } finally { stop(); client.dispose(); }
  });

  it("keeps acknowledgement local when the selected mobile account has changed after durable recovery", async () => {
    const { row, session } = await fixture();
    await saveDurableExternalTransactionRecovery(row.id, evidence(row));
    storeExternalSession({ ...session, address: "0x2", chainId: 1, network: "mainnet" });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No remote authority is exercised"));
    await acknowledgeRecoverableRequest(row.id);
    expect((await listDurableRequests())[0].state).toBe("acknowledged");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not archive a verified failure through either the public API or the atomic storage transition", async () => {
    const { row } = await fixture(); await saveDurableExternalTransactionRecovery(row.id, evidence(row));
    await expect(archiveRecoverableRequest(row.id, "independently-checked")).rejects.toThrow("must be acknowledged");
    await expect(transitionDurableRequest(row.id, "archive", { archivedAt: new Date().toISOString(), reconciliationReference: "checked" })).rejects.toThrow();
    expect((await listDurableRequests())[0].state).toBe("active");
  });

  it.each(["missing", "unknown", "hash"])("retains %s evidence as unresolved and refuses acknowledgement", async (kind) => {
    const { row } = await fixture();
    if (kind !== "missing") await saveDurableExternalTransactionRecovery(row.id, {
      recoverySchema: "infer-connect-transaction-recovery-v1", requestId: row.requestId,
      invocationId: row.invocationId, requestCommitment: row.requestCommitment, scope,
      method: row.method, status: "unknown",
      ...(kind === "hash" ? { transactionHash: hash, submissionAcceptance: "unknown" } : {})
    });
    await expect(acknowledgeRecoverableRequest(row.id)).rejects.toThrow();
    await expect(transitionDurableRequest(row.id, "acknowledge")).rejects.toThrow();
    expect((await listDurableRequests())[0].state).toBe("active");
  });

  it.each([
    { requestId: "other" }, { invocationId: "other" }, { requestCommitment: "0".repeat(64) },
    { scope: { ...scope, origin: "https://foreign.example" } },
    { scope: { ...scope, accountAddress: canonicalAddress("0x2") } },
    { scope: { ...scope, network: "mainnet" } }, { scope: { ...scope, chainId: 1 } },
    { method: "signMessage" }, { recoverySchema: "unsupported" },
    { transactionHash: hash }, { failureCode: "unqualified-failure" }
  ])("revalidates stored terminal evidence before acknowledging: %j", async (extra) => {
    const { row } = await fixture();
    await replaceStoredRow({ ...row, externalTransactionRecovery: evidence(row, extra) as never });
    await expect(acknowledgeRecoverableRequest(row.id)).rejects.toThrow();
    await expect(transitionDurableRequest(row.id, "acknowledge")).rejects.toThrow();
    expect((await listDurableRequests())[0].state).toBe("active");
  });

  it("retains evidence and acknowledgement debt after a failed write, then permits an explicit retry", async () => {
    const { row } = await fixture(); await saveDurableExternalTransactionRecovery(row.id, evidence(row));
    const before = (await listDurableRequests())[0];
    const original = IDBObjectStore.prototype.put;
    const write = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (value?.state === "acknowledged") throw new Error("fixture-storage-failure");
      return original.call(this, value, key);
    });
    await expect(acknowledgeRecoverableRequest(row.id)).rejects.toThrow();
    expect((await listDurableRequests())[0]).toMatchObject({ state: "active", revision: before.revision, externalTransactionRecovery: evidence(row) });
    write.mockRestore();
    await acknowledgeRecoverableRequest(row.id);
    expect((await listDurableRequests())[0].state).toBe("acknowledged");
  });

  it("acknowledges the exact request once when two consumers accept it concurrently", async () => {
    const { row } = await fixture(); await saveDurableExternalTransactionRecovery(row.id, evidence(row));
    const before = (await listDurableRequests())[0];
    await Promise.all([acknowledgeRecoverableRequest(row.id), acknowledgeRecoverableRequest(row.id)]);
    expect((await listDurableRequests())[0]).toMatchObject({ state: "acknowledged", revision: before.revision + 1 });
  });

  it("allows only one of a signed identity or non-submission assertion to be retained", async () => {
    const { row } = await fixture();
    const results = await Promise.allSettled([
      saveDurableTransactionHash(row.id, hash), saveDurableExternalTransactionRecovery(row.id, evidence(row))
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const retained = (await listDurableRequests())[0];
    if (retained.transactionHash) {
      await expect(acknowledgeRecoverableRequest(row.id)).rejects.toThrow();
      expect(retained.transactionHash).toBe(hash);
    } else {
      await acknowledgeRecoverableRequest(row.id);
      expect((await listDurableRequests())[0].state).toBe("acknowledged");
    }
  });

  it("prunes only aged acknowledged evidence and its exact linked invocation, retaining unresolved work", async () => {
    const accepted = await fixture(false, "accepted");
    const active = await fixture(false, "active");
    const unknown = await fixture(false, "unknown");
    await saveDurableExternalTransactionRecovery(accepted.row.id, evidence(accepted.row));
    await saveDurableExternalTransactionRecovery(active.row.id, evidence(active.row));
    await acknowledgeRecoverableRequest(accepted.row.id);
    await pruneDurableEvidence();
    expect(await listDurableRequests()).toHaveLength(3);
    localStorage.clear(); sessionStorage.clear();
    await pruneDurableEvidence(Date.now() + retention);
    expect((await listDurableRequests()).map((row) => row.id).sort()).toEqual([active.row.id, unknown.row.id].sort());
    expect((await listDurableInvocations()).map((row) => row.id).sort()).toEqual([active.row.invocationId, unknown.row.invocationId].sort());
  });
});
