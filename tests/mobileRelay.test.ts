import { connectViaMobileRelay } from "../src/mobileRelay";
import { NOVA_PENDING_MOBILE_PAIRING_STORAGE_KEY } from "../src/constants";

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
        capturedPendingPairing = window.localStorage.getItem(NOVA_PENDING_MOBILE_PAIRING_STORAGE_KEY);
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
      capturedPendingPairing ?? window.localStorage.getItem(NOVA_PENDING_MOBILE_PAIRING_STORAGE_KEY) ?? "null"
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
    expect(window.localStorage.getItem(NOVA_PENDING_MOBILE_PAIRING_STORAGE_KEY)).not.toBeNull();
  });
});
