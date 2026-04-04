# Architecture

This document describes the internal architecture of `@inferenco/nova-wallet-adapter`, including transport mechanisms, connection flows, and the relationship between components.

## Overview

The adapter provides a unified interface for connecting Cedra dApps to Nova Wallet across different environments. Two public surfaces &mdash; `NovaWallet` (legacy adapter) and the AIP-62 bridge &mdash; share a single `NovaClient` that handles all connection logic.

```
┌──────────────────────────────────────────────────────────────┐
│                        Your dApp                             │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────┐            ┌──────────────────────┐     │
│  │   NovaWallet    │            │   AIP-62 Bridge      │     │
│  │   (legacy)      │            │   registerNovaWallet  │     │
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
│ Injected │  │   Desktop   │  │   Mobile   │
│ Provider │  │   Bridge    │  │   Relay    │
└──────────┘  └─────────────┘  └────────────┘
```

## Module Structure

```
src/
├── index.ts              # Main entry — re-exports everything
├── aip62.ts              # AIP-62 wallet-standard bridge + registration
├── auto-register.ts      # Side-effect auto-registration entry point
├── NovaClient.ts         # Core client — connection, signing, session orchestration
├── NovaWallet.ts         # Legacy Petra-style adapter class
├── provider.ts           # Injected provider detection (window.inferenco, etc.)
├── bridge.ts             # Desktop bridge HTTP transport + session management
├── mobileRelay.ts        # Mobile relay REST transport (nova-service)
├── mobileSocket.ts       # Mobile relay WebSocket transport
├── mobileCrypto.ts       # X25519 key exchange + XChaCha20-Poly1305 encryption
├── conversion.ts         # Data normalization helpers (accounts, networks, txns)
├── deeplink.ts           # Deeplink URL generation
├── constants.ts          # Default URLs, timeouts, storage keys, icon
├── types.ts              # All TypeScript interfaces and type definitions
└── errors.ts             # NovaAdapterError + error code remapping
```

## Transport Mechanisms

### 1. Injected Provider

**When used:** Provider detected on `window.inferenco`, `window.nova`, or branded aliases.

**How it works:** Direct JavaScript function calls to the provider object injected by Nova Wallet's browser extension or embedded wallet.

```
dApp  ──▶  window.inferenco.connect()  ──▶  Nova Extension
dApp  ◀──  { address, publicKey }       ◀──  Nova Extension
```

**Advantages:**
- Zero latency, no network requests
- No session management needed
- Supports real-time event subscriptions (`onAccountChange`, `onNetworkChange`)

**Detection priority:**
1. `window.inferenco` (primary)
2. `window.nova` (secondary)
3. `window.cedra` if `isNovaWallet === true`
4. `window.aptos` if `isNovaWallet === true`

### 2. Desktop Bridge

**When used:** Desktop browser without injected provider, Nova Desk running locally.

**How it works:** HTTP requests to a local server at `http://127.0.0.1:21984` run by the Nova Desk desktop application.

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

### 3. Mobile Relay

**When used:** Mobile browser or external browser without injected provider.

**How it works:** End-to-end encrypted communication through a hosted relay server (nova-service). The relay never sees plaintext data.

```
dApp                        nova-service                    Nova Wallet App
 │                              │                                │
 │──POST /v1/pairings─────────▶│                                │
 │◀── { pairingId,             │                                │
 │      walletDeeplinkUrl }    │                                │
 │                              │                                │
 │──open deeplink──────────────────────────────────────────────▶│
 │                              │                                │
 │                              │◀─── wallet claims pairing ────│
 │                              │                                │
 │                              │◀─── wallet approves ──────────│
 │                              │     (encrypted result)         │
 │                              │                                │
 │◀── poll/websocket ──────────│                                │
 │    (encrypted result)        │                                │
 │                              │                                │
 │── decrypt with               │                                │
 │   shared secret              │                                │
```

**Crypto flow:**
1. dApp generates X25519 keypair
2. dApp sends public key with pairing request
3. Wallet generates its own keypair, derives shared secret via ECDH
4. Both sides derive encryption key using HKDF-SHA256
5. All payloads encrypted with XChaCha20-Poly1305

See [Mobile Relay Protocol](mobile-relay.md) for the full cryptographic specification.

## Connection Flow

The `NovaClient.connect()` method executes this decision tree:

```
connect()
│
├─▶ 1. Check injected provider
│      window.inferenco / window.nova / branded aliases
│      └─ If found → provider.connect() → return
│
├─▶ 2. Check for mobile callback resume
│      Returning from deeplink with callback params?
│      └─ If yes → parse params, store session → return
│
├─▶ 3. Check for stored external session
│      Read from localStorage, validate against bridge/relay
│      └─ If valid → reuse session → return
│      └─ If invalid → clear session, continue
│
├─▶ 4. Detect environment
│      └─ Mobile browser?
│         ├─ Yes → connectViaMobileRelay()
│         │        Create pairing, launch deeplink,
│         │        poll/websocket for approval
│         │        └─ return
│         │
│         └─ No (desktop) → tryLocalBridgeConnect()
│                           GET /connect, poll for approval
│                           └─ If success → return
│                           └─ If fail → continue
│
└─▶ 5. Deeplink fallback
       Launch inferenco://login?redirect=...
       Wait for callback via localStorage markers
       └─ Timeout after ~120s if no response
```

## Signing Flow

Once connected, signing operations follow a similar pattern across transports:

**Injected provider:** Direct call → immediate result.

**Desktop bridge:**
1. `POST /sign-message` (or `/sign-transaction`, `/transaction`) with payload
2. Receive `requestId`
3. Poll `/request/{requestId}` until approved
4. Extract result from poll response

**Mobile relay:**
1. Encrypt request payload with shared secret
2. `POST /v1/requests` with encrypted payload
3. Launch deeplink for user to approve in wallet app
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

## Storage Keys

| Key | Storage | Purpose |
|-----|---------|---------|
| `inferenco:nova-session` | `localStorage` | Active session (desktop-bridge or mobile-relay) |
| `inferenco:nova-pending-mobile-pairing` | `localStorage` | Unfinished mobile pairing (survives reload) |
| `inferenco:nova-callback-marker` | `sessionStorage` | Callback markers for pending deeplink flows |
| `inferenco:nova-protocol-key` | `localStorage` | Wallet's public key received via callback |

## Error Flow

All errors from any transport are remapped through `remapNovaError()` into `NovaAdapterError` instances with typed `NovaErrorCode` values. This provides a consistent error interface regardless of whether the error originated from an injected provider, bridge HTTP response, relay API, or WebSocket.

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

## Independence of Transports

The desktop bridge and mobile relay are completely independent:

| Scenario | Desktop Bridge | Mobile Relay | Result |
|----------|:-:|:-:|--------|
| Desktop + Nova Desk running | works | N/A | Local bridge connection |
| Desktop + Nova Desk not running | fails | N/A | Falls back to deeplink |
| Mobile + nova-service up | N/A | works | Encrypted relay connection |
| Mobile + nova-service down | N/A | fails | Connection error |
| Extension installed (any) | N/A | N/A | Direct provider, no bridge/relay needed |

Neither transport depends on the other. A dApp can function with only the desktop bridge, only the mobile relay, or only the injected provider.
