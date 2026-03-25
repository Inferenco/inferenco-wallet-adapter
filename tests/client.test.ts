import { Account } from "@cedra-labs/ts-sdk";
import { NovaClient } from "../src/NovaClient";

describe("NovaClient", () => {
  afterEach(() => {
    delete (window as any).inferenco;
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
});
