import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _setBridgeTokenForTesting, _resetBridgeTokenForTesting } from "../src/bridge/token";
import {
  readExternalSession,
  storeExternalSession,
  validateExternalSession
} from "../src/bridge";
import {
  INFER_EXTERNAL_SESSION_STORAGE_KEY,
  LEGACY_NOVA_EXTERNAL_SESSION_STORAGE_KEY
} from "../src/constants";
import type { InferExternalSession } from "../src/types";
import { InferAdapterError, InferErrorCode } from "../src/errors";

const SAMPLE_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SAMPLE_BRIDGE_URL = `http://127.0.0.1:21984/${SAMPLE_TOKEN}`;
const SAMPLE_SESSION_ID = "b90ae6fb-b36b-435a-95b4-213381296c77";

function makeStaleDesktopSession(): InferExternalSession {
  return {
    transport: "desktop-bridge",
    address: "0xabc",
    publicKey: "0x" + "ab".repeat(32),
    network: "testnet",
    chainId: 2,
    sessionId: SAMPLE_SESSION_ID,
    bridgeUrl: SAMPLE_BRIDGE_URL,
    walletName: "Infer Connect"
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
    //
    // P-04 (0.2.0-rc.18): a TypeError on validateExternalSession now
    // does NOT clear the session — it falls back to
    // `readExternalSession()` so the dApp can still get a usable
    // session for direct bridge calls. The trade-off is documented
    // in the catch block comment.

    const session = makeStaleDesktopSession();
    storeExternalSession(session);
    expect(readExternalSession()).not.toBeNull();

    // Simulate browser CORS enforcement: the fetch is sent but the
    // browser blocks reading the (no-CORS) 404 response. The
    // implementation sees a TypeError with no Response object.
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const result = await validateExternalSession(session, {});
    // TypeError is now SOFT — return whatever localStorage has
    // (the session we just stored). This is the P-04 fix: the dApp
    // can decide what to do with a possibly-stale session rather
    // than being forced through fresh connect on every transient
    // network blip / CORS block.
    expect(result).not.toBeNull();
    expect(result?.sessionId).toBe(SAMPLE_SESSION_ID);
    // Session is preserved (NOT wiped).
    expect(readExternalSession()).not.toBeNull();
  });

  it("preserves_session_on_real_network_failure_too", async () => {
    // Counterpart: when the wallet is genuinely down (cold start,
    // crashed, host network unreachable), the same TypeError fires.
    // P-04: TypeError is now a SOFT failure — preserve the session
    // so the next sign call can retry (and surface the real error
    // if the wallet is still down).
    storeExternalSession(makeStaleDesktopSession());

    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const result = await validateExternalSession(makeStaleDesktopSession(), {});
    // P-04: return whatever localStorage has; session preserved.
    expect(result).not.toBeNull();
    expect(readExternalSession()).not.toBeNull();
  });

  it("does_not_clear_session_on_explicit_404_response_with_cors", async () => {
    // Regression-guard: a real `BridgeHttpError(404)` (e.g., a Node
    // test or a future wallet build that DOES add CORS to 404) STILL
    // clears the session because the wallet explicitly told us the
    // session is dead.
    storeExternalSession(makeStaleDesktopSession());

    globalThis.fetch = vi.fn(async () => {
      return new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain" }
      });
    }) as unknown as typeof fetch;

    const result = await validateExternalSession(makeStaleDesktopSession(), {});
    expect(result).toBeNull();
    expect(readExternalSession()).toBeNull();
  });

  it("preserves_session_on_typeerror_and_returns_localstorage", async () => {
    // P-04 explicit pin: a TypeError on validateExternalSession
    // MUST NOT call `clearExternalSession()` (that would silently
    // force a fresh connect). Instead, the catch branch calls
    // `readExternalSession()` and returns the cached session
    // directly.
    const session = makeStaleDesktopSession();
    storeExternalSession(session);

    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("NetworkError when attempting to fetch resource.");
    }) as unknown as typeof fetch;

    const result = await validateExternalSession(session, {});
    expect(result).not.toBeNull();
    expect(result?.sessionId).toBe(SAMPLE_SESSION_ID);
    // The session is preserved on disk.
    expect(readExternalSession()).not.toBeNull();
  });

  it("returns_null_on_typeerror_when_no_session_is_stored", async () => {
    // Edge case: TypeError fired during validateExternalSession but
    // no session is stored in localStorage. `readExternalSession()`
    // returns null and that's what the function returns.
    window.localStorage.clear();

    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const result = await validateExternalSession(makeStaleDesktopSession(), {});
    expect(result).toBeNull();
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
          walletName: "Infer Connect"
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }) as unknown as typeof fetch;

    const result = await validateExternalSession(makeStaleDesktopSession(), {});
    expect(result).not.toBeNull();
    expect(readExternalSession()).not.toBeNull();
  });

  // v0.3.0 (rebrand): dual-read storage keys. A previously-installed
  // 0.2.0-rc.x dapp stored its session under `inferenco:nova-session`;
  // the new adapter must find that legacy session, migrate it to
  // `inferenco:infer-session`, and clear the legacy key — all without
  // a re-connect prompt.
  it("dual_read_migrates_session_from_legacy_inferenco_nova_session_key", () => {
    const legacy = makeStaleDesktopSession();
    window.localStorage.setItem(
      LEGACY_NOVA_EXTERNAL_SESSION_STORAGE_KEY,
      JSON.stringify(legacy)
    );

    const migrated = readExternalSession();

    expect(migrated).not.toBeNull();
    expect(migrated?.sessionId).toBe(SAMPLE_SESSION_ID);
    // After a successful read-and-migrate, the legacy key should be
    // cleared and the primary key populated.
    expect(window.localStorage.getItem(LEGACY_NOVA_EXTERNAL_SESSION_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(INFER_EXTERNAL_SESSION_STORAGE_KEY)).not.toBeNull();
  });

  it("dual_read_returns_null_when_neither_storage_key_is_set", () => {
    window.localStorage.clear();
    expect(readExternalSession()).toBeNull();
  });
});