# Changelog

All notable changes to `@inferenco/nova-wallet-adapter` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
> **Upgrade directly to `0.2.0-rc.2` or later.**

## [0.2.0-rc.2] - 2026-06-29

### Added

- **Bridge token support.** The adapter now reads the wallet's
  per-session URL token (delivered via `window.postMessage` or via
  the `bridgeToken` field in the `/connect` response body) and
  prefixes every bridge URL with `/<token>/`. Matches the wallet-side
  F-03 token piece.
- **New helpers** in `src/bridge/`:
  - `readBridgeToken()` — synchronous accessor; throws
    `MissingBridgeTokenError` if the token is not available.
  - `ensureBridgeToken()` — async accessor; awaits the postMessage
    listener with a 2 s timeout.
  - `getBridgeBaseUrlWithToken(options?)` — `host:port/<token>`.
  - `bridgePathWithToken(route, options?)` — `/<token><route>`.
  - `bridgeUrlWithToken(route, options?)` — full URL with the token
    in the path. **Use this for every bridge call.**
  - `forceRefreshBridgeToken()` — internal, used by the B+ retry path.
  - `MissingBridgeTokenError` and `MISSING_BRIDGE_TOKEN_MESSAGE`
    for typed error handling.
  - `BRIDGE_TOKEN_PATH_REGEX` — the 64-lowercase-hex shape.

### Changed (breaking for adapter < 0.2.0 against wallet ≥ Phase 2)

- Every internal bridge URL construction in `src/bridge.ts` now
  goes through `bridgeUrlWithToken(options?)` (or
  `bridgePathWithToken` + `DEFAULT_DESKTOP_BRIDGE_URL`) instead of
  `bridgeBaseUrl(options)`. The previous code landed requests on
  unprefixed routes, which the wallet rejects.
- `startBridgeRequest` and `pollSignedResult` now implement the
  **B+ retry path**: a `BridgeHttpError(404)` is treated as a
  token-mismatch signal. The adapter force-refreshes the token
  and retries once before falling back to the
  `clearExternalSession` + reconnect-error path.
- The `BRIDGE_TOKEN_PATH_REGEX` rejects uppercase hex, lengths
  other than 64, and any non-hex character. This is enforced in
  the postMessage listener so a malicious or buggy delivery
  channel cannot inject an invalid token.
- External code that imports `bridgeBaseUrl()` directly still gets
  the unprefixed host:port (back-compat for advanced consumers).

### Migration from 0.1.x

- **No code change required for typical consumers.** The adapter
  wires the token automatically; existing dapp code works
  unchanged.
- Dapps on `0.1.x` against a Phase-2 wallet see `404` on every
  call. Upgrade to `0.2.0-rc.2` before testing against a Phase-2
  wallet build.
- Dapps that imported `bridgeBaseUrl()` directly still get the
  unprefixed host:port (back-compat). Internal callers are
  rewritten to use `bridgeUrlWithToken()`.

### Wallet-side dependency

`0.2.0-rc.2` requires the wallet to deliver the per-session URL
token via one of the two channels described in
[`docs/bridge-token.md`](docs/bridge-token.md). Wallets built from
`Inferenco/nova_desk` commit `71eb1df` or later deliver the token
in both channels. Older wallet builds will return
`MissingBridgeTokenError` and the dapp will surface a
reconnect prompt.

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
