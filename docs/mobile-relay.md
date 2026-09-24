# Mobile Relay Protocol

This document describes the end-to-end encrypted mobile relay protocol used by `@inferenco/infer-wallet-adapter` for connecting mobile browsers to Infer Wallet via the hosted Infer Service relay.

## Overview

When the adapter detects a mobile browser, it uses a hosted relay service (Infer Service) to bridge communication between the dApp and the Infer Wallet mobile app. All request and response payloads are end-to-end encrypted &mdash; the relay server never sees plaintext data.

```
Mobile Browser (dApp)         nova-service (relay)         Infer Wallet App
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
const encryptionKey = hkdf(sha256, rawSharedSecret, undefined, "infer-connect-relay", 32);
```

**HKDF parameters:**
- Hash: SHA-256
- IKM (input keying material): raw X25519 shared secret
- Salt: `undefined` (empty)
- Info: `"infer-connect-relay"` (context string)
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

The adapter opens the `walletDeeplinkUrl` to hand off to the Infer Wallet mobile app:

```
inferenco://connect?pairingId={id}&walletClaimToken={token}&callbackUrl={url}&dappPublicKey={key}
```

### Step 3: Wallet Claims and Approves

In the Infer Wallet app:
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

{
  "sessionId": "session-uuid",
  "dappSessionToken": "<session-token>",
  "method": "signMessage",
  "encryptedRequest": "<base64url-encoded encrypted JSON>",
  "callbackUrl": "https://your-dapp.com/current-page",
  "requestMetadata": { ... }
}
```

The `encryptedRequest` contains the method-specific payload, encrypted with the session's shared secret.

**Methods:**
- `signMessage` &mdash; `{ message, nonce, address?, application?, chainId? }`
- `signTransaction` &mdash; wallet-standard v1.1 input, or legacy `{ rawTransactionBcsHex, options? }`
- `signAndSubmitTransaction` &mdash; `{ transactionPayload, options? }`

For `signTransaction` responses, `rawTransactionBcsHex` should encode the full SDK
transaction wrapper (`SimpleTransaction` or `MultiAgentTransaction`). Legacy
raw-only `RawTransaction` BCS is still accepted for single-signer transactions, but
it cannot carry secondary signer or fee payer metadata.

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
x-infer-session-token: {dappSessionToken}
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

## Transaction contract and recovery

Request polling and session deletion send only `x-infer-session-token`.
The removed Nova header is not sent. Deploy the matching Infer Service header
and CORS change before testing this adapter against the hosted relay.

For prebuilt `SimpleTransaction` and `MultiAgentTransaction` input, Infer Connect
sends compact `rawTransactionBcsHex`/`bcsHex` through both external transports
and the injected provider. Returned `authenticatorHex` and
`rawTransactionBcsHex` are strictly decoded: invalid hex, trailing bytes and
noncanonical BCS fail. A prebuilt request requires byte-for-byte equality with
the original transaction, including signer/fee-payer metadata. Real SDK result
objects remain supported for in-process providers; plain JSON objects without
canonical BCS do not substitute for them.

`cedra:signTransaction` remains version `1.1` and returns the full
`{ authenticator, rawTransaction }` result. Sign-only never invokes submission.
Only a validated structured rejection becomes `USER_REJECTED`; HTTP failures,
malformed signing output and mixed rejection/signature material remain errors.

Before request creation, Infer Connect stores an opaque invocation identity in
same-origin IndexedDB. Set onInvocationPrepared to durably associate that
identity with an application action before the outbound POST. A failure in this
awaited hook is definitely not invoked. Once POST starts, a lost response is
unknown: inspect listRecoverableInvocations() and never issue an automatic
replacement. The creation endpoint does not yet offer a coordinated idempotency
key.

After the response supplies a request ID, the adapter writes an exact-scoped
receipt to IndexedDB before wallet launch or onRequestCreated delivery. The
existing same-tab sessionStorage receipt remains for rc.20 compatibility and is
migrated when read. Set onRequestCreated to associate the exact request ID with
the application action. These public hooks and the IndexedDB records contain
no bridge token, relay session token, shared secret, or signing key. Active
session credentials remain in the existing adapter-owned localStorage session.
Other JavaScript on the same origin can access browser storage; this is not an
XSS boundary.

Use listRecoverableRequests(), readRecoverableRequest(recoveryId), and
acknowledgeRecoverableRequest(recoveryId) from the package, InferClient,
InferWallet, or the optional AIP-62 inferenco:recoveredOutcomes feature. The
opaque recoveryId disambiguates reused request IDs across sessions; the exact
requestId remains available for existing callers where unique. List and
acknowledge are asynchronous. Read returns pending, validated approved output,
rejected, or unknown. Recovery never creates or cancels a request, signs,
submits, or opens a wallet. The original origin, session, account, network,
method, and request ID are checked before remote reads. A verified final result
is persisted before a direct signing call returns or a recovery callback fires,
and replayed locally after a tab or session change.

Set onRecoveredOutcome for optional startup notification, or call
subscribeRecoveredOutcomes() at any time. The coordinator wakes on startup,
focus/visibility return, pageshow, reconnection, and cross-tab record changes.
A subscriber receives each retained final outcome once per client instance;
a failed callback can be retried at a later wake. Application writes must be
idempotent by recoveryId. Acknowledge only after the application durably records
the verified result. Acknowledgement uses an exact-record transaction and
retains a tombstone for 30 days. Call dispose() when replacing an InferClient
or InferWallet instance.

If the original active session is lost, a previously verified final result can
still replay from IndexedDB. An unverified old-session request stays unknown;
a new session is never used as if it owned the original request. After
independent wallet/relay/chain reconciliation, archive it with an explicit
reference and inspect it through listArchivedRecoverableRequests(). Archiving
is not proof of non-submission or permission to retry. Unknown active evidence
does not expire automatically; acknowledged tombstones and explicit archives
are eligible for cleanup after 30 and 180 days respectively. Browser data
deletion, a different origin/browser/device, or loss of required keys can make
recovery impossible.

Phase 2 (rc.22) closes the "old session, new identity" gap via two
explicitly authorized original-request read contracts: the mobile-relay
`POST/GET /v1/requests/:requestId/read-grant` flow (see "Authorized
Original-Request Read (rc.22)" below) and the desktop-bridge
`GET /read-result/:requestId` endpoint served by Infer Desk's redb
durable store. The adapter attempts both paths before falling back to
the rc.21 `{status: "unknown"}` payload.

The optional inferenco:connectionHealth feature exposes checking, connected,
unreachable, and reconnect-required states for external sessions. A browser
TypeError is ambiguous: the cached identity is retained for recovery, but
cannot validate the bridge as live. A cached mobile relay session reports
checking with a reason because the relay currently has no authenticated
session-health read route; possession of a token alone is not proof of liveness. External-browser reconnect must use the
approved inferenco:// and PKCE callback path to obtain a fresh endpoint; do
not discover URL tokens publicly or repeat an uncertain transaction. The
lower-level readPendingMobileRelayRequests, resumeMobileRelayRequest, and
clearPendingMobileRelayRequest exports remain for existing integrations.

## Authorized Original-Request Read (rc.22)

The Infer Connect recovery repair plan closes the protocol dependency
where a new dapp session cannot read an old unverified result. After the
original wallet session is gone, the dapp may still hold an active
`DurableRequest` whose `sessionId` does not match the current session
but whose `(origin, transport, address, network, chainId)` DOES match
— i.e. the SAME wallet identity is alive on a fresh sessionId. In that
case the adapter attempts two authorized-read paths before falling back
to the rc.21 `{status: "unknown"}` payload.

The exact scope binding the read-grant is checked against is:

- `origin` (browser origin; tied to IndexedDB scope)
- `accountAddress` (the address bound to the old session)
- `network` (Cedra / Testnet / Mainnet, etc.)
- `chainId` (numeric chain id)
- `method` (the original request's exact method — the relay's S1
  endpoint REQUIRES it and rejects the mint with 400 `invalid_scope`
  when missing; it also validates `method` against the original
  request row)

The adapter's local gate additionally requires the row's `transport`
to match the current session's transport and the row's endpoint to
match the current session's relay base URL / Desk bridge origin — but
`transport` is NOT part of the relay wire scope. An optional
`invocationId` is included when the row has one (the relay uses it for
idempotent re-mint matching).

### Mobile-relay path (S1)

1. The dapp posts a one-shot read-grant:
   ```
   POST /v1/requests/:requestId/read-grant
   x-infer-session-token: <new session's dappSessionToken>
   Content-Type: application/json

   {
     "dappSessionToken": "<new session's dappSessionToken>",
     "scope": {
       "origin": "https://dapp.example",
       "accountAddress": "0xABC…",
       "network": "testnet",
       "chainId": 2,
       "method": "signAndSubmitTransaction",
       "invocationId": "<optional, when the row has one>"
     }
   }
   ```
   The relay verifies the scope matches BOTH the new session row and
   the original request's stored scope (origin/address/network/
   chainId/method) and mints a `grantId` bound to the new session
   (resolved from the presented `dappSessionToken`, never from the
   scope). Re-minting within the grant TTL is idempotent: the relay
   returns the existing grant instead of minting a second one.

2. The wallet (W2) re-wraps the original ciphertext under the NEW
   session's `sharedSecret` (`XChaCha20-Poly1305` envelope) and POSTs
   it to `POST /v1/requests/:requestId/read-delivery`, authenticating
   with the ORIGINAL session's `walletSessionToken`. NOTE: the relay
   has no wallet-facing grant-list endpoint or WS broadcast yet — the
   wallet learns about a pending grant from a user action ("Recover
   pending") until the relay ships an indexed read (`discoverPendingReadGrants`
   in the wallet is a documented Phase 2 stub). Without wallet-side
   fulfillment the grant stays `pending_fulfillment` and the dapp's
   poll ends in `grant_pending_timeout`.

3. The dapp polls the grant state:
   ```
   GET /v1/requests/:requestId/read-grant
   x-infer-session-token: <new session's dappSessionToken>
   ```
   Until `status === "fulfilled"`:
   ```json
   {
     "grantId": "…",
     "requestId": "…",
     "scope": { "origin": "…", "accountAddress": "…", "network": "…", "chainId": 2, "method": "signAndSubmitTransaction" },
     "status": "fulfilled",
     "expiresAt": "…",
     "fulfilledAt": "…",
     "redeliveredEncryptedResult": "{ v: 1, nonce: '…', ciphertext: '…' }"
   }
   ```
   The grant status enum mirrors the relay's `relay_read_grant_status`:
   `pending_fulfillment` | `fulfilled` | `expired` | `denied`. Expired,
   denied, and not-found grants are signaled via HTTP 410/404 (the
   adapter treats them as terminal and falls back to rc.21).

4. The dapp decrypts `redeliveredEncryptedResult` with the CURRENT
   session's `sharedSecret`, validates the decoded payload against
   the row's stored scope, persists the verified final via
   `saveDurableFinal` (BEFORE returning — preserve the rc.21 ordering
   invariant), and returns the recovered outcome.

If the poll never sees `fulfilled` within the bound (default: 30 s),
the recovery returns `{status: "unknown", reason: "grant_pending_timeout"}`.

If the decrypt fails (e.g. W2 produced ciphertext under a different
shared secret), the recovery returns `{status: "unknown", reason: "decrypt_failed"}`.

### Desktop-bridge path (D2)

The desktop-bridge path is simpler because Infer Desk is the durable
authority for results (redb-backed store, `persistence.rs`). No
re-encryption layer is needed:

```
GET /<token>/read-result/:requestId?newSessionId=<new-session>&origin=…&accountAddress=…&network=…&chainId=…&method=…
```

The Desk-side dispatch (`read_result_for_session`) validates the new
bridge session's scope (origin/address/network) plus the exact
`method` against the stored result's `ResultScope` before returning
anything. A scope mismatch returns 422 (`{error: "scope_mismatch"}`);
a missing token-gated path returns 404 and the adapter falls back to
rc.21 behavior.

> **Endpoint status (rc.22):** the durable store and the
> `read_result_for_session` dispatch exist on the Desk side, but the
> HTTP route serving `GET /read-result/:requestId` is NOT yet wired
> into the external-bridge transport. Until Desk ships the route,
> every desktop authorized read 404s and the adapter falls back to
> the byte-identical rc.21 `{status: "unknown"}` payload — the
> fallback gate makes the missing route safe but inert.

### Fallback contract

If the relay lacks the S1 endpoints, or the Desk lacks the D2 endpoint,
the adapter's behavior is byte-identical to rc.21: the read-grant mint
returns 404 → the `authorizedReadMobileRelay` helper returns `null` →
the caller falls through to `{status: "unknown", reason: "Original
wallet session cannot authenticate a remote read; reconnect or
reconcile externally"}`. This guarantees older deployments see no
behavior change.

### Relationship to existing API

The authorized-read path is fully internal to `readRecoverableRequest`.
No new public API is required to benefit from rc.22; existing
applications calling `listRecoverableRequests()` /
`readRecoverableRequest(recoveryId)` automatically pick up the new
path. The lower-level primitives `mintReadGrant`, `getReadGrant`, and
`readResultForSession` are exported from the package for tests and
for advanced integrations that need to drive the path explicitly.

### Hard guarantees

- The adapter NEVER signs, broadcasts, or opens another transaction
  approval during the authorized-read path. The only HTTP traffic is
  the read-grant mint/poll (relay) or the durable read IPC (Desk).
- Expiry / revocation / disconnect do NOT block reconciliation — the
  new path is bounded only by its own poll timeout (default 30 s) and
  by the row's lifetime.
- After a full reload, the adapter recovers the *result*, not the old
  JS promise. The result is durably persisted via `saveDurableFinal`
  BEFORE returning, so a follow-up `readRecoverableRequest` locally
  replays without re-issuing any mint/poll.
- Secrets stay adapter/wallet-owned. The `dappSessionToken` is sent
  on the wire but no shared secret or signing key is logged.

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

Transaction requests poll HTTP immediately and then at the configured interval.
WebSocket events and page focus/visibility changes only wake a pending poll early.
A missing, silent or failed WebSocket cannot block transaction polling. This does
not change the separate pairing flow.

Transient network errors, HTTP 429 and 5xx responses retry GET within the request
deadline. Request creation is never automatically retried. An elapsed timeout is
an unknown outcome, not proof of rejection or proof that nothing was submitted.
A final read is allowed after server expiry to recover an already completed result.

## Persistence Across Page Reloads

Mobile browsers often reload the page when returning from a deeplink. The adapter handles this by persisting state:

1. **Before deeplink launch:** Pending pairing state (keypair, pairingId, tokens) is saved to `localStorage` under `inferenco:infer-pending-mobile-pairing`
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

All defaults can be overridden via `InferWalletOptions`.
