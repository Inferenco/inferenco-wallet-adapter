import {
  connectViaMobileRelay, mobileWalletLaunchUrl, resumeMobileRelaySession,
  signAndSubmitViaMobileRelay
} from "../src/mobileRelay";
import { storeExternalSession } from "../src/bridge";
import { storePendingMobileRelayRequest } from "../src/mobileRequests";
import { hasLiveOriginalMobileTab, installMobileReturnOwnerResponder } from "../src/mobileReturnCoordinator";
import { listDurableInvocations, listDurableRequests, saveDurableRequest, saveDurableFinal } from "../src/durableRecovery";
import { InferClient } from "../src/InferClient";
import { createKeyPair, deriveSharedSecret, encryptJson } from "../src/mobileCrypto";
import { reconcileRecoverableInvocation, relaunchRecoverableInvocation } from "../src/recovery";
import type { InferExternalSession } from "../src/types";

const relay = "https://relay.example";
const hash = "0x" + "cd".repeat(32);
const expiresAt = () => new Date(Date.now() + 60_000).toISOString();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mobile return without callback navigation", () => {
  it("adds the optional return preference to wallet launch URLs only when enabled", () => {
    const base = "inferenco://connect?pairingId=pair-1&walletClaimToken=secret";
    expect(new URL(mobileWalletLaunchUrl(base, {})).searchParams.has("returnMode")).toBe(false);
    const target = new URL(mobileWalletLaunchUrl(base, {
      mobileReturnMode: "resume-browser-v1"
    }));
    expect(target.searchParams.get("returnMode")).toBe("resume-browser-v1");
    expect(target.searchParams.get("pairingId")).toBe("pair-1");
    expect(target.searchParams.get("walletClaimToken")).toBe("secret");
  });

  it("polls pairing approval without websocket event or callback marker", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const wallet = createKeyPair();
    let shared = "";
    let pairingReads = 0, createCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/pairings") && init?.method === "POST") {
        createCalls++;
        const body = JSON.parse(String(init.body)) as { dappPublicKey: string };
        shared = deriveSharedSecret(wallet.privateKey, body.dappPublicKey);
        return json({
          pairingId: "pair-1", dappPairingToken: "pair-token",
          walletDeeplinkUrl: window.location.href, expiresAt: expiresAt()
        });
      }
      if (url.includes("/v1/pairings/pair-1")) {
        pairingReads++;
        return json(pairingReads === 1
          ? { pairingId: "pair-1", status: "pending" }
          : {
              pairingId: "pair-1", status: "approved",
              encryptedResult: encryptJson({
                address: "0x1", publicKey: "0x2", network: "testnet",
                chainId: 2, walletName: "Infer Wallet"
              }, shared),
              dappSessionToken: "session-token", walletPublicKey: wallet.publicKey,
              sessionId: "session-1"
            });
      }
      throw new Error("Unexpected fetch " + url);
    });
    const create = connectViaMobileRelay({
      relayBaseUrl: relay, mobilePollIntervalMs: 2, mobileRequestTimeoutMs: 200
    });
    await expect(create).resolves.toMatchObject({ sessionId: "session-1", address: "0x1" });
    expect(createCalls).toBe(1);
    expect(pairingReads).toBeGreaterThan(1);
  });

  it("wakes the original pairing on focus and reports rejection without another POST", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const dapp = createKeyPair();
    window.localStorage.setItem("inferenco:infer-pending-mobile-pairing", JSON.stringify({
      pairingId: "pair-rejected", dappPairingToken: "pair-token",
      privateKey: dapp.privateKey, publicKey: dapp.publicKey,
      relayBaseUrl: relay, expiresAt: expiresAt()
    }));
    let reads = 0;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json({ pairingId: "pair-rejected", status: ++reads === 1 ? "pending" : "rejected" }));
    const resumed = resumeMobileRelaySession({
      relayBaseUrl: relay, mobilePollIntervalMs: 10_000, mobileRequestTimeoutMs: 20_000
    });
    await vi.waitFor(() => expect(reads).toBe(1));
    window.dispatchEvent(new Event("focus"));
    await expect(resumed).rejects.toMatchObject({ code: "USER_REJECTED" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("resumes an approved saved pairing after reload with no callback marker or launch", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const dapp = createKeyPair(), wallet = createKeyPair();
    window.localStorage.setItem("inferenco:infer-pending-mobile-pairing", JSON.stringify({
      pairingId: "pair-reload", dappPairingToken: "pair-token",
      privateKey: dapp.privateKey, publicKey: dapp.publicKey,
      relayBaseUrl: relay, expiresAt: expiresAt()
    }));
    const shared = deriveSharedSecret(wallet.privateKey, dapp.publicKey);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({
      pairingId: "pair-reload", status: "approved",
      encryptedResult: encryptJson({
        address: "0x1", publicKey: "0x2", network: "testnet",
        chainId: 2, walletName: "Infer Wallet"
      }, shared),
      dappSessionToken: "session-token", walletPublicKey: wallet.publicKey,
      sessionId: "session-1"
    }));
    expect(await resumeMobileRelaySession({
      relayBaseUrl: relay, mobileRequestTimeoutMs: 50
    })).toMatchObject({ sessionId: "session-1", address: "0x1" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]?.method).toBeUndefined();
  });
});

describe("receipt-less invocation reconciliation", () => {
  let session: InferExternalSession;
  let invocationId: string;
  let postBody: Record<string, unknown>;

  beforeEach(() => {
    vi.stubGlobal("WebSocket", undefined);
    const dapp = createKeyPair(), wallet = createKeyPair();
    session = {
      transport: "mobile-relay", address: "0x1", publicKey: "0x2",
      network: "testnet", chainId: 2, sessionId: "session-1",
      relayBaseUrl: relay, dappSessionToken: "session-token",
      sharedSecret: deriveSharedSecret(dapp.privateKey, wallet.publicKey)
    };
    storeExternalSession(session);
    postBody = {};
    invocationId = "";
  });

  async function createUnknownInvocation(): Promise<void> {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe(relay + "/v1/requests");
      expect(init?.method).toBe("POST");
      postBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      throw new TypeError("lost response");
    });
    await expect(signAndSubmitViaMobileRelay({ data: { function: "0x1::test::run", functionArguments: [] } },
      session, { relayBaseUrl: relay, mobileRequestTimeoutMs: 50 }))
      .rejects.toMatchObject({ code: "REQUEST_OUTCOME_UNKNOWN", requestId: null });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockRestore();
    const [invocation] = await listDurableInvocations();
    invocationId = invocation!.id;
    expect(invocation.state).toBe("unknown");
    expect(invocation.failureReason).toBe("creation_network_error");
    expect(invocationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(postBody.clientInvocationId).toBe(invocationId);
    expect(invocation.mobileRequest?.envelope.encryptedRequest).toBe(postBody.encryptedRequest);
    expect(JSON.stringify(invocation)).not.toContain("session-token");
  }

  it("recovers the exact approved request after a lost creation response", async () => {
    await createUnknownInvocation();
    window.sessionStorage.clear(); // simulate a fresh tab
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/by-invocation/")) {
        expect(init?.method).toBeUndefined();
        expect(new Headers(init?.headers).get("x-infer-session-token")).toBe("session-token");
        return json({ requestId: "request-one", expiresAt: expiresAt(), status: "approved" });
      }
      if (url.endsWith("/v1/requests/request-one")) {
        return json({
          requestId: "request-one", sessionId: session.sessionId,
          method: "signAndSubmitTransaction", status: "approved",
          callbackUrl: window.location.href, expiresAt: expiresAt(),
          encryptedResult: encryptJson({ hash }, session.sharedSecret!)
        });
      }
      throw new Error("Unexpected fetch " + url);
    });
    expect(await reconcileRecoverableInvocation(invocationId)).toMatchObject({
      invocationId, requestId: "request-one", status: "approved", output: { hash }
    });
    expect(calls).toHaveLength(2);
    expect((await listDurableRequests())[0]).toMatchObject({
      requestId: "request-one", final: { status: "approved", hash }
    });
    window.localStorage.clear();
    expect(await reconcileRecoverableInvocation(invocationId)).toMatchObject({
      status: "approved", output: { hash }
    });
    expect(calls).toHaveLength(2);
  });

  it("keeps a pending request without automatic wallet relaunch", async () => {
    await createUnknownInvocation();
    let relaunches = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/by-invocation/") && init?.method === "POST") {
        relaunches++;
        return json({
          requestId: "request-one", expiresAt: expiresAt(), status: "pending",
          walletDeeplinkUrl: window.location.href
        });
      }
      if (url.includes("/by-invocation/")) {
        return json({ requestId: "request-one", expiresAt: expiresAt(), status: "pending" });
      }
      if (url.endsWith("/v1/requests/request-one")) {
        return json({
          requestId: "request-one", sessionId: session.sessionId,
          method: "signAndSubmitTransaction", status: "pending",
          callbackUrl: window.location.href, expiresAt: expiresAt()
        });
      }
      throw new Error("Unexpected fetch " + url);
    });
    expect(await reconcileRecoverableInvocation(invocationId)).toMatchObject({
      status: "pending", requestId: "request-one"
    });
    expect(relaunches).toBe(0);
    await relaunchRecoverableInvocation(invocationId);
    expect(relaunches).toBe(1);
    expect((await listDurableRequests())).toHaveLength(1);
  });
});

describe("duplicate mobile completion wakeups", () => {
  it("delivers one retained final outcome without creating another request", async () => {
    const requestId = "duplicate-callback-request";
    const row = await saveDurableRequest({
      version: 1, requestId, sessionId: "duplicate-session",
      address: "0x1", network: "testnet", chainId: 2,
      relayBaseUrl: relay, origin: window.location.origin,
      method: "signAndSubmitTransaction", expiresAt: expiresAt()
    });
    await saveDurableFinal(row.id, {
      status: "approved", method: "signAndSubmitTransaction", hash
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("A retained final outcome needs no network request")
    );
    const delivered: string[] = [];
    const client = new InferClient({
      onRecoveredOutcome: (outcome) => {
        if (outcome.requestId === requestId) delivered.push(outcome.requestId);
      }
    });
    try {
      await vi.waitFor(() => expect(delivered).toEqual([requestId]));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("pageshow"));
      window.dispatchEvent(new Event("storage"));
      const recoveryRun = (client as unknown as { recoveryRun: Promise<void> | null }).recoveryRun;
      expect(recoveryRun).not.toBeNull();
      await recoveryRun;
      expect(delivered).toEqual([requestId]);
      expect(fetch.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
      expect((await listDurableRequests()).find((request) => request.requestId === requestId))
        .toMatchObject({ final: { status: "approved", hash } });
    } finally {
      client.dispose();
    }
  });
});

describe("fallback callback tab ownership", () => {
  it("identifies only a live owner of the exact request without sharing credentials", async () => {
    const messages: unknown[] = [];
    class Channel {
      static instances = new Set<Channel>();
      listeners = new Set<(event: MessageEvent) => void>();
      constructor(public name: string) { Channel.instances.add(this); }
      addEventListener(_type: string, listener: (event: MessageEvent) => void) {
        this.listeners.add(listener);
      }
      removeEventListener(_type: string, listener: (event: MessageEvent) => void) {
        this.listeners.delete(listener);
      }
      postMessage(message: unknown) {
        messages.push(message);
        for (const peer of Channel.instances) {
          if (peer !== this && peer.name === this.name) {
            queueMicrotask(() => peer.listeners.forEach((listener) =>
              listener({ data: message } as MessageEvent)));
          }
        }
      }
      close() { Channel.instances.delete(this); }
    }
    vi.stubGlobal("BroadcastChannel", Channel);
    const session: InferExternalSession = {
      transport: "mobile-relay", address: "0x1", publicKey: "0x2",
      network: "testnet", chainId: 2, sessionId: "session-1",
      relayBaseUrl: relay, dappSessionToken: "private-session-token",
      sharedSecret: "private-shared-secret"
    };
    storeExternalSession(session);
    const pending = {
      version: 1 as const, requestId: "owned-request", sessionId: session.sessionId,
      address: session.address, network: session.network, chainId: session.chainId,
      relayBaseUrl: relay, origin: window.location.origin,
      method: "signAndSubmitTransaction" as const, expiresAt: expiresAt()
    };
    storePendingMobileRelayRequest(pending);
    const dispose = installMobileReturnOwnerResponder();
    const peer = new Channel("inferenco:infer-mobile-return-owner");
    try {
      // The callback tab's own responder cannot claim to be the original,
      // even if its sessionStorage was cloned.
      expect(await hasLiveOriginalMobileTab("owned-request", 20)).toBe(false);
      peer.addEventListener("message", (event) => {
        const probe = event.data as {
          type: string; requestId: string; nonce: string;
        };
        if (probe.type === "probe" && probe.requestId === "owned-request") {
          peer.postMessage({
            type: "owner", requestId: probe.requestId, nonce: probe.nonce,
            tabInstanceId: "original-tab-instance"
          });
        }
      });
      expect(await hasLiveOriginalMobileTab("owned-request", 20)).toBe(true);
      expect(await hasLiveOriginalMobileTab("other-request", 20)).toBe(false);
      expect(JSON.stringify(messages)).not.toContain("private-session-token");
      expect(JSON.stringify(messages)).not.toContain("private-shared-secret");

      const row = await saveDurableRequest(pending);
      await saveDurableFinal(row.id, {
        status: "approved", method: "signAndSubmitTransaction", hash
      });
      window.sessionStorage.clear(); // callback tab has no original tab receipt
      window.sessionStorage.setItem("inferenco:infer-callback-marker", JSON.stringify({
        requestId: "owned-request", status: "approved"
      }));
      vi.stubGlobal("matchMedia", () => ({ matches: true }));
      const client = new InferClient();
      try {
        await vi.waitFor(() =>
          expect(document.getElementById("inferenco-infer-callback-overlay"))
            .not.toBeNull());
      } finally {
        client.dispose();
        document.getElementById("inferenco-infer-callback-overlay")?.remove();
      }
    } finally {
      peer.close();
      dispose();
    }
  });
});
