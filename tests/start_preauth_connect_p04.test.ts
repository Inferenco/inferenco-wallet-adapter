import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _setBridgeTokenForTesting, _resetBridgeTokenForTesting } from "../src/bridge/token";
import { startPreauthConnect } from "../src/bridge";
import { InferAdapterError, InferErrorCode } from "../src/errors";

const SAMPLE_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SAMPLE_BRIDGE_URL = `http://127.0.0.1:21984/${SAMPLE_TOKEN}`;

describe("startPreauthConnect — P-04 (HTTPS connect reload, 0.2.0-rc.18)", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    _resetBridgeTokenForTesting();
    _setBridgeTokenForTesting(SAMPLE_TOKEN);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetBridgeTokenForTesting();
    window.localStorage.clear();
  });

  it("throws_typed_infer_adapter_error_with_bridge_private_network_blocked_on_typeerror", async () => {
    // P-04: when the fetch throws a TypeError (the canonical signal
    // for a browser-blocked cross-origin request — most commonly
    // Chrome ≥142's LNA/PNA enforcement from a public HTTPS origin
    // to the loopback bridge), startPreauthConnect throws a TYPED
    // InferAdapterError with code BRIDGE_PRIVATE_NETWORK_BLOCKED.
    //
    // This is a breaking change from rc.16/rc.17, which silently
    // returned null and let the caller fall through to the
    // deeplink-fallback re-navigation (the "page reload" UX bug).
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    let captured: unknown;
    try {
      await startPreauthConnect({
        origin: "https://app.example.com",
        app: "TestApp",
        options: { bridgeBaseUrl: SAMPLE_BRIDGE_URL }
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(InferAdapterError);
    const err = captured as InferAdapterError;
    expect(err.code).toBe(InferErrorCode.BridgePrivateNetworkBlocked);
    // The error message must be actionable (mention the LNA / local
    // network permission) so dApps can render a user-friendly fix.
    expect(err.message).toMatch(/PNA|LNA|local network|blocked/i);
    // The original TypeError must be preserved as the cause for
    // debugging.
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it("returns_null_on_non_typeerror_failure_to_preserve_legacy_deeplink_fallback", async () => {
    // Regression guard: connection refused / ECONNREFUSED throws
    // WITHOUT a TypeError (it's a plain Error with a different
    // message). The legacy "return null" semantics must be preserved
    // so existing dApps fall through to the deeplink fallback path.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:21984");
    }) as unknown as typeof fetch;

    const result = await startPreauthConnect({
      origin: "https://app.example.com",
      app: "TestApp",
      options: { bridgeBaseUrl: SAMPLE_BRIDGE_URL }
    });
    expect(result).toBeNull();
  });

  it("returns_null_on_http_500_response", async () => {
    // Regression guard: a 5xx bridge error (which becomes a
    // BridgeHttpError internally, NOT a TypeError) must still
    // return null. Only TypeError triggers the new typed error.
    globalThis.fetch = vi.fn(async () => {
      return new Response("Internal Server Error", {
        status: 500,
        headers: { "Content-Type": "text/plain" }
      });
    }) as unknown as typeof fetch;

    const result = await startPreauthConnect({
      origin: "https://app.example.com",
      app: "TestApp",
      options: { bridgeBaseUrl: SAMPLE_BRIDGE_URL }
    });
    expect(result).toBeNull();
  });

  it("returns_parsed_preauth_start_result_on_200", async () => {
    // Sanity check: the happy path still returns a parsed result
    // (P-04 does not change the success path).
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          requestId: "req-abc-123",
          pollUrl: "/preauth-poll/req-abc-123",
          bridgeUrl: "http://127.0.0.1:21984/" + SAMPLE_TOKEN
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }) as unknown as typeof fetch;

    const result = await startPreauthConnect({
      origin: "https://app.example.com",
      app: "TestApp",
      options: { bridgeBaseUrl: SAMPLE_BRIDGE_URL }
    });
    expect(result).not.toBeNull();
    expect(result?.requestId).toBe("req-abc-123");
    expect(result?.pollUrl).toBe("/preauth-poll/req-abc-123");
  });
});

describe("BRIDGE_PRIVATE_NETWORK_BLOCKED is exported from package entry", () => {
  it("is_exported_from_index", async () => {
    // The new error code must be reachable from the package entry
    // so dApps can `import { InferErrorCode, BRIDGE_PRIVATE_NETWORK_BLOCKED }`
    // (the latter via the enum value).
    const mod = await import("../src/index");
    expect(mod.InferErrorCode).toBeDefined();
    expect(mod.InferErrorCode.BridgePrivateNetworkBlocked).toBe(
      "BRIDGE_PRIVATE_NETWORK_BLOCKED"
    );
    expect(mod.InferAdapterError).toBeDefined();
  });
});
