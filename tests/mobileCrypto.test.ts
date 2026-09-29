import {
  createKeyPair,
  decryptJson,
  deriveSharedSecret,
  deriveSharedSecretLegacy,
  encryptJson
} from "../src/mobileCrypto";

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

  // v0.3.0 (rebrand): the legacy HKDF info `"nova-connect-relay"`
  // produces a different derived key than the canonical
  // `"infer-connect-relay"`. A wallet that still speaks the legacy
  // info (because nova-service is not yet rebranded) can only be
  // decrypted with `deriveSharedSecretLegacy`. This test pins that
  // the two helpers return different secrets and that legacy
  // decryption works.
  it("deriveSharedSecretLegacy_returns_different_key_than_canonical", () => {
    const dapp = createKeyPair();
    const wallet = createKeyPair();
    const canonical = deriveSharedSecret(dapp.privateKey, wallet.publicKey);
    const legacy = deriveSharedSecretLegacy(dapp.privateKey, wallet.publicKey);
    expect(canonical).not.toBe(legacy);
  });

  it("deriveSharedSecretLegacy_decrypts_payloads_encrypted_with_legacy_info", () => {
    const dapp = createKeyPair();
    const wallet = createKeyPair();
    const legacySecret = deriveSharedSecretLegacy(wallet.privateKey, dapp.publicKey);
    const payload = { address: "0xABC", publicKey: "0xDEF" };
    const encrypted = encryptJson(payload, legacySecret);
    expect(decryptJson(encrypted, legacySecret)).toEqual(payload);
  });
});
