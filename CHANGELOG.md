# Changelog

All notable changes to `@inferenco/nova-wallet-adapter` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0-rc.3] - 2026-06-29

### Fixed

- **Restore public export surface.** `0.2.0-rc.2` was published
  with a mis-edited `src/index.ts` that dropped the wildcard
  re-export from `./bridge`, which in turn dropped
  `tryResumeNovaWalletConnection` and other existing helpers
  from the package. Vite rejected dapp imports with
  `does not provide an export named: 'tryResumeNovaWalletConnection'`.
  Restored `export * from "./bridge";` alongside the new
  `export { ... } from "./bridge/index-public.js";` filter.
  Test-only token helpers (`_resetBridgeTokenForTesting`,
  `_setBridgeTokenForTesting`) remain internal.

## [0.2.0-rc.2] - 2026-06-29

> **WARNING — broken release. Do not use.**
>
> `0.2.0-rc.2` shipped the bridge-token feature but a mis-edit
> to `src/index.ts` dropped the wildcard re-export from `./bridge`,
> breaking the public API. Vite rejected dapp imports with
> `does not provide an export named: 'tryResumeNovaWalletConnection'`.
> **Upgrade directly to `0.2.0-rc.3` or later.**

## [0.2.0-rc.1] - 2026-06-27

> **WARNING — broken release. Do not use.**
>
> This version was published to npm **before** the wallet-side bridge
> token delivery was complete. Nova Desk ≥ Phase 2 binds the HTTP
> bridge at `http://127.0.0.1:21984/<token>/<route>` and rejects
> unprefixed requests with `404` (no CORS). `0.2.0-rc.1` did not
> know about the token, so every `connect`, `signMessage`,
> `signTransaction`, and `signAndSubmitTransaction` call returned
> `404` and the wallet never showed the approval sheet in the
> Dashboard.
>
> **Upgrade directly to `0.2.0-rc.3` or later.**

## [0.1.0] - 2026-04-04

### Added

- **Core adapter** &mdash; `NovaWallet` plugin adapter class for plugin-style dApp integrations
- **AIP-62 bridge** &mdash; `createNovaAIP62Wallet()` and `registerNovaWallet()` for wallet-standard integration
- **Auto-registration** &mdash; `@inferenco/nova-wallet-adapter/auto-register` side-effect entry point
- **NovaClient** &mdash; Shared core client powering both adapter surfaces
- **Nova Desk support** &mdash; Local HTTP bridge to Nova Desk desktop application at `localhost:21984`
  - Connect, sign message, sign transaction, sign-and-submit endpoints
  - Poll-based request/response flow
  - Session persistence and validation
  - Session revocation
- **Nova Wallet support** &mdash; End-to-end encrypted connection to Nova Wallet via nova-service relay
  - X25519 ECDH key exchange
  - XChaCha20-Poly1305 authenticated encryption
  - HKDF-SHA256 key derivation
  - REST API + WebSocket real-time notifications
  - Deeplink handoff to Nova Wallet mobile app
  - Pairing persistence across page reloads
- **Injected provider detection** &mdash; `window.inferenco`, `window.nova`, branded `window.cedra`/`window.aptos`
- **Deeplink support** &mdash; `inferenco://` URI scheme for desktop and mobile handoff
- **Session management** &mdash; localStorage-based session persistence with bridge validation
- **Error handling** &mdash; `NovaAdapterError` with typed `NovaErrorCode` enum and automatic remapping
- **Conversion helpers** &mdash; Account, network, transaction, and message normalization
- **WalletCore resume helper** &mdash; `tryResumeNovaWalletConnection()` for Cedra WalletCore integration
- **Configurable options** &mdash; All URLs, timeouts, and behavior flags customizable via `NovaWalletOptions`
- **Dual module output** &mdash; ESM and CommonJS builds with TypeScript declarations
- **Unit tests** &mdash; Provider detection, bridge session management, mobile crypto round-trip, AIP-62 registration

### Notes

- Public wallet name is `"Nova Connect"` (`NOVA_CONNECT_NAME`)
- `NOVA_DESK_NAME` exported as deprecated alias for backward compatibility
- Default hosted relay: `https://nova-service-160604102004.europe-west1.run.app`
- Default desktop bridge: `http://127.0.0.1:21984`
