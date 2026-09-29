import {
  storeExternalSession,
  tryLocalBridgeSignAndSubmit,
  tryLocalBridgeSignMessage,
  tryLocalBridgeSignTransaction
} from "../src/bridge";
import { InferClient } from "../src/InferClient";
import { InferWallet } from "../src/InferWallet";
import { storePendingDesktopBridgeRequest } from "../src/desktopRequests";
import { createInferAIP62Wallet } from "../src/aip62";
import { _setBridgeTokenForTesting, _resetBridgeTokenForTesting } from "../src/bridge/token";
import { INFER_CALLBACK_MARKER_STORAGE_KEY } from "../src/constants";
import { createKeyPair, deriveSharedSecret, encryptJson } from "../src/mobileCrypto";
import { storePendingMobileRelayRequest } from "../src/mobileRequests";
import {
  acknowledgeRecoverableRequest,
  archiveRecoverableRequest,
  listArchivedRecoverableRequests,
  listRecoverableRequests,
  readRecoverableRequest
} from "../src/recovery";
import type { InferExternalSession } from "../src/types";

const token = "0123456789abcdef".repeat(4);
const hash = "0x" + "ab".repeat(32);
const desktop: InferExternalSession = {
  transport: "desktop-bridge", address: "0x1", publicKey: "0x2",
  network: "testnet", chainId: 2, sessionId: "desktop-session",
  bridgeUrl: "http://127.0.0.1:21984"
};

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
  vi.useRealTimers();
});

describe("exact-ID signing recovery", () => {
  it("keeps a timed-out desktop submission and reads its later hash without another POST or cancel", async () => {
    _setBridgeTokenForTesting(token);
    storeExternalSession(desktop);
    let approved = false;
    let posts = 0;
    let cancels = 0;
    const hook = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/transaction")) {
        posts++;
        return json({ requestId: "desktop-request" });
      }
      if (url.includes("/cancel/")) {
        cancels++;
        throw new Error("Recovery must not cancel");
      }
      if (url.endsWith("/session/desktop-session")) return json(desktop);
      if (url.endsWith("/transaction-request/desktop-request")) {
        expect(hook).toHaveBeenCalledTimes(1);
        return json(approved
          ? { status: "approved", requestId: "desktop-request", hash }
          : { status: "pending", requestId: "desktop-request" });
      }
      throw new Error("Unexpected request: " + url);
    });
    await expect(tryLocalBridgeSignAndSubmit({} as never, desktop,
      { bridgePollTimeoutMs: 0, onRequestCreated: hook }))
      .rejects.toMatchObject({ code: "REQUEST_OUTCOME_UNKNOWN", requestId: "desktop-request" });
    expect(posts).toBe(1);
    expect(cancels).toBe(0);
    expect(await listRecoverableRequests()).toMatchObject([{
      requestId: "desktop-request", method: "signAndSubmitTransaction", transport: "desktop-bridge"
    }]);
    await expect(acknowledgeRecoverableRequest("desktop-request"))
      .rejects.toThrow("verified final outcome");
    expect(await readRecoverableRequest("desktop-request")).toMatchObject({ status: "pending" });
    approved = true;
    expect(await readRecoverableRequest("desktop-request")).toMatchObject({
      requestId: "desktop-request", method: "signAndSubmitTransaction",
      transport: "desktop-bridge", status: "approved", output: { hash }
    });
    await acknowledgeRecoverableRequest("desktop-request");
    expect(await listRecoverableRequests()).toEqual([]);
    expect(posts).toBe(1);
    expect(cancels).toBe(0);
  });

  it("treats a different desktop request ID as unknown and retains the receipt", async () => {
    _setBridgeTokenForTesting(token);
    storeExternalSession(desktop);
    window.sessionStorage.setItem("inferenco:infer-pending-desktop-request:desktop-request",
      JSON.stringify({ version: 1, transport: "desktop-bridge", requestId: "desktop-request",
        sessionId: desktop.sessionId, address: desktop.address, network: desktop.network,
        chainId: desktop.chainId, origin: window.location.origin,
        bridgeBaseUrl: desktop.bridgeUrl, method: "signAndSubmitTransaction" }));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/session/desktop-session")) return json(desktop);
      if (url.endsWith("/transaction-request/desktop-request")) {
        return json({ status: "approved", requestId: "other-request", hash });
      }
      throw new Error("Unexpected request: " + url);
    });
    expect(await readRecoverableRequest("desktop-request")).toMatchObject({ status: "unknown" });
    await expect(acknowledgeRecoverableRequest("desktop-request"))
      .rejects.toThrow("verified final outcome");
    expect(await listRecoverableRequests()).toHaveLength(1);
  });

  it("decrypts a mobile result after reload and clears only the exact callback and receipt", async () => {
    const dapp = createKeyPair(), wallet = createKeyPair();
    const mobile: InferExternalSession = {
      transport: "mobile-relay", address: "0x1", publicKey: "0x2",
      network: "testnet", chainId: 2, sessionId: "mobile-session",
      relayBaseUrl: "https://relay.example", dappSessionToken: "fixture-token",
      sharedSecret: deriveSharedSecret(dapp.privateKey, wallet.publicKey)
    };
    storeExternalSession(mobile);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    storePendingMobileRelayRequest({
      version: 1, requestId: "mobile-request", sessionId: mobile.sessionId,
      address: mobile.address, network: mobile.network, chainId: mobile.chainId,
      relayBaseUrl: mobile.relayBaseUrl!, origin: window.location.origin,
      method: "signAndSubmitTransaction", expiresAt
    });
    window.sessionStorage.setItem(INFER_CALLBACK_MARKER_STORAGE_KEY,
      JSON.stringify({ requestId: "different-request", status: "approved" }));
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(init?.method).not.toBe("POST");
      expect(String(input)).toBe("https://relay.example/v1/requests/mobile-request");
      return json({ requestId: "mobile-request", sessionId: mobile.sessionId,
        method: "signAndSubmitTransaction", status: "approved",
        encryptedResult: encryptJson({ hash }, mobile.sharedSecret!),
        callbackUrl: window.location.href, expiresAt });
    });
    expect(await readRecoverableRequest("mobile-request")).toMatchObject({
      status: "approved", output: { hash }
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(INFER_CALLBACK_MARKER_STORAGE_KEY))
      .toContain("different-request");
    await acknowledgeRecoverableRequest("mobile-request");
    expect(await listRecoverableRequests()).toEqual([]);
  });

  it("keeps a desktop receipt visible when the bridge is offline", async () => {
    _setBridgeTokenForTesting(token);
    storeExternalSession(desktop);
    storePendingDesktopBridgeRequest({
      version: 2, transport: "desktop-bridge", requestId: "offline-request",
      sessionId: desktop.sessionId, address: desktop.address,
      network: desktop.network, chainId: desktop.chainId,
      origin: window.location.origin, bridgeOrigin: new URL(desktop.bridgeUrl!).origin,
      method: "signAndSubmitTransaction"
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await listRecoverableRequests()).toHaveLength(1);
    expect(await readRecoverableRequest("offline-request")).toMatchObject({ status: "unknown" });
    expect(await listRecoverableRequests()).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("maps only a clean exact-ID desktop rejection and retains ambiguous replies", async () => {
    _setBridgeTokenForTesting(token);
    storeExternalSession(desktop);
    for (const requestId of ["rejected-one", "mixed-two"]) {
      storePendingDesktopBridgeRequest({
        version: 2, transport: "desktop-bridge", requestId,
        sessionId: desktop.sessionId, address: desktop.address,
        network: desktop.network, chainId: desktop.chainId,
        origin: window.location.origin, bridgeOrigin: new URL(desktop.bridgeUrl!).origin,
        method: "signAndSubmitTransaction"
      });
    }
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/session/desktop-session")) return json(desktop);
      if (url.endsWith("/transaction-request/rejected-one")) {
        return json({ status: "rejected", requestId: "rejected-one", error: "User rejected" });
      }
      if (url.endsWith("/transaction-request/mixed-two")) {
        return json({ status: "rejected", requestId: "mixed-two", hash });
      }
      throw new Error("Unexpected request: " + url);
    });
    expect(await readRecoverableRequest("rejected-one")).toMatchObject({ status: "rejected" });
    expect(await readRecoverableRequest("mixed-two")).toMatchObject({ status: "unknown" });
    await acknowledgeRecoverableRequest("rejected-one");
    expect(await listRecoverableRequests()).toMatchObject([{
      requestId: "mixed-two", method: "signAndSubmitTransaction", transport: "desktop-bridge"
    }]);
  });

  it("exposes the recovery feature and reports storage denial instead of an empty list", async () => {
    storeExternalSession({ ...desktop, transport: "mobile-relay" });
    const wallet = createInferAIP62Wallet();
    expect(wallet.features).toHaveProperty("inferenco:recoveredOutcomes");
    vi.stubGlobal("indexedDB", undefined);
    await expect(listRecoverableRequests()).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("does not list a request bound to another origin or session", async () => {
    storeExternalSession({ ...desktop, transport: "mobile-relay" });
    storePendingMobileRelayRequest({
      version: 1, requestId: "foreign", sessionId: "other-session",
      address: "0x1", network: "testnet", chainId: 2,
      relayBaseUrl: "https://relay.example", origin: "https://other.example",
      method: "signAndSubmitTransaction", expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    expect(await listRecoverableRequests()).toEqual([]);
    await expect(readRecoverableRequest("foreign")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("recovery repair boundaries", () => {
  it("writes token-free receipts and migrates an exact-bound legacy receipt", async () => {
    const tokenUrl = "http://127.0.0.1:21984/" + token;
    const session = { ...desktop, bridgeUrl: tokenUrl };
    _setBridgeTokenForTesting(token);
    storeExternalSession(session);
    const created = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/transaction")) return json({ requestId: "token-free" });
      if (url.endsWith("/transaction-request/token-free")) return json({ status: "pending", requestId: "token-free" });
      throw new Error("Unexpected request: " + url);
    });
    await expect(tryLocalBridgeSignAndSubmit({} as never, session,
      { bridgePollTimeoutMs: 0, onRequestCreated: created }))
      .rejects.toMatchObject({ code: "REQUEST_OUTCOME_UNKNOWN", requestId: "token-free" });
    expect(JSON.stringify(created.mock.calls[0]?.[0])).not.toContain(token);
    const key = "inferenco:infer-pending-desktop-request:token-free";
    expect(window.sessionStorage.getItem(key)).not.toContain(token);
    expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({
      version: 2, bridgeOrigin: "http://127.0.0.1:21984"
    });
    const oldKey = "inferenco:infer-pending-desktop-request:legacy";
    window.sessionStorage.setItem(oldKey, JSON.stringify({
      version: 1, transport: "desktop-bridge", requestId: "legacy",
      sessionId: session.sessionId, address: session.address, network: session.network,
      chainId: session.chainId, origin: window.location.origin,
      bridgeBaseUrl: tokenUrl, method: "signAndSubmitTransaction"
    }));
    expect(await listRecoverableRequests()).toHaveLength(2);
    expect(window.sessionStorage.getItem(oldKey)).not.toContain(token);
  });

  it("bounds a hidden desktop poll and leaves the request recoverable", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    _setBridgeTokenForTesting(token);
    storeExternalSession(desktop);
    let reads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/transaction")) {
        return json({ requestId: "hidden-desktop" });
      }
      if (url.endsWith("/transaction-request/hidden-desktop")) {
        reads++;
        return json({ requestId: "hidden-desktop", status: "pending" });
      }
      throw new Error("Unexpected request: " + url);
    });
    const result = tryLocalBridgeSignAndSubmit({} as never, desktop,
      { bridgePollTimeoutMs: 20, bridgePollIntervalMs: 10000 });
    await expect(result).rejects.toMatchObject({
      code: "REQUEST_OUTCOME_UNKNOWN", requestId: "hidden-desktop"
    });
    expect(reads).toBe(2);
    expect(await listRecoverableRequests()).toHaveLength(1);
  });

  it.each(["signMessage", "signTransaction", "signAndSubmitTransaction"] as const)(
    "rejects a missing desktop request ID for %s", async (method) => {
      _setBridgeTokenForTesting(token);
      storeExternalSession(desktop);
      storePendingDesktopBridgeRequest({
        version: 2, transport: "desktop-bridge", requestId: "missing-id",
        sessionId: desktop.sessionId, address: desktop.address,
        network: desktop.network, chainId: desktop.chainId,
        origin: window.location.origin, bridgeOrigin: new URL(desktop.bridgeUrl!).origin,
        method
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input).endsWith("/session/desktop-session")) return json(desktop);
        return json({ status: "approved", hash });
      });
      expect(await readRecoverableRequest("missing-id")).toMatchObject({ status: "unknown" });
      await expect(acknowledgeRecoverableRequest("missing-id"))
      .rejects.toThrow("verified final outcome");
    }
  );

  it("reads through the configured bridge host when a session URL names another host", async () => {
    _setBridgeTokenForTesting(token);
    const session = { ...desktop, bridgeUrl: "https://untrusted.example/" + token };
    const options = { bridgeBaseUrl: "http://127.0.0.1:21984" };
    storeExternalSession(session);
    storePendingDesktopBridgeRequest({
      version: 2, transport: "desktop-bridge", requestId: "host-bound",
      sessionId: session.sessionId, address: session.address,
      network: session.network, chainId: session.chainId,
      origin: window.location.origin, bridgeOrigin: "http://127.0.0.1:21984",
      method: "signAndSubmitTransaction"
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input).startsWith("http://127.0.0.1:21984/")).toBe(true);
      if (String(input).endsWith("/session/desktop-session")) return json(session);
      return json({ requestId: "host-bound", status: "approved", hash });
    });
    expect(await readRecoverableRequest("host-bound", options))
      .toMatchObject({ status: "approved", output: { hash } });
    expect(fetch).toHaveBeenCalled();
  });

  it.each(["signMessage", "signTransaction"] as const)(
    "rejects a wrong direct desktop ID for %s while retaining the receipt", async (method) => {
      _setBridgeTokenForTesting(token);
      storeExternalSession(desktop);
      const startPath = method === "signMessage" ? "/sign-message" : "/sign-transaction";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (init?.method === "POST" && url.endsWith(startPath)) {
          return json({ requestId: "direct-request" });
        }
        return json({ status: "approved", requestId: "other-request" });
      });
      const result = method === "signMessage"
        ? tryLocalBridgeSignMessage({ message: "test" } as never, desktop)
        : tryLocalBridgeSignTransaction({} as never, desktop);
      await expect(result).rejects.toMatchObject({ code: "REQUEST_OUTCOME_UNKNOWN", dispatch: "unknown" });
      expect(await listRecoverableRequests()).toMatchObject([{ requestId: "direct-request" }]);
    }
  );

  it("archives an unknown receipt only for the current session and retains evidence", async () => {
    _setBridgeTokenForTesting(token);
    storeExternalSession(desktop);
    storePendingDesktopBridgeRequest({
      version: 2, transport: "desktop-bridge", requestId: "unresolved",
      sessionId: desktop.sessionId, address: desktop.address,
      network: desktop.network, chainId: desktop.chainId,
      origin: window.location.origin, bridgeOrigin: new URL(desktop.bridgeUrl!).origin,
      method: "signAndSubmitTransaction"
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    expect(await readRecoverableRequest("unresolved")).toMatchObject({ status: "unknown" });
    let invalidReferenceError: unknown;
    try { await archiveRecoverableRequest("unresolved", ""); }
    catch (error) { invalidReferenceError = error; }
    expect(invalidReferenceError).toMatchObject({ code: "INVALID_PARAMS" });
    await archiveRecoverableRequest("unresolved", "chain:testnet:tx:checked");
    expect(await listRecoverableRequests()).toEqual([]);
    expect(await listArchivedRecoverableRequests()).toMatchObject([{
      requestId: "unresolved", reconciliationReference: "chain:testnet:tx:checked"
    }]);
    expect(window.sessionStorage.getItem("inferenco:infer-pending-desktop-request:unresolved"))
      .toContain("chain:testnet:tx:checked");
    await expect(acknowledgeRecoverableRequest("unresolved")).rejects.toThrow();
    await expect(archiveRecoverableRequest("unresolved", "again")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    storeExternalSession({ ...desktop, sessionId: "other-session" });
    expect(await listArchivedRecoverableRequests()).toMatchObject([{
      requestId: "unresolved", sessionId: desktop.sessionId
    }]);
  });

  it("continues startup delivery after a hook failure and skips archived requests", async () => {
    _setBridgeTokenForTesting(token);
    storeExternalSession(desktop);
    for (const requestId of ["first", "second", "archived"]) {
      storePendingDesktopBridgeRequest({
        version: 2, transport: "desktop-bridge", requestId,
        sessionId: desktop.sessionId, address: desktop.address,
        network: desktop.network, chainId: desktop.chainId,
        origin: window.location.origin, bridgeOrigin: new URL(desktop.bridgeUrl!).origin,
        method: "signAndSubmitTransaction"
      });
    }
    await archiveRecoverableRequest("archived", "checked externally");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/session/desktop-session")) return json(desktop);
      return json({ requestId: url.split("/").at(-1), status: "approved", hash });
    });
    const delivered: string[] = [];
    const client = new InferClient({
      onRecoveredOutcome: async (outcome) => {
        delivered.push(outcome.requestId);
        if (outcome.requestId === "first") throw new Error("app callback failed");
      }
    });
    expect(client.listArchivedRecoverableRequests).toBeTypeOf("function");
    await vi.waitFor(() => {
      expect(delivered).toContain("first");
      expect(delivered).toContain("second");
      expect(delivered.filter((id) => id === "second")).toHaveLength(1);
    });
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith("/archived"))).toBe(false);
    expect(await listRecoverableRequests()).toHaveLength(2);
    const plugin = new InferWallet();
    expect(plugin.listRecoverableRequests).toBeTypeOf("function");
    expect(plugin.archiveRecoverableRequest).toBeTypeOf("function");
  });
});
