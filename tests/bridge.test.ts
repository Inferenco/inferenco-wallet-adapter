import {
  NOVA_CALLBACK_MARKER_STORAGE_KEY,
  NOVA_CONNECT_NAME
} from "../src/constants";
import {
  storeExternalSession,
  storePendingMobilePairing,
  tryResumeNovaWalletConnection
} from "../src/bridge";

describe("bridge resume helpers", () => {
  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
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
});
