import { afterEach, describe, expect, it, vi } from "vitest";
import { InferClient } from "../src/InferClient";
import { InferAdapterError, InferErrorCode, unresolvedRequestError } from "../src/errors";
import { storeExternalSession, tryLocalBridgeSignAndSubmit } from "../src/bridge";
import { _resetBridgeTokenForTesting, _setBridgeTokenForTesting } from "../src/bridge/token";
import { createKeyPair, deriveSharedSecret, encryptJson } from "../src/mobileCrypto";
import { signAndSubmitViaMobileRelay } from "../src/mobileRelay";
import {
  listDurableRequests, saveDurableRequest, transitionDurableRequest
} from "../src/durableRecovery";
import {
  acknowledgeRecoverableRequest, archiveRecoverableRequest,
  listArchivedRecoverableRequests, listRecoverableInvocations,
  listRecoverableRequests, readRecoverableRequest
} from "../src/recovery";
import type { PendingDesktopBridgeRequest } from "../src/desktopRequests";
import type { InferExternalSession } from "../src/types";

const token = "0123456789abcdef".repeat(4);
const hash = "0x" + "ab".repeat(32);
const session: InferExternalSession = {
  transport: "desktop-bridge", address: "0x1", publicKey: "0x2",
  network: "testnet", chainId: 2, sessionId: "session-one",
  bridgeUrl: "http://127.0.0.1:21984/" + token
};

function pending(requestId: string, sessionId = session.sessionId): PendingDesktopBridgeRequest {
  return {
    version: 2, transport: "desktop-bridge", requestId,
    method: "signAndSubmitTransaction", sessionId,
    address: session.address, network: session.network, chainId: session.chainId,
    origin: window.location.origin, bridgeOrigin: new URL(session.bridgeUrl!).origin
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { "Content-Type": "application/json" }
  });
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetBridgeTokenForTesting();
});

describe("durable recovery across page and session boundaries", () => {
  it("keeps a post-dispatch nested rejection error classified as unknown", () => {
    const error = unresolvedRequestError("result unreadable", "invocation", "request",
      new InferAdapterError(InferErrorCode.UserRejected, "untrusted status"));
    expect(error).toMatchObject({
      code: "REQUEST_OUTCOME_UNKNOWN", dispatch: "unknown",
      invocationId: "invocation", requestId: "request"
    });
  });

  it("recovers in a replacement tab with no sessionStorage and never repeats request creation", async () => {
    _setBridgeTokenForTesting(token);
    storeExternalSession(session);
    const row = await saveDurableRequest(pending("new-tab-request"));
    window.sessionStorage.clear();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(init?.method).not.toBe("POST");
      expect(String(input)).toContain("/transaction-request/new-tab-request");
      return json({ status: "approved", requestId: "new-tab-request", hash });
    });
    expect(await listRecoverableRequests()).toMatchObject([{ recoveryId: row.id }]);
    expect(await readRecoverableRequest(row.id)).toMatchObject({
      status: "approved", output: { hash }
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    window.localStorage.clear();
    expect(await readRecoverableRequest(row.id)).toMatchObject({
      status: "approved", output: { hash }
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await Promise.all([
      acknowledgeRecoverableRequest(row.id),
      acknowledgeRecoverableRequest(row.id)
    ]);
    expect(await listRecoverableRequests()).toEqual([]);
  });

  it("saves a direct desktop approval before returning its hash", async () => {
    _setBridgeTokenForTesting(token);
    storeExternalSession(session);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (init?.method === "POST") return json({ requestId: "direct-desktop" });
      expect(String(input)).toContain("/transaction-request/direct-desktop");
      return json({ status: "approved", requestId: "direct-desktop", hash });
    });
    await expect(tryLocalBridgeSignAndSubmit({} as never, session)).resolves.toEqual({ hash });
    const [row] = await listRecoverableRequests();
    const calls = fetch.mock.calls.length;
    window.localStorage.clear();
    expect(await readRecoverableRequest(row.recoveryId)).toMatchObject({
      status: "approved", output: { hash }
    });
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it("saves a direct mobile approval before returning its hash", async () => {
    const dapp = createKeyPair(), wallet = createKeyPair();
    const mobile: InferExternalSession = {
      transport: "mobile-relay", address: "0x1", publicKey: "0x2",
      network: "testnet", chainId: 2, sessionId: "mobile-one",
      relayBaseUrl: "https://relay.example", dappSessionToken: "fixture-token",
      sharedSecret: deriveSharedSecret(dapp.privateKey, wallet.publicKey)
    };
    storeExternalSession(mobile);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "POST") {
        return json({ requestId: "direct-mobile", walletDeeplinkUrl: window.location.href, expiresAt });
      }
      return json({
        requestId: "direct-mobile", sessionId: mobile.sessionId,
        method: "signAndSubmitTransaction", status: "approved",
        callbackUrl: window.location.href, expiresAt,
        encryptedResult: encryptJson({ hash }, mobile.sharedSecret!)
      });
    });
    await expect(signAndSubmitViaMobileRelay({} as never, mobile,
      { mobileRequestTimeoutMs: 100 })).resolves.toEqual({ hash });
    const [row] = await listRecoverableRequests();
    const calls = fetch.mock.calls.length;
    window.localStorage.clear();
    expect(await readRecoverableRequest(row.recoveryId)).toMatchObject({
      status: "approved", output: { hash }
    });
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it("does not call a cached mobile token a validated live connection", async () => {
    storeExternalSession({
      transport: "mobile-relay", address: "0x1", publicKey: "0x2",
      network: "testnet", chainId: 2, sessionId: "mobile-health",
      relayBaseUrl: "https://relay.example", dappSessionToken: "fixture-token",
      sharedSecret: "fixture-secret"
    });
    const client = new InferClient();
    expect(await client.checkConnectionHealth()).toMatchObject({
      state: "checking", identity: { sessionId: "mobile-health" }
    });
    client.dispose();
  });

  it("keeps an older unresolved session unknown after reconnect, and allows explicit archive", async () => {
    storeExternalSession(session);
    const row = await saveDurableRequest(pending("old-request"));
    storeExternalSession({ ...session, sessionId: "session-two", address: "0x3" });
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(await readRecoverableRequest(row.id)).toMatchObject({
      status: "unknown", requestId: "old-request"
    });
    expect(fetch).not.toHaveBeenCalled();
    await archiveRecoverableRequest(row.id, "chain-check:old-request");
    expect(await listRecoverableRequests()).toEqual([]);
    expect(await listArchivedRecoverableRequests()).toMatchObject([{
      recoveryId: row.id, reconciliationReference: "chain-check:old-request"
    }]);
  });

  it("replays a verified result to a late subscriber and keeps it after callback failure", async () => {
    _setBridgeTokenForTesting(token);
    storeExternalSession(session);
    const row = await saveDurableRequest(pending("late-request"));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json({ status: "approved", requestId: "late-request", hash }));
    expect(await readRecoverableRequest(row.id)).toMatchObject({ status: "approved" });
    const failed = vi.fn(async () => { throw new Error("journal write failed"); });
    const client = new InferClient();
    const unsubscribe = client.subscribeRecoveredOutcomes(failed);
    await vi.waitFor(() => expect(failed).toHaveBeenCalled());
    unsubscribe();
    const delivered = vi.fn();
    client.subscribeRecoveredOutcomes(delivered);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith(expect.objectContaining({
      recoveryId: row.id, status: "approved", output: { hash }
    })));
    expect(await listRecoverableRequests()).toHaveLength(1);
    client.dispose();
  });

  it("persists an invocation before POST and reports a pre-dispatch hook failure", async () => {
    _setBridgeTokenForTesting(token);
    storeExternalSession(session);
    const fetch = vi.spyOn(globalThis, "fetch");
    let invocationId = "";
    await expect(tryLocalBridgeSignAndSubmit({} as never, session, {
      onInvocationPrepared: async (invocation) => {
        invocationId = invocation.invocationId;
        throw new Error("consumer journal unavailable");
      }
    })).rejects.toMatchObject({
      code: "REQUEST_NOT_INVOKED", dispatch: "not-invoked", requestId: null
    });
    expect(invocationId).not.toBe("");
    expect(fetch).not.toHaveBeenCalled();
    expect(await listRecoverableInvocations()).toMatchObject([{
      invocationId, state: "not-invoked"
    }]);
  });

  it("keeps tokens and signing credentials out of the durable request and public receipt", async () => {
    storeExternalSession(session);
    const row = await saveDurableRequest(pending("no-secret"));
    const serialized = JSON.stringify(await listDurableRequests());
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("sharedSecret");
    expect(serialized).not.toContain("dappSessionToken");
    expect(row.endpoint).toBe("http://127.0.0.1:21984");
  });

  it("refuses signing before dispatch when persistent storage is unavailable", async () => {
    _setBridgeTokenForTesting(token);
    storeExternalSession(session);
    vi.stubGlobal("indexedDB", undefined);
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(tryLocalBridgeSignAndSubmit({} as never, session))
      .rejects.toMatchObject({ code: "REQUEST_NOT_INVOKED", dispatch: "not-invoked" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("skips a corrupted IndexedDB row without hiding valid requests", async () => {
    const row = await saveDurableRequest(pending("valid"));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("inferenco:infer-recovery", 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("requests", "readwrite");
      tx.objectStore("requests").put({
        id: "corrupt", origin: window.location.origin, requestId: "bad",
        state: "active", pending: { version: 2 }
      });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    expect(await listRecoverableRequests()).toMatchObject([{ recoveryId: row.id }]);
  });

  it("rejects conflicting archive and acknowledge transitions in one exact-record transaction", async () => {
    const row = await saveDurableRequest(pending("race"));
    await expect(transitionDurableRequest(row.id, "acknowledge"))
      .rejects.toThrow("Recovery record changed");
    await transitionDurableRequest(row.id, "archive", {
      archivedAt: new Date().toISOString(), reconciliationReference: "independent-chain-check"
    });
    await expect(transitionDurableRequest(row.id, "acknowledge"))
      .rejects.toThrow("Recovery record changed");
  });
});
