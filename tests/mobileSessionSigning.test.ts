import { Account } from "@cedra-labs/ts-sdk";
import { InferClient } from "../src/InferClient";
import { readExternalSession, storePendingMobilePairing } from "../src/bridge";
import { INFER_CALLBACK_MARKER_STORAGE_KEY } from "../src/constants";
import { createKeyPair, deriveSharedSecret, encryptJson, decryptJson } from "../src/mobileCrypto";

const relayBaseUrl = "https://relay.example";
const methods = ["signMessage", "signTransaction", "signAndSubmitTransaction"] as const;
const transaction = {
  payload: { function: "0x1::account::transfer" as const, typeArguments: [], functionArguments: ["0x2", "7"] }
};
const message = { message: "Generic dapp request", nonce: "fixture-nonce" };

function response(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

describe("Infer Wallet connection followed by mobile signing", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", undefined);
  });

  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(methods)("dispatches %s after pairing and after restoring the saved session", async (method) => {
    // Exercise the real client, session parser, encryption and relay transport.
    // Only the network and wallet are simulated; no injected provider is present.
    const signer = Account.generate();
    const dapp = createKeyPair();
    const wallet = createKeyPair();
    const sharedSecret = deriveSharedSecret(wallet.privateKey, dapp.publicKey);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const hash = "0x" + "ab".repeat(32);
    const posted: { method: string; encryptedRequest: string }[] = [];
    let pairingReads = 0;
    let outcomeReads = 0;

    storePendingMobilePairing({
      pairingId: "pairing-1", dappPairingToken: "fixture-pairing-token",
      privateKey: dapp.privateKey, publicKey: dapp.publicKey, relayBaseUrl, expiresAt
    });
    window.sessionStorage.setItem(INFER_CALLBACK_MARKER_STORAGE_KEY,
      JSON.stringify({ requestId: "pairing-1", status: "approved" }));

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(relayBaseUrl);
      if (url.pathname === "/v1/pairings/pairing-1") {
        pairingReads++;
        return response({
          pairingId: "pairing-1", status: "approved", sessionId: "session-1",
          dappSessionToken: "fixture-session-token", walletPublicKey: wallet.publicKey,
          encryptedResult: encryptJson({
            address: signer.accountAddress.toString(), publicKey: signer.publicKey.toString(),
            network: "testnet", chainId: 2, walletName: "Infer Wallet"
          }, sharedSecret)
        });
      }
      if (url.pathname === "/v1/requests" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({
          sessionId: "session-1", dappSessionToken: "fixture-session-token", method,
          requestMetadata: { origin: window.location.origin }
        });
        posted.push(body);
        return response({
          requestId: "request-" + posted.length,
          walletDeeplinkUrl: window.location.href, expiresAt
        });
      }
      if (url.pathname === "/v1/requests/request-" + posted.length) {
        outcomeReads++;
        expect(new Headers(init?.headers).get("x-infer-session-token")).toBe("fixture-session-token");
        return response({
          requestId: "request-" + posted.length, sessionId: "session-1", method,
          callbackUrl: window.location.href, expiresAt,
          ...(method === "signAndSubmitTransaction"
            ? { status: "approved", encryptedResult: encryptJson({ hash }, sharedSecret) }
            : { status: "rejected", errorCode: "USER_REJECTED", errorMessage: "Declined" })
        });
      }
      throw new Error("Unexpected fixture request: " + url.pathname);
    });

    for (const expectedRequests of [1, 2]) {
      const client = new InferClient({ relayBaseUrl });
      expect(client.hasProvider()).toBe(false);
      const connection = await client.connect();
      expect(connection.account.address.toString()).toBe(signer.accountAddress.toString());

      // The second client must restore storage, not require another pairing.
      if (method === "signAndSubmitTransaction") {
        await expect(client.signAndSubmitTransaction(transaction)).resolves.toEqual({ hash });
      } else {
        const result = method === "signMessage"
          ? client.signMessage(message)
          : client.signTransaction(transaction);
        await expect(result).rejects.toMatchObject({ code: "USER_REJECTED" });
      }
      expect(posted).toHaveLength(expectedRequests);
      expect(outcomeReads).toBe(expectedRequests);
      expect(decryptJson(posted[expectedRequests - 1].encryptedRequest, sharedSecret))
        .toEqual(method === "signMessage" ? message : transaction);
      expect(readExternalSession()).toMatchObject({
        transport: "mobile-relay", walletName: "Infer Wallet",
        sessionId: "session-1", network: "testnet", chainId: 2
      });
    }
    expect(pairingReads).toBe(1);
  });
});
