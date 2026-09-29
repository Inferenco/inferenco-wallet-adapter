# Architecture

This document describes the internal architecture of `@inferenco/infer-wallet-adapter`, including how it connects dApps to Infer Desk and Infer Wallet.

## Overview

The adapter connects Cedra dApps to two Infer products:

- **Infer Desk** &mdash; Desktop application, connected via a local HTTP bridge
- **Infer Wallet** &mdash; Mobile wallet app, connected via nova-service (a hosted relay) and `inferenco://` deeplinks

Two dApp integration surfaces &mdash; `InferWallet` (plugin adapter) and the AIP-62 bridge &mdash; share a single `InferClient` that handles all connection logic. The dApp integration mode is independent of which Infer product the user connects to.

```
┌──────────────────────────────────────────────────────────────┐
│                        Your dApp                             │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────┐            ┌──────────────────────┐     │
│  │   InferWallet    │            │   AIP-62 Bridge      │     │
│  │   (plugin)      │            │   registerInferWallet  │     │
│  └────────┬────────┘            └──────────┬───────────┘     │
│           │                                │                 │
│           └──────────┬─────────────────────┘                 │
│                      ▼                                       │
│           ┌──────────────────┐                               │
│           │    InferClient    │                               │
│           │   (core logic)   │                               │
│           └────────┬─────────┘                               │
│                    │                                         │
└────────────────────┼─────────────────────────────────────────┘
                     │
     ┌───────────────┼───────────────┐
     ▼               ▼               ▼
┌──────────┐  ┌─────────────┐  ┌────────────┐
│ Injected │  │  Infer Desk  │  │Infer Wallet │
│ Provider │  │  (desktop)  │  │ (mobile)   │
│          │  │             │  │            │
│ window.  │  │ localhost   │  │nova-service│
│ inferenco│  │ :21984      │  │ + deeplink │
└──────────┘  └─────────────┘  └────────────┘
```

## Module Structure

```
src/
├── index.ts              # Main entry — re-exports everything
├── aip62.ts              # AIP-62 wallet-standard bridge + registration
├── auto-register.ts      # Side-effect auto-registration entry point
├── InferClient.ts         # Core client — connection, signing, session orchestration
├── InferWallet.ts         # Plugin-style adapter class
├── provider.ts           # Injected provider detection (window.inferenco, etc.)
├── bridge.ts             # Infer Desk HTTP bridge + session management
├── mobileRelay.ts        # Infer Wallet relay REST transport (nova-service)
├── mobileSocket.ts       # Infer Wallet relay WebSocket transport
├── mobileCrypto.ts       # X25519 key exchange + XChaCha20-Poly1305 encryption
├── conversion.ts         # Data normalization helpers (accounts, networks, txns)
├── deeplink.ts           # Deeplink URL generation
├── constants.ts          # Default URLs, timeouts, storage keys, icon
├── types.ts              # All TypeScript interfaces and type definitions
└── errors.ts             # InferAdapterError + error code remapping
```

## Connecting to Infer Desk

**When:** Desktop browser, Infer Desk application running locally.

Infer Desk exposes a local HTTP bridge at `http://127.0.0.1:21984`. The adapter communicates with it directly &mdash; no external services involved.

```
dApp  ──GET /connect──────────────▶  Infer Desk (localhost:21984)
dApp  ◀── { requestId } ──────────  Infer Desk
                                          │
                                     User approves
                                     in Infer Desk UI
                                          │
dApp  ──GET /request/{id}─────────▶  Infer Desk
dApp  ◀── { status: "approved",     Infer Desk
           address, publicKey,
           sessionId }
```

**Poll-based flow:**
1. Initiate request → receive `requestId`
2. Poll `/request/{requestId}` at 250ms intervals
3. Status transitions: `pending` → `approved` | `rejected` | `expired`
4. Total timeout: 120 seconds

**Endpoints:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/connect` | `GET` | Start connection |
| `/sign-message` | `POST` | Sign a message |
| `/sign-transaction` | `POST` | Sign a transaction |
| `/transaction` | `POST` | Sign and submit |
| `/request/{requestId}` | `GET` | Poll request status |
| `/session/{sessionId}` | `GET` | Validate session |
| `/connection` | `DELETE` | Revoke connection |
| `/session/{sessionId}` | `DELETE` | Revoke session |

**Session persistence:** Approved sessions are stored in `localStorage` as `InferExternalSession` with `transport: "desktop-bridge"`. On subsequent visits, the adapter validates the stored session against the bridge before reuse.

**Desktop deeplink:** If Infer Desk is not running (the bridge probe fails), the adapter launches `inferenco://login?redirect=...` to open Infer Desk and waits for a callback via localStorage markers.

## Connecting to Infer Wallet

**When:** Mobile browser (or external browser without an injected provider or local Infer Desk).

Infer Wallet connections go through **nova-service**, a hosted relay that brokers end-to-end encrypted communication between the dApp and the Infer Wallet mobile app. The relay never sees plaintext data.

```
dApp (mobile browser)           nova-service (relay)         Infer Wallet App
 │                                   │                            │
 │──POST /v1/pairings──────────────▶│                            │
 │◀── { pairingId,                  │                            │
 │      walletDeeplinkUrl }         │                            │
 │                                   │                            │
 │──open inferenco:// deeplink─────────────────────────────────▶│
 │                                   │                            │
 │                                   │◀── wallet claims pairing──│
 │                                   │                            │
 │                                   │◀── wallet approves ───────│
 │                                   │    (encrypted result)      │
 │                                   │                            │
 │◀── poll/websocket ───────────────│                            │
 │    (encrypted result)             │                            │
 │                                   │                            │
 │── decrypt with shared secret      │                            │
```

**Crypto flow:**
1. dApp generates X25519 keypair
2. dApp sends public key with pairing request to nova-service
3. Wallet generates its own keypair, derives shared secret via ECDH
4. Both sides derive encryption key using HKDF-SHA256
5. All payloads encrypted with XChaCha20-Poly1305

**Deeplinks** are integral to this flow &mdash; they hand off from the browser to the Infer Wallet app for the user to approve, then Infer Wallet sends the encrypted result back through the relay.

See [Mobile Relay Protocol](mobile-relay.md) for the full cryptographic specification.

## Injected Provider

**When:** An Infer browser extension or embedded wallet is installed, exposing a provider on the window object.

The adapter calls the provider directly &mdash; no bridge, relay, or deeplink needed.

```
dApp  ──▶  window.inferenco.connect()  ──▶  Infer Extension
dApp  ◀──  { address, publicKey }       ◀──  Infer Extension
```

**Detection priority (v0.3.0 rebrand):**
1. `window.inferenco` (primary)
2. `window.infer` (new rebrand namespace)
3. `window.nova` (legacy alias, kept for transition; remove in 0.4.0)
4. `window.cedra` if `isInferWallet === true` (or legacy `isNovaWallet === true`)
5. `window.aptos` if `isInferWallet === true` (or legacy `isNovaWallet === true`)

Supports real-time event subscriptions (`onAccountChange`, `onNetworkChange`) that are not available through the bridge or relay.

## Connection Flow

The `InferClient.connect()` method executes this decision tree:

```
connect()
│
├─▶ 1. Check injected provider
│      window.inferenco / window.nova / branded aliases
│      └─ If found → provider.connect() → done
│
├─▶ 2. Check for mobile callback resume
│      Returning from Infer Wallet deeplink with callback params?
│      └─ If yes → parse params, store session → done
│
├─▶ 3. Check for stored session
│      Read from localStorage, validate against Infer Desk bridge or relay
│      └─ If valid → reuse session → done
│      └─ If invalid → clear session, continue
│
├─▶ 4. Detect environment
│      └─ Mobile browser?
│         ├─ Yes → Connect via Infer Wallet
│         │        Create pairing on nova-service,
│         │        launch inferenco:// deeplink,
│         │        poll/websocket for approval
│         │        └─ done
│         │
│         └─ No (desktop) → Connect via Infer Desk
│                           GET localhost:21984/connect,
│                           poll for approval
│                           └─ If Infer Desk running → done
│                           └─ If not → deeplink handoff
│
└─▶ 5. Desktop deeplink handoff
       Launch inferenco://login?redirect=...
       Wait for callback via localStorage markers
       └─ Timeout after ~120s if no response
```

## Signing Flow

Once connected, signing operations follow the same transport that was used to connect:

**Injected provider:** Direct call → immediate result.

**Infer Desk:**
1. `POST /sign-message` (or `/sign-transaction`, `/transaction`) with payload
2. Receive `requestId`
3. Poll `/request/{requestId}` until user approves in Infer Desk
4. Extract result from poll response

**Infer Wallet:**
1. Encrypt request payload with shared secret
2. `POST /v1/requests` with encrypted payload to nova-service
3. Launch deeplink for user to approve in Infer Wallet
4. Poll or listen via WebSocket for encrypted result
5. Decrypt result with shared secret

## Session Lifecycle

```
                     ┌──────────────┐
                     │   No Session │
                     └──────┬───────┘
                            │ connect()
                            ▼
                     ┌──────────────┐
                     │   Pending    │ ←── waiting for user approval
                     └──────┬───────┘
                            │ approved
                            ▼
                     ┌──────────────┐
          ┌────────▶│   Active     │ ←── stored in localStorage
          │         └──────┬───────┘
          │                │
          │    ┌───────────┼────────────┐
          │    │           │            │
          │    ▼           ▼            ▼
          │  page       disconnect()  expired/
          │  reload                   revoked
          │    │           │            │
          │    ▼           ▼            ▼
          │  validate   ┌──────────────┐
          │  session    │   Cleared    │
          │    │        └──────┬───────┘
          │    │               │
          │    │               ▼
          │    │      ┌────────────────────────────┐
          │    │      │ InferClient.emit("disconnect")│ ─── peer tabs, embedded webview
          │    │      └────────────────────────────┘
          │    │
          │    ├─ valid ──┘
          │    │
          └────┘
               └─ invalid → clear → fresh connect()
```

**Disconnect detection paths (added in v0.2.0-rc.8):**

1. **Dapp-side `disconnect()`** — calls `clearExternalSession()`, fires the
   new `InferClient.emit("disconnect")` event locally, and broadcasts
   `inferenco:nova-session-cleared` over `BroadcastChannel` /
   `window.postMessage` so peer tabs learn in the same tick.
2. **Peer-tab `clearExternalSession`** — the `storage` event fires in
   other tabs with `newValue === null`; the
   `installExternalSessionResumeListeners` storage handler dispatches
   `broadcastExternalDisconnect()` which clears state and emits
   `disconnect` in each tab.
3. **Wallet-initiated disconnect from inside Infer Desk's embedded
   webview** — `disconnect_connected_app` pushes
   `__novaDeskHostUpdate({action:"disconnect"})` via
   `webview.evaluate_script` into any matching in-wallet webview tab;
   the embedded provider's `applyHostState` calls `emit("disconnect")`.
4. **Wallet-initiated disconnect from external browser** — opt-in via
   `InferWalletOptions.sessionLivenessIntervalMs`. When set, the adapter
   schedules `setInterval(readValidatedExternalSession, intervalMs)`;
   a 403/404 response from `GET /<token>/session/<id>` triggers
   `InferClient.emit("disconnect")` (the same path as #1).
5. **Lazy fallback (always available)** — the next user-initiated
   `connect()` / `getAccount()` sees a 404 from `validateExternalSession`
   and silently clears state. No event fires (the dapp code is in
   control at that moment).

**Infer Desk sessions** are validated by calling the bridge's `/session/{id}` endpoint on reconnect (the same call used for the liveness heartbeat in #4).

**Infer Wallet sessions** trust the stored encrypted credentials (shared secret, session token).

## Storage Keys

| Key | Storage | Purpose |
|-----|---------|---------|
| `inferenco:nova-session` | `localStorage` | Active session (Infer Desk or Infer Wallet) |
| `inferenco:nova-pending-mobile-pairing` | `localStorage` | Unfinished Infer Wallet pairing (survives reload) |
| `inferenco:nova-callback-marker` | `sessionStorage` | Callback markers for pending deeplink flows |
| `inferenco:nova-protocol-key` | `localStorage` | Wallet's public key received via callback |

## Error Flow

All errors from any transport are remapped through `remapInferError()` into `InferAdapterError` instances with typed `InferErrorCode` values. This provides a consistent error interface regardless of whether the error originated from an injected provider, Infer Desk bridge, or Infer Wallet relay.

```
Provider error / HTTP status / WebSocket error
         │
         ▼
   remapInferError()
         │
         ├── status 401 / "reject"  → InferErrorCode.UserRejected
         ├── status 4200 / "unsupported" → InferErrorCode.Unsupported
         ├── status 400 / "invalid" → InferErrorCode.InvalidParams
         ├── "timed out"            → InferErrorCode.ConnectionTimeout
         ├── "not installed"        → InferErrorCode.NotInstalled
         └── everything else        → InferErrorCode.InternalError
```

## Infer Desk vs Infer Wallet

The two products are completely independent:

| Scenario | Infer Desk | Infer Wallet | What happens |
|----------|:-:|:-:|--------|
| Desktop + Infer Desk running | connected | &mdash; | Local bridge to Infer Desk |
| Desktop + Infer Desk not running | &mdash; | &mdash; | Deeplink launches Infer Desk |
| Mobile + nova-service up | &mdash; | connected | Encrypted relay to Infer Wallet |
| Mobile + nova-service down | &mdash; | &mdash; | Connection error |
| Extension installed (any platform) | &mdash; | &mdash; | Direct provider, no bridge or relay |

Infer Desk does not require nova-service. Infer Wallet does not require Infer Desk. A dApp using this adapter supports both automatically.
