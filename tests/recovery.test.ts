import { storeExternalSession, tryLocalBridgeSignAndSubmit } from "../src/bridge";
import { storePendingDesktopBridgeRequest } from "../src/desktopRequests";
import { createInferAIP62Wallet } from "../src/aip62";
import { _setBridgeTokenForTesting, _resetBridgeTokenForTesting } from "../src/bridge/token";
import { INFER_CALLBACK_MARKER_STORAGE_KEY } from "../src/constants";
import { createKeyPair, deriveSharedSecret, encryptJson } from "../src/mobileCrypto";
import { storePendingMobileRelayRequest } from "../src/mobileRequests";
import {
  acknowledgeRecoverableRequest,
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
      .rejects.toThrow("outcome is unknown");
    expect(posts).toBe(1);
    expect(cancels).toBe(0);
    expect(await listRecoverableRequests()).toEqual([{
      requestId: "desktop-request", method: "signAndSubmitTransaction", transport: "desktop-bridge"
    }]);
    expect(() => acknowledgeRecoverableRequest("desktop-request")).toThrow("verified final outcome");
    expect(await readRecoverableRequest("desktop-request")).toMatchObject({ status: "pending" });
    approved = true;
    expect(await readRecoverableRequest("desktop-request")).toEqual({
      requestId: "desktop-request", method: "signAndSubmitTransaction",
      transport: "desktop-bridge", status: "approved", output: { hash }
    });
    acknowledgeRecoverableRequest("desktop-request");
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
    expect(() => acknowledgeRecoverableRequest("desktop-request")).toThrow("verified final outcome");
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
    acknowledgeRecoverableRequest("mobile-request");
    expect(await listRecoverableRequests()).toEqual([]);
  });

  it("keeps a desktop receipt visible when the bridge is offline", async () => {
    _setBridgeTokenForTesting(token);
    storeExternalSession(desktop);
    storePendingDesktopBridgeRequest({
      version: 1, transport: "desktop-bridge", requestId: "offline-request",
      sessionId: desktop.sessionId, address: desktop.address,
      network: desktop.network, chainId: desktop.chainId,
      origin: window.location.origin, bridgeBaseUrl: desktop.bridgeUrl!,
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
        version: 1, transport: "desktop-bridge", requestId,
        sessionId: desktop.sessionId, address: desktop.address,
        network: desktop.network, chainId: desktop.chainId,
        origin: window.location.origin, bridgeBaseUrl: desktop.bridgeUrl!,
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
    acknowledgeRecoverableRequest("rejected-one");
    expect(await listRecoverableRequests()).toEqual([{
      requestId: "mixed-two", method: "signAndSubmitTransaction", transport: "desktop-bridge"
    }]);
  });

  it("exposes the recovery feature and reports storage denial instead of an empty list", async () => {
    storeExternalSession({ ...desktop, transport: "mobile-relay" });
    const wallet = createInferAIP62Wallet();
    expect(wallet.features).toHaveProperty("inferenco:recoveredOutcomes");
    vi.spyOn(Storage.prototype, "length", "get").mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    await expect(listRecoverableRequests()).rejects.toThrow("Unable to inspect saved relay requests");
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
