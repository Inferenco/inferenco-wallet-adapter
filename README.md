<p align="center">
  <img src="https://img.shields.io/badge/Infer-Wallet%20Adapter-0a3d91?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTYiIGZpbGw9IiMwYTNkOTEiLz48cGF0aCBkPSJNMzIgMTIgNDAgMjggNTYgMzIgNDAgMzYgMzIgNTIgMjQgMzYgOCAzMiAyNCAyOFoiIGZpbGw9IiM2NmQ5ZmYiLz48L3N2Zz4=&logoColor=66d9ff" alt="Infer Wallet Adapter" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@inferenco/infer-wallet-adapter"><img src="https://img.shields.io/npm/v/@inferenco/infer-wallet-adapter?color=0a3d91&label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@inferenco/infer-wallet-adapter"><img src="https://img.shields.io/npm/dm/@inferenco/infer-wallet-adapter?color=66d9ff" alt="npm downloads" /></a>
  <a href="https://github.com/Inferenco/nova-plugin-wallet-adapter/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="license" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/ESM%20%2B%20CJS-supported-brightgreen" alt="Module formats" />
  <img src="https://img.shields.io/badge/version-0.2.0--rc.8-0a3d91" alt="version" />
</p>

<p align="center">
  Wallet adapter for connecting Cedra dApps to <a href="https://inferenco.com/infer-desk">Infer Desk</a> and <a href="https://inferenco.com/infer-wallet">Infer Wallet</a>.<br/>
  Supports the AIP-62 wallet-standard and plugin-style integration.
</p>

---

## Overview

This adapter allows Cedra dApps to connect to two Infer products:

- **Infer Desk** &mdash; Desktop application. The adapter connects directly to Infer Desk's local HTTP bridge at `localhost:21984`. No external services required.
- **Infer Wallet** &mdash; Mobile wallet app. The adapter connects through [nova-service](docs/mobile-relay.md), a hosted relay that brokers end-to-end encrypted communication between the dApp and the wallet via deeplinks.

Both connections are handled transparently &mdash; the adapter detects the environment and uses the right transport automatically.

## Features

- **Infer Desk integration** &mdash; Direct local HTTP bridge to the Infer Desk desktop application
- **Infer Wallet integration** &mdash; End-to-end encrypted relay via nova-service (X25519 + XChaCha20-Poly1305)
- **Dual dApp integration** &mdash; Plugin adapter (`InferWallet`) and AIP-62 wallet-standard (`registerInferWallet`)
- **Injected provider** &mdash; Auto-detects `window.inferenco`, `window.nova`, and branded aliases
- **Deeplinks** &mdash; `inferenco://` URI scheme for wallet handoff on desktop and mobile
- **Session persistence** &mdash; Reconnect without re-approval across page reloads
- **Zero config** &mdash; Works out of the box with sensible defaults, fully configurable when needed

## Installation

```bash
npm install @inferenco/infer-wallet-adapter
```

```bash
yarn add @inferenco/infer-wallet-adapter
```

```bash
pnpm add @inferenco/infer-wallet-adapter
```

> **Note:** versions `0.2.0-rc.1` and `0.2.0-rc.2` are broken releases — see [Bridge token](#bridge-token) for the migration path. Upgrade directly to `0.2.0-rc.3` or later.

## Bridge token

Infer Desk's HTTP bridge binds at `http://127.0.0.1:21984/<token>/<route>` and rejects unprefixed requests with 404 (no CORS). The token is generated at every wallet startup and is delivered to the dapp via two channels:

1. **`window.postMessage({type: "nova:bridge-token", token: "<64-hex>"})`** — fires once at provider script injection when the dapp is loaded inside Infer Desk's embedded browser.
2. **`bridgeToken` field in the `GET /<token>/connect` response body** — the only channel available to an external browser tab.

The adapter consumes either channel and prefixes every bridge URL with `/<token>/`. No dapp-side configuration is required.

```typescript
import { readBridgeToken, bridgeUrlWithToken, MISSING_BRIDGE_TOKEN_MESSAGE } from "@inferenco/infer-wallet-adapter";

// The token is read at module-init time. After wallet restart, the
// dapp re-reads on the next page load.
const token = readBridgeToken();
console.log("current bridge token:", token);

// Build a fully-qualified URL with the per-session token in the path.
const url = bridgeUrlWithToken("/connect", { bridgeBaseUrl: "http://127.0.0.1:21984" });
// => "http://127.0.0.1:21984/<token>/connect"

// If the dapp is opened outside Infer Desk, the adapter throws this:
MISSING_BRIDGE_TOKEN_MESSAGE;
// => "Infer Desk bridge token not available. Open this dapp via Infer Desk."
```

See [`docs/bridge-token.md`](docs/bridge-token.md) for the full contract.

## Quick Start

### AIP-62 Wallet-Standard (Recommended)

The simplest way to integrate &mdash; auto-register Infer Connect as a wallet-standard wallet:

```typescript
// Side-effect import — registers Infer Connect wallet automatically
import "@inferenco/infer-wallet-adapter/auto-register";
```

Or register manually with options:

```typescript
import { registerInferWallet } from "@inferenco/infer-wallet-adapter/aip62";

registerInferWallet({
  forceRegistration: true,  // Register even without injected provider
});
```

### Plugin Adapter

For dApps using plugin-style adapters:

```typescript
import { InferWallet } from "@inferenco/infer-wallet-adapter";

const wallet = new InferWallet();

// Connect
const account = await wallet.connect();
console.log(account.address);

// Sign a message
const response = await wallet.signMessage({
  message: "Hello Infer!",
  nonce: "unique-nonce-123",
});

// Sign and submit a transaction
const result = await wallet.signAndSubmitTransaction({
  data: {
    function: "0x1::coin::transfer",
    typeArguments: ["0x1::aptos_coin::AptosCoin"],
    functionArguments: ["0xrecipient", 1000],
  },
});

// Disconnect
await wallet.disconnect();
```

### Using InferClient Directly

For full control over the connection lifecycle:

```typescript
import { InferClient } from "@inferenco/infer-wallet-adapter";

const client = new InferClient({
  bridgeBaseUrl: "http://127.0.0.1:21984",
  detectAliases: true,
});

const { account, network } = await client.connect();

const signed = await client.signTransaction(rawTransaction);
const result = await client.signAndSubmitTransaction(transactionPayload);
```

### WalletCore Resume Helper

If your dApp uses Cedra `WalletCore`, call the resume helper during provider bootstrap:

```typescript
import {
  INFER_CONNECT_NAME,
  tryResumeInferWalletConnection,
} from "@inferenco/infer-wallet-adapter";

await tryResumeInferWalletConnection(walletCore);
```

This resumes pending mobile callback state after browser reloads and reconnects through stored sessions without app-specific bridge logic.

## Architecture

The adapter provides two dApp integration surfaces backed by a shared `InferClient`, which connects to Infer Desk or Infer Wallet depending on the environment:

```
┌─────────────────────────────────────────────────────────┐
│                     Your dApp                           │
│                                                         │
│   InferWallet (plugin)  ─┐                               │
│                         ├──▶  InferClient (core logic)   │
│   AIP-62 Bridge ────────┘         │                     │
└───────────────────────────────────┼─────────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
     │   Injected   │     │  Infer Desk   │     │ Infer Wallet  │
     │   Provider   │     │  (desktop)   │     │  (mobile)    │
     │              │     │              │     │              │
     │ window.nova  │     │  localhost   │     │ nova-service │
     │ window.      │     │  :21984      │     │  + deeplink  │
     │  inferenco   │     │  HTTP bridge │     │  E2E encrypt │
     └──────────────┘     └──────────────┘     └──────────────┘
```

### How Connections Work

**Desktop &mdash; Infer Desk:** The adapter connects to Infer Desk's local HTTP bridge at `http://127.0.0.1:21984`. Requests are initiated, then polled until the user approves in the Infer Desk UI. Sessions persist across page reloads.

**Mobile &mdash; Infer Wallet:** The adapter creates an encrypted pairing through nova-service, then launches an `inferenco://` deeplink to hand off to Infer Wallet. The user approves in the app, and the result is returned through the relay. All communication is end-to-end encrypted.

**Injected provider:** When an Infer extension is installed, the adapter calls it directly &mdash; no bridge or relay needed.

### Connection Order

1. **Injected provider** &mdash; `window.inferenco` / `window.nova` (instant, direct)
2. **Stored session** &mdash; validates and reuses a prior Infer Desk or Infer Wallet session
3. **Infer Desk bridge** &mdash; local HTTP connection on desktop browsers
4. **Infer Wallet relay** &mdash; encrypted relay + deeplink on mobile browsers
5. **Desktop deeplink** &mdash; `inferenco://login` handoff when Infer Desk is not running

> Infer Desk and nova-service are independent. Infer Desk works without nova-service, and Infer Wallet works without Infer Desk.

For more detail, see [Architecture docs](docs/architecture.md).

## API Reference

### `InferWallet`

The plugin adapter class, compatible with plugin-style wallet consumers.

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<AccountInfo>` | Connect to Infer Desk or Infer Wallet |
| `account()` | `Promise<AccountInfo>` | Get current account info |
| `disconnect()` | `Promise<void>` | Disconnect and clear session |
| `signMessage(input)` | `Promise<CedraSignMessageOutput>` | Sign an arbitrary message |
| `signTransaction(tx, opts?)` | `Promise<Uint8Array \| { authenticator, rawTransaction?: AnyRawTransaction }>` | Sign a transaction without submitting |
| `signAndSubmitTransaction(tx, opts?)` | `Promise<CedraSignAndSubmitTransactionOutput>` | Sign and submit a transaction |
| `signAndSubmitBCSTransaction(tx, opts?)` | `Promise<CedraSignAndSubmitTransactionOutput>` | Sign and submit (BCS variant) |
| `onAccountChange(cb)` | `Promise<void>` | Subscribe to account changes |
| `onNetworkChange(cb)` | `Promise<void>` | Subscribe to network changes |
| `deeplinkProvider(url?)` | `string` | Generate a deeplink URL |

`signTransaction` accepts prebuilt SDK transactions and Cedra wallet-standard v1.1
inputs, including `secondarySigners` and fee payer fields. When the wallet returns
a signed multi-agent transaction, the adapter preserves the SDK `AnyRawTransaction`
wrapper so secondary signer and fee payer metadata remains available for submission.

**Properties:**

| Property | Type | Description |
|----------|------|-------------|
| `name` | `"Infer Connect"` | Wallet display name |
| `url` | `string` | Wallet website URL |
| `icon` | `string` | Base64 SVG icon |
| `readyState` | `InferWalletReadyState` | Current detection state |
| `connecting` | `boolean` | Connection in progress |
| `connected` | `boolean` | Currently connected |
| `publicAccount` | `InferAccountKeys` | Cached public key info |
| `network` | `InferNetworkInfo` | Current network info |

### `registerInferWallet(options?)`

Registers Infer Connect as an AIP-62 wallet-standard wallet. Implements all Cedra standard features:

- `cedra:connect`, `cedra:disconnect`, `cedra:account`, `cedra:network`
- `cedra:signMessage`, `cedra:signTransaction`, `cedra:signAndSubmitTransaction`
- `cedra:onAccountChange`, `cedra:onNetworkChange`
- `cedra:openInMobileApp`

### `InferClient`

The core client powering both adapter surfaces. Use directly for advanced control.

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<{ account, network }>` | Connect to Infer Desk or Infer Wallet |
| `disconnect()` | `Promise<void>` | Disconnect and revoke session |
| `getAccount()` | `Promise<AccountInfo>` | Fetch account from provider or session |
| `getNetwork()` | `Promise<NetworkInfo>` | Fetch current network |
| `signMessage(input)` | `Promise<CedraSignMessageOutput>` | Sign message via active transport |
| `signMessageAndVerify(input)` | `Promise<boolean>` | Sign and verify locally |
| `signTransaction(tx, opts?)` | `Promise<InferSignTransactionResult>` | Sign transaction |
| `signAndSubmitTransaction(tx, opts?)` | `Promise<CedraSignAndSubmitTransactionOutput>` | Sign and submit |
| `hasProvider()` | `boolean` | Check for injected provider |
| `hasExternalSession()` | `boolean` | Check for stored Infer Desk or Infer Wallet session |

For the complete type reference, see [API Reference docs](docs/api-reference.md).

## Configuration

All options are optional with sensible defaults:

```typescript
const wallet = new InferWallet({
  // Identity & deeplinks
  deeplinkBaseUrl: "inferenco://connect?callback=",
  deeplinkScheme: "inferenco",
  websiteUrl: "https://inferenco.com/infer-desk",

  // Registration behavior
  forceRegistration: false,     // Register even without injected provider
  desktopRegistration: true,    // Register on desktop browsers
  detectAliases: true,          // Check window.cedra / window.aptos

  // Network
  networkOverride: undefined,   // Force specific network
  fullnodeUrl: undefined,       // Custom fullnode for SDK operations

  // Infer Desk (desktop bridge)
  bridgeBaseUrl: "http://127.0.0.1:21984",
  bridgeConnectTimeoutMs: 1200,
  bridgePollIntervalMs: 250,
  bridgePollTimeoutMs: 120000,

  // Infer Wallet (mobile relay via nova-service)
  relayBaseUrl: "https://nova-service-....run.app",
  websocketBaseUrl: "wss://nova-service-....run.app/v1/ws",
  mobilePollIntervalMs: 1000,
  mobileRequestTimeoutMs: 180000,
  mobileSocketTimeoutMs: 15000,
});
```

See [Configuration docs](docs/configuration.md) for detailed descriptions of each option.

## Error Handling

All adapter errors are instances of `InferAdapterError` with a typed error code:

```typescript
import { InferAdapterError, InferErrorCode } from "@inferenco/infer-wallet-adapter";

try {
  await wallet.connect();
} catch (error) {
  if (error instanceof InferAdapterError) {
    switch (error.code) {
      case InferErrorCode.UserRejected:
        console.log("User rejected the request");
        break;
      case InferErrorCode.ConnectionTimeout:
        console.log("Connection timed out");
        break;
      case InferErrorCode.NotInstalled:
        console.log("Infer Wallet not found");
        break;
    }
  }
}
```

| Error Code | Value | Description |
|------------|-------|-------------|
| `UserRejected` | `USER_REJECTED` | User declined the request |
| `Unauthorized` | `UNAUTHORIZED` | Session expired or invalid |
| `Unsupported` | `UNSUPPORTED` | Operation not supported by provider |
| `NotInstalled` | `NOT_INSTALLED` | No provider or bridge found |
| `ConnectionTimeout` | `CONNECTION_TIMEOUT` | Bridge/relay connection timed out |
| `InvalidParams` | `INVALID_PARAMS` | Invalid parameters provided |
| `InvalidNetwork` | `INVALID_NETWORK` | Network mismatch or unavailable |
| `InternalError` | `INTERNAL_ERROR` | Unexpected internal error |

## Provider Detection

The adapter detects Infer providers in this priority order:

1. `window.inferenco` &mdash; primary namespace
2. `window.nova` &mdash; secondary namespace
3. `window.cedra` &mdash; only if `isNovaWallet === true` (branded)
4. `window.aptos` &mdash; only if `isNovaWallet === true` (branded)

Unbranded providers on `window.cedra` / `window.aptos` are never wrapped. Alias detection can be disabled with `detectAliases: false`.

## Session Management

Sessions are persisted in `localStorage` under the key `inferenco:infer-session` (v0.3.0 rebrand — the legacy `inferenco:nova-session` is still read for one release cycle and auto-migrated on read) and automatically validated on reconnect:

- **Infer Desk sessions** are validated against the bridge's `/session/{id}` endpoint
- **Infer Wallet sessions** trust the stored encrypted credentials
- Invalid or expired sessions are automatically cleared, triggering a fresh connection flow

## Infer Wallet Relay Security

Communication between the dApp and Infer Wallet through nova-service is end-to-end encrypted:

| Layer | Algorithm | Purpose |
|-------|-----------|---------|
| Key exchange | X25519 (ECDH) | Derive shared secret between dApp and wallet |
| Key derivation | HKDF-SHA256 | Deterministic key from shared secret with `"infer-connect-relay"` info |
| Encryption | XChaCha20-Poly1305 | Authenticated encryption of all request/response payloads |
| Nonce | 24 random bytes | Per-message nonce prevents replay attacks |

The relay server (nova-service) never sees plaintext request or response data.

## Exports

The package ships three entry points:

| Entry Point | Import Path | Contents |
|-------------|-------------|----------|
| Main | `@inferenco/infer-wallet-adapter` | `InferWallet`, `InferClient`, types, utilities, errors |
| AIP-62 | `@inferenco/infer-wallet-adapter/aip62` | `createInferAIP62Wallet`, `registerInferWallet` |
| Auto-register | `@inferenco/infer-wallet-adapter/auto-register` | Side-effect registration (import-only) |

Both ESM and CommonJS builds are included with full TypeScript declarations.

## Infer Desk Bridge API

When Infer Desk is running locally, the adapter communicates via HTTP:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/connect` | `GET` | Initiate connection request |
| `/sign-message` | `POST` | Sign message request |
| `/sign-transaction` | `POST` | Sign transaction request |
| `/transaction` | `POST` | Sign and submit transaction |
| `/request/{requestId}` | `GET` | Poll for request status |
| `/session/{sessionId}` | `GET` | Validate existing session |
| `/connection` | `DELETE` | Revoke connection |
| `/session/{sessionId}` | `DELETE` | Revoke session |

All operations use a poll-based flow: initiate a request, receive a `requestId`, then poll until the user approves or rejects in Infer Desk.

## Development

```bash
# Install dependencies
npm install

# Build (ESM + CJS + declarations)
npm run build

# Run tests
npm test

# Watch tests
npm run test:watch

# Type check
npm run typecheck
```

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | Transport mechanisms, connection flows, and system design |
| [API Reference](docs/api-reference.md) | Complete type and method documentation |
| [Configuration](docs/configuration.md) | All options with defaults and examples |
| [Mobile Relay Protocol](docs/mobile-relay.md) | Infer Wallet end-to-end encrypted communication |
| [Changelog](CHANGELOG.md) | Version history and release notes |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@cedra-labs/ts-sdk` | Transaction building, network utilities, SDK operations |
| `@cedra-labs/wallet-standard` | AIP-62 wallet-standard types and registration |
| `@noble/curves` | X25519 ECDH key exchange (Infer Wallet relay) |
| `@noble/hashes` | SHA256, HKDF key derivation (Infer Wallet relay) |
| `@noble/ciphers` | XChaCha20-Poly1305 authenticated encryption (Infer Wallet relay) |
| `eventemitter3` | Event emission for account/network change subscriptions |

## License

[Apache-2.0](LICENSE)
