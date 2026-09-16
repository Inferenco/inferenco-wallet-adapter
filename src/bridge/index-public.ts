/**
 * Public re-exports of the bridge-token module. The test-only
 * `_resetBridgeTokenForTesting` and `_setBridgeTokenForTesting`
 * helpers are deliberately excluded from the package surface.
 */
export {
  BRIDGE_TOKEN_PATH_REGEX,
  MISSING_BRIDGE_TOKEN_MESSAGE,
  MissingBridgeTokenError,
  ensureBridgeToken,
  forceRefreshBridgeToken,
  readBridgeToken
} from "./token.js";

export { getBridgeBaseUrlWithToken, bridgePathWithToken, bridgeUrlWithToken } from "./url.js";

/**
 * A3 (deeplink hardening, PKCE): public re-exports for the PKCE
 * helper. The dapp calls `generatePkcePair()` once per connect
 * attempt, stores the `codeVerifier` in `sessionStorage`, passes
 * the `codeChallenge` to `launchDesktopOrMobileConnect`, and on the
 * callback invokes `storeCallbackSessionViaPkce({ codeVerifier })`
 * (or `exchangeCodeForSession` directly).
 */
export {
  PkceVerificationFailed,
  appendCodeChallengeToDeeplink,
  exchangeCodeForSession,
  generatePkcePair
} from "./pkce.js";

export type { PkcePair } from "./pkce.js";
