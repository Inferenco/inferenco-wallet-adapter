import { randomBytes } from "@noble/hashes/utils";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { Buffer } from "node:buffer";

export interface InferKeyPair {
  privateKey: string;
  publicKey: string;
}

export interface InferEncryptedEnvelope {
  v: 1;
  nonce: string;
  ciphertext: string;
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = base64.length % 4;
  return padding === 0 ? base64 : `${base64}${"=".repeat(4 - padding)}`;
}

function toBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(fromBase64Url(value), "base64"));
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function createKeyPair(): InferKeyPair {
  const privateKey = randomBytes(32);
  const publicKey = x25519.getPublicKey(privateKey);
  return {
    privateKey: toBase64Url(privateKey),
    publicKey: toBase64Url(publicKey)
  };
}

// v0.3.0 (rebrand): canonical HKDF info string. The mobile relay uses a
// per-derivation `info` parameter to domain-separate the derived key from
// any other HKDF consumer. nova-service (the mobile relay backend) currently
// derives with the legacy `"nova-connect-relay"` info string; the rebranded
// name is the canonical post-rebrand contract.
const HKDF_INFO_NEW = "infer-connect-relay";
const HKDF_INFO_LEGACY = "nova-connect-relay";

function deriveSharedKeyWithInfo(sharedSecret: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, sharedSecret, undefined, info, 32);
}

/**
 * Derive the AEAD key shared between dApp and wallet.
 *
 * v0.3.0 (rebrand): dual-derive — try the canonical rebrand HKDF info
 * (`"infer-connect-relay"`) first; if decryption/auth fails on the wire (the
 * mobile wallet may still be speaking the legacy info string until nova-service
 * is fully rebranded), retry with the legacy `"nova-connect-relay"` info.
 *
 * Returns the derived key as base64url. Callers that need both directions
 * (encrypt + decrypt) should always derive both sides with the same `info` —
 * the dApp and mobile wallet negotiate the info via the first successful pair,
 * which is then cached.
 */
export function deriveSharedSecret(privateKey: string, publicKey: string): string {
  const shared = x25519.getSharedSecret(toBytes(privateKey), toBytes(publicKey));
  // First attempt with the canonical rebrand info.
  const keyNew = deriveSharedKeyWithInfo(shared, HKDF_INFO_NEW);
  return toBase64Url(keyNew);
}

/**
 * Derive with the legacy HKDF info string. Used as a fallback on
 * decrypt-failure to interoperate with mobile wallets that still speak
 * the old `"nova-connect-relay"` info.
 *
 * Typical use:
 * ```ts
 * try {
 *   return decryptJson(payload, deriveSharedSecret(priv, pub));
 * } catch {
 *   return decryptJson(payload, deriveSharedSecretLegacy(priv, pub));
 * }
 * ```
 */
export function deriveSharedSecretLegacy(
  privateKey: string,
  publicKey: string
): string {
  const shared = x25519.getSharedSecret(toBytes(privateKey), toBytes(publicKey));
  const keyLegacy = deriveSharedKeyWithInfo(shared, HKDF_INFO_LEGACY);
  return toBase64Url(keyLegacy);
}

export function encryptJson(value: unknown, sharedSecret: string): string {
  const key = toBytes(sharedSecret);
  const nonce = randomBytes(24);
  const cipher = xchacha20poly1305(key, nonce);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = cipher.encrypt(plaintext);
  return JSON.stringify({
    v: 1,
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(ciphertext)
  } satisfies InferEncryptedEnvelope);
}

export function decryptJson<T>(value: string, sharedSecret: string): T {
  const envelope = JSON.parse(value) as InferEncryptedEnvelope;
  const cipher = xchacha20poly1305(toBytes(sharedSecret), toBytes(envelope.nonce));
  const plaintext = cipher.decrypt(toBytes(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
