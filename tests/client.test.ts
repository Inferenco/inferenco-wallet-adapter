import {
  Account,
  ChainId,
  EntryFunction,
  MultiAgentTransaction,
  parseTypeTag,
  RawTransaction,
  TransactionPayloadEntryFunction
} from "@cedra-labs/ts-sdk";
import type { CedraSignTransactionInputV1_1 } from "@cedra-labs/wallet-standard";
import * as bridge from "../src/bridge";
import * as mobileRelay from "../src/mobileRelay";
import { createKeyPair, deriveSharedSecret, encryptJson } from "../src/mobileCrypto";
import {
  NOVA_CALLBACK_MARKER_STORAGE_KEY,
  NOVA_EXTERNAL_SESSION_STORAGE_KEY,
  NOVA_PENDING_MOBILE_PAIRING_STORAGE_KEY
} from "../src/constants";
import { NovaErrorCode } from "../src/errors";
import { NovaClient } from "../src/NovaClient";

describe("NovaClient", () => {
  afterEach(() => {
    delete (window as any).inferenco;
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("connects and caches account data", async () => {
    const signer = Account.generate();
    (window as any).inferenco = {
      isNovaWallet: true,
      connect: async () => ({
        address: signer.accountAddress.toString(),
        publicKey: signer.publicKey.toUint8Array()
      }),
      network: async () => "devnet"
    };

    const client = new NovaClient();
    const result = await client.connect();

    expect(result.account.address.toString()).toBe(signer.accountAddress.toString());
    expect(result.account.publicKey.toString()).toBe(signer.publicKey.toString());
    expect(result.account.publicKey.toUint8Array()).toHaveLength(32);
    expect(client.account?.address.toString()).toBe(signer.accountAddress.toString());
    expect(client.cachedNetwork?.name).toBe("devnet");
  });

  it("restores a cached external session only after bridge validation", async () => {
    const signer = Account.generate();
    bridge.storeExternalSession({
      transport: "desktop-bridge",
      address: signer.accountAddress.toString(),
      publicKey: signer.publicKey.toString(),
      network: "testnet",
      chainId: 2,
      sessionId: "session-123",
      bridgeUrl: "http://127.0.0.1:21984/session/session-123",
      walletName: "Nova Desk"
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          address: signer.accountAddress.toString(),
          publicKey: signer.publicKey.toString(),
          network: "testnet",
          chainId: 2,
          sessionId: "session-123",
          bridgeUrl: "http://127.0.0.1:21984",
          walletName: "Nova Desk"
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );
    const bridgeConnectSpy = vi.spyOn(bridge, "tryLocalBridgeConnect");

    const client = new NovaClient();
    const result = await client.connect();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(bridgeConnectSpy).not.toHaveBeenCalled();
    expect(result.account.address.toString()).toBe(signer.accountAddress.toString());
    expect(client.cachedNetwork?.name).toBe("testnet");
  });

  it("clears a revoked cached external session before restoring", async () => {
    vi.useFakeTimers();
    const signer = Account.generate();
    bridge.storeExternalSession({
      transport: "desktop-bridge",
      address: signer.accountAddress.toString(),
      publicKey: signer.publicKey.toString(),
      network: "testnet",
      chainId: 2,
      sessionId: "revoked-session",
      bridgeUrl: "http://127.0.0.1:21984",
      walletName: "Nova Desk"
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "session_not_found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json"
        }
      })
    );
    vi.spyOn(bridge, "tryLocalBridgeConnect").mockResolvedValue(null);
    vi.spyOn(bridge, "launchDesktopOrMobileConnect").mockReturnValue(
      "inferenco://login?redirect=https%3A%2F%2Fexample.com"
    );
    vi.spyOn(bridge, "waitForExternalSession").mockResolvedValue(null);

    const client = new NovaClient();
    const connectPromise = client.connect();
    const rejection = expect(connectPromise).rejects.toMatchObject({
      code: NovaErrorCode.ConnectionTimeout
    });
    await vi.advanceTimersByTimeAsync(9_000);

    await rejection;
    expect(window.localStorage.getItem(NOVA_EXTERNAL_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("builds signMessageAndVerify from provider output", async () => {
    const signer = Account.generate();
    const nonce = "nonce";
    const message = "hello";
    const fullMessage = ["CEDRA", "", signer.accountAddress.toString(), nonce, "", message].join("\n");
    const signature = "0xdeadbeef";
    (window as any).inferenco = {
      isNovaWallet: true,
      connect: async () => ({
        address: signer.accountAddress.toString(),
        publicKey: signer.publicKey.toUint8Array()
      }),
      account: async () => ({
        address: signer.accountAddress.toString(),
        publicKey: signer.publicKey.toUint8Array()
      }),
      network: async () => "devnet",
      signMessage: async () => ({
        address: signer.accountAddress.toString(),
        fullMessage,
        message,
        nonce,
        prefix: "CEDRA",
        signature
      })
    };

    const client = new NovaClient();
    await client.connect();
    const verifySignature = vi
      .spyOn(client.account!.publicKey as any, "verifySignature")
      .mockReturnValue(true);
    const verifySignatureAsync = vi
      .spyOn(client.account!.publicKey as any, "verifySignatureAsync")
      .mockResolvedValue(true);
    await expect(
      client.signMessageAndVerify({
        message,
        nonce
      })
    ).resolves.toBe(true);
    verifySignature.mockRestore();
    verifySignatureAsync.mockRestore();
  });

  it("serializes prebuilt multi-agent transactions for external signing", async () => {
    const sender = Account.generate();
    const secondarySigner = Account.generate();
    const rawTransaction = new RawTransaction(
      sender.accountAddress,
      0n,
      new TransactionPayloadEntryFunction(
        EntryFunction.build("0x1::account", "transfer", [], [])
      ),
      1_000n,
      1n,
      60n,
      new ChainId(3),
      parseTypeTag("0x1::cedra_coin::CedraCoin")
    );
    const transaction = new MultiAgentTransaction(rawTransaction, [
      secondarySigner.accountAddress
    ]);
    const authenticator = sender.signTransactionWithAuthenticator(transaction);
    const session = {
      transport: "desktop-bridge" as const,
      address: sender.accountAddress.toString(),
      publicKey: sender.publicKey.toString(),
      network: "devnet",
      chainId: 3,
      sessionId: "session-123",
      bridgeUrl: "https://bridge.example"
    };
    vi.spyOn(bridge, "readValidatedExternalSession").mockResolvedValue(session);
    const signSpy = vi.spyOn(bridge, "tryLocalBridgeSignTransaction").mockResolvedValue({
      authenticator,
      rawTransaction: transaction
    });

    const client = new NovaClient();
    await expect(client.signTransaction(transaction)).resolves.toMatchObject({
      authenticator,
      rawTransaction: transaction
    });

    expect(signSpy).toHaveBeenCalledWith(
      {
        rawTransactionBcsHex: transaction.toString(),
        bcsHex: transaction.toString(),
        sender: sender.accountAddress.toString(),
        secondarySignerAddresses: [secondarySigner.accountAddress.toString()]
      },
      session,
      {}
    );
  });

  it("normalizes provider JSON signTransaction results into SDK-compatible objects", async () => {
    const sender = Account.generate();
    const secondarySigner = Account.generate();
    const rawTransaction = new RawTransaction(
      sender.accountAddress,
      0n,
      new TransactionPayloadEntryFunction(
        EntryFunction.build("0x1::account", "transfer", [], [])
      ),
      1_000n,
      1n,
      60n,
      new ChainId(3),
      parseTypeTag("0x1::cedra_coin::CedraCoin")
    );
    const transaction = new MultiAgentTransaction(rawTransaction, [
      secondarySigner.accountAddress
    ]);
    const authenticator = sender.signTransactionWithAuthenticator(transaction);
    (window as any).inferenco = {
      isNovaWallet: true,
      signTransaction: vi.fn().mockResolvedValue({
        authenticatorHex: authenticator.toString(),
        authenticator: { hex: authenticator.toString() },
        rawTransactionBcsHex: transaction.toString()
      })
    };

    const client = new NovaClient();
    const result = await client.signTransaction(transaction);

    expect(result).toMatchObject({
      rawTransaction: expect.any(MultiAgentTransaction)
    });
    expect(
      "authenticator" in result &&
        typeof result.authenticator.bcsToHex === "function" &&
        result.authenticator.bcsToHex().toString()
    ).toBe(authenticator.toString());
  });

  it("maps wallet-standard multi-agent metadata for external signing", async () => {
    const sender = Account.generate();
    const secondarySigner = Account.generate();
    const feePayer = Account.generate();
    const rawTransaction = new RawTransaction(
      sender.accountAddress,
      0n,
      new TransactionPayloadEntryFunction(
        EntryFunction.build("0x1::account", "transfer", [], [])
      ),
      1_000n,
      1n,
      60n,
      new ChainId(3),
      parseTypeTag("0x1::cedra_coin::CedraCoin")
    );
    const transaction = new MultiAgentTransaction(rawTransaction, [
      secondarySigner.accountAddress
    ], feePayer.accountAddress);
    const authenticator = sender.signTransactionWithAuthenticator(transaction);
    const input: CedraSignTransactionInputV1_1 = {
      sender: { address: sender.accountAddress },
      secondarySigners: [{ address: secondarySigner.accountAddress }],
      feePayer: { address: feePayer.accountAddress },
      payload: {
        function: "0x1::account::transfer",
        typeArguments: [],
        functionArguments: []
      },
      gasUnitPrice: 1,
      maxGasAmount: 1_000,
      sequenceNumber: 0n,
      expirationTimestamp: 60,
      network: "devnet" as never
    };
    const session = {
      transport: "desktop-bridge" as const,
      address: sender.accountAddress.toString(),
      publicKey: sender.publicKey.toString(),
      network: "devnet",
      chainId: 3,
      sessionId: "session-123",
      bridgeUrl: "https://bridge.example"
    };
    vi.spyOn(bridge, "readValidatedExternalSession").mockResolvedValue(session);
    const signSpy = vi.spyOn(bridge, "tryLocalBridgeSignTransaction").mockResolvedValue({
      authenticator,
      rawTransaction: transaction
    });

    const client = new NovaClient();
    await expect(client.signTransaction(input)).resolves.toMatchObject({
      authenticator,
      rawTransaction: transaction
    });

    expect(signSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: input.payload,
        sequenceNumber: "0",
        sender: sender.accountAddress.toString(),
        secondarySignerAddresses: [secondarySigner.accountAddress.toString()],
        feePayerAddress: feePayer.accountAddress.toString()
      }),
      session,
      {}
    );
  });

  it("completes cold-start desktop connect during the retry window", async () => {
    const signer = Account.generate();
    const bridgeConnectSpy = vi
      .spyOn(bridge, "tryLocalBridgeConnect")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        address: signer.accountAddress,
        publicKey: signer.publicKey as any
      } as any);
    const launchSpy = vi
      .spyOn(bridge, "launchDesktopOrMobileConnect")
      .mockReturnValue("inferenco://login?redirect=https%3A%2F%2Fexample.com");
    const readValidatedSessionSpy = vi
      .spyOn(bridge, "readValidatedExternalSession")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        transport: "desktop-bridge",
        address: signer.accountAddress.toString(),
        publicKey: signer.publicKey.toString(),
        network: "testnet",
        chainId: 2,
        sessionId: "session-123",
        bridgeUrl: "http://127.0.0.1:21984/session/session-123",
        walletName: "Nova Desk"
      });

    const client = new NovaClient();
    const result = await client.connect();

    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(bridgeConnectSpy).toHaveBeenCalledTimes(3);
    expect(readValidatedSessionSpy).toHaveBeenCalled();
    expect(result.account.address.toString()).toBe(signer.accountAddress.toString());
    expect(client.cachedNetwork?.name).toBe("testnet");
  });

  it("falls back to callback handoff only after the retry window expires", async () => {
    vi.useFakeTimers();
    const bridgeConnectSpy = vi.spyOn(bridge, "tryLocalBridgeConnect").mockResolvedValue(null);
    const launchSpy = vi.spyOn(bridge, "launchDesktopOrMobileConnect").mockReturnValue(
      "inferenco://login?redirect=https%3A%2F%2Fexample.com"
    );
    const signer = Account.generate();
    const waitForExternalSessionSpy = vi.spyOn(bridge, "waitForExternalSession").mockResolvedValue({
      transport: "desktop-bridge",
      address: signer.accountAddress.toString(),
      publicKey: signer.publicKey.toString(),
      network: "testnet",
      chainId: 2,
      sessionId: "session-456",
      bridgeUrl: "http://127.0.0.1:21984/session/session-456",
      walletName: "Nova Desk"
    });

    const client = new NovaClient();
    const connectPromise = client.connect();
    await vi.advanceTimersByTimeAsync(9_000);
    const result = await connectPromise;

    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(bridgeConnectSpy.mock.calls.length).toBeGreaterThan(2);
    expect(waitForExternalSessionSpy).toHaveBeenCalledTimes(1);
    expect(result.account.address.toString()).toBe(signer.accountAddress.toString());
    expect(client.cachedNetwork?.name).toBe("testnet");
  });

  it("reports a connection timeout when retries exhaust and deeplink handoff never returns", async () => {
    vi.useFakeTimers();
    const bridgeConnectSpy = vi.spyOn(bridge, "tryLocalBridgeConnect").mockResolvedValue(null);
    vi.spyOn(bridge, "launchDesktopOrMobileConnect").mockReturnValue(
      "inferenco://login?redirect=https%3A%2F%2Fexample.com"
    );
    const waitForExternalSessionSpy = vi.spyOn(bridge, "waitForExternalSession").mockResolvedValue(null);

    const client = new NovaClient();
    const connectPromise = client.connect();
    const rejection = expect(connectPromise).rejects.toMatchObject({
      code: NovaErrorCode.ConnectionTimeout
    });
    await vi.advanceTimersByTimeAsync(9_000);

    await rejection;
    expect(bridgeConnectSpy.mock.calls.length).toBeGreaterThan(2);
    expect(waitForExternalSessionSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces bridge errors immediately during the retry window", async () => {
    vi.spyOn(bridge, "tryLocalBridgeConnect")
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("Nova Desk rejected the browser bridge request"));
    const launchSpy = vi.spyOn(bridge, "launchDesktopOrMobileConnect").mockReturnValue(
      "inferenco://login?redirect=https%3A%2F%2Fexample.com"
    );
    const waitForExternalSessionSpy = vi.spyOn(bridge, "waitForExternalSession").mockResolvedValue(null);

    const client = new NovaClient();

    await expect(client.connect()).rejects.toThrow("Nova Desk rejected the browser bridge request");
    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(waitForExternalSessionSpy).not.toHaveBeenCalled();
  });

  it("uses the mobile relay path on mobile browsers", async () => {
    vi.spyOn(bridge, "isMobileBrowser").mockReturnValue(true);
    vi.spyOn(bridge, "tryLocalBridgeConnect").mockResolvedValue(null);
    const signer = Account.generate();
    const relaySpy = vi.spyOn(mobileRelay, "connectViaMobileRelay").mockResolvedValue({
      transport: "mobile-relay",
      address: signer.accountAddress.toString(),
      publicKey: signer.publicKey.toString(),
      network: "testnet",
      chainId: 2,
      sessionId: "relay-session",
      relayBaseUrl: "https://relay.example",
      dappSessionToken: "dapp-token",
      sharedSecret: "shared-secret",
      walletPublicKey: "wallet-public-key",
      walletName: "Nova Wallet"
    });

    const client = new NovaClient({ relayBaseUrl: "https://relay.example" });
    const result = await client.connect();

    expect(relaySpy).toHaveBeenCalledTimes(1);
    expect(result.account.address.toString()).toBe(signer.accountAddress.toString());
    expect(client.cachedNetwork?.name).toBe("testnet");
  });

  it("resumes a pending mobile relay pairing after callback", async () => {
    const dappKeyPair = createKeyPair();
    const walletKeyPair = createKeyPair();
    const sharedSecret = deriveSharedSecret(dappKeyPair.privateKey, walletKeyPair.publicKey);
    const signer = Account.generate();
    bridge.storePendingMobilePairing({
      pairingId: "pairing-123",
      dappPairingToken: "pairing-token",
      privateKey: dappKeyPair.privateKey,
      publicKey: dappKeyPair.publicKey,
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

    const connectSpy = vi.spyOn(mobileRelay, "connectViaMobileRelay");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          pairingId: "pairing-123",
          status: "approved",
          callbackUrl: "https://example.com",
          encryptedResult: encryptJson(
            {
              address: signer.accountAddress.toString(),
              publicKey: signer.publicKey.toString(),
              network: "testnet",
              chainId: 2,
              walletName: "Nova Wallet"
            },
            sharedSecret
          ),
          dappSessionToken: "session-token",
          sessionId: "session-123",
          walletPublicKey: walletKeyPair.publicKey,
          walletName: "Nova Wallet",
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const client = new NovaClient();
    const result = await client.connect();

    expect(connectSpy).not.toHaveBeenCalled();
    expect(result.account.address.toString()).toBe(signer.accountAddress.toString());
    expect(window.localStorage.getItem(NOVA_PENDING_MOBILE_PAIRING_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(NOVA_CALLBACK_MARKER_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(NOVA_EXTERNAL_SESSION_STORAGE_KEY)).toContain("\"transport\":\"mobile-relay\"");
  });

  it("revokes the Nova Desk bridge session before clearing the external session", async () => {
    const signer = Account.generate();
    bridge.storeExternalSession({
      transport: "desktop-bridge",
      address: signer.accountAddress.toString(),
      publicKey: signer.publicKey.toString(),
      network: "testnet",
      chainId: 2,
      sessionId: "session-123",
      bridgeUrl: "http://127.0.0.1:21984/session/session-123",
      walletName: "Nova Desk"
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "revoked",
          sessionId: "session-123"
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const client = new NovaClient();

    await client.disconnect();

    expect(fetchSpy).toHaveBeenCalledWith(
      `http://127.0.0.1:21984/connection?origin=${encodeURIComponent(window.location.origin)}&address=${encodeURIComponent(signer.accountAddress.toString())}&network=testnet`,
      expect.objectContaining({
        method: "DELETE"
      })
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(NOVA_EXTERNAL_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("falls back to session revoke when the connection endpoint is unavailable", async () => {
    const signer = Account.generate();
    bridge.storeExternalSession({
      transport: "desktop-bridge",
      address: signer.accountAddress.toString(),
      publicKey: signer.publicKey.toString(),
      network: "testnet",
      chainId: 2,
      sessionId: "session-fallback",
      bridgeUrl: "http://127.0.0.1:21984/session/session-fallback",
      walletName: "Nova Desk"
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "revoked",
            sessionId: "session-fallback"
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        )
      );

    const client = new NovaClient();

    await client.disconnect();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(NOVA_EXTERNAL_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("clears the cached external session when Nova Desk disconnect revocation fails", async () => {
    const signer = Account.generate();
    bridge.storeExternalSession({
      transport: "desktop-bridge",
      address: signer.accountAddress.toString(),
      publicKey: signer.publicKey.toString(),
      network: "testnet",
      chainId: 2,
      sessionId: "session-500",
      bridgeUrl: "http://127.0.0.1:21984/session/session-500",
      walletName: "Nova Desk"
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "bridge_unavailable" }), {
        status: 503,
        headers: {
          "Content-Type": "application/json"
        }
      })
    );

    const client = new NovaClient();

    await expect(client.disconnect()).rejects.toMatchObject({
      code: NovaErrorCode.InternalError
    });
    expect(window.localStorage.getItem(NOVA_EXTERNAL_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("0.2.0-rc.7: connect resolves from callback URL without re-firing the deeplink", async () => {
    // External browser: Nova Desk fires the deeplink, user approves,
    // wallet redirects back to the dapp at <redirect>?address=...&sessionId=...
    // &bridgeUrl=... The dapp's React re-mount fires walletCore.connect()
    // again on the new page load. The connect() helper must consume
    // the URL params FIRST (instead of firing another deeplink).
    const tokenHex =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const callbackBridgeUrl = `http://127.0.0.1:21984/${tokenHex}`;
    // Use a valid 64-hex-char address (matches AccountAddress requirements).
    const validAddress =
      "0x" + "a".repeat(64);
    const validPublicKey =
      "0x" + "d".repeat(64);
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        href: `https://dapp.example/?address=${validAddress}&publicKey=${validPublicKey}&network=testnet&chainId=2&sessionId=sess-1&bridgeUrl=${encodeURIComponent(callbackBridgeUrl)}&walletName=Nova%20Connect`,
        origin: "https://dapp.example",
        pathname: "/"
      }
    });

    // The validation fetch would normally hit /<token>/session/<id>; mock
    // it to return success with the echoed session shape.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          address: validAddress,
          publicKey: validPublicKey,
          network: "testnet",
          chainId: 2,
          sessionId: "sess-1",
          bridgeUrl: callbackBridgeUrl,
          walletName: "Nova Connect"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = new NovaClient();
    const result = await client.connect();

    expect(result.account.address.toString()).toBe(validAddress);
    // Token survives in the persisted session.bridgeUrl — the next
    // sign-message / sign-transaction call will extract it from there.
    const stored = JSON.parse(
      window.localStorage.getItem(NOVA_EXTERNAL_SESSION_STORAGE_KEY) || "null"
    );
    expect(stored?.bridgeUrl).toBe(callbackBridgeUrl);
    // The deeplink must NOT have been fired a second time.
    expect((window as any).location.href).not.toContain("inferenco://");
  });

  it("0.2.0-rc.7: connect falls through to deeplink when no callback params are present", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        href: "https://dapp.example/",
        origin: "https://dapp.example",
        pathname: "/"
      }
    });
    window.localStorage.clear();

    // Stub launchDesktopOrMobileConnect to be a no-op so the test can
    // observe its effect (or absence) without affecting the test runner.
    const launchSpy = vi
      .spyOn(bridge, "launchDesktopOrMobileConnect")
      .mockImplementation(() => "");

    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("MissingBridgeTokenError: token unavailable")
    );

    const client = new NovaClient();
    const connectPromise = client.connect();

    // Let the microtask queue run so launchDesktopOrMobileConnect
    // gets a chance to be invoked.
    await new Promise((r) => setTimeout(r, 10));

    expect(launchSpy).toHaveBeenCalled();
    connectPromise.catch(() => {
      /* expected to reject with timeout / not installed */
    });
  });
});
