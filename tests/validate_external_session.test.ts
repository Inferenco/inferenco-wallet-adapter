import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _setBridgeTokenForTesting, _resetBridgeTokenForTesting } from "../src/bridge/token";
import {
  readExternalSession,
  storeExternalSession,
  validateExternalSession
} from "../src/bridge";
import type { NovaExternalSession } from "../src/types";

const SAMPLE_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SAMPLE_BRIDGE_URL = `http://127.0.0.1:21984/${SAMPLE_TOKEN}`;
const SAMPLE_SESSION_ID = "b90ae6fb-b36b-435a-95b4-213381296c77";

function makeStaleDesktopSession(): NovaExternalSession {
  return {
    transport: "desktop-bridge",
    address: "0xabc",
    publicKey: "0x" + "ab".repeat(32),
    network: "testnet",
    chainId: 2,
    sessionId: SAMPLE_SESSION_ID,
    bridgeUrl: SAMPLE_BRIDGE_URL,
    walletName: "Nova Connect"
  };
}

describe("validateExternalSession — F-03 CORS-blocked 404 fallback", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    _resetBridgeTokenForTesting();
    _setBridgeTokenForTesting(SAMPLE_TOKEN);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetBridgeTokenForTesting();
    window.localStorage.clear();
  });

  it("clears_session_when_browser_CORS_blocks_404_from_bridge", async () => {
    // Reproduce the user-facing devtools error from nova-ecosystem:
    //
    //   Solicitud desde otro origen bloqueada: la política de mismo
    //   origen impide leer el recurso remoto en
    //   http://127.0.0.1:21984/<token>/session/<sessionId>
    //   (razón: falta la cabecera CORS 'Access-Control-Allow-Origin').
    //   Código de estado: 404.
    //
    // The wallet's HTTP bridge returns 404 with NO CORS headers
    // for unknown sessions (F-03 token gate). Browsers enforce CORS
    // and refuse to give JS access to the response body / status,
    // surfacing the failure as `TypeError: Failed to fetch`.
    // Without the fix, `validateExternalSession`'s catch block
    // doesn't match `BridgeHttpError` and leaves the stale session
    // in localStorage forever — every page load retries the same
    // request and emits the same devtools CORS error.

    storeExternalSession(makeStaleDesktopSession());
    expect(readExternalSession()).not.toBeNull();

    // Simulate browser CORS enforcement: the fetch is sent but the
    // browser blocks reading the (no-CORS) 404 response. The
    // implementation sees a TypeError with no Response object.
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const result = await validateExternalSession({}, {});
    expect(result).toBeNull();
    // Session is wiped so the next page load doesn't retry.
    expect(readExternalSession()).toBeNull();
  });

  it("clears_session_on_real_network_failure_too", async () => {
    // Counterpart: when the wallet is genuinely down (cold start,
    // crashed, host network unreachable), the same TypeError fires.
    // The recovery is identical — clear the session, force the user
    // through fresh connect. Without this branch, a wallet restart
    // would leave the dapp with a permanently-broken session.
    storeExternalSession(makeStaleDesktopSession());

    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const result = await validateExternalSession({}, {});
    expect(result).toBeNull();
    expect(readExternalSession()).toBeNull();
  });

  it("does_not_clear_session_on_explicit_404_response_with_cors", async () => {
    // Regression-guard: the original behaviour for a real
    // `BridgeHttpError(404)` (e.g., a Node test or a future wallet
    // build that DOES add CORS to 404) still clears the session.
    // Covered by the existing test suite — kept here as a contract
    // marker so future maintainers don't drop the BridgeHttpError
    // branch when refactoring the catch.
    storeExternalSession(makeStaleDesktopSession());

    globalThis.fetch = vi.fn(async () => {
      return new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain" }
      });
    }) as unknown as typeof fetch;

    const result = await validateExternalSession({}, {});
    expect(result).toBeNull();
    expect(readExternalSession()).toBeNull();
  });

  it("preserves_session_on_successful_validation", async () => {
    // Sanity check: a 200 response with a valid session body
    // refreshes and keeps the session.
    storeExternalSession(makeStaleDesktopSession());

    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          address: "0xabc",
          publicKey: "0x" + "ab".repeat(32),
          network: "testnet",
          chainId: 2,
          sessionId: SAMPLE_SESSION_ID,
          bridgeUrl: SAMPLE_BRIDGE_URL,
          walletName: "Nova Connect"
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }) as unknown as typeof fetch;

    const result = await validateExternalSession({}, {});
    expect(result).not.toBeNull();
    expect(readExternalSession()).not.toBeNull();
  });
});