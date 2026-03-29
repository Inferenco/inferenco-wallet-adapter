import { Account } from "@cedra-labs/ts-sdk";
import * as bridge from "../src/bridge";
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
});
