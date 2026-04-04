import { randomBytes } from "@noble/hashes/utils";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { Buffer } from "node:buffer";

export interface NovaKeyPair {
  privateKey: string;
  publicKey: string;
}

export interface NovaEncryptedEnvelope {
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

export function createKeyPair(): NovaKeyPair {
  const privateKey = randomBytes(32);
  const publicKey = x25519.getPublicKey(privateKey);
  return {
    privateKey: toBase64Url(privateKey),
    publicKey: toBase64Url(publicKey)
  };
}

export function deriveSharedSecret(privateKey: string, publicKey: string): string {
  const shared = x25519.getSharedSecret(toBytes(privateKey), toBytes(publicKey));
  const key = hkdf(sha256, shared, undefined, "nova-connect-relay", 32);
  return toBase64Url(key);
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
  } satisfies NovaEncryptedEnvelope);
}

export function decryptJson<T>(value: string, sharedSecret: string): T {
  const envelope = JSON.parse(value) as NovaEncryptedEnvelope;
  const cipher = xchacha20poly1305(toBytes(sharedSecret), toBytes(envelope.nonce));
  const plaintext = cipher.decrypt(toBytes(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
