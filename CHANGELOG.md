# Changelog

All notable changes to `@inferenco/nova-wallet-adapter` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0-rc.4] - 2026-06-29

### Added (deeplink hardening, non-breaking)

- **Tier 1: Origin check.** `tryResumeNovaWalletConnection(walletCore, { expectedOrigin })` — when `expectedOrigin` is set, the adapter verifies the callback URL's `window.location.origin` matches and throws `CallbackOriginMismatch` on mismatch. Dapps that don't pass `expectedOrigin` see identical behavior to `0.2.0-rc.3`.

- **Tier 1 (cont.):** `parseExternalSession` now rejects any session whose `walletName` is not `"Nova Connect"`. Defends against attacker-controlled `walletName` substitution in the callback URL.

- **Tier 1 (cont.):** `sessionBridgeBaseUrl` ignores `session.bridgeUrl` when the dapp's `options.bridgeBaseUrl` is configured. Defends against attacker-controlled bridge substitution.

- **Tier 1 (cont.):** `CallbackOriginMismatch` typed error class exported from the package. Dapps can `instanceof`-check for clean UX.

- **Tier 3: Red banner.** When the dapp includes `origin` in the `inferenco://` deeplink, the wallet's approval sheet displays a red banner if the redirect URL's origin differs. Copy: "Heads up: this connection will redirect you to `<expected>`, not `<origin>` where you started."

- **Tier 4: PKCE.** New helpers `generatePkcePair()` and `exchangeCodeForSession({ code, codeVerifier })` implement RFC 7636-style PKCE for the `inferenco://` deeplink. The wallet stores `(code, code_challenge, session_id, redirect, stored_at)` in an in-memory `HashMap` with a 60 s lazy TTL and provides a new `POST /<token>/exchange` endpoint that verifies `SHA-256(code_verifier) == code_challenge` and returns the session. The legacy flow (session in callback URL) continues to work for dapps that don't opt in.

- **Tier 4 (cont.):** `storeCallbackSessionViaPkce({ codeVerifier, options })` — dapp-facing helper that detects the `?code=` query param, calls `exchangeCodeForSession`, and stores the result. Replaces `storeCallbackSession` for PKCE flows; the legacy helper is preserved.

- **Tier 4 (cont.):** `buildDesktopOrMobileConnectUrl` reads `options.codeChallenge` and appends `&code_challenge=` to the deeplink URL. New `PKCE_VERIFIER_STORAGE_KEY` constant for the dapp to persist the verifier between deeplink launch and callback consumption.

- **Tier 4 (cont.):** `PkceVerificationFailed` typed error class exported from the package. Distinct from `MissingBridgeTokenError` so dapps can surface a clear "PKCE exchange failed" UX.

### Backwards compatibility

All new behaviors are opt-in. Existing dapps that don't pass `expectedOrigin`, `origin`, or `codeChallenge` see identical behavior to `0.2.0-rc.3`. No API signatures have changed. No exports have been removed (the ESM build and `.d.ts` are clean; a tsup CJS quirk lists a few internal test helpers in the CJS bundle but they are not in the public API and are not used by any dapp).

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

## [0.2.0-rc.4] - 2026-06-29

### Changed (clarification, not a new feature)

- **External browsers must use the deeplink flow.** Earlier
  drafts proposed a third delivery channel (a token-free
  `GET /token` discovery endpoint on the wallet's HTTP bridge)
  to let external dapps learn the per-session URL token without
  the deeplink. The wallet side of that proposal was rejected
  — it bypasses the F-03 token-prefix security boundary, which
  is the audit-intended control. `0.2.0-rc.4` documents the
  supported path instead:
  1. The dapp detects that no token is available
     (`readBridgeToken()` / `ensureBridgeToken()` throws
     `MissingBridgeTokenError`).
  2. The dapp calls `launchDesktopOrMobileConnect(options)`,
     which fires the `inferenco://` deeplink. The OS hands
     off to Nova Desk.
  3. Nova Desk shows the approval sheet, the user approves,
     and Nova Desk redirects the browser back to the dapp
     with the session in the callback URL.
  4. The dapp's existing `installExternalSessionResumeListeners()`
     + `tryResumeNovaWalletConnection` flow picks up the
     callback and stores the session.
  5. Subsequent bridge calls use the new session normally.
  This is the same flow the deeplink has always used; nothing
  about the audit broke it. The dapp just needs to call
  `launchDesktopOrMobileConnect` on its Connect button when
  the adapter reports no token.

- **Error message tightened.** `MISSING_BRIDGE_TOKEN_MESSAGE`
  now explicitly tells the dapp user to open the dapp via
  Nova Desk (either inside its embedded browser or via the
  `inferenco://` deeplink), instead of a generic "open this
  dapp via Nova Desk" hint.

### Test totals

60 passing — no test changes in this commit (the HTTP
discovery path was a previous-commit artefact, and the
deeplink flow is already covered by existing tests in
`tests/bridge.test.ts` and `tests/aip62.test.ts`).

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
