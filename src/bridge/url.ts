import { DEFAULT_DESKTOP_BRIDGE_URL } from "../constants.js";
import type { NovaWalletOptions } from "../types.js";
import { readBridgeToken } from "./token.js";

/**
 * Returns the bridge base URL with the per-session URL token in the
 * path. The wallet's HTTP bridge binds at
 *
 *   http://127.0.0.1:21984/<token>/<route>
 *
 * and rejects unprefixed requests with 404 (no CORS). The token is
 * process-local to the wallet and is re-read on every call, so a
 * retry 5 s into a session uses the **current** token.
 *
 * IMPORTANT: do NOT pass this to `new URL(path, base)` with a leading
 * slash on `path` — `new URL("/connect", "http://.../<token>")` would
 * strip the token (the absolute path replaces the base path). Use
 * `bridgePathWithToken` below for the URL construction, or pass a
 * relative path. Internal callers in this package use the
 * `bridgePathWithToken` helper to avoid the pitfall.
 */
export function getBridgeBaseUrlWithToken(options: NovaWalletOptions = {}): string {
  const base = options.bridgeBaseUrl ?? DEFAULT_DESKTOP_BRIDGE_URL;
  return `${base}/${readBridgeToken()}`;
}

/**
 * Returns a token-prefixed path suitable for use as the first argument
 * to `new URL(...)` (or as a bare path in a fetch call). The returned
 * string starts with `/<token>` and concatenates `route` if non-empty.
 *
 * Use this everywhere the adapter previously did
 * `new URL("/connect", bridgeBaseUrl(options))`. The old form landed
 * the request on the unprefixed route, which the wallet rejects.
 */
export function bridgePathWithToken(
  route: string,
  options: NovaWalletOptions = {}
): string {
  const token = readBridgeToken();
  const trimmed = route.startsWith("/") ? route : `/${route}`;
  return `/${token}${trimmed}`;
}

/**
 * Returns a fully-qualified URL with the per-session token in the
 * path. Re-reads the token on every call, so a retry 5 s into a
 * session uses the **current** token (not a snapshot).
 *
 * This is the canonical URL constructor for every bridge call.
 */
export function bridgeUrlWithToken(
  route: string,
  options: NovaWalletOptions = {}
): string {
  const path = bridgePathWithToken(route, options);
  const base = options.bridgeBaseUrl ?? DEFAULT_DESKTOP_BRIDGE_URL;
  return new URL(path, base).toString();
}
