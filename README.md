<p align="center">
  <img src="https://img.shields.io/badge/Nova-Wallet%20Adapter-0a3d91?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTYiIGZpbGw9IiMwYTNkOTEiLz48cGF0aCBkPSJNMzIgMTIgNDAgMjggNTYgMzIgNDAgMzYgMzIgNTIgMjQgMzYgOCAzMiAyNCAyOFoiIGZpbGw9IiM2NmQ5ZmYiLz48L3N2Zz4=&logoColor=66d9ff" alt="Nova Wallet Adapter" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@inferenco/nova-wallet-adapter"><img src="https://img.shields.io/npm/v/@inferenco/nova-wallet-adapter?color=0a3d91&label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@inferenco/nova-wallet-adapter"><img src="https://img.shields.io/npm/dm/@inferenco/nova-wallet-adapter?color=66d9ff" alt="npm downloads" /></a>
  <a href="https://github.com/Inferenco/nova-plugin-wallet-adapter/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="license" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/ESM%20%2B%20CJS-supported-brightgreen" alt="Module formats" />
  <img src="https://img.shields.io/badge/version-0.1.0-0a3d91" alt="version" />
</p>

<p align="center">
  Standalone wallet adapter for connecting Cedra dApps to <a href="https://inferenco.com">Nova Wallet</a>.<br/>
  Supports desktop bridge, mobile relay, injected provider, deeplinks, and AIP-62 wallet-standard.
</p>

---

## Features

- **Dual integration** &mdash; Legacy plugin adapter (`NovaWallet`) and AIP-62 wallet-standard (`registerNovaWallet`)
- **Desktop bridge** &mdash; Direct local HTTP connection to Nova Desk / Nova Connect
- **Mobile relay** &mdash; End-to-end encrypted relay via nova-service (X25519 + XChaCha20-Poly1305)
- **Injected provider** &mdash; Auto-detects `window.inferenco`, `window.nova`, and branded aliases
- **Deeplink fallback** &mdash; `inferenco://` URI scheme for app handoff
- **Session persistence** &mdash; Reconnect without re-approval across page reloads
- **Zero config** &mdash; Works out of the box with sensible defaults, fully configurable when needed

## Installation

```bash
npm install @inferenco/nova-wallet-adapter
```

```bash
yarn add @inferenco/nova-wallet-adapter
```

```bash
pnpm add @inferenco/nova-wallet-adapter
```

## Quick Start

### AIP-62 Wallet-Standard (Recommended)

The simplest way to integrate &mdash; auto-register Nova as a wallet-standard wallet:

```typescript
// Side-effect import — registers Nova wallet automatically
import "@inferenco/nova-wallet-adapter/auto-register";
```

Or register manually with options:

```typescript
import { registerNovaWallet } from "@inferenco/nova-wallet-adapter/aip62";

registerNovaWallet({
  forceRegistration: true,  // Register even without injected provider
});
```

### Legacy Plugin Adapter

For dApps using Petra-style plugin adapters:

```typescript
import { NovaWallet } from "@inferenco/nova-wallet-adapter";

const wallet = new NovaWallet();

// Connect
const account = await wallet.connect();
console.log(account.address);

// Sign a message
const response = await wallet.signMessage({
  message: "Hello Nova!",
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

### Using NovaClient Directly

For full control over the connection lifecycle:

```typescript
import { NovaClient } from "@inferenco/nova-wallet-adapter";

const client = new NovaClient({
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
  NOVA_CONNECT_NAME,
  tryResumeNovaWalletConnection,
} from "@inferenco/nova-wallet-adapter";

await tryResumeNovaWalletConnection(walletCore);
```

This resumes pending mobile callback state after browser reloads and reconnects through stored sessions without app-specific bridge logic.

## Architecture

Nova Wallet Adapter supports three transport mechanisms, selected automatically based on the runtime environment:

```
┌─────────────────────────────────────────────────────────┐
│                     Your dApp                           │
│                                                         │
│   NovaWallet (legacy)  ─┐                               │
│                         ├──▶  NovaClient (core logic)   │
│   AIP-62 Bridge ────────┘         │                     │
└───────────────────────────────────┼─────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
           ┌──────────────┐ ┌─────────────┐ ┌────────────┐
           │   Injected   │ │   Desktop   │ │   Mobile   │
           │   Provider   │ │   Bridge    │ │   Relay    │
           │              │ │             │ │            │
           │ window.nova  │ │  localhost  │ │  nova-svc  │
           │ window.      │ │  :21984     │ │  (hosted)  │
           │  inferenco   │ │             │ │            │
           └──────────────┘ └─────────────┘ └────────────┘
                 direct         HTTP          E2E encrypted
                                              WebSocket+REST
```

### Connection Priority

1. **Injected provider** &mdash; `window.inferenco` / `window.nova` (instant, no bridge needed)
2. **Stored session resume** &mdash; validates and reuses prior sessions
3. **Desktop bridge** &mdash; connects to locally-running Nova Desk via HTTP (`http://127.0.0.1:21984`)
4. **Mobile relay** &mdash; end-to-end encrypted relay for mobile browsers via nova-service
5. **Deeplink fallback** &mdash; launches Nova Wallet app via `inferenco://` URI scheme

> Nova Desk and nova-service are independent. The desktop bridge works without nova-service, and vice versa.

For more detail, see [Architecture docs](docs/architecture.md).

## API Reference

### `NovaWallet`

The legacy adapter class, compatible with Petra-style plugin consumers.

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<AccountInfo>` | Connect to Nova Wallet |
| `account()` | `Promise<AccountInfo>` | Get current account info |
| `disconnect()` | `Promise<void>` | Disconnect and clear session |
| `signMessage(input)` | `Promise<CedraSignMessageOutput>` | Sign an arbitrary message |
| `signTransaction(tx, opts?)` | `Promise<Uint8Array \| { authenticator, rawTransaction? }>` | Sign a transaction without submitting |
| `signAndSubmitTransaction(tx, opts?)` | `Promise<CedraSignAndSubmitTransactionOutput>` | Sign and submit a transaction |
| `signAndSubmitBCSTransaction(tx, opts?)` | `Promise<CedraSignAndSubmitTransactionOutput>` | Sign and submit (BCS variant) |
| `onAccountChange(cb)` | `Promise<void>` | Subscribe to account changes |
| `onNetworkChange(cb)` | `Promise<void>` | Subscribe to network changes |
| `deeplinkProvider(url?)` | `string` | Generate a deeplink URL |

**Properties:**

| Property | Type | Description |
|----------|------|-------------|
| `name` | `"Nova Connect"` | Wallet display name |
| `url` | `string` | Wallet website URL |
| `icon` | `string` | Base64 SVG icon |
| `readyState` | `NovaWalletReadyState` | Current detection state |
| `connecting` | `boolean` | Connection in progress |
| `connected` | `boolean` | Currently connected |
| `publicAccount` | `NovaAccountKeys` | Cached public key info |
| `network` | `NovaNetworkInfo` | Current network info |

### `registerNovaWallet(options?)`

Registers Nova as an AIP-62 wallet-standard wallet. Implements all Cedra standard features:

- `cedra:connect`, `cedra:disconnect`, `cedra:account`, `cedra:network`
- `cedra:signMessage`, `cedra:signTransaction`, `cedra:signAndSubmitTransaction`
- `cedra:onAccountChange`, `cedra:onNetworkChange`
- `cedra:openInMobileApp`

### `NovaClient`

The core client powering both adapter surfaces. Use directly for advanced control.

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<{ account, network }>` | Full connection flow with transport negotiation |
| `disconnect()` | `Promise<void>` | Disconnect and revoke session |
| `getAccount()` | `Promise<AccountInfo>` | Fetch account from provider or session |
| `getNetwork()` | `Promise<NetworkInfo>` | Fetch current network |
| `signMessage(input)` | `Promise<CedraSignMessageOutput>` | Sign message via best available transport |
| `signMessageAndVerify(input)` | `Promise<boolean>` | Sign and verify locally |
| `signTransaction(tx, opts?)` | `Promise<NovaSignTransactionResult>` | Sign transaction |
| `signAndSubmitTransaction(tx, opts?)` | `Promise<CedraSignAndSubmitTransactionOutput>` | Sign and submit |
| `hasProvider()` | `boolean` | Check for injected provider |
| `hasExternalSession()` | `boolean` | Check for stored bridge/relay session |

For the complete type reference, see [API Reference docs](docs/api-reference.md).

## Configuration

All options are optional with sensible defaults:

```typescript
const wallet = new NovaWallet({
  // Identity & deeplinks
  deeplinkBaseUrl: "inferenco://connect?callback=",
  deeplinkScheme: "inferenco",
  websiteUrl: "https://inferenco.com",

  // Registration behavior
  forceRegistration: false,     // Register even without injected provider
  desktopRegistration: true,    // Register on desktop browsers
  detectAliases: true,          // Check window.cedra / window.aptos

  // Network
  networkOverride: undefined,   // Force specific network
  fullnodeUrl: undefined,       // Custom fullnode for SDK operations

  // Desktop bridge
  bridgeBaseUrl: "http://127.0.0.1:21984",
  bridgeConnectTimeoutMs: 1200,
  bridgePollIntervalMs: 250,
  bridgePollTimeoutMs: 120000,

  // Mobile relay
  relayBaseUrl: "https://nova-service-....run.app",
  websocketBaseUrl: "wss://nova-service-....run.app/v1/ws",
  mobilePollIntervalMs: 1000,
  mobileRequestTimeoutMs: 180000,
  mobileSocketTimeoutMs: 15000,
});
```

See [Configuration docs](docs/configuration.md) for detailed descriptions of each option.

## Error Handling

All adapter errors are instances of `NovaAdapterError` with a typed error code:

```typescript
import { NovaAdapterError, NovaErrorCode } from "@inferenco/nova-wallet-adapter";

try {
  await wallet.connect();
} catch (error) {
  if (error instanceof NovaAdapterError) {
    switch (error.code) {
      case NovaErrorCode.UserRejected:
        console.log("User rejected the request");
        break;
      case NovaErrorCode.ConnectionTimeout:
        console.log("Connection timed out");
        break;
      case NovaErrorCode.NotInstalled:
        console.log("Nova Wallet not found");
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

The adapter detects Nova Wallet providers in this priority order:

1. `window.inferenco` &mdash; primary namespace
2. `window.nova` &mdash; secondary namespace
3. `window.cedra` &mdash; only if `isNovaWallet === true` (branded)
4. `window.aptos` &mdash; only if `isNovaWallet === true` (branded)

Unbranded providers on `window.cedra` / `window.aptos` are never wrapped. Alias detection can be disabled with `detectAliases: false`.

## Session Management

Sessions are persisted in `localStorage` under the key `inferenco:nova-session` and automatically validated on reconnect:

- **Desktop bridge sessions** are validated against the bridge's `/session/{id}` endpoint
- **Mobile relay sessions** trust the stored encrypted credentials
- Invalid or expired sessions are automatically cleared, triggering a fresh connection flow

## Mobile Relay Security

Mobile relay communication is end-to-end encrypted:

| Layer | Algorithm | Purpose |
|-------|-----------|---------|
| Key exchange | X25519 (ECDH) | Derive shared secret between dApp and wallet |
| Key derivation | HKDF-SHA256 | Deterministic key from shared secret with `"nova-connect-relay"` info |
| Encryption | XChaCha20-Poly1305 | Authenticated encryption of all request/response payloads |
| Nonce | 24 random bytes | Per-message nonce prevents replay attacks |

The relay server (nova-service) never sees plaintext request or response data.

## Exports

The package ships three entry points:

| Entry Point | Import Path | Contents |
|-------------|-------------|----------|
| Main | `@inferenco/nova-wallet-adapter` | `NovaWallet`, `NovaClient`, types, utilities, errors |
| AIP-62 | `@inferenco/nova-wallet-adapter/aip62` | `createNovaAIP62Wallet`, `registerNovaWallet` |
| Auto-register | `@inferenco/nova-wallet-adapter/auto-register` | Side-effect registration (import-only) |

Both ESM and CommonJS builds are included with full TypeScript declarations.

## Desktop Bridge API

When Nova Desk is running locally, the adapter communicates via HTTP:

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

All operations use a poll-based flow: initiate a request, receive a `requestId`, then poll until the user approves or rejects in the wallet.

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
| [Mobile Relay Protocol](docs/mobile-relay.md) | End-to-end encrypted mobile communication |
| [Changelog](CHANGELOG.md) | Version history and release notes |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@cedra-labs/ts-sdk` | Transaction building, network utilities, SDK operations |
| `@cedra-labs/wallet-standard` | AIP-62 wallet-standard types and registration |
| `@noble/curves` | X25519 ECDH key exchange (mobile relay) |
| `@noble/hashes` | SHA256, HKDF key derivation (mobile relay) |
| `@noble/ciphers` | XChaCha20-Poly1305 authenticated encryption (mobile relay) |
| `eventemitter3` | Event emission for account/network change subscriptions |

## License

[Apache-2.0](LICENSE)
