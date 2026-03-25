# `@inferenco/nova-wallet-adapter`

Standalone Nova wallet adapter package for Cedra dapps.

This package is intended to live outside Cedra core, similar to Petra's standalone adapter model. It provides:

- `NovaWallet` for legacy plugin-style integrations
- `createNovaAIP62Wallet()` for explicit wallet-standard bridging
- `registerNovaWallet()` for Cedra AIP-62 registration on import

## Install

```bash
npm install @inferenco/nova-wallet-adapter
```

## Legacy Adapter Usage

```ts
import { NovaWallet } from "@inferenco/nova-wallet-adapter";

const wallet = new NovaWallet();

await wallet.connect();
const account = await wallet.account();
const network = wallet.network;
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

## Provider Detection

Provider detection prefers:

1. `window.inferenco`
2. `window.nova`
3. branded aliases such as `window.cedra` or `window.aptos` when they are marked as Nova

## Deeplink Fallback

If no injected provider is available, the adapter can generate a desktop/mobile handoff URL:

```ts
import { NovaWallet } from "@inferenco/nova-wallet-adapter";

const wallet = new NovaWallet({
  deeplinkBaseUrl: "inferenco://connect?callback=",
});

const url = wallet.deeplinkProvider("https://example.com/callback");
```

## Development

```bash
npm run typecheck
npm run test
npm run build
```
