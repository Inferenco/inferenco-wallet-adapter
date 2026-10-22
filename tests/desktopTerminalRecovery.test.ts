import golden from "./fixtures/desktop-expiry-recovery-v1.json";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InferClient } from "../src/InferClient";
import { IDBObjectStore } from "fake-indexeddb";
import { readDesktopBridgeRequestOnce, readResultForSession, storeExternalSession, tryLocalBridgeSignAndSubmit } from "../src/bridge";
import { _setBridgeTokenForTesting, _resetBridgeTokenForTesting } from "../src/bridge/token";
import { canonicalAddress, requestCommitment } from "../src/integrationContract";
import { listDurableRequests, prepareDurableInvocation, saveDurableRequest, saveDurableExternalTransactionRecovery, saveDurableTransactionHash, saveDurableFinal, updateDurableInvocation } from "../src/durableRecovery";
import { acknowledgeRecoverableRequest, archiveRecoverableRequest, listRecoverableRequests, readRecoverableRequest, reconcileRecoverableInvocation } from "../src/recovery";
import type { InferExternalSession } from "../src/types";
import type { DurableRequest } from "../src/durableRecovery";

const token = "0123456789abcdef".repeat(4);
const bridge = "http://127.0.0.1:21984";
const hash = "0x" + "ab".repeat(32);
const payload = { contractVersion: 1, data: { function: "0x1::fixture::run", typeArguments: [], functionArguments: [] }, options: {} };
const scope = { origin: window.location.origin, accountAddress: canonicalAddress("0x1"), network: "testnet", chainId: 2 };
const commitment = requestCommitment("signAndSubmitTransaction", scope, payload);
const session: InferExternalSession = { transport: "desktop-bridge", address: "0x1", publicKey: "0x2", network: "testnet", chainId: 2,
  sessionId: "current", bridgeUrl: bridge + "/" + token, integrationContractVersion: 1,
  capabilities: { durableInvocationLookup: true, transactionRestrictions: true } };
function json(body: unknown) { return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }); }
async function fixture(oldSession = true) {
  _setBridgeTokenForTesting(token); storeExternalSession(session);
  const invocation = await prepareDurableInvocation({ ...session, sessionId: oldSession ? "retired" : "current" }, "signAndSubmitTransaction", {
    requestCommitment: commitment, requestPayload: payload, endpoint: bridge
  });
  const row = await saveDurableRequest({ version: 2, transport: "desktop-bridge", requestId: "original-request", invocationId: invocation.id,
    requestCommitment: commitment, requestPayload: payload, origin: scope.origin, sessionId: invocation.sessionId,
    address: "0x1", network: "testnet", chainId: 2, bridgeOrigin: bridge, method: "signAndSubmitTransaction" }, invocation.id);
  await updateDurableInvocation(invocation.id, "created", row.requestId);
  return row;
}
function evidence(row: DurableRequest, extra: Record<string, unknown> = {}) {
  return { recoverySchema: "infer-connect-transaction-recovery-v1", requestId: row.requestId, invocationId: row.invocationId,
    requestCommitment: row.requestCommitment, scope, method: "signAndSubmitTransaction", status: "not-submitted",
    failureCode: "EXECUTION_FAILED_BEFORE_BROADCAST", ...extra };
}
function response(row: DurableRequest, extra: Record<string, unknown> = {}) {
  return { contractVersion: 1, requestId: row.requestId, invocationId: row.invocationId, requestCommitment: row.requestCommitment,
    sessionId: session.sessionId, originalSessionId: row.sessionId, scope: { ...scope, transport: "desktop-bridge", method: row.method },
    status: "failed", payload: { error: "This transaction expired before approval." }, finalizedAt: "2026-10-22T12:45:04Z",
    transactionRecovery: evidence(row), ...extra };
}
function serve(row: DurableRequest, value: unknown = response(row), failAck = false) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/read-result/")) { expect(init?.method).not.toBe("POST"); return json(value); }
    if (url.includes("/acknowledge-result/")) {
      expect(init?.method).toBe("POST"); const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ sessionId: session.sessionId, invocationId: row.invocationId, requestCommitment: row.requestCommitment });
      if (failAck) throw new Error("ack response lost");
      return json({ ...response(row), status: "acknowledged", method: row.method });
    }
    throw new Error("Recovery cannot create, sign, relaunch or cancel a request: " + url);
  });
}
afterEach(() => { localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); _resetBridgeTokenForTesting(); });

describe("desktop terminal non-submission recovery", () => {
  it("decodes the unchanged cross-workspace golden fixture with the actual scoped read API", async () => {
    _setBridgeTokenForTesting(token);
    const wire = golden.envelope;
    const originalWindow = window;
    vi.stubGlobal("window", { location: { origin: wire.scope.origin }, setTimeout: originalWindow.setTimeout.bind(originalWindow), clearTimeout: originalWindow.clearTimeout.bind(originalWindow) });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(wire));
    expect(await readResultForSession({
      invocationId: wire.invocationId, requestCommitment: wire.requestCommitment,
      requestPayload: golden.requestPayload, originalSessionId: wire.originalSessionId,
      bridgeOrigin: bridge, requestId: wire.requestId, newSessionId: wire.sessionId,
      scope: { ...wire.scope, transport: "desktop-bridge", method: "signAndSubmitTransaction" },
      session: { ...session, sessionId: wire.sessionId }
    })).toEqual({ ok: true, status: "not-submitted", transactionRecovery: wire.transactionRecovery });
  });
  it("recovers the original failure through a new authorized session, persists, and replays after reload without network", async () => {
    const row = await fixture(); const fetch = serve(row);
    expect(await reconcileRecoverableInvocation(row.invocationId!)).toMatchObject({ status: "unknown", requestId: row.requestId,
      invocationId: row.invocationId, submissionDisposition: "not-submitted", failureCode: "EXECUTION_FAILED_BEFORE_BROADCAST" });
    expect((await listDurableRequests())[0]).toMatchObject({ state: "active", externalTransactionRecovery: evidence(row) });
    expect(fetch).toHaveBeenCalledTimes(1); localStorage.clear(); sessionStorage.clear(); fetch.mockClear();
    expect(await readRecoverableRequest(row.id)).toMatchObject({ status: "unknown", submissionDisposition: "not-submitted" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(archiveRecoverableRequest(row.id, "not-a-retry")).rejects.toThrow("must be acknowledged");
  });
  it("uses the ordinary poll recovery path when the current session lacks the optional lookup capability", async () => {
    const row = await fixture(false); storeExternalSession({ ...session, capabilities: {} });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(init?.method).not.toBe("POST"); expect(String(input)).toContain("/transaction-request/"); return json(response(row));
    });
    expect(await readDesktopBridgeRequestOnce(row.requestId, session, {}, row.pending as never)).toMatchObject({ status: "not-submitted", transactionRecovery: evidence(row) });
    expect(await readRecoverableRequest(row.id)).toMatchObject({ status: "unknown", submissionDisposition: "not-submitted" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("persists a normal signing-poll failure before throwing a scoped unknown instead of UserRejected", async () => {
    _setBridgeTokenForTesting(token); storeExternalSession(session);
    let requestBody: Record<string, unknown>;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (init?.method === "POST") { requestBody = JSON.parse(String(init.body)); return json({ requestId: "normal-poll" }); }
      const [row] = await listDurableRequests();
      expect(row.invocationId).toBe(requestBody.invocationId);
      return json(response(row));
    });
    await expect(tryLocalBridgeSignAndSubmit(payload as never, session)).rejects.toMatchObject({ code: "REQUEST_OUTCOME_UNKNOWN", requestId: "normal-poll" });
    const [row] = await listDurableRequests(); expect(row.externalTransactionRecovery?.status).toBe("not-submitted");
    const calls = fetch.mock.calls.length;
    expect(await readRecoverableRequest(row.id)).toMatchObject({ status: "unknown", submissionDisposition: "not-submitted" });
    expect(fetch).toHaveBeenCalledTimes(calls);
  });
  it.each([undefined, null, {}, { error: "Unsupported transaction payload format." }])("keeps a bare failed result unresolved: %j", async (value) => {
    const row = await fixture(); const wire = response(row); delete (wire as { transactionRecovery?: unknown }).transactionRecovery;
    serve(row, { ...wire, payload: value });
    expect(await readRecoverableRequest(row.id)).not.toHaveProperty("submissionDisposition");
    expect((await listDurableRequests())[0]).not.toHaveProperty("externalTransactionRecovery");
  });
  it.each([
    { requestId: "other" }, { invocationId: "other" }, { requestCommitment: "0".repeat(64) },
    { scope: { ...scope, origin: "https://foreign.example" } }, { scope: { ...scope, accountAddress: canonicalAddress("0x2") } },
    { scope: { ...scope, network: "mainnet" } }, { scope: { ...scope, chainId: 1 } },
    { recoverySchema: "unknown-v2" }, { method: "signMessage" }, { unexpected: true },
    { transactionHash: hash }, { submissionAcceptance: "accepted" }, { chainStatus: "unknown" }, { chainVersion: "42" },
    { failureCode: "some-generic-error" }
  ])("rejects substituted or contradictory inner evidence %j", async (extra) => {
    const row = await fixture(); serve(row, response(row, { transactionRecovery: evidence(row, extra) }));
    expect(await readRecoverableRequest(row.id)).not.toHaveProperty("submissionDisposition");
    expect((await listDurableRequests())[0]).not.toHaveProperty("externalTransactionRecovery");
  });
  it.each([
    { contractVersion: 2 }, { requestId: "other" }, { invocationId: "other" }, { requestCommitment: "0".repeat(64) },
    { sessionId: "foreign-session" }, { originalSessionId: "different-original" }, { hash },
    { scope: { ...scope, transport: "mobile-relay", method: "signAndSubmitTransaction" } },
    { scope: { ...scope, transport: "desktop-bridge", method: "signMessage" } }
  ])("rejects changed outer envelope %j", async (extra) => {
    const row = await fixture(); serve(row, response(row, extra));
    expect(await readRecoverableRequest(row.id)).not.toHaveProperty("submissionDisposition");
  });
  it("recomputes the commitment from original input rather than accepting matching strings alone", async () => {
    const row = await fixture(); serve(row);
    expect(await readResultForSession({ invocationId: row.invocationId, requestCommitment: commitment, requestPayload: { changed: true }, originalSessionId: row.sessionId,
      requestId: row.requestId, bridgeOrigin: bridge, newSessionId: session.sessionId, scope: { ...scope, transport: "desktop-bridge", method: row.method }, session })).toEqual({ ok: false, reason: "unavailable" });
  });
  it("retains unknown if session authority changes during a remote read", async () => {
    const row = await fixture(); vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      storeExternalSession({ ...session, address: "0x2" }); return json(response(row));
    });
    expect(await readRecoverableRequest(row.id)).not.toHaveProperty("submissionDisposition");
    expect((await listDurableRequests())[0]).not.toHaveProperty("externalTransactionRecovery");
  });
  it("fails closed when evidence cannot be durably saved", async () => {
    const row = await fixture(); serve(row);
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (value?.externalTransactionRecovery) throw new Error("fixture disk failure"); return original.call(this, value, key);
    });
    expect(await readRecoverableRequest(row.id)).not.toHaveProperty("submissionDisposition");
    expect((await listDurableRequests())[0]).not.toHaveProperty("externalTransactionRecovery");
  });
  it.each(["hash", "approved", "rejected"])("never downgrades retained %s into not-submitted", async (known) => {
    const row = await fixture();
    if (known === "hash") await saveDurableTransactionHash(row.id, hash);
    else await saveDurableFinal(row.id, known === "approved" ? { status: "approved", method: row.method, hash } as never : { status: "rejected" });
    await expect(saveDurableExternalTransactionRecovery(row.id, evidence(row))).rejects.toThrow();
    expect((await listDurableRequests())[0]).not.toHaveProperty("externalTransactionRecovery");
  });
  it("atomically permits either a known hash or terminal failure to win a competing write, never both", async () => {
    const row = await fixture(); const results = await Promise.allSettled([
      saveDurableExternalTransactionRecovery(row.id, evidence(row)), saveDurableTransactionHash(row.id, hash)
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [stored] = await listDurableRequests();
    expect(!!stored.transactionHash).not.toBe(stored.externalTransactionRecovery?.status === "not-submitted");
  });
  it("revalidates before remote acknowledgement and retains debt when acknowledgement fails", async () => {
    const row = await fixture(); let fetch = serve(row); await readRecoverableRequest(row.id); fetch.mockRestore();
    fetch = serve(row, response(row), true);
    await expect(acknowledgeRecoverableRequest(row.id)).rejects.toThrow();
    expect((await listDurableRequests())[0]).toMatchObject({ state: "active", externalTransactionRecovery: evidence(row) });
    localStorage.clear(); sessionStorage.clear(); storeExternalSession(session); fetch.mockRestore();
    fetch = serve(row); await acknowledgeRecoverableRequest(row.id);
    expect(await listRecoverableRequests()).toEqual([]);
    expect((await listDurableRequests())[0].state).toBe("acknowledged");
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname.split("/").at(-2))).toEqual(["read-result", "acknowledge-result"]);
    expect(await readRecoverableRequest(row.id)).toMatchObject({ submissionDisposition: "not-submitted" });
  });
  it("replays to late subscribers and keeps terminal evidence if consumer persistence fails", async () => {
    const row = await fixture(); const fetch = serve(row); await readRecoverableRequest(row.id);
    const client = new InferClient(); const failed = vi.fn(async () => { throw new Error("consumer journal write failed"); });
    const stop = client.subscribeRecoveredOutcomes(failed);
    await vi.waitFor(() => expect(failed).toHaveBeenCalled()); stop();
    expect((await listDurableRequests())[0].state).toBe("active");
    const accepted = vi.fn(); client.subscribeRecoveredOutcomes(accepted);
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledWith(expect.objectContaining({
      requestId: row.requestId, invocationId: row.invocationId, status: "unknown", submissionDisposition: "not-submitted"
    })));
    expect(fetch).toHaveBeenCalledTimes(1); client.dispose();
  });
  it("treats concurrent identical evidence merges as one durable change regardless of property order", async () => {
    const row = await fixture();
    const value = evidence(row);
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    const results = await Promise.all([
      saveDurableExternalTransactionRecovery(row.id, value), saveDurableExternalTransactionRecovery(row.id, reordered)
    ]);
    expect(results[0].revision).toBe(row.revision + 1);
    expect(results[1].revision).toBe(results[0].revision);
    expect(results[1].updatedAt).toBe(results[0].updatedAt);
    const puts = vi.spyOn(IDBObjectStore.prototype, "put");
    await saveDurableExternalTransactionRecovery(row.id, reordered);
    expect(puts).not.toHaveBeenCalled();
  });
  it("does not wake its own recovery subscription repeatedly when remote acknowledgement fails", async () => {
    const channels = new Set<TestChannel>();
    const posts = vi.fn();
    class TestChannel {
      listeners = new Set<(event: MessageEvent) => void>();
      constructor(readonly name: string) { channels.add(this); }
      addEventListener(type: string, listener: (event: MessageEvent) => void) { if (type === "message") this.listeners.add(listener); }
      removeEventListener(type: string, listener: (event: MessageEvent) => void) { if (type === "message") this.listeners.delete(listener); }
      postMessage(data: unknown) {
        posts(this.name);
        for (const peer of [...channels]) if (peer !== this && peer.name === this.name) {
          queueMicrotask(() => { for (const listener of peer.listeners) listener({ data } as MessageEvent); });
        }
      }
      close() { channels.delete(this); this.listeners.clear(); }
    }
    vi.stubGlobal("BroadcastChannel", TestChannel);
    const row = await fixture(); const fetch = serve(row, response(row), true);
    await readRecoverableRequest(row.id);
    const before = (await listDurableRequests())[0]; posts.mockClear(); fetch.mockClear();
    const client = new InferClient();
    // Let the constructor's initial storage scan finish before adding a consumer.
    await client.listRecoverableRequests(); await new Promise((resolve) => setTimeout(resolve, 0));
    const accept = vi.fn(async () => {
      // Bound the failing implementation so this regression reports instead of
      // keeping a notification feedback loop alive after the test fails.
      if (accept.mock.calls.length >= 3) client.dispose();
      await acknowledgeRecoverableRequest(row.id);
    });
    const stop = client.subscribeRecoveredOutcomes(accept);
    try {
      await vi.waitFor(() => expect(accept).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(accept).toHaveBeenCalledTimes(1);
      expect(posts).not.toHaveBeenCalled();
      expect((await listDurableRequests())[0]).toMatchObject({ state: "active", revision: before.revision, updatedAt: before.updatedAt });
      expect(fetch.mock.calls.filter(([url]) => String(url).includes("/acknowledge-result/"))).toHaveLength(1);
      // A later real wake still retries the retained acknowledgement debt.
      window.dispatchEvent(new Event("focus"));
      await vi.waitFor(() => expect(accept).toHaveBeenCalledTimes(2));
      expect((await listDurableRequests())[0].state).toBe("active");
    } finally { stop(); client.dispose(); }
  });
  it("retains local acknowledgement debt if authorization changes during remote acknowledgement", async () => {
    const row = await fixture(); const read = serve(row); await readRecoverableRequest(row.id); read.mockRestore();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/acknowledge-result/")) {
        storeExternalSession({ ...session, address: "0x2" });
        return json({ ...response(row), status: "acknowledged", method: row.method });
      }
      return json(response(row));
    });
    await expect(acknowledgeRecoverableRequest(row.id)).rejects.toThrow("authority changed");
    expect((await listDurableRequests())[0].state).toBe("active");
  });
  it("does not waive terminal-failure acknowledgement because the original session lacked the capability", async () => {
    const row = await fixture();
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open("inferenco:infer-recovery"); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve) => { const tx = db.transaction("requests", "readwrite"); tx.objectStore("requests").put({ ...row, remoteAcknowledgementRequired: false }); tx.oncomplete = () => resolve(); }); db.close();
    const fetch = serve(row); await readRecoverableRequest(row.id); fetch.mockClear();
    await acknowledgeRecoverableRequest(row.id);
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/acknowledge-result/"))).toBe(true);
  });
  it("does not acknowledge a terminal result that the wallet can no longer revalidate", async () => {
    const row = await fixture(); const fetch = serve(row); await readRecoverableRequest(row.id); fetch.mockRestore();
    const next = serve(row, response(row, { transactionRecovery: undefined }));
    await expect(acknowledgeRecoverableRequest(row.id)).rejects.toThrow();
    expect(next.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
    expect((await listDurableRequests())[0].state).toBe("active");
  });
});
