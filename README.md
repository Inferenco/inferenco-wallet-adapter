# `@inferenco/nova-wallet-adapter`

Standalone Nova wallet adapter package for Cedra dapps.

This package is intended to live outside Cedra core, similar to Petra's standalone adapter model. It provides:

- `NovaWallet` for direct adapter-style integrations
- `createNovaAIP62Wallet()` for explicit wallet-standard bridging
- `registerNovaWallet()` for Cedra AIP-62 registration
- desktop `Nova Desk` connect/sign/sign-submit support through the local bridge
- mobile external-browser support through `nova-service` + `inferenco://` handoff

## Install

```bash
npm install @inferenco/nova-wallet-adapter
```

## Adapter Usage

```ts
import { NovaWallet } from "@inferenco/nova-wallet-adapter";

const wallet = new NovaWallet();

await wallet.connect();
const account = await wallet.account();
const network = wallet.network;
const signedMessage = await wallet.signMessage({
  message: "hello",
  nonce: "1",
});
```

## AIP-62 Registration Usage

```ts
import { registerNovaWallet } from "@inferenco/nova-wallet-adapter/aip62";

registerNovaWallet();
```

Or via side-effect import:

```ts
import "@inferenco/nova-wallet-adapter/auto-register";
```

The public wallet name exposed by the adapter is `Nova Connect`.

## Provider Detection

Provider detection prefers:

1. `window.inferenco`
2. `window.nova`
3. branded aliases such as `window.cedra` or `window.aptos` when they are marked as Nova

## Desktop Bridge

When Nova Desk is already running on desktop, the adapter prefers the local bridge:

- connect through `http://127.0.0.1:21984/connect`
- sign message through `POST /sign-message`
- sign transaction through `POST /sign-transaction`
- sign and submit through `POST /transaction`

The adapter stores the approved desktop session in browser storage and reuses it for later requests.

## Deeplink Fallback

If no injected provider or local Nova Desk bridge is available, the adapter falls back to desktop/mobile handoff URLs.

Desktop still uses `inferenco://login?redirect=...`.

Mobile external-browser support requires a relay:

```ts
import { NovaWallet } from "@inferenco/nova-wallet-adapter";

const wallet = new NovaWallet({
  relayBaseUrl: "https://relay.example",
  websocketBaseUrl: "wss://relay.example/v1/ws",
  deeplinkScheme: "inferenco",
});
```

In that mode the adapter:

- creates a relay pairing/session with `nova-service`
- opens `inferenco://connect?...` or `inferenco://approve?...`
- waits for websocket or callback resume markers
- fetches and decrypts the approved result from the relay

## Feature Surface

The adapter currently supports:

- `connect`
- `disconnect`
- `account`
- `network`
- `signMessage`
- `signTransaction`
- `signAndSubmitTransaction`

## Development

```bash
npm run typecheck
npm run test
npm run build
```
