import { createKeyPair, decryptJson, deriveSharedSecret, encryptJson } from "../src/mobileCrypto";

describe("mobileCrypto", () => {
  it("round-trips encrypted payloads using browser-safe base64url encoding", () => {
    const dapp = createKeyPair();
    const wallet = createKeyPair();
    const dappSecret = deriveSharedSecret(dapp.privateKey, wallet.publicKey);
    const walletSecret = deriveSharedSecret(wallet.privateKey, dapp.publicKey);
    const payload = {
      hello: "world",
      nonce: "123",
      nested: {
        ok: true
      }
    };

    const encrypted = encryptJson(payload, dappSecret);

    expect(decryptJson(encrypted, walletSecret)).toEqual(payload);
  });
});
