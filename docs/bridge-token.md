# Bridge token

Infer Desk's HTTP bridge is the channel external dapps use to request connect / sign-message / sign-transaction / sign-and-submit operations. The bridge binds at:

```
http://127.0.0.1:21984/<token>/<route>
```

where `<token>` is a 32-byte hex string (64 lowercase hex chars) generated at every wallet startup via `getrandom::getrandom`. Requests to unprefixed paths receive `404` with **no CORS headers**, so cross-origin scripts cannot probe whether the wallet is running.

This document describes the consumer contract that this adapter implements.

## Delivery channels

The wallet delivers the token to the dapp's JavaScript via one of two channels:

### 1. `window.postMessage` (embedded browser)

When the dapp is loaded inside Infer Desk's embedded browser, the wallet injects a provider script that calls:

```js
window.postMessage(
  { type: "infer:bridge-token", token: "<64-hex>" },
  window.location.origin || "*"
);
```

once at script-injection time. The adapter registers a same-origin `message` listener and resolves its internal promise on the first matching message.

> **v0.3.0 (rebrand):** The canonical postMessage type is now `"infer:bridge-token"`. For one release cycle the adapter also accepts the legacy type `"nova:bridge-token"` so older Infer Desk builds (pre-rebrand) continue to function during the transition window. Dual-listen will be removed in 0.4.0.

### 2. `bridgeToken` field in the `/connect` response (external browser)

When the dapp is a regular browser tab (e.g. Chrome, Firefox) outside the wallet's webview, postMessage cannot cross the process boundary. The wallet instead returns the current token in the connect response body:

```json
{
  "status": "pending",
  "requestId": "...",
  "bridgeToken": "<64-hex>"
}
```

The adapter reads this field, stores it in module-scope memory, and uses it for all subsequent bridge calls.

## Adapter behavior

- The token is read **once at module init**, then cached.
- Every URL construction (`bridgeUrlWithToken`, `bridgePathWithToken`, `getBridgeBaseUrlWithToken`) re-reads the cached token. On a 404 response from the wallet, the adapter force-refreshes the token and retries **once** (B+ behavior) before falling back to the clear-session reconnect path.
- The token is **memory-only** — never written to `localStorage`, `sessionStorage`, `cookie`, or `IndexedDB`. Persisting it would leak the previous (now-stale) token across wallet restarts.
- A dapp that is opened outside Infer Desk fails fast with `MissingBridgeTokenError` after a 2 s timeout, with the message:

  > "Infer Desk bridge token not available. Open this dapp via Infer Desk."

## Exported helpers

| Export | Type | Purpose |
|---|---|---|
| `readBridgeToken()` | `string` | Synchronous accessor. Throws `MissingBridgeTokenError` if no token is available. |
| `ensureBridgeToken()` | `Promise<string>` | Async accessor. Awaits the postMessage listener (or rejects on 2 s timeout). |
| `bridgePathWithToken(route, options?)` | `string` | Returns `/<token><route>`. |
| `bridgeUrlWithToken(route, options?)` | `string` | Returns a fully-qualified URL with the token in the path. **Use this for every bridge call.** |
| `getBridgeBaseUrlWithToken(options?)` | `string` | Returns `host:port/<token>` for callers that need a base. |
| `MissingBridgeTokenError` | class | Typed error thrown when the token is not available. |
| `MISSING_BRIDGE_TOKEN_MESSAGE` | `string` | The canonical user-facing error message. |
| `BRIDGE_TOKEN_PATH_REGEX` | `RegExp` | `/^[0-9a-f]{64}$/`. The 64-hex shape. |

## Migration from 0.1.x

**No code change required for typical consumers.** The adapter wires the token automatically; existing dapp code works unchanged.

Dapps on `0.1.x` against a Phase-2 wallet (introduced in commit `870dcbc` of `Inferenco/infer_desk`) see `404` on every call. Upgrade to `0.2.0-rc.2` or later before testing against a Phase-2 wallet build.

Dapps that imported `bridgeBaseUrl()` directly still get the unprefixed host:port (back-compat for advanced consumers) — internal callers are rewritten to use `bridgeUrlWithToken()`.

## Why a token and not just an allowlist

- The token is a per-process secret. It is regenerated at every wallet startup, so a leaked token is invalidated by the next wallet restart.
- The token is delivered in the URL path, which is visible in devtools network tabs. This is acceptable because the security boundary is "only processes running on the user's local machine can listen on `127.0.0.1:21984`". A network attacker cannot reach the bridge from outside the machine.
- Cross-origin scripts (e.g. a phishing site loaded in a different tab) cannot probe the bridge for the presence of the token — the wallet's 404 response carries no CORS headers.
