import {
  NOVA_CALLBACK_MARKER_STORAGE_KEY,
  NOVA_CONNECT_NAME
} from "../src/constants";
import {
  readExternalSession,
  storeCallbackSession,
  storeExternalSession,
  storePendingMobilePairing,
  tryResumeNovaWalletConnection,
  waitForExternalSession
} from "../src/bridge";

describe("bridge resume helpers", () => {
  const originalBroadcastChannel = globalThis.BroadcastChannel;

  class MockBroadcastChannel {
    static instances: MockBroadcastChannel[] = [];
    readonly postMessage = vi.fn();
    private readonly listeners = new Set<(event: MessageEvent) => void>();

    constructor(public readonly name: string) {
      MockBroadcastChannel.instances.push(this);
    }

    addEventListener(_type: string, listener: (event: MessageEvent) => void): void {
      this.listeners.add(listener);
    }

    removeEventListener(_type: string, listener: (event: MessageEvent) => void): void {
      this.listeners.delete(listener);
    }

    dispatch(data: unknown): void {
      const event = { data } as MessageEvent;
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }

  beforeEach(() => {
    MockBroadcastChannel.instances = [];
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel as unknown as typeof BroadcastChannel);
  });

  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    if (originalBroadcastChannel) {
      vi.stubGlobal("BroadcastChannel", originalBroadcastChannel);
    } else {
      vi.unstubAllGlobals();
    }
  });

  it("returns false when no Nova state can be resumed", async () => {
    const walletCore = {
      wallets: [{ name: NOVA_CONNECT_NAME }],
      connect: vi.fn()
    };

    await expect(tryResumeNovaWalletConnection(walletCore)).resolves.toBe(false);
    expect(walletCore.connect).not.toHaveBeenCalled();
  });

  it("calls walletCore.connect when a validated external session exists", async () => {
    storeExternalSession({
      transport: "mobile-relay",
      address: "0x1",
      publicKey: "0x2",
      network: "testnet",
      chainId: 2,
      sessionId: "session-123",
      relayBaseUrl: "https://relay.example",
      dappSessionToken: "session-token",
      sharedSecret: "shared-secret",
      walletPublicKey: "wallet-public-key"
    });
    const walletCore = {
      wallets: [{ name: NOVA_CONNECT_NAME }],
      connect: vi.fn().mockResolvedValue(undefined)
    };

    await expect(tryResumeNovaWalletConnection(walletCore)).resolves.toBe(true);
    expect(walletCore.connect).toHaveBeenCalledWith(NOVA_CONNECT_NAME);
  });

  it("calls walletCore.connect when a pending mobile callback can be resumed", async () => {
    storePendingMobilePairing({
      pairingId: "pairing-123",
      dappPairingToken: "pairing-token",
      privateKey: "private-key",
      publicKey: "public-key",
      relayBaseUrl: "https://relay.example",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    window.sessionStorage.setItem(
      NOVA_CALLBACK_MARKER_STORAGE_KEY,
      JSON.stringify({
        requestId: "pairing-123",
        status: "approved"
      })
    );
    const walletCore = {
      wallets: [{ name: NOVA_CONNECT_NAME }],
      connect: vi.fn().mockResolvedValue(undefined)
    };

    await expect(tryResumeNovaWalletConnection(walletCore)).resolves.toBe(true);
    expect(walletCore.connect).toHaveBeenCalledWith(NOVA_CONNECT_NAME);
  });

  it("stores callback sessions, notifies the opener, and strips callback params", async () => {
    const opener = { postMessage: vi.fn() };
    Object.defineProperty(window, "opener", {
      configurable: true,
      value: opener
    });
    vi.spyOn(window, "close").mockImplementation(() => undefined);
    window.history.replaceState(
      {},
      "",
      "/callback?address=0x1&publicKey=0x2&network=testnet&chainId=2&sessionId=session-123&bridgeUrl=http%3A%2F%2F127.0.0.1%3A21984&walletName=Nova%20Desk"
    );

    storeCallbackSession();

    expect(readExternalSession()).toMatchObject({
      address: "0x1",
      publicKey: "0x2",
      network: "testnet",
      chainId: 2,
      sessionId: "session-123",
      bridgeUrl: "http://127.0.0.1:21984",
      walletName: "Nova Desk"
    });
    expect(opener.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "inferenco:nova-session-ready",
        session: expect.objectContaining({ sessionId: "session-123" })
      }),
      window.location.origin
    );
    expect(window.location.search).toBe("");
  });

  it("falls back to a completion overlay when the callback window cannot close", async () => {
    vi.useFakeTimers();
    Object.defineProperty(window, "opener", {
      configurable: true,
      value: { postMessage: vi.fn() }
    });
    vi.spyOn(window, "close").mockImplementation(() => undefined);
    window.history.replaceState(
      {},
      "",
      "/callback?address=0x1&publicKey=0x2&network=testnet&chainId=2&sessionId=session-456"
    );

    storeCallbackSession();
    await vi.advanceTimersByTimeAsync(200);

    expect(document.getElementById("inferenco-nova-callback-overlay")?.textContent).toContain(
      "Nova Connect is complete"
    );
    vi.useRealTimers();
  });

  it("resolves waiters when a same-origin storage update delivers the external session", async () => {
    vi.useFakeTimers();
    const waiter = waitForExternalSession({ bridgePollTimeoutMs: 5_000, bridgePollIntervalMs: 250 });
    const sessionPayload = JSON.stringify({
      transport: "desktop-bridge",
      address: "0xabc",
      publicKey: "0xdef",
      network: "testnet",
      chainId: 2,
      sessionId: "session-storage"
    });

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "inferenco:nova-session",
        newValue: sessionPayload
      })
    );

    await expect(waiter).resolves.toMatchObject({
      sessionId: "session-storage",
      address: "0xabc"
    });
    vi.useRealTimers();
  });
});
