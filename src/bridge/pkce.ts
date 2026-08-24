/**
 * PKCE (RFC 7636) for the `inferenco://` deeplink flow.
 *
 * The dapp generates a `code_verifier` (random 32 bytes, hex) and a
 * `code_challenge` (SHA-256 of the verifier, base64url, no padding).
 * The dapp passes `code_challenge` in the deeplink URL. After the
 * wallet shows the approval sheet and the user approves, the wallet
 * generates a fresh `code` and includes it in the callback URL. The
 * dapp then POSTs `{ code, code_verifier }` to the wallet's
 * `/exchange` endpoint; the wallet verifies `SHA-256(code_verifier) ==
 * code_challenge` and returns the session.
 *
 * This is the deeplink-equivalent of the OAuth 2.0 PKCE pattern. It
 * defends against:
 *   - **Scheme hijack**: if an attacker registers a competing
 *     `inferenco://` handler and captures the deeplink, they cannot
 *     complete the exchange because they do not have the
 *     `code_verifier` (which never leaves the dapp's tab).
 *   - **URL replay**: the `code` is single-use on the wallet side;
 *     a captured callback URL is useless after the first exchange.
 *   - **Open redirect chain**: the dapp controls the verifier; an
 *     attacker who substitutes the redirect URL still cannot derive
 *     a valid `code` from the wallet.
 */

import { BRIDGE_TOKEN_PATH_REGEX, MISSING_BRIDGE_TOKEN_MESSAGE, MissingBridgeTokenError } from "./token.js";
import { bridgeUrlWithToken } from "./url.js";
import type { InferWalletOptions } from "../types.js";

const PKCE_CODE_VERIFIER_BYTES = 32;

export class PkceVerificationFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PkceVerificationFailed";
    Object.setPrototypeOf(this, PkceVerificationFailed.prototype);
  }
}

export interface PkcePair {
  /**
   * 32 random bytes, hex-encoded (64 chars). The dapp keeps this
   * secret until the callback arrives.
   */
  codeVerifier: string;
  /**
   * `SHA-256(code_verifier)`, base64url-encoded, no padding. The
   * dapp passes this in the deeplink URL.
   */
  codeChallenge: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  // btoa is available in both browser and (since Node 16) node.
  const b64 = typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(input: string): Promise<Uint8Array> {
  if (typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined") {
    const bytes = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return new Uint8Array(digest);
  }
  // Node fallback (older runtimes).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = await import("node:crypto");
  return new Uint8Array(nodeCrypto.createHash("sha256").update(input).digest());
}

/**
 * Generate a PKCE pair. The dapp should call this exactly once per
 * connect attempt. The `code_verifier` is kept in module-scope or
 * component state; the `code_challenge` is sent in the deeplink URL.
 */
export async function generatePkcePair(): Promise<PkcePair> {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new PkceVerificationFailed("crypto.getRandomValues is not available in this environment");
  }
  const bytes = new Uint8Array(PKCE_CODE_VERIFIER_BYTES);
  crypto.getRandomValues(bytes);
  const codeVerifier = Array.from(bytes, (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  const challengeBytes = await sha256(codeVerifier);
  const codeChallenge = toBase64Url(challengeBytes);
  return { codeVerifier, codeChallenge };
}

/**
 * Append `code_challenge` to a `inferenco://` deeplink URL built by
 * `buildDesktopOrMobileConnectUrl`. The wallet reads this on launch
 * and stores it as the challenge for the connect request.
 */
export function appendCodeChallengeToDeeplink(
  deeplinkUrl: string,
  codeChallenge: string
): string {
  if (typeof deeplinkUrl !== "string" || deeplinkUrl.length === 0) {
    return deeplinkUrl;
  }
  // The deeplink URL already has `?redirect=...&app=...` (and
  // optionally `?origin=...`); append the new param without a
  // leading `&` separator.
  const separator = deeplinkUrl.includes("?") ? "&" : "?";
  return `${deeplinkUrl}${separator}code_challenge=${encodeURIComponent(codeChallenge)}`;
}

interface ExchangeBody {
  code: string;
  code_verifier: string;
}

interface ExchangeResponse {
  address: string;
  publicKey: string;
  network: string;
  chainId: number;
  sessionId: string;
  bridgeUrl?: string;
  walletName?: string;
}

const EXCHANGE_TIMEOUT_MS = 5000;

/**
 * POST `{ code, code_verifier }` to the wallet's `/exchange` endpoint
 * and return the parsed session. The wallet verifies the PKCE
 * challenge; on success it removes the pending code (one-time use)
 * and returns the session bound to the (origin, address, network)
 * tuple.
 *
 * The error surface:
 *   - `MissingBridgeTokenError` if the per-session URL token is not
 *     available (caller should `await ensureBridgeToken()` first).
 *   - `PkceVerificationFailed` if the wallet returns 400 (bad code,
 *     bad verifier, expired, etc.).
 */
export async function exchangeCodeForSession(input: {
  code: string;
  codeVerifier: string;
  options?: InferWalletOptions;
}): Promise<{
  address: string;
  publicKey: string;
  network: string;
  chainId: number;
  sessionId: string;
  bridgeUrl?: string;
  walletName?: string;
  transport: "desktop-bridge" | "mobile-relay";
}> {
  if (typeof input.code !== "string" || !/^[0-9a-f]{16,128}$/i.test(input.code)) {
    throw new PkceVerificationFailed("code must be a hex string between 16 and 128 chars");
  }
  if (typeof input.codeVerifier !== "string" || !/^[0-9a-f]{64,256}$/i.test(input.codeVerifier)) {
    throw new PkceVerificationFailed(
      "code_verifier must be a hex string between 64 and 256 chars"
    );
  }

  // The token must be available before we can build a token-prefixed
  // URL. If the caller hasn't awaited `ensureBridgeToken()`, surface
  // a clear error rather than a silent 404.
  try {
    // Read the token synchronously. If the postMessage listener is
    // still pending, the sync accessor throws — the caller should
    // have awaited `ensureBridgeToken()` first.
    // (We import lazily to avoid a circular dependency between
    // url.ts and token.ts at module init.)
    const { readBridgeToken } = await import("./token.js");
    readBridgeToken();
  } catch (error) {
    if (error instanceof MissingBridgeTokenError) {
      throw new PkceVerificationFailed(
        "Bridge token not available. Call await ensureBridgeToken() before exchangeCodeForSession(). " +
          MISSING_BRIDGE_TOKEN_MESSAGE
      );
    }
    throw error;
  }

  const url = bridgeUrlWithToken("/exchange", input.options);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        code: input.code,
        code_verifier: input.codeVerifier
      } satisfies ExchangeBody),
      signal: controller.signal,
      credentials: "omit"
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new PkceVerificationFailed(
        `Wallet rejected PKCE exchange (HTTP ${response.status}): ${text || "(no body)"}`
      );
    }
    const body = (await response.json()) as ExchangeResponse;
    if (typeof body.address !== "string") {
      throw new PkceVerificationFailed("Wallet response missing address");
    }
    // Verify the token shape on the returned session.
    if (body.walletName && body.walletName !== "Infer Connect" && body.walletName !== "Infer Desk" && body.walletName !== "Nova Desk") {
      throw new PkceVerificationFailed(
        `Unexpected walletName in exchange response: ${body.walletName}`
      );
    }
    return {
      ...body,
      // If the wallet didn't include bridgeUrl, leave it undefined;
      // sessionBridgeBaseUrl falls back to options.bridgeBaseUrl.
      transport: "desktop-bridge" as const
    };
  } finally {
    clearTimeout(timeout);
  }
}

// Mark the unused-token-shape import as used to keep the export
// surface stable.
void BRIDGE_TOKEN_PATH_REGEX;
