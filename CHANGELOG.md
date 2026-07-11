# Changelog

All notable changes to `@inferenco/nova-wallet-adapter` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - audit-08 ND-WEB-001 follow-on

### Changed (Nova Desk no longer returns `bridgeUrl` in preauth response)

`PreauthStartResult.bridgeUrl` is now declared `string | undefined`
(was `string`). Nova Desk 0.6.0-rc.7+ no longer includes the
`bridgeUrl` field in the `POST /preauth-connect` response — the
process-global bridge URL is never exposed to a dapp before
user approval (audit-08 ND-WEB-001 HIGH finding).

Production behaviour is unchanged: `NovaClient.connect()` does
not read `preauth.bridgeUrl` — it passes its own `options`
through to `pollPreauthUntilResolved`, and downstream sign
operations go through `bridgeUrlWithToken(route, options)` /
`sessionBridgeBaseUrl(session, options)` which already fall
back to `options.bridgeBaseUrl` when `session.bridgeUrl` is
unset.

Direct API consumers (a dapp calling `startPreauthConnect()`
themselves and reading `.bridgeUrl`) get `undefined` for
modern Nova Desk builds and the existing string for older
builds. Backward compatible — no breaking change for code
that handles the field defensively.

## [0.2.0-rc.12] - 2026-07-02

### Changed (avoid duplicate wallet in dapp's selector when running inside Nova Desk)

`registerNovaWallet()` now skips `registerWallet()` when the dapp is
already hosted inside Nova Desk's embedded browser. The embedded
provider (`window.cedra` / `window.nova` / `window.aptos`, all stamped
with `isNovaDesk: true`) is already on the page and provides identical
functionality through the same IPC channel. Registering Nova Connect on
top produced a duplicate entry in the dapp's wallet-selector modal that
routes to the same wallet.

This is fully backward compatible: external browsers are unaffected
because the embedded `isNovaDesk` flag is only set inside Nova Desk's
WebView. Detection is done by reading `window.cedra.isNovaDesk`,
`window.nova.isNovaDesk`, `window.aptos.isNovaDesk`, or the
`__novaDeskProviderInjected` sentinel — any of which is sufficient and
reliable.

### Added (helper for dapps using third-party adapters)

`isHostedInNovaDesk()` is now exported from the package root. Dapps
that use a wallet adapter other than Nova Connect can use this helper
to filter the wallet-selector modal:

```ts
import { isHostedInNovaDesk } from "@inferenco/nova-wallet-adapter";

const wallets = getCedraWallets().cedraWallets.filter(
  (w) => !(isHostedInNovaDesk() && w.name === "Nova Connect"),
);
```

Dapps that use the Nova Connect adapter itself do not need to call
this — suppression is automatic.

### Override

Dapps that explicitly want both entries (e.g. to compare behavior, or
for testing) can pass `forceRegistration: true` to `registerNovaWallet()`.

## [0.2.0-rc.11] - 2026-07-02

### Fixed (bridge "already pending" guard getting stuck after dapp abort)

When a dapp cancelled or aborted a `signMessage` / `signTransaction` /
`signAndSubmit` request before the wallet could transition the state out of
`Pending`, the wallet's "Another Nova Desk ... approval is already pending."
guard would block every subsequent request — including after
disconnect/reconnect, until the wallet process restarted. Root cause:
the per-request maps were never cleared when the dapp side aborted, and
session-revoke only cleaned the session/connect maps, not the per-request
maps.

Requires Nova Desk `v0.6.0-rc.6+` (the new `POST /cancel/<id>` endpoint
and the session-revoke cleanup are wallet-side changes that ship with
the next wallet release; the adapter just consumes them).

- **`tryLocalBridgeSignMessage`** — on any error during
  `startBridgeRequest` / `pollSignedResult` the adapter now fires a
  fire-and-forget `POST <bridgeUrl>/cancel/<requestId>` with the error
  message as the `reason`. The wallet's cancel handler transitions
  `Pending` → `Failed` (idempotent) so the next request can proceed.
- **`tryLocalBridgeSignTransaction`** — same pattern.
- **`tryLocalBridgeSignAndSubmit`** — same pattern.
- **`cancelPendingRequest`** — new internal helper. `void` `fetch` with
  `.catch(() => {})` so a wallet-side blip never delays the caller.
  Server-side cancel is idempotent (no-op on terminal/unknown ids), so
  duplicate cancels are safe.

### Migration from 0.2.0-rc.10

| Wallet | Adapter | Behaviour |
|---|---|---|
| v0.6.0-rc.6+ | **0.2.0-rc.11** | Cancelled/aborted requests release the pending guard immediately. |
| v0.6.0-rc.6+ | 0.2.0-rc.10 | Still works; the wallet's 5-min lazy expiration sweep eventually clears stale entries. |
| v0.6.0-rc.5 or older | 0.2.0-rc.11 | Cancel POST returns 404; the adapter swallows the error so nothing regresses (the wallet won't ever expose the cancel endpoint). |

### Tests

- 112/112 passing (no new test files — the cancel path is a fire-and-forget
  side effect that's hard to assert without a live bridge, so the
  coverage lives in the wallet's `nova-desk-ui` test suite which spins
  up the bridge directly).

## [0.2.0-rc.10] - 2026-07-01

### Changed (deprecation)

- **`buildDesktopOrMobileConnectUrlWithRequest`** is now marked
  `@deprecated since 0.2.0-rc.10` with a console warning. The
  pre-auth flow no longer needs the deeplink in the success path —
  `NovaClient.connect()` no longer fires it. Kept exported for
  dapps that call it directly. Will be removed in `0.4.0`.

## [0.2.0-rc.8] - 2026-07-01

### Added (Phase 5 UX — wallet-initiated disconnect notification)

First-class `disconnect` event across all three adapter surfaces so dapps learn
when Nova Connect revokes their session (or when they themselves revoke it) —
without polling `GET /<token>/session/<id>` from the dapp side.

- **`NovaClient.on("disconnect", cb)`** — payload-less event emitted when the
  adapter loses its session. Subscribers should drop cached account/network
  state and route the user back through the connect flow.
- **`NovaWallet.onDisconnect(cb)`** — mirror of `NovaClient`'s event for the
  plugin-style adapter. Also re-emitted as `wallet.emit("disconnect")`.
- **`cedra:onDisconnect`** AIP-62 feature — `wallet.features["cedra:onDisconnect"].onDisconnect(cb)`
  for wallet-standard consumers. Modeled after `cedra:onAccountChange`.
- **`NovaWalletOptions.sessionLivenessIntervalMs?: number`** — opt-in
  liveness heartbeat (default `0` = disabled, backwards-compatible). When
  set to a positive integer the adapter schedules
  `setInterval(readValidatedExternalSession, intervalMs)`; a 403/404
  response from `GET /<token>/session/<id>` triggers the new disconnect
  event. Recommended range: 15_000 – 60_000. Cost: 1 HTTP call per dapp
  tab per interval against `127.0.0.1`.

### Changed

- **Cross-tab session-cleared detection.** `installExternalSessionResumeListeners`
  now also handles `storage` events with `newValue === null` (peer-tab
  `clearExternalSession`), `window.message` events carrying
  `inferenco:nova-session-cleared`, and the corresponding `BroadcastChannel`
  messages. Peer tabs learn about a disconnect in the same tick.
- **New `inferenco:nova-session-cleared` BroadcastChannel / CustomEvent**
  string constant (`NOVA_SESSION_CLEARED_MESSAGE_TYPE`) imported from
  `constants.ts`. Exported for dapps that want to listen on `window`
  directly without going through the typed adapter surface.
- **`NovaClient.disconnect()` now emits `"disconnect"` locally** and
  notifies peer tabs (via the new clear channel) before clearing state.
  Parity with the wallet-revoked path. Reset of the
  `disconnectEmitted` guard happens at the next successful
  `connectResultFromExternalSession`.

### Public-API additions

```typescript
// NovaClient (event emitter, payload-less)
client.on("disconnect", () => {
  // Drop cached state, route user back through connect()
});

// NovaWallet (plugin adapter)
await wallet.onDisconnect(() => { /* ... */ });

// AIP-62 (wallet-standard)
await wallet.features["cedra:onDisconnect"].onDisconnect(() => { /* ... */ });

// Opt-in liveness heartbeat
new NovaClient({ sessionLivenessIntervalMs: 30_000 });
```

### Backwards compatibility

- All new behaviours are opt-in or non-breaking additions. Dapps that don't
  set `sessionLivenessIntervalMs` see identical behaviour to `0.2.0-rc.7`
  (lazy disconnect detection on the next user-initiated `connect()` /
  `getAccount()`).
- The `provider.disconnect` path inside Nova Desk's embedded webview is
  unchanged. The new event covers cross-tab and cross-process cases only.

### Tests

93 → 100 (+7 new tests):
- `tests/bridge.test.ts`: storage `newValue=null`, BroadcastChannel cleared,
  `awaitExternalDisconnect` resolves after `notifyExternalDisconnect`.
- `tests/client.test.ts`: disconnect event on explicit `disconnect()`,
  disconnect via liveness heartbeat, `sessionLivenessIntervalMs=0`
  does not start a heartbeat.
- `tests/aip62.test.ts`: `cedra:onDisconnect` is exposed on the wallet
  features object.

### Paired release

- **Nova Desk release tag `v0.6.0-rc.2`** (force-update of `v0.6.0-rc.1`,
  which was never released to anyone). Companion change on the wallet
  side: `disconnect_connected_app` now pushes
  `__novaDeskHostUpdate({action:"disconnect", connected:false, …})` via
  `webview.evaluate_script` into any open in-wallet webview tab whose
  origin matches the disconnected dapp. The embedded provider's
  `applyHostState` already emits `disconnect` from the existing
  `wasConnected && !connected` branch (`dapp_provider.rs:366`), so this
  becomes an instant notification for the embedded case.
- External browser still requires `sessionLivenessIntervalMs` opt-in or
  next user-initiated `connect()` to detect. Documented in
  `SECURITY.md` (Phase 5 addendum) — flagged as **UX improvement, not a
  security boundary**.

## [0.2.0-rc.7] - 2026-06-30

### Fixed (external-dapp-connect)

Restores the end-to-end "Connect Nova Connect" flow when the dapp loads
in a regular web browser (not inside Nova Desk's WebKit2GTK webview).

Companion to the wallet's F-07b self-heal registration change.

- **`NovaClient.connect()` now consumes the callback URL params first.**
  When the wallet fires `xdg-open <redirect>?address=...&sessionId=...`
  after the user approves, the browser navigates back to the dapp with
  the callback params in the URL. Before rc.7, `connect()` would re-fire
  the deeplink (asking the user to approve again) and `waitForExternalSession`
  would time out at 120s because nothing consumed the params from the URL
  on the new page load. The fix: `connect()` now invokes
  `consumeExternalCallbackIfPresent` (which now returns `Promise<boolean>`)
  before trying the local bridge or deeplink paths.

- **`sessionEndpointUrl` and `connectionEndpointUrl` preserve the per-session URL token.**
  These helpers previously used the URL constructor to build
  `/session/<id>` paths against a token-bearing base
  (`http://127.0.0.1:21984/<token>/`), which treated the token as a
  directory and replaced it with `session/<id>`. The wallet's F-03
  token gate would 404 the resulting request, and `validateExternalSession`
  would call `clearExternalSession()` on every post-callback page load,
  wiping the freshly-consumed session. Fix: detect the token via
  `BRIDGE_TOKEN_PATH_REGEX` and prefix the path manually.

- **`bridgePathWithToken` falls back to `options.bridgeBaseUrl`'s token.**
  In an external browser the postMessage delivery channel never fires
  (it's only set up inside Nova Desk's embedded webview). The token
  was delivered via the wallet's redirect callback URL's `bridgeUrl=`
  parameter. When `readBridgeToken()` throws, the function now extracts
  the token from the configured base URL. This makes `signMessage`,
  `signTransaction`, and `signAndSubmit` work in external browsers.

- **Moved `BRIDGE_TOKEN_PATH_REGEX` to `constants.ts`** (was duplicated
  in `bridge/token.ts`). Re-exported for tests.

### Internal

- Test-only helpers `_sessionEndpointUrlInternal` and
  `_connectionEndpointUrlInternal` underscore-prefixed.

### Tests

- 83 -> 93 (+10 new tests covering token preservation, fallback chain,
  and the new callback-consume behavior).

### Paired release

- **Nova Desk release tag `v0.6.0-rc.1`** (commits `3a6b585`..
  `dd84f04` on `Inferenco/nova_desk::fix/audit-06-2026`). Notable
  changes on the wallet side for this RC pair:
  - `inferenco://` protocol auto-registers the wrapper script and
    `.desktop` entry on every launch — no more stale handler from
    a previous install.
  - `confirm login` button now surfaces approval errors via toast
    + state (previously silently dropped).
  - `NOVA_DESK_ALLOW_HTTP_LOOPBACK=1` — opt-in to allow the wallet to
    approve connections from `http://localhost:*` (Vite dev server)
    when running a release-built wallet against a dev server. Without
    this env var, release builds of the wallet reject loopback http
    redirects per F-06; with it set, the developer workflow works.
  - `NOVA_DESK_DEEPLINK_DEBUG=1` — verbose deeplink tracing that
    logs every state transition to `~/.nova_desk/runtime/deeplink-flow.log`.

## [0.2.0-rc.6] - 2026-06-29

### Fixed (export surface)

- **`src/index.ts` was missing the PKCE re-exports.** The PKCE helpers (`generatePkcePair`, `exchangeCodeForSession`, `appendCodeChallengeToDeeplink`, `PkceVerificationFailed`) were exported from `src/bridge/index-public.ts` but never re-exported from the top-level `src/index.ts`. The CJS bundle happened to include them via tsup's tree-shaking, but the ESM bundle and the `.d.ts` types did not. Dapps that imported `generatePkcePair` from the package (ESM consumers, TypeScript users) saw `does not provide an export named: 'generatePkcePair'`. The PKCE exports are now in the explicit re-export block at `src/index.ts:7-23`, so ESM, CJS, and `.d.ts` are all in sync.

No code changes to the runtime behavior. The bug was purely in the public API surface — the source code was correct, the dist was incomplete. `0.2.0-rc.6` is identical to `0.2.0-rc.5` at runtime; only the export surface was patched.

## [0.2.0-rc.5] - 2026-06-29

### Fixed (transparent deeplink fallback)

- **`tryLocalBridgeConnect` no longer throws `MissingBridgeTokenError` synchronously.** When the dapp is in an external browser and the per-session URL token is not available, the function used to throw at the `bridgePathWithToken` call site (before the existing deeplink fallback at `NovaClient.connect` could fire). It now catches the throw and returns `null`, allowing the existing deeplink flow to take over: the OS hands off to Nova Desk, the user approves, the browser returns to the dapp's callback URL, and `tryResumeNovaWalletConnection` (which the dapp's `useEffect` already calls) consumes the session. **No dapp code change required.**

- **`tryResumeNovaWalletConnection` now auto-consumes the URL callback** before reading from `localStorage`. The new `consumeExternalCallbackIfPresent(options)` helper detects either the legacy `?address=...&sessionId=...` bundle or the PKCE `?code=...` query param, stores the resulting session in `localStorage`, and the rest of the resume flow picks it up. This is the second half of the transparent deeplink path: the dapp's `useEffect` runs `tryResumeNovaWalletConnection` on every page load, so the callback consumption is automatic.

### Backwards compatibility

- The dapp dev's contract is unchanged: call `walletCore.connect('Nova Connect')`. In the embedded browser, this works directly. In an external browser, the adapter fires the `inferenco://` deeplink internally and the user comes back connected. No new exports are required and no opt-in is needed.
- The `MissingBridgeTokenError` exception is no longer thrown to the dapp for the no-token case (the deeplink fallback catches it). It is still exported and can still be thrown by direct callers of `readBridgeToken` / `ensureBridgeToken` if they bypass the `walletCore.connect` path.
- `consumeExternalCallbackIfPresent(options)` is exported for dapps that want to call it directly (e.g. in a SPA route that handles the callback URL), but the standard useEffect path does not need to call it explicitly.

### Test totals

77 → 83 (+6 new in `tests/bridge/transparent_deeplink.test.ts`):
  - `no_op_when_url_has_no_callback_params`
  - `consumes_legacy_callback_address_param_into_localStorage`
  - `consumes_pkce_callback_code_param_into_localStorage`
  - `prefers_pkce_over_legacy_when_both_are_present`
  - `tolerates_malformed_url_without_throwing`
  - `tryLocalBridgeConnect returns_null_when_readBridgeToken_throws_MissingBridgeTokenError`

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

## [0.2.0-rc.10] - 2026-07-01

### Changed

- `NovaClient.connect()` no longer fires the `inferenco://` deeplink in the
  pre-auth success branch. Nova Desk 0.6.0-rc.6+ auto-shows the approval
  sheet from the `POST /preauth-connect` queue — firing the deeplink
  triggers the browser's external-protocol handler dialog (Chrome on
  Linux) and is redundant. The dapp simply polls `GET /preauth-poll/<uuid>`
  and receives the session via JSON.

- `launchDesktopOrMobileConnect` (and the legacy `?redirect=...` deeplink)
  remains as the **fallback** path: when `startPreauthConnect` returns
  `null` (wallet not reachable, or pre-rc.6 wallet build), the adapter
  fires the legacy deeplink to launch the wallet via the OS handler.
  Cold-start scenarios still work; nothing changes for the user gesture
  of clicking Connect in the dapp.

### Deprecated

- `buildDesktopOrMobileConnectUrlWithRequest` is deprecated and will be
  removed in `0.4.0`. The function still works (emits a `console.warn`
  on each call); it remains exported for dapps that call it directly
  outside the pre-auth flow. The wallet-side approval is now driven by
  the pre-auth POST, not by the deeplink.

### Tests

108 → 112 (+4 new tests):
- `tests/bridge/preauth.test.ts`:
  - `buildDesktopOrMobileConnectUrlWithRequest emits a deprecation warning`
  - `NovaClient source does NOT assign window.location.href to a deeplink URL`
  - `NovaClient source does NOT call launchDesktopOrMobileConnect inside the preauth success branch`
  - `buildDesktopOrMobileConnectUrlWithRequest still produces the legacy URL shape for callers that need it`

### Migration

For dapps currently using `@inferenco/nova-wallet-adapter < 0.2.0-rc.10`:

- **Adapter 0.2.0-rc.10 + wallet 0.6.0-rc.6+ (primary path):** no code
  changes required. The dapp's `NovaClient.connect()` works against the
  new wallet without a deeplink firing.

- **Adapter 0.2.0-rc.10 + wallet < 0.6.0-rc.6:** `startPreauthConnect`
  returns `null` (pre-auth routes don't exist), and the adapter falls
  through to the legacy deeplink. Same behavior as rc.9.

- **Adapter < 0.2.0-rc.10 + wallet 0.6.0-rc.6+:** the adapter fires
  the legacy `?redirect=...` deeplink, which the wallet accepts on the
  fallback path. Same behavior as rc.3 from the user's perspective.
  Recommend upgrading to rc.10 for the no-new-tab UX.
