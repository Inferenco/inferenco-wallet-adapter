# Configuration

All configuration is passed through the `NovaWalletOptions` interface. Every field is optional &mdash; the adapter works out of the box with sensible defaults.

## Usage

```typescript
import { NovaWallet } from "@inferenco/nova-wallet-adapter";

const wallet = new NovaWallet({
  bridgeBaseUrl: "http://127.0.0.1:21984",
  detectAliases: false,
  bridgePollTimeoutMs: 60000,
});
```

The same options are accepted by `NovaClient`, `registerNovaWallet`, and `createNovaAIP62Wallet`.

---

## Identity & Deeplinks

### `deeplinkBaseUrl`

| | |
|-|-|
| **Type** | `string` |
| **Default** | `"inferenco://connect?callback="` |

Base URL for deeplink generation. The adapter appends the current page URL as the callback parameter.

```typescript
new NovaWallet({
  deeplinkBaseUrl: "myapp://connect?callback=",
});
```

### `deeplinkScheme`

| | |
|-|-|
| **Type** | `string` |
| **Default** | `"inferenco"` |

URI scheme used for deeplinks. Used when constructing deeplink URLs for mobile relay pairing.

```typescript
new NovaWallet({
  deeplinkScheme: "inferenco",
});
```

### `websiteUrl`

| | |
|-|-|
| **Type** | `string` |
| **Default** | `"https://inferenco.com"` |

The URL exposed as the wallet's website in the adapter metadata.

---

## Registration Behavior

### `forceRegistration`

| | |
|-|-|
| **Type** | `boolean` |
| **Default** | `false` |

When `true`, `registerNovaWallet()` registers the wallet even if no injected provider is detected. This enables deeplink-based connection flows for dApps that want Nova to appear in wallet selection UIs without requiring the extension.

```typescript
import { registerNovaWallet } from "@inferenco/nova-wallet-adapter/aip62";

registerNovaWallet({
  forceRegistration: true,
});
```

### `desktopRegistration`

| | |
|-|-|
| **Type** | `boolean` |
| **Default** | `true` |

When `true`, the adapter auto-registers on desktop browsers even without an injected provider. This allows desktop users to connect via the local bridge or deeplink without needing the extension installed.

Set to `false` to only register when a provider is explicitly detected.

### `detectAliases`

| | |
|-|-|
| **Type** | `boolean` |
| **Default** | `true` |

When `true`, the adapter checks `window.cedra` and `window.aptos` for Nova-branded providers (those with `isNovaWallet === true`). When `false`, only `window.inferenco` and `window.nova` are checked.

Disable this if your dApp has its own handling for `window.cedra` / `window.aptos` and you want to avoid conflicts.

```typescript
new NovaWallet({
  detectAliases: false, // Only check window.inferenco and window.nova
});
```

---

## Network

### `networkOverride`

| | |
|-|-|
| **Type** | `Network` (from `@cedra-labs/ts-sdk`) |
| **Default** | `undefined` |

Force the adapter to use a specific network regardless of what the provider reports. Useful for dApps that are hardcoded to a single network.

```typescript
import { Network } from "@cedra-labs/ts-sdk";

new NovaWallet({
  networkOverride: Network.TESTNET,
});
```

### `fullnodeUrl`

| | |
|-|-|
| **Type** | `string` |
| **Default** | `undefined` (uses SDK defaults) |

Custom fullnode URL for SDK operations like transaction building and submission. When set, the adapter uses this URL instead of the SDK's default for the detected network.

```typescript
new NovaWallet({
  fullnodeUrl: "https://fullnode.testnet.cedralabs.com/v1",
});
```

---

## Nova Desk (Desktop Bridge)

These options configure the local HTTP bridge to the Nova Desk desktop application.

### `bridgeBaseUrl`

| | |
|-|-|
| **Type** | `string` |
| **Default** | `"http://127.0.0.1:21984"` |

Base URL for the desktop bridge. Change this if Nova Desk is configured to run on a different port.

```typescript
new NovaWallet({
  bridgeBaseUrl: "http://127.0.0.1:9999",
});
```

### `bridgeConnectTimeoutMs`

| | |
|-|-|
| **Type** | `number` |
| **Default** | `1200` |

Timeout in milliseconds for the initial bridge connection probe. If the bridge doesn't respond within this time, the adapter considers Nova Desk as not running and falls back to the next transport.

Keep this short to avoid blocking the user when Nova Desk is not installed.

### `bridgePollIntervalMs`

| | |
|-|-|
| **Type** | `number` |
| **Default** | `250` |

Interval in milliseconds between poll requests to the bridge while waiting for user approval. Lower values provide faster feedback but increase request volume.

### `bridgePollTimeoutMs`

| | |
|-|-|
| **Type** | `number` |
| **Default** | `120000` (2 minutes) |

Maximum time in milliseconds to wait for the user to approve or reject a request in Nova Desk. After this timeout, the adapter throws a `ConnectionTimeout` error.

```typescript
new NovaWallet({
  bridgePollTimeoutMs: 60000, // 1 minute timeout
});
```

---

## Nova Wallet (Mobile Relay)

These options configure the nova-service relay used for connecting to the Nova Wallet mobile app.

### `relayBaseUrl`

| | |
|-|-|
| **Type** | `string` |
| **Default** | `"https://nova-service-160604102004.europe-west1.run.app"` |

Base URL for the nova-service relay REST API. Override for self-hosted relay deployments or local development.

```typescript
new NovaWallet({
  relayBaseUrl: "https://relay.your-domain.com",
});
```

### `websocketBaseUrl`

| | |
|-|-|
| **Type** | `string` |
| **Default** | `"wss://nova-service-160604102004.europe-west1.run.app/v1/ws"` |

WebSocket URL for real-time relay notifications. Must match the relay deployment.

```typescript
new NovaWallet({
  websocketBaseUrl: "wss://relay.your-domain.com/v1/ws",
});
```

### `mobilePollIntervalMs`

| | |
|-|-|
| **Type** | `number` |
| **Default** | `1000` (1 second) |

Interval in milliseconds between poll requests to nova-service while waiting for the user to approve in Nova Wallet. Used when WebSocket notifications are unavailable or time out.

### `mobileRequestTimeoutMs`

| | |
|-|-|
| **Type** | `number` |
| **Default** | `180000` (3 minutes) |

Maximum time in milliseconds to wait for the user to approve or reject a request in Nova Wallet. Longer than the Nova Desk timeout to account for app switching delays on mobile.

### `mobileSocketTimeoutMs`

| | |
|-|-|
| **Type** | `number` |
| **Default** | `15000` (15 seconds) |

Time in milliseconds to wait for a WebSocket response from nova-service before switching to HTTP polling. If the WebSocket connection fails or no message arrives within this window, the adapter polls at `mobilePollIntervalMs` intervals instead.

---

## Example Configurations

### Minimal (defaults)

```typescript
const wallet = new NovaWallet();
```

### Testnet with Force Registration

```typescript
import { Network } from "@cedra-labs/ts-sdk";

const wallet = new NovaWallet({
  networkOverride: Network.TESTNET,
  forceRegistration: true,
  fullnodeUrl: "https://fullnode.testnet.cedralabs.com/v1",
});
```

### Self-Hosted Relay

```typescript
const wallet = new NovaWallet({
  relayBaseUrl: "https://relay.your-domain.com",
  websocketBaseUrl: "wss://relay.your-domain.com/v1/ws",
});
```

### Custom Bridge Port

```typescript
const wallet = new NovaWallet({
  bridgeBaseUrl: "http://127.0.0.1:9999",
  bridgePollTimeoutMs: 60000,
});
```

### Extension-Only (No Aliases)

```typescript
const wallet = new NovaWallet({
  detectAliases: false,
  desktopRegistration: false,
});
```
