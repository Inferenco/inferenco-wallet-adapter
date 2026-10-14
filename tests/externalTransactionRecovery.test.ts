import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBObjectStore } from "fake-indexeddb";
import * as mobileRelay from "../src/mobileRelay";
import { InferClient } from "../src/InferClient";
import { storeExternalSession } from "../src/bridge";
import { canonicalAddress, requestCommitment } from "../src/integrationContract";
import { listDurableRequests, saveDurableRequest } from "../src/durableRecovery";
import { createKeyPair, deriveSharedSecret, encryptJson } from "../src/mobileCrypto";
import { _setReadGrantPollConfigForTesting, acknowledgeRecoverableRequest, readRecoverableRequest } from "../src/recovery";
import type { InferExternalSession } from "../src/types";

const hash = "0x" + "ab".repeat(32);
const payload = { contractVersion: 1, data: { function: "0x1::chips::claim", typeArguments: [], functionArguments: [] } };
const scope = { origin: window.location.origin, accountAddress: canonicalAddress("0x1"), network: "testnet", chainId: 2 };
const commitment = requestCommitment("signAndSubmitTransaction", scope, payload);
function json(body: unknown) { return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }); }
async function fixture(sameSession = false) {
  const dapp = createKeyPair(), wallet = createKeyPair();
  const session: InferExternalSession = { transport: "mobile-relay", address: "0x1", publicKey: "0x2", network: "testnet", chainId: 2,
    sessionId: "current", relayBaseUrl: "https://relay.example", dappSessionToken: "fixture-token", sharedSecret: deriveSharedSecret(dapp.privateKey, wallet.publicKey),
    integrationContractVersion: 1, capabilities: { durableExternalSubmissionRecovery: true } };
  storeExternalSession(session);
  const row = await saveDurableRequest({ version: 1, requestId: "original-request", invocationId: "original-invocation", requestCommitment: commitment,
    requestPayload: payload, origin: scope.origin, sessionId: sameSession ? "current" : "retired", address: "0x1", network: "testnet", chainId: 2,
    relayBaseUrl: session.relayBaseUrl!, method: "signAndSubmitTransaction", expiresAt: new Date(Date.now() + 60_000).toISOString() }, "original-invocation");
  return { row, session };
}
function envelope(extra: Record<string, unknown> = {}) {
  return { recoverySchema: "infer-connect-transaction-recovery-v1", requestId: "original-request", invocationId: "original-invocation",
    requestCommitment: commitment, scope, method: "signAndSubmitTransaction", status: "unknown", transactionHash: hash,
    submissionAcceptance: "unknown", chainStatus: "unknown", ...extra };
}
function serve(session: InferExternalSession, value: unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/read-grant")) return json({ grantId: "grant", requestId: "original-request", status: "fulfilled", scope: { ...scope, method: "signAndSubmitTransaction", invocationId: "original-invocation" },
      expiresAt: new Date(Date.now() + 60_000).toISOString(), redeliveredEncryptedResult: encryptJson(value, session.sharedSecret!) });
    if (url.endsWith("/original-request") && init?.method !== "POST") return json({ requestId: "original-request", sessionId: "current", method: "signAndSubmitTransaction",
      status: "pending", callbackUrl: window.location.href, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    throw new Error("Recovery must not create, approve, or resubmit a request");
  });
}
afterEach(() => { localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); _setReadGrantPollConfigForTesting(1000, 30_000); });
describe("external transaction recovery evidence", () => {
  it("retains the signed identity without calling a wallet outcome an approval or chain pending", async () => {
    const { row, session } = await fixture(); const fetch = serve(session, envelope());
    expect(await readRecoverableRequest(row.id)).toMatchObject({ status: "unknown", transactionHash: hash, submissionAcceptance: "unknown", chainStatus: "unknown" });
    expect((await listDurableRequests())[0]).toMatchObject({ transactionHash: hash });
    localStorage.clear(); fetch.mockClear();
    expect(await readRecoverableRequest(row.id)).toMatchObject({ status: "unknown", transactionHash: hash, submissionAcceptance: "unknown", chainStatus: "unknown" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(acknowledgeRecoverableRequest(row.id)).rejects.toThrow();
  });
  it("recovers a pending original request in the same session without creating or relaunching one", async () => {
    const { row, session } = await fixture(true); const fetch = serve(session, envelope());
    expect(await readRecoverableRequest(row.id)).toMatchObject({ status: "unknown", transactionHash: hash });
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith("/read-grant"))).toBe(true);
    expect(fetch.mock.calls.every(([input]) => !String(input).endsWith("/v1/requests"))).toBe(true);
  });
  it("distinguishes proven non-submission from user rejection and retains it across reload", async () => {
    const { row, session } = await fixture();
    const value: Record<string, unknown> = envelope({ status: "not-submitted", failureCode: "EXECUTION_FAILED_BEFORE_BROADCAST" });
    delete value.transactionHash; delete value.submissionAcceptance; delete value.chainStatus;
    serve(session, value);
    expect(await readRecoverableRequest(row.id)).toMatchObject({ status: "unknown", reason: "transaction_not_submitted", submissionDisposition: "not-submitted", failureCode: "EXECUTION_FAILED_BEFORE_BROADCAST" });
    localStorage.clear();
    expect(await readRecoverableRequest(row.id)).toMatchObject({ status: "unknown", submissionDisposition: "not-submitted" });
  });
  it.each(["confirmed", "aborted"])("persists accepted %s evidence without reporting application success", async (chainStatus) => {
    const { row, session } = await fixture(); serve(session, envelope({ status: "approved", submissionAcceptance: "accepted", chainStatus, chainVersion: "42" }));
    expect(await readRecoverableRequest(row.id)).toMatchObject({ status: "approved", output: { hash }, submissionAcceptance: "accepted", chainStatus, chainVersion: "42" });
    localStorage.clear();
    expect(await readRecoverableRequest(row.id)).toMatchObject({ status: "approved", output: { hash }, chainStatus, chainVersion: "42" });
  });
  it.each([
    { requestId: "other" }, { invocationId: "other" }, { requestCommitment: "0".repeat(64) }, { scope: { ...scope, network: "mainnet" } },
    { scope: { ...scope, accountAddress: canonicalAddress("0x2") } }, { method: "signMessage" }, { unexpected: true },
    { status: "approved", submissionAcceptance: "unknown" }, { chainStatus: "confirmed" }, { transactionHash: "malformed" },
    { chainStatus: "confirmed", chainVersion: "42", submissionAcceptance: "unknown" }, { status: "not-submitted", failureCode: "EXECUTION_FAILED_BEFORE_BROADCAST" }
  ])("rejects conflicting or incomplete encrypted evidence %j", async (change) => {
    const { row, session } = await fixture(); serve(session, envelope(change));
    const result = await readRecoverableRequest(row.id);
    expect(result.status).toBe("unknown"); expect(result).not.toHaveProperty("transactionHash");
    expect((await listDurableRequests())[0]).not.toHaveProperty("transactionHash");
  });
  it("rejects a later conflicting hash while preserving the original identity", async () => {
    const { row, session } = await fixture(); const fetch = serve(session, envelope());
    await readRecoverableRequest(row.id); fetch.mockRestore(); serve(session, envelope({ transactionHash: "0x" + "cd".repeat(32) }));
    expect(await readRecoverableRequest(row.id)).toMatchObject({ status: "unknown", transactionHash: hash });
    expect((await listDurableRequests())[0]).toMatchObject({ transactionHash: hash });
  });
  it("keeps background lookup read-only and promptly asks for an explicit wallet read", async () => {
    const { row, session } = await fixture(true);
    const launch = vi.spyOn(mobileRelay, "launchMobileRelayRecoveryRead").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => json(String(input).endsWith("/read-grant")
      ? { grantId: "pending-grant", requestId: row.requestId, status: "pending_fulfillment", scope: { ...scope, method: row.method, invocationId: row.invocationId }, expiresAt: new Date(Date.now() + 60_000).toISOString() }
      : { requestId: row.requestId, sessionId: session.sessionId, method: row.method, status: "pending", expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    expect(await new InferClient().readRecoverableRequest(row.id)).toMatchObject({ status: "unknown", reason: "wallet_read_required" });
    expect(launch).not.toHaveBeenCalled();
  });
  it("allows one explicit read-only handoff through the public client and coalesces concurrent reads", async () => {
    const { row, session } = await fixture(true);
    const launch = vi.spyOn(mobileRelay, "launchMobileRelayRecoveryRead").mockImplementation(() => {});
    let polls = 0, mints = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (!String(input).endsWith("/read-grant")) return json({ requestId: row.requestId, sessionId: session.sessionId, method: row.method, status: "pending", expiresAt: new Date(Date.now() + 60_000).toISOString() });
      if (init?.method === "POST") mints++; else polls++;
      return json({ grantId: "handoff-grant", requestId: row.requestId, scope: { ...scope, method: row.method, invocationId: row.invocationId },
        status: polls < 2 ? "pending_fulfillment" : "fulfilled", expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...(polls >= 2 ? { redeliveredEncryptedResult: encryptJson(envelope(), session.sharedSecret!) } : {}) });
    });
    _setReadGrantPollConfigForTesting(1, 100);
    const client = new InferClient();
    const results = await Promise.all([client.readRecoverableRequest(row.id, { allowMobileRecoveryHandoff: true }), client.readRecoverableRequest(row.id, { allowMobileRecoveryHandoff: true })]);
    expect(results.every((result) => "transactionHash" in result && result.transactionHash === hash)).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1); expect(mints).toBe(1); client.dispose();
  });
  it("builds a read-only handoff with opaque IDs only and permits a later explicit retry", () => {
    const writes: string[] = [];
    vi.stubGlobal("window", { location: { set href(value: string) { writes.push(value); } } });
    const grant = { grantId: "10000000-0000-4000-8000-000000000001", requestId: "10000000-0000-4000-8000-000000000002", status: "pending_fulfillment" as const, scope: { ...scope, method: "signAndSubmitTransaction" as const }, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const session = { sessionId: "10000000-0000-4000-8000-000000000004", capabilities: { durableExternalSubmissionRecovery: true } } as InferExternalSession;
    mobileRelay.launchMobileRelayRecoveryRead(grant, "10000000-0000-4000-8000-000000000003", session);
    mobileRelay.launchMobileRelayRecoveryRead(grant, "10000000-0000-4000-8000-000000000003", session);
    expect(writes).toHaveLength(2);
    const url = new URL(writes[0]!);
    expect(url.protocol).toBe("inferenco:"); expect(url.hostname).toBe("recover");
    expect(Object.fromEntries(url.searchParams)).toEqual({ grantId: "10000000-0000-4000-8000-000000000001", requestId: "10000000-0000-4000-8000-000000000002", originSessionId: "10000000-0000-4000-8000-000000000003", authorizedSessionId: "10000000-0000-4000-8000-000000000004" });
  });
  it("does not deliver or persist evidence after authorization changes during a read", async () => {
    const { row, session } = await fixture();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      storeExternalSession({ ...session, address: "0x2" });
      return json({ grantId: "grant", requestId: row.requestId, status: "fulfilled", scope: { ...scope, method: row.method, invocationId: row.invocationId }, expiresAt: new Date(Date.now() + 60_000).toISOString(), redeliveredEncryptedResult: encryptJson(envelope(), session.sharedSecret!) });
    });
    expect(await readRecoverableRequest(row.id)).not.toHaveProperty("transactionHash");
    expect((await listDurableRequests())[0]).not.toHaveProperty("transactionHash");
  });
  it("fails closed if the durable evidence write cannot commit", async () => {
    const { row, session } = await fixture(); serve(session, envelope());
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (value?.externalTransactionRecovery) throw new Error("fixture-storage-unavailable");
      return original.call(this, value, key);
    });
    expect(await readRecoverableRequest(row.id)).not.toHaveProperty("transactionHash");
    expect((await listDurableRequests())[0]).not.toHaveProperty("transactionHash");
  });

  it("can progress from legacy-style started uncertainty to proved pre-submission failure", async () => {
    const { row, session } = await fixture();
    const unknown: Record<string, unknown> = envelope();
    delete unknown.transactionHash; delete unknown.submissionAcceptance; delete unknown.chainStatus;
    const first = serve(session, unknown);
    expect(await readRecoverableRequest(row.id)).toMatchObject({ status: "unknown" });
    first.mockRestore();
    serve(session, { ...unknown, status: "not-submitted", failureCode: "EXECUTION_FAILED_BEFORE_BROADCAST" });
    expect(await readRecoverableRequest(row.id)).toMatchObject({ status: "unknown", submissionDisposition: "not-submitted" });
  });

  it("verifies a directly rejected pre-broadcast failure through the encrypted grant before classifying it", async () => {
    const { row, session } = await fixture(true);
    const value: Record<string, unknown> = envelope({ status: "not-submitted", failureCode: "EXECUTION_FAILED_BEFORE_BROADCAST" });
    delete value.transactionHash; delete value.submissionAcceptance; delete value.chainStatus;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => json(String(input).endsWith("/read-grant")
      ? { grantId: "pre-broadcast-grant", requestId: row.requestId, status: "fulfilled", scope: { ...scope, method: row.method, invocationId: row.invocationId },
          expiresAt: new Date(Date.now() + 60_000).toISOString(), redeliveredEncryptedResult: encryptJson(value, session.sharedSecret!) }
      : { requestId: row.requestId, sessionId: session.sessionId, method: row.method, status: "rejected", errorCode: "EXECUTION_FAILED_BEFORE_BROADCAST",
          callbackUrl: window.location.href, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    expect(await readRecoverableRequest(row.id)).toMatchObject({ status: "unknown", submissionDisposition: "not-submitted" });
  });

});
