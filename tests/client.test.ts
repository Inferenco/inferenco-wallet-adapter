import { Account } from "@cedra-labs/ts-sdk";
import * as bridge from "../src/bridge";
import * as mobileRelay from "../src/mobileRelay";
import { NOVA_EXTERNAL_SESSION_STORAGE_KEY } from "../src/constants";
import { NovaErrorCode } from "../src/errors";
import { NovaClient } from "../src/NovaClient";

describe("NovaClient", () => {
  afterEach(() => {
    delete (window as any).inferenco;
    window.localStorage.clear();
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

    await expect(client.connect()).rejects.toMatchObject({
      code: NovaErrorCode.ConnectionTimeout
    });
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

  it("completes cold-start desktop connect after deeplink handoff", async () => {
    const signer = Account.generate();
    vi.spyOn(bridge, "tryLocalBridgeConnect").mockResolvedValue(null);
    const launchSpy = vi
      .spyOn(bridge, "launchDesktopOrMobileConnect")
      .mockReturnValue("inferenco://login?redirect=https%3A%2F%2Fexample.com");
    vi.spyOn(bridge, "waitForExternalSession").mockResolvedValue({
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
    expect(result.account.address.toString()).toBe(signer.accountAddress.toString());
    expect(client.cachedNetwork?.name).toBe("testnet");
  });

  it("reports a connection timeout when deeplink handoff never returns", async () => {
    vi.spyOn(bridge, "tryLocalBridgeConnect").mockResolvedValue(null);
    vi.spyOn(bridge, "launchDesktopOrMobileConnect").mockReturnValue(
      "inferenco://login?redirect=https%3A%2F%2Fexample.com"
    );
    vi.spyOn(bridge, "waitForExternalSession").mockResolvedValue(null);

    const client = new NovaClient();

    await expect(client.connect()).rejects.toMatchObject({
      code: NovaErrorCode.ConnectionTimeout
    });
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

  it("keeps the cached external session when Nova Desk disconnect revocation fails", async () => {
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
    expect(window.localStorage.getItem(NOVA_EXTERNAL_SESSION_STORAGE_KEY)).not.toBeNull();
  });
});
