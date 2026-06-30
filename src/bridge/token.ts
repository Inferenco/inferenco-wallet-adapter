/**
 * Per-session URL token consumer.
 *
 * The wallet's HTTP bridge binds at `http://127.0.0.1:21984/<token>/<route>`.
 * The token is regenerated at every wallet startup and is delivered to the
 * dapp's JavaScript via two channels:
 *
 *   1. `window.postMessage({ type: "nova:bridge-token", token: "<64-hex>" })`
 *      — fires once at provider script injection when the dapp is loaded
 *      inside the wallet's embedded browser.
 *
 *   2. `bridgeToken` field in the `GET /<token>/connect` response body —
 *      the only channel available to an external browser (the wallet's
 *      postMessage cannot reach a regular Chrome tab).
 *
 * `readBridgeToken()` is a synchronous accessor over a Promise resolved at
 * module-init time. The first call kicks off the postMessage listener
 * registration; subsequent calls return the cached value once resolved
 * (or throw `MissingBridgeTokenError` if the 2 s timeout elapsed without
 * either delivery channel arriving).
 *
 * The token is **memory-only** — never written to localStorage,
 * sessionStorage, cookie, or IndexedDB. Persisting it would leak the
 * previous (now-stale) token across wallet restarts.
 */

import { BRIDGE_TOKEN_PATH_REGEX, MISSING_BRIDGE_TOKEN_MESSAGE } from "../constants.js";

export { BRIDGE_TOKEN_PATH_REGEX, MISSING_BRIDGE_TOKEN_MESSAGE };

export class MissingBridgeTokenError extends Error {
  constructor(message: string = MISSING_BRIDGE_TOKEN_MESSAGE) {
    super(message);
    this.name = "MissingBridgeTokenError";
    Object.setPrototypeOf(this, MissingBridgeTokenError.prototype);
  }
}

const RESOLVE_TIMEOUT_MS = 2000;
const POSTMESSAGE_TYPE = "nova:bridge-token";

interface BridgeTokenReady {
  resolve(value: string): void;
  reject(reason: Error): void;
  promise: Promise<string>;
}

let readyPromise: Promise<string> | null = null;
let resolvedToken: string | null = null;

function createReadyPromise(): BridgeTokenReady {
  let resolveOuter: (value: string) => void = () => {};
  let rejectOuter: (reason: Error) => void = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    resolveOuter = resolve;
    rejectOuter = reject;
  });
  return {
    resolve: resolveOuter,
    reject: rejectOuter,
    promise
  };
}

function extractTokenFromPathname(pathname: string): string | null {
  if (typeof pathname !== "string" || !pathname) return null;
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  const first = segments[0];
  return BRIDGE_TOKEN_PATH_REGEX.test(first) ? first : null;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.addEventListener === "function";
}

function installPostMessageListener(ready: BridgeTokenReady): void {
  if (typeof window === "undefined") return;

  const onMessage = (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if ((data as { type?: unknown }).type !== POSTMESSAGE_TYPE) return;
    const token = (data as { token?: unknown }).token;
    if (typeof token !== "string" || !BRIDGE_TOKEN_PATH_REGEX.test(token)) return;
    resolvedToken = token;
    window.removeEventListener("message", onMessage);
    ready.resolve(token);
  };

  window.addEventListener("message", onMessage);
  setTimeout(() => {
    if (resolvedToken !== null) return;
    // If the path-source already resolved the promise, the listener is
    // a no-op. Otherwise we reject on timeout.
    ready.reject(new MissingBridgeTokenError());
  }, RESOLVE_TIMEOUT_MS);
}

function resolveFromPathname(): string | null {
  if (typeof window === "undefined") return null;
  const token = extractTokenFromPathname(window.location?.pathname ?? "");
  if (token !== null) {
    resolvedToken = token;
  }
  return token;
}

/**
 * Returns the per-session URL token as a string. Throws
 * `MissingBridgeTokenError` if the token is not available within the
 * 2 s postMessage window and the pathname fallback did not match.
 *
 * Safe to call from any module. The first call kicks off the listener
 * registration; subsequent calls return the cached value once resolved.
 *
 * Note: this is the synchronous accessor. If you can await, prefer
 * `ensureBridgeToken()` which lets both delivery channels complete
 * before resolving. The sync variant is for URL constructors that
 * need a string at the moment of construction.
 */
export function readBridgeToken(): string {
  if (resolvedToken !== null) return resolvedToken;

  const pathToken = resolveFromPathname();
  if (pathToken !== null) return pathToken;

  if (!isBrowser()) {
    throw new MissingBridgeTokenError();
  }

  if (readyPromise === null) {
    const ready = createReadyPromise();
    readyPromise = ready.promise;
    installPostMessageListener(ready);
  }

  if (resolvedToken !== null) return resolvedToken;

  throw new MissingBridgeTokenError();
}

/**
 * Async accessor. Awaits the postMessage listener (or rejects on
 * timeout). Use this from connect/sign flows where you can await.
 *
 * Order of resolution:
 *   1. Cached token from a previous call.
 *   2. `window.location.pathname` first segment — used when the dapp
 *      is loaded inside Nova Desk's embedded browser.
 *   3. `window.postMessage({type:"nova:bridge-token", token})` — the
 *      wallet's embedded provider script posts this once at
 *      script-injection time.
 *
 * There is intentionally **no** HTTP discovery fallback. The wallet's
 * HTTP bridge is protected by the per-session URL token (F-03); the
 * token is the security boundary. External browsers (regular Chrome
 * tabs at e.g. `localhost:5173`) that do not share a window with the
 * wallet's webview cannot learn the token through this adapter and
 * must use the `inferenco://` deeplink flow instead — see
 * `launchDesktopOrMobileConnect` exported from `./bridge.js`.
 */
export async function ensureBridgeToken(): Promise<string> {
  if (resolvedToken !== null) return resolvedToken;
  if (!isBrowser()) {
    throw new MissingBridgeTokenError();
  }
  const pathToken = resolveFromPathname();
  if (pathToken !== null) return pathToken;
  if (readyPromise === null) {
    const ready = createReadyPromise();
    readyPromise = ready.promise;
    installPostMessageListener(ready);
  }
  return readyPromise;
}

/**
 * Test-only: reset the cached token. Used by the unit tests to simulate
 * token rotation mid-session. Not re-exported from the package index
 * (use the explicit `*_for_testing` imports inside the test suite).
 * @internal
 */
export function _resetBridgeTokenForTesting(): void {
  resolvedToken = null;
  readyPromise = null;
}

/**
 * Test-only: directly set the cached token. Used to verify the URL
 * constructor in the absence of a real postMessage delivery.
 * @internal
 */
export function _setBridgeTokenForTesting(token: string | null): void {
  if (token === null) {
    resolvedToken = null;
    return;
  }
  if (!BRIDGE_TOKEN_PATH_REGEX.test(token)) {
    throw new Error(`invalid test token: ${token}`);
  }
  resolvedToken = token;
}

/**
 * Force-refresh the token from the source. Clears the cache and
 * re-reads the pathname; if the pathname does not match the 64-hex
 * shape, re-arms the postMessage listener for a fresh attempt.
 *
 * Used by the B+ retry logic: a 404 from the wallet's HTTP bridge
 * most likely means the wallet was restarted and the token rotated.
 * The dapp must re-read on every retry attempt.
 */
export function forceRefreshBridgeToken(): string {
  resolvedToken = null;
  readyPromise = null;
  return readBridgeToken();
}
