# Mobile Relay Protocol

This document describes the end-to-end encrypted mobile relay protocol used by `@inferenco/nova-wallet-adapter` for connecting mobile browsers to Nova Wallet via the hosted nova-service relay.

## Overview

When the adapter detects a mobile browser, it uses a hosted relay service (nova-service) to bridge communication between the dApp and the Nova Wallet mobile app. All request and response payloads are end-to-end encrypted &mdash; the relay server never sees plaintext data.

```
Mobile Browser (dApp)         nova-service (relay)         Nova Wallet App
      │                            │                            │
      │◄── E2E Encrypted ────────►│◄── E2E Encrypted ────────►│
      │                            │                            │
      │   relay sees only          │                            │
      │   opaque ciphertext        │                            │
```

## Cryptographic Stack

| Layer | Algorithm | Library | Purpose |
|-------|-----------|---------|---------|
| Key exchange | X25519 (ECDH) | `@noble/curves` | Establish shared secret |
| Key derivation | HKDF-SHA256 | `@noble/hashes` | Derive encryption key from shared secret |
| Encryption | XChaCha20-Poly1305 | `@noble/ciphers` | Authenticated encryption of payloads |
| Nonce | 24 random bytes | `crypto.getRandomValues` | Per-message uniqueness |
| Encoding | Base64url (no padding) | Manual implementation | Transport-safe binary encoding |

## Key Exchange

### Keypair Generation

The dApp generates an X25519 keypair at the start of each pairing:

```typescript
import { x25519 } from "@noble/curves/ed25519";

// Generate 32-byte random private key
const privateKey = crypto.getRandomValues(new Uint8Array(32));

// Derive public key
const publicKey = x25519.getPublicKey(privateKey);
```

### Shared Secret Derivation

Once the wallet provides its public key (via the relay), both sides derive the same shared secret:

```typescript
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

// ECDH: combine dApp private key + wallet public key
const rawSharedSecret = x25519.getSharedSecret(dappPrivateKey, walletPublicKey);

// HKDF: derive a 32-byte encryption key
const encryptionKey = hkdf(sha256, rawSharedSecret, undefined, "nova-connect-relay", 32);
```

**HKDF parameters:**
- Hash: SHA-256
- IKM (input keying material): raw X25519 shared secret
- Salt: `undefined` (empty)
- Info: `"nova-connect-relay"` (context string)
- Output length: 32 bytes

## Encryption

### Encrypt

```typescript
import { xchacha20poly1305 } from "@noble/ciphers/chacha";

function encryptPayload(plaintext: string, sharedSecret: Uint8Array): string {
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  const cipher = xchacha20poly1305(sharedSecret, nonce);
  const ciphertext = cipher.encrypt(data);

  // Concatenate: nonce (24 bytes) + ciphertext
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce);
  combined.set(ciphertext, nonce.length);

  return base64urlEncode(combined);
}
```

### Decrypt

```typescript
function decryptPayload(encoded: string, sharedSecret: Uint8Array): string {
  const combined = base64urlDecode(encoded);

  // Split: first 24 bytes = nonce, rest = ciphertext
  const nonce = combined.slice(0, 24);
  const ciphertext = combined.slice(24);

  const cipher = xchacha20poly1305(sharedSecret, nonce);
  const plaintext = cipher.decrypt(ciphertext);

  return new TextDecoder().decode(plaintext);
}
```

### Base64url Encoding

The adapter uses manual base64url encoding (no padding) for transport safety:

```typescript
function base64urlEncode(bytes: Uint8Array): string {
  const binString = Array.from(bytes, (b) => String.fromCodePoint(b)).join("");
  return btoa(binString)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binString = atob(padded);
  return Uint8Array.from(binString, (c) => c.codePointAt(0)!);
}
```

## Pairing Flow

### Step 1: Create Pairing

The dApp sends its public key to the relay to create a pairing:

```
POST /v1/pairings
Content-Type: application/json

{
  "dappPublicKey": "<base64url-encoded X25519 public key>",
  "callbackUrl": "https://your-dapp.com/current-page",
  "appName": "Your dApp",
  "origin": "https://your-dapp.com"
}
```

**Response:**

```json
{
  "pairingId": "uuid",
  "dappPairingToken": "auth-token",
  "walletDeeplinkUrl": "inferenco://connect?pairingId=...&walletClaimToken=...",
  "websocketUrl": "wss://nova-service-.../v1/ws",
  "expiresAt": "2026-04-04T12:00:00Z"
}
```

### Step 2: Launch Deeplink

The adapter opens the `walletDeeplinkUrl` to hand off to the Nova Wallet mobile app:

```
inferenco://connect?pairingId={id}&walletClaimToken={token}&callbackUrl={url}&dappPublicKey={key}
```

### Step 3: Wallet Claims and Approves

In the Nova Wallet app:
1. Wallet claims the pairing with its claim token
2. Wallet generates its own X25519 keypair
3. Wallet derives the shared secret using `dappPublicKey`
4. User approves or rejects the connection
5. Wallet sends its public key and encrypted session data back to the relay

### Step 4: Poll or WebSocket

The dApp waits for the pairing to be approved:

**Polling:**
```
GET /v1/pairings/{pairingId}?dappPairingToken={token}
```

**WebSocket (preferred):**
```
WS wss://nova-service-.../v1/ws

→ { "type": "hello", "role": "dapp", "token": "{dappPairingToken}", "target": { "kind": "pairing", "id": "{pairingId}" } }
← { "type": "pairing.approved", ... }
```

**Pairing status transitions:**
```
pending → claimed → approved
                  → rejected
         → expired
         → revoked
```

### Step 5: Decrypt Result

When approved, the response includes `walletPublicKey` and optionally `encryptedResult`:

1. Derive shared secret: `ECDH(dappPrivateKey, walletPublicKey)` → `HKDF`
2. Decrypt `encryptedResult` using XChaCha20-Poly1305
3. Parse decrypted JSON for session details
4. Store session with encryption credentials for future requests

## Request Flow (Post-Pairing)

After a session is established, signing requests use the same encryption:

### Step 1: Create Request

```
POST /v1/requests
Content-Type: application/json
X-Dapp-Session-Token: {dappSessionToken}

{
  "sessionId": "session-uuid",
  "method": "signMessage",
  "encryptedRequest": "<base64url-encoded encrypted JSON>",
  "callbackUrl": "https://your-dapp.com/current-page",
  "requestMetadata": { ... }
}
```

The `encryptedRequest` contains the method-specific payload, encrypted with the session's shared secret.

**Methods:**
- `signMessage` &mdash; `{ message, nonce, address?, application?, chainId? }`
- `signTransaction` &mdash; `{ rawTransactionBcsHex, options? }`
- `signAndSubmitTransaction` &mdash; `{ transactionPayload, options? }`

**Response:**

```json
{
  "requestId": "request-uuid",
  "walletDeeplinkUrl": "inferenco://approve?requestId=...&sessionId=...",
  "expiresAt": "2026-04-04T12:05:00Z"
}
```

### Step 2: Launch Deeplink

Open `walletDeeplinkUrl` for the user to approve in the wallet app.

### Step 3: Poll or WebSocket

```
GET /v1/requests/{requestId}
X-Dapp-Session-Token: {dappSessionToken}
```

**WebSocket:**
```
→ { "type": "hello", "role": "dapp", "token": "{dappSessionToken}", "target": { "kind": "session", "id": "{sessionId}" } }
← { "type": "request.approved", "requestId": "...", "encryptedResult": "..." }
```

**Request status transitions:**
```
pending → approved
        → rejected
        → expired
        → cancelled
```

### Step 4: Decrypt Result

Decrypt `encryptedResult` with the session's shared secret to get the signing result.

## WebSocket Protocol

The WebSocket provides real-time notifications instead of polling.

### Connection

```
wss://nova-service-.../v1/ws
```

### Hello Message

```json
{
  "type": "hello",
  "role": "dapp",
  "token": "<dappPairingToken or dappSessionToken>",
  "target": {
    "kind": "pairing",
    "id": "<pairingId>"
  }
}
```

### Event Types

| Event | Description |
|-------|-------------|
| `pairing.approved` | Pairing was approved by the wallet |
| `pairing.rejected` | Pairing was rejected by the user |
| `request.approved` | Signing request was approved |
| `request.rejected` | Signing request was rejected |
| `session.revoked` | Session was revoked |
| `session.expired` | Session expired |

### Timeout

The adapter waits for WebSocket responses with a configurable timeout (default: 15 seconds). If no response arrives, it falls back to HTTP polling.

## Persistence Across Page Reloads

Mobile browsers often reload the page when returning from a deeplink. The adapter handles this by persisting state:

1. **Before deeplink launch:** Pending pairing state (keypair, pairingId, tokens) is saved to `localStorage` under `inferenco:nova-pending-mobile-pairing`
2. **On page load:** The adapter checks for pending pairings and resumes polling
3. **Callback parameters:** The wallet may redirect back with URL parameters (`address`, `publicKey`, `protocolPublicKey`, etc.) which are parsed and used to complete the session

## Security Properties

| Property | Guarantee |
|----------|-----------|
| **Confidentiality** | XChaCha20-Poly1305 encryption &mdash; relay never sees plaintext |
| **Authenticity** | Poly1305 MAC prevents tampering |
| **Forward secrecy** | Ephemeral X25519 keypairs per pairing |
| **Replay protection** | Random 24-byte nonces per message |
| **Session binding** | Shared secret tied to specific keypair exchange |

## Default Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `relayBaseUrl` | `https://nova-service-160604102004.europe-west1.run.app` | Hosted relay |
| `websocketBaseUrl` | `wss://nova-service-160604102004.europe-west1.run.app/v1/ws` | WebSocket endpoint |
| `mobilePollIntervalMs` | `1000` | Poll frequency |
| `mobileRequestTimeoutMs` | `180000` | Total request timeout (3 min) |
| `mobileSocketTimeoutMs` | `15000` | WebSocket wait timeout (15s) |

All defaults can be overridden via `NovaWalletOptions`.
