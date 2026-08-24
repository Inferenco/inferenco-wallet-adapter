import { connectViaMobileRelay } from "../src/mobileRelay";
import { INFER_PENDING_MOBILE_PAIRING_STORAGE_KEY } from "../src/constants";

describe("mobile relay pairing persistence", () => {
  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("persists the pending mobile pairing before approval completes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let capturedPendingPairing: string | null = null;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/pairings") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            pairingId: "pairing-123",
            dappPairingToken: "pairing-token",
            walletDeeplinkUrl: "inferenco://connect?pairingId=pairing-123&walletClaimToken=wallet-token",
            expiresAt: new Date(Date.now() + 60_000).toISOString()
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }

      if (url.includes("/v1/pairings/pairing-123?dappPairingToken=pairing-token")) {
        capturedPendingPairing = window.localStorage.getItem(INFER_PENDING_MOBILE_PAIRING_STORAGE_KEY);
        return new Response(
          JSON.stringify({
            pairingId: "pairing-123",
            status: "pending",
            callbackUrl: "https://example.com",
            expiresAt: new Date(Date.now() + 60_000).toISOString()
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const connectPromise = connectViaMobileRelay({
      relayBaseUrl: "https://relay.example",
      mobilePollIntervalMs: 10,
      mobileRequestTimeoutMs: 2_000
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const pendingPairing = JSON.parse(
      capturedPendingPairing ?? window.localStorage.getItem(INFER_PENDING_MOBILE_PAIRING_STORAGE_KEY) ?? "null"
    ) as {
      privateKey: string;
      publicKey: string;
    } | null;
    expect(pendingPairing).toMatchObject({
      pairingId: "pairing-123",
      dappPairingToken: "pairing-token",
      relayBaseUrl: "https://relay.example"
    });
    await expect(connectPromise).rejects.toMatchObject({
      code: "CONNECTION_TIMEOUT"
    });
    expect(window.localStorage.getItem(INFER_PENDING_MOBILE_PAIRING_STORAGE_KEY)).not.toBeNull();
  });

  // v0.3.0 (rebrand): the session-establishment path must dual-derive
  // the AEAD key. When the wallet sends an `encryptedResult` sealed
  // with the legacy `"nova-connect-relay"` HKDF info, the adapter must
  // still decrypt it via `deriveSharedSecretLegacy` and produce a
  // valid session. This pins the dual-derive fallback path.
  it("dual_derives_legacy_hkdf_info_when_canonical_decrypt_fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { createKeyPair, deriveSharedSecretLegacy, encryptJson } = await import("../src/mobileCrypto");

    // Pre-arrange: the dapp generates a keypair, persists the
    // private key, and a "wallet" is "running" on the legacy HKDF
    // info (because nova-service is not yet rebranded).
    const dapp = createKeyPair();
    const wallet = createKeyPair();
    const legacySecret = deriveSharedSecretLegacy(wallet.privateKey, dapp.publicKey);
    const encryptedResult = encryptJson(
      {
        address: "0xABC",
        publicKey: "0xDEF",
        network: "testnet",
        chainId: 2,
        walletName: "Infer Wallet"
      },
      legacySecret
    );

    // Persist the pending pairing so resumeMobileRelaySessionFromCallback
    // picks it up. The pairing is "approved" with an encryptedResult
    // sealed by the LEGACY HKDF info — the adapter must decrypt it.
    const pendingPairing = {
      pairingId: "pairing-legacy",
      dappPairingToken: "pairing-token",
      relayBaseUrl: "https://relay.example",
      privateKey: dapp.privateKey,
      publicKey: dapp.publicKey,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    window.localStorage.setItem(
      INFER_PENDING_MOBILE_PAIRING_STORAGE_KEY,
      JSON.stringify(pendingPairing)
    );
    // The callback marker must match the pairing id.
    window.sessionStorage.setItem(
      "inferenco:infer-callback-marker",
      JSON.stringify({ requestId: "pairing-legacy", status: "ok" })
    );

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/v1/pairings/pairing-legacy?dappPairingToken=pairing-token")) {
        return new Response(
          JSON.stringify({
            pairingId: "pairing-legacy",
            status: "approved",
            encryptedResult,
            dappSessionToken: "session-token",
            walletPublicKey: wallet.publicKey,
            sessionId: "session-id",
            walletName: "Infer Wallet"
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { resumeMobileRelaySessionFromCallback } = await import("../src/mobileRelay");
    const session = await resumeMobileRelaySessionFromCallback({
      relayBaseUrl: "https://relay.example",
      mobileRequestTimeoutMs: 5_000
    });

    expect(session).toMatchObject({
      address: "0xABC",
      publicKey: "0xDEF",
      network: "testnet",
      chainId: 2,
      sessionId: "session-id",
      dappSessionToken: "session-token",
      walletName: "Infer Wallet"
    });
  });
});
