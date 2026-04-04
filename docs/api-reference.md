# API Reference

Complete type and method documentation for `@inferenco/nova-wallet-adapter`.

## Table of Contents

- [Classes](#classes)
  - [NovaWallet](#novawallet)
  - [NovaClient](#novaclient)
  - [NovaAdapterError](#novaadaptererror)
- [Functions](#functions)
  - [registerNovaWallet](#registernovawallet)
  - [createNovaAIP62Wallet](#createnovaaip62wallet)
  - [tryResumeNovaWalletConnection](#tryresumenovawalletconnection)
  - [remapNovaError](#remapnovaerror)
  - [detectNovaProvider](#detectnovaprovider)
- [Enums](#enums)
  - [NovaErrorCode](#novaerrorcode)
  - [NovaWalletReadyState](#novawalletreadystate)
- [Interfaces](#interfaces)
  - [NovaWalletOptions](#novawalletoptions)
  - [NovaExternalSession](#novaexternalsession)
  - [NovaProvider](#novaprovider)
  - [NovaAccountKeys](#novaaccountkeys)
  - [NovaNetworkInfo](#novanetworkinfo)
  - [SignMessagePayload](#signmessagepayload)
  - [NovaSignMessageResponse](#novasignmessageresponse)
  - [NovaWindow](#novawindow)
- [Type Aliases](#type-aliases)
  - [NovaTransactionPayload](#novatransactionpayload)
  - [NovaSignTransactionResult](#novasigntransactionresult)
  - [NovaWalletName](#novawalletname)
- [Constants](#constants)
- [Bridge & Session Utilities](#bridge--session-utilities)
- [Conversion Helpers](#conversion-helpers)
- [Mobile Relay Exports](#mobile-relay-exports)

---

## Classes

### `NovaWallet`

Plugin-style adapter class. Extends `EventEmitter<{ accountChange, networkChange }>`.

```typescript
import { NovaWallet } from "@inferenco/nova-wallet-adapter";

const wallet = new NovaWallet(options?: NovaWalletOptions);
```

#### Constructor

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `options` | `NovaWalletOptions` | `{}` | Configuration options |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `NovaWalletName` | `"Nova Connect"` |
| `url` | `string` | Wallet website URL |
| `icon` | `string` | Base64-encoded SVG icon |
| `readyState` | `NovaWalletReadyState` | Current detection state |
| `connecting` | `boolean` | `true` during connection attempt |
| `connected` | `boolean` | `true` when connected |
| `publicAccount` | `NovaAccountKeys` | Cached account keys |
| `network` | `NovaNetworkInfo` | Cached network info |

#### Methods

##### `connect(): Promise<AccountInfo>`

Initiates a connection to Nova Wallet. Tries injected provider first, then desktop bridge or mobile relay, using deeplinks for app handoff as needed.

**Returns:** `AccountInfo` with `address` and `publicKey`.

**Throws:** `NovaAdapterError` on failure.

```typescript
const account = await wallet.connect();
console.log(account.address); // "0x..."
```

##### `account(): Promise<AccountInfo>`

Fetches the current connected account.

**Returns:** `AccountInfo`

**Throws:** `NovaAdapterError` if not connected.

##### `disconnect(): Promise<void>`

Disconnects from the wallet and clears any stored session.

##### `signMessage(message: CedraSignMessageInput | SignMessagePayload): Promise<CedraSignMessageOutput | NovaSignMessageResponse>`

Signs an arbitrary message.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `message` | `CedraSignMessageInput \| SignMessagePayload` | Message to sign with nonce |

**Returns:** Signed message response with `signature` and `fullMessage`.

```typescript
const response = await wallet.signMessage({
  message: "Hello Nova!",
  nonce: "unique-nonce",
});
```

##### `signTransaction(transaction, options?): Promise<Uint8Array | { authenticator, rawTransaction? }>`

Signs a transaction without submitting it.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `transaction` | `AnyRawTransaction \| NovaTransactionPayload` | Transaction to sign |
| `options` | `InputGenerateTransactionOptions` | Optional transaction options |

##### `signAndSubmitTransaction(transaction, options?): Promise<CedraSignAndSubmitTransactionOutput>`

Signs and submits a transaction in one step. Falls back to local submission via `@cedra-labs/ts-sdk` if the provider does not support direct submit.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `transaction` | `NovaTransactionPayload` | Transaction payload |
| `options` | `InputGenerateTransactionOptions` | Optional transaction options |

```typescript
const result = await wallet.signAndSubmitTransaction({
  data: {
    function: "0x1::coin::transfer",
    typeArguments: ["0x1::aptos_coin::AptosCoin"],
    functionArguments: ["0xrecipient", 1000],
  },
});
console.log(result.hash);
```

##### `signAndSubmitBCSTransaction(transaction, options?): Promise<CedraSignAndSubmitTransactionOutput>`

Same as `signAndSubmitTransaction` but retries without unsupported options when the provider rejects object-style options.

##### `onAccountChange(callback: (account: AccountInfo) => void): Promise<void>`

Subscribes to account change events.

##### `onNetworkChange(callback: (network: NetworkInfo) => void): Promise<void>`

Subscribes to network change events.

##### `deeplinkProvider(url?: string): string`

Generates a deeplink URL for launching Nova Desk or Nova Wallet.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | `string` | current page URL | Callback URL |

---

### `NovaClient`

Core client powering both adapter surfaces. Extends `EventEmitter<{ accountChange, networkChange }>`.

```typescript
import { NovaClient } from "@inferenco/nova-wallet-adapter";

const client = new NovaClient(options?: NovaWalletOptions);
```

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `account` | `AccountInfo \| null` | Cached account (getter) |
| `cachedNetwork` | `NetworkInfo \| null` | Cached network (getter) |

#### Methods

##### `connect(): Promise<{ account: AccountInfo; network: NetworkInfo | null }>`

Full connection flow with automatic transport negotiation.

##### `disconnect(): Promise<void>`

Disconnect and revoke the active session.

##### `getAccount(): Promise<AccountInfo>`

Fetch account from provider or stored session.

##### `getNetwork(): Promise<NetworkInfo>`

Fetch current network from provider or stored session.

##### `signMessage(input: CedraSignMessageInput): Promise<CedraSignMessageOutput>`

Sign a message via the active transport (provider, Nova Desk bridge, or Nova Wallet relay).

##### `signMessageAndVerify(input: CedraSignMessageInput): Promise<boolean>`

Sign a message and verify the signature locally using the connected public key.

##### `signTransaction(transaction, options?): Promise<NovaSignTransactionResult>`

Sign a transaction.

##### `signAndSubmitTransaction(transaction, options?): Promise<CedraSignAndSubmitTransactionOutput>`

Sign and submit a transaction.

##### `signAndSubmitBCSTransaction(transaction, options?): Promise<CedraSignAndSubmitTransactionOutput>`

Sign and submit with retry for BCS payloads.

##### `refreshProvider(): NovaProvider | undefined`

Re-detect the injected provider.

##### `hasProvider(): boolean`

Check if an injected provider is detected.

##### `hasExternalSession(): boolean`

Check if a stored desktop-bridge or mobile-relay session exists.

##### `subscribe(): Promise<void>`

Subscribe to provider change events (account/network).

---

### `NovaAdapterError`

Custom error class for all adapter errors.

```typescript
class NovaAdapterError extends Error {
  readonly code: NovaErrorCode;
  readonly cause?: unknown;
}
```

**Properties:**

| Property | Type | Description |
|----------|------|-------------|
| `code` | `NovaErrorCode` | Typed error code |
| `message` | `string` | Human-readable error message |
| `cause` | `unknown` | Original error (if remapped) |
| `name` | `string` | Always `"NovaAdapterError"` |

---

## Functions

### `registerNovaWallet(options?)`

Registers Nova as an AIP-62 wallet-standard wallet via Cedra's `registerWallet()`.

```typescript
import { registerNovaWallet } from "@inferenco/nova-wallet-adapter/aip62";

registerNovaWallet({ forceRegistration: true });
```

**Registration conditions** (registers if any are true):
- Injected provider detected
- Stored external session exists
- `forceRegistration: true`
- Desktop browser (when `desktopRegistration: true`, the default)
- Mobile browser

Prevents duplicate registration automatically.

### `createNovaAIP62Wallet(options?)`

Creates a `CedraWallet` object implementing AIP-62 wallet-standard features.

```typescript
import { createNovaAIP62Wallet } from "@inferenco/nova-wallet-adapter/aip62";

const wallet = createNovaAIP62Wallet();
```

**Implemented features:**
- `cedra:connect` (v1.0.0)
- `cedra:disconnect` (v1.0.0)
- `cedra:network` (v1.0.0)
- `cedra:account` (v1.0.0)
- `cedra:onAccountChange` (v1.0.0)
- `cedra:onNetworkChange` (v1.0.0)
- `cedra:signMessage` (v1.0.0)
- `cedra:signTransaction` (v1.1)
- `cedra:signAndSubmitTransaction` (v1.1.0)
- `cedra:openInMobileApp` (v1.0.0)

### `tryResumeNovaWalletConnection(walletCore, options?)`

Helper for dApps using Cedra `WalletCore`. Resumes pending mobile callback state and reconnects through stored sessions.

```typescript
import { tryResumeNovaWalletConnection } from "@inferenco/nova-wallet-adapter";

await tryResumeNovaWalletConnection(walletCore);
```

### `remapNovaError(error: unknown): never`

Converts any error into a `NovaAdapterError` with the appropriate error code. Always throws.

```typescript
try {
  await riskyOperation();
} catch (error) {
  remapNovaError(error); // throws NovaAdapterError
}
```

### `detectNovaProvider(detectAliases?)`

Detects an injected Nova provider on the window object.

```typescript
import { detectNovaProvider } from "@inferenco/nova-wallet-adapter";

const provider = detectNovaProvider(true); // true = check aliases
if (provider) {
  console.log("Nova provider found");
}
```

---

## Enums

### `NovaErrorCode`

```typescript
enum NovaErrorCode {
  UserRejected    = "USER_REJECTED",
  Unauthorized    = "UNAUTHORIZED",
  Unsupported     = "UNSUPPORTED",
  NotInstalled    = "NOT_INSTALLED",
  ConnectionTimeout = "CONNECTION_TIMEOUT",
  InvalidParams   = "INVALID_PARAMS",
  InvalidNetwork  = "INVALID_NETWORK",
  InternalError   = "INTERNAL_ERROR",
}
```

### `NovaWalletReadyState`

```typescript
enum NovaWalletReadyState {
  Installed   = "Installed",     // Provider found or session stored
  NotDetected = "NotDetected",   // No provider, no session
  Loadable    = "Loadable",      // Can be loaded (deeplink capable)
  Unsupported = "Unsupported",   // Non-browser environment
}
```

---

## Interfaces

### `NovaWalletOptions`

Configuration for all adapter constructors. All fields are optional.

```typescript
interface NovaWalletOptions {
  deeplinkBaseUrl?: string;
  deeplinkScheme?: string;
  websiteUrl?: string;
  forceRegistration?: boolean;
  desktopRegistration?: boolean;
  detectAliases?: boolean;
  networkOverride?: Network;
  fullnodeUrl?: string;
  bridgeBaseUrl?: string;
  relayBaseUrl?: string;
  websocketBaseUrl?: string;
  bridgeConnectTimeoutMs?: number;
  bridgePollIntervalMs?: number;
  bridgePollTimeoutMs?: number;
  mobilePollIntervalMs?: number;
  mobileRequestTimeoutMs?: number;
  mobileSocketTimeoutMs?: number;
}
```

See [Configuration](configuration.md) for detailed descriptions.

### `NovaExternalSession`

Stored session state in `localStorage`.

```typescript
interface NovaExternalSession {
  transport: "desktop-bridge" | "mobile-relay";
  address: string;
  publicKey: string;
  network: string;
  chainId: number;
  sessionId: string;
  bridgeUrl?: string;              // desktop-bridge only
  relayBaseUrl?: string;           // mobile-relay only
  protocolPublicKey?: string;      // mobile-relay crypto
  dappSessionToken?: string;       // mobile-relay auth
  sharedSecret?: string;           // mobile-relay encryption
  walletPublicKey?: string;        // mobile-relay key exchange
  walletName?: string;
}
```

### `NovaProvider`

Interface for injected Nova wallet providers on the window object.

```typescript
interface NovaProvider {
  isNovaWallet?: boolean;
  connect?(...args: unknown[]): Promise<NovaProviderAccount | NovaProviderResponse<NovaProviderAccount>>;
  account?(): Promise<NovaProviderAccount | NovaProviderResponse<NovaProviderAccount>>;
  disconnect?(): Promise<void | NovaProviderResponse<void>>;
  network?(): Promise<string | number | NetworkInfo | NovaProviderResponse<...>>;
  signMessage?(input): Promise<CedraSignMessageOutput | NovaSignMessageResponse | NovaProviderResponse<...>>;
  signTransaction?(transaction, options?): Promise<...>;
  signAndSubmitTransaction?(transaction, options?): Promise<...>;
  onAccountChange?(callback): Promise<void> | void;
  onNetworkChange?(callback): Promise<void> | void;
  submitTransaction?(input): Promise<PendingTransactionResponse | NovaProviderResponse<...>>;
}
```

### `NovaAccountKeys`

```typescript
interface NovaAccountKeys {
  publicKey: string | string[] | null;
  address: string | null;
  authKey: string | null;
  minKeysRequired?: number;
}
```

### `NovaNetworkInfo`

```typescript
interface NovaNetworkInfo {
  api?: string;
  chainId?: string;
  name: string | undefined;
}
```

### `SignMessagePayload`

Message signing payload format.

```typescript
interface SignMessagePayload {
  address?: boolean;      // Include address in full message
  application?: boolean;  // Include application origin
  chainId?: boolean;      // Include chain ID
  message: string;        // Message content
  nonce: string;          // Unique nonce
}
```

### `NovaSignMessageResponse`

Message signing response format.

```typescript
interface NovaSignMessageResponse {
  address: string;
  application?: string;
  chainId?: number;
  fullMessage: string;
  message: string;
  nonce: string;
  prefix: string;         // Typically "CEDRA"
  signature: string;
}
```

### `NovaWindow`

Extended Window interface with Nova provider slots.

```typescript
interface NovaWindow extends Window {
  inferenco?: NovaProvider;
  nova?: NovaProvider;
  cedra?: NovaProvider;
  aptos?: NovaProvider;
}
```

---

## Type Aliases

### `NovaTransactionPayload`

Accepted transaction payload formats.

```typescript
type NovaTransactionPayload =
  | InputGenerateTransactionPayloadData
  | {
      sender?: AccountAddressInput;
      data: InputGenerateTransactionPayloadData;
      options?: InputGenerateTransactionOptions;
      withFeePayer?: boolean;
    };
```

### `NovaSignTransactionResult`

Possible return types from `signTransaction`.

```typescript
type NovaSignTransactionResult =
  | AccountAuthenticator
  | Uint8Array
  | { authenticator: AccountAuthenticator; rawTransaction?: Uint8Array }
  | CedraSignTransactionOutputV1_1;
```

### `NovaWalletName`

Branded string type for wallet names.

```typescript
type NovaWalletName<T extends string = string> = T & { __brand__: "WalletName" };
```

---

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `NOVA_CONNECT_NAME` | `"Nova Connect"` | Public wallet display name |
| `NOVA_WALLET_NAME` | `"Nova Wallet"` | Internal wallet name |
| `NOVA_DESK_NAME` | `"Nova Connect"` | Deprecated alias for `NOVA_CONNECT_NAME` |
| `DEFAULT_WEBSITE_URL` | `"https://inferenco.com"` | Default website URL |
| `DEFAULT_DEEPLINK_BASE_URL` | `"inferenco://connect?callback="` | Deeplink base |
| `DEFAULT_DESKTOP_LOGIN_URL` | `"inferenco://login"` | Desktop login deeplink |
| `DEFAULT_DESKTOP_BRIDGE_URL` | `"http://127.0.0.1:21984"` | Local bridge URL |
| `DEFAULT_DEEPLINK_SCHEME` | `"inferenco"` | URI scheme |
| `DEFAULT_MOBILE_RELAY_BASE_URL` | `"https://nova-service-....run.app"` | Hosted relay |
| `DEFAULT_MOBILE_WEBSOCKET_URL` | `"wss://nova-service-....run.app/v1/ws"` | Hosted WebSocket |
| `DEFAULT_MOBILE_POLL_INTERVAL_MS` | `1000` | Mobile poll interval |
| `DEFAULT_MOBILE_REQUEST_TIMEOUT_MS` | `180000` | Mobile request timeout (3 min) |
| `DEFAULT_MOBILE_SOCKET_TIMEOUT_MS` | `15000` | WebSocket timeout (15s) |
| `DEFAULT_DETECT_ALIASES` | `true` | Check branded aliases |
| `DEFAULT_REGISTER_FORCE` | `false` | Force registration |
| `DEFAULT_DESKTOP_REGISTRATION` | `true` | Desktop auto-registration |
| `DEFAULT_BRIDGE_CONNECT_TIMEOUT_MS` | `1200` | Bridge connect timeout |
| `DEFAULT_BRIDGE_POLL_INTERVAL_MS` | `250` | Bridge poll interval |
| `DEFAULT_BRIDGE_POLL_TIMEOUT_MS` | `120000` | Bridge poll timeout (2 min) |
| `NOVA_WALLET_ICON` | `data:image/svg+xml;base64,...` | Base64 SVG icon |

### Storage Keys

| Constant | Value | Description |
|----------|-------|-------------|
| `NOVA_EXTERNAL_SESSION_STORAGE_KEY` | `"inferenco:nova-session"` | Session storage |
| `NOVA_PENDING_MOBILE_PAIRING_STORAGE_KEY` | `"inferenco:nova-pending-mobile-pairing"` | Pending pairing |
| `NOVA_CALLBACK_MARKER_STORAGE_KEY` | `"inferenco:nova-callback-marker"` | Callback markers |
| `NOVA_PROTOCOL_KEY_STORAGE_KEY` | `"inferenco:nova-protocol-key"` | Protocol key |

---

## Bridge & Session Utilities

Exported from the main entry point.

| Function | Description |
|----------|-------------|
| `readExternalSession()` | Read stored session from localStorage |
| `storeExternalSession(session)` | Save session to localStorage |
| `clearExternalSession()` | Remove stored session |
| `readPendingMobilePairing()` | Read pending mobile pairing |
| `storePendingMobilePairing(pairing)` | Save pending pairing |
| `validateExternalSession(session, options)` | Validate session against bridge |
| `revokeExternalSession(session, options)` | Delete session from bridge/relay |
| `readValidatedExternalSession(options)` | Read + validate in one call |
| `sessionToAccountInfo(session)` | Convert session to `AccountInfo` |
| `isMobileBrowser()` | Detect mobile user agent |
| `fetchJsonWithTimeout(url, timeoutMs, init?)` | Fetch with abort controller |

---

## Conversion Helpers

Exported from the main entry point.

| Function | Description |
|----------|-------------|
| `toUint8Array(input)` | Convert hex string to `Uint8Array` |
| `normalizeProviderAccount(account)` | Normalize provider account to `AccountInfo` |
| `normalizeNetwork(network)` | Normalize any network format to `NetworkInfo` |
| `normalizeTransactionPayload(transaction)` | Normalize mixed transaction inputs |
| `normalizeSignMessageOutput(output)` | Normalize signature outputs |
| `getSdkNetwork(networkInfo?, fullnodeUrl?)` | Get `Cedra` SDK instance for network |
| `submitSignedTransaction(args)` | Submit a signed transaction via SDK |
| `createFullMessage(input, address, chainId?)` | Build full message for signing |

---

## Mobile Relay Exports

Exported from the main entry point. See [Mobile Relay Protocol](mobile-relay.md) for details.

| Export | Description |
|--------|-------------|
| `generateX25519Keypair()` | Generate X25519 keypair for ECDH |
| `deriveSharedSecret(privateKey, publicKey)` | Derive shared secret from ECDH |
| `encryptPayload(plaintext, sharedSecret)` | Encrypt with XChaCha20-Poly1305 |
| `decryptPayload(ciphertext, sharedSecret)` | Decrypt with XChaCha20-Poly1305 |
| `connectViaMobileRelay(options)` | Full mobile pairing flow |
| `createMobileRelayRequest(options)` | Create a signing request via relay |
| `pollMobileRelayRequest(options)` | Poll for request result |
| `waitForMobileSocket(options)` | Wait for WebSocket notification |
