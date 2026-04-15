# Architecture

This document describes the internal architecture of `@inferenco/nova-wallet-adapter`, including how it connects dApps to Nova Desk and Nova Wallet.

## Overview

The adapter connects Cedra dApps to two Nova products:

- **Nova Desk** &mdash; Desktop application, connected via a local HTTP bridge
- **Nova Wallet** &mdash; Mobile wallet app, connected via nova-service (a hosted relay) and `inferenco://` deeplinks

Two dApp integration surfaces &mdash; `NovaWallet` (plugin adapter) and the AIP-62 bridge &mdash; share a single `NovaClient` that handles all connection logic. The dApp integration mode is independent of which Nova product the user connects to.

```
┌──────────────────────────────────────────────────────────────┐
│                        Your dApp                             │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────┐            ┌──────────────────────┐     │
│  │   NovaWallet    │            │   AIP-62 Bridge      │     │
│  │   (plugin)      │            │   registerNovaWallet  │     │
│  └────────┬────────┘            └──────────┬───────────┘     │
│           │                                │                 │
│           └──────────┬─────────────────────┘                 │
│                      ▼                                       │
│           ┌──────────────────┐                               │
│           │    NovaClient    │                               │
│           │   (core logic)   │                               │
│           └────────┬─────────┘                               │
│                    │                                         │
└────────────────────┼─────────────────────────────────────────┘
                     │
     ┌───────────────┼───────────────┐
     ▼               ▼               ▼
┌──────────┐  ┌─────────────┐  ┌────────────┐
│ Injected │  │  Nova Desk  │  │Nova Wallet │
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
├── NovaClient.ts         # Core client — connection, signing, session orchestration
├── NovaWallet.ts         # Plugin-style adapter class
├── provider.ts           # Injected provider detection (window.inferenco, etc.)
├── bridge.ts             # Nova Desk HTTP bridge + session management
├── mobileRelay.ts        # Nova Wallet relay REST transport (nova-service)
├── mobileSocket.ts       # Nova Wallet relay WebSocket transport
├── mobileCrypto.ts       # X25519 key exchange + XChaCha20-Poly1305 encryption
├── conversion.ts         # Data normalization helpers (accounts, networks, txns)
├── deeplink.ts           # Deeplink URL generation
├── constants.ts          # Default URLs, timeouts, storage keys, icon
├── types.ts              # All TypeScript interfaces and type definitions
└── errors.ts             # NovaAdapterError + error code remapping
```

## Connecting to Nova Desk

**When:** Desktop browser, Nova Desk application running locally.

Nova Desk exposes a local HTTP bridge at `http://127.0.0.1:21984`. The adapter communicates with it directly &mdash; no external services involved.

```
dApp  ──GET /connect──────────────▶  Nova Desk (localhost:21984)
dApp  ◀── { requestId } ──────────  Nova Desk
                                          │
                                     User approves
                                     in Nova Desk UI
                                          │
dApp  ──GET /request/{id}─────────▶  Nova Desk
dApp  ◀── { status: "approved",     Nova Desk
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

**Session persistence:** Approved sessions are stored in `localStorage` as `NovaExternalSession` with `transport: "desktop-bridge"`. On subsequent visits, the adapter validates the stored session against the bridge before reuse.

**Desktop deeplink:** If Nova Desk is not running (the bridge probe fails), the adapter launches `inferenco://login?redirect=...` to open Nova Desk and waits for a callback via localStorage markers.

## Connecting to Nova Wallet

**When:** Mobile browser (or external browser without an injected provider or local Nova Desk).

Nova Wallet connections go through **nova-service**, a hosted relay that brokers end-to-end encrypted communication between the dApp and the Nova Wallet mobile app. The relay never sees plaintext data.

```
dApp (mobile browser)           nova-service (relay)         Nova Wallet App
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

**Deeplinks** are integral to this flow &mdash; they hand off from the browser to the Nova Wallet app for the user to approve, then Nova Wallet sends the encrypted result back through the relay.

See [Mobile Relay Protocol](mobile-relay.md) for the full cryptographic specification.

## Injected Provider

**When:** A Nova browser extension or embedded wallet is installed, exposing a provider on the window object.

The adapter calls the provider directly &mdash; no bridge, relay, or deeplink needed.

```
dApp  ──▶  window.inferenco.connect()  ──▶  Nova Extension
dApp  ◀──  { address, publicKey }       ◀──  Nova Extension
```

**Detection priority:**
1. `window.inferenco` (primary)
2. `window.nova` (secondary)
3. `window.cedra` if `isNovaWallet === true`
4. `window.aptos` if `isNovaWallet === true`

Supports real-time event subscriptions (`onAccountChange`, `onNetworkChange`) that are not available through the bridge or relay.

## Connection Flow

The `NovaClient.connect()` method executes this decision tree:

```
connect()
│
├─▶ 1. Check injected provider
│      window.inferenco / window.nova / branded aliases
│      └─ If found → provider.connect() → done
│
├─▶ 2. Check for mobile callback resume
│      Returning from Nova Wallet deeplink with callback params?
│      └─ If yes → parse params, store session → done
│
├─▶ 3. Check for stored session
│      Read from localStorage, validate against Nova Desk bridge or relay
│      └─ If valid → reuse session → done
│      └─ If invalid → clear session, continue
│
├─▶ 4. Detect environment
│      └─ Mobile browser?
│         ├─ Yes → Connect via Nova Wallet
│         │        Create pairing on nova-service,
│         │        launch inferenco:// deeplink,
│         │        poll/websocket for approval
│         │        └─ done
│         │
│         └─ No (desktop) → Connect via Nova Desk
│                           GET localhost:21984/connect,
│                           poll for approval
│                           └─ If Nova Desk running → done
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

**Nova Desk:**
1. `POST /sign-message` (or `/sign-transaction`, `/transaction`) with payload
2. Receive `requestId`
3. Poll `/request/{requestId}` until user approves in Nova Desk
4. Extract result from poll response

**Nova Wallet:**
1. Encrypt request payload with shared secret
2. `POST /v1/requests` with encrypted payload to nova-service
3. Launch deeplink for user to approve in Nova Wallet
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
         │    │        └──────────────┘
         │    │
         │    ├─ valid ──┘
         │    │
         └────┘
              └─ invalid → clear → fresh connect()
```

**Nova Desk sessions** are validated by calling the bridge's `/session/{id}` endpoint on reconnect.

**Nova Wallet sessions** trust the stored encrypted credentials (shared secret, session token).

## Storage Keys

| Key | Storage | Purpose |
|-----|---------|---------|
| `inferenco:nova-session` | `localStorage` | Active session (Nova Desk or Nova Wallet) |
| `inferenco:nova-pending-mobile-pairing` | `localStorage` | Unfinished Nova Wallet pairing (survives reload) |
| `inferenco:nova-callback-marker` | `sessionStorage` | Callback markers for pending deeplink flows |
| `inferenco:nova-protocol-key` | `localStorage` | Wallet's public key received via callback |

## Error Flow

All errors from any transport are remapped through `remapNovaError()` into `NovaAdapterError` instances with typed `NovaErrorCode` values. This provides a consistent error interface regardless of whether the error originated from an injected provider, Nova Desk bridge, or Nova Wallet relay.

```
Provider error / HTTP status / WebSocket error
         │
         ▼
   remapNovaError()
         │
         ├── status 401 / "reject"  → NovaErrorCode.UserRejected
         ├── status 4200 / "unsupported" → NovaErrorCode.Unsupported
         ├── status 400 / "invalid" → NovaErrorCode.InvalidParams
         ├── "timed out"            → NovaErrorCode.ConnectionTimeout
         ├── "not installed"        → NovaErrorCode.NotInstalled
         └── everything else        → NovaErrorCode.InternalError
```

## Nova Desk vs Nova Wallet

The two products are completely independent:

| Scenario | Nova Desk | Nova Wallet | What happens |
|----------|:-:|:-:|--------|
| Desktop + Nova Desk running | connected | &mdash; | Local bridge to Nova Desk |
| Desktop + Nova Desk not running | &mdash; | &mdash; | Deeplink launches Nova Desk |
| Mobile + nova-service up | &mdash; | connected | Encrypted relay to Nova Wallet |
| Mobile + nova-service down | &mdash; | &mdash; | Connection error |
| Extension installed (any platform) | &mdash; | &mdash; | Direct provider, no bridge or relay |

Nova Desk does not require nova-service. Nova Wallet does not require Nova Desk. A dApp using this adapter supports both automatically.
