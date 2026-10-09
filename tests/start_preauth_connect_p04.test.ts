import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _setBridgeTokenForTesting, _resetBridgeTokenForTesting } from "../src/bridge/token";
import { startPreauthConnect } from "../src/bridge";
import { InferAdapterError, InferErrorCode } from "../src/errors";

const SAMPLE_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SAMPLE_BRIDGE_URL = `http://127.0.0.1:21984/${SAMPLE_TOKEN}`;

/** v0.2.1-rc.1: the rejection shape produced by `fetchJsonWithTimeout`'s
 * AbortController when the browser holds the loopback fetch behind
 * Chrome >=142's Local Network Access prompt. It is a `DOMException`,
 * NOT a `TypeError` — the distinction is the whole point of the fix. */
function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function rateLimited(retryAfterMs: number): Response {
  return new Response(
    JSON.stringify({ error: "rate_limited", retryAfterMs }),
    { status: 429, headers: { "Content-Type": "application/json" } }
  );
}

function okStart(requestId: string): Response {
  return new Response(
    JSON.stringify({
      requestId,
      pollUrl: `/preauth-poll/${requestId}`,
      bridgeUrl: SAMPLE_BRIDGE_URL
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

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
    vi.useRealTimers();
    vi.restoreAllMocks();
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

/**
 * v0.2.1-rc.1 — first-time connect / no-new-tab.
 *
 * Regression: on a first-ever connect from a public HTTPS origin,
 * Chrome >=142's Local Network Access prompt holds the loopback fetch.
 * The 1200 ms `bridgeConnectTimeoutMs` liveness probe aborts it with a
 * `DOMException` named `AbortError` (NOT a `TypeError`), the old catch
 * collapsed that into `return null`, `InferClient.connect()` fell
 * through to `launchDesktopOrMobileConnect()`, and the WALLET
 * `xdg-open`'d a NEW TAB while the originating tab polled forever.
 *
 * The fix is a bounded retry loop around `POST /preauth-connect`.
 */
describe("startPreauthConnect — bounded retry (0.2.1-rc.1, first-time connect)", () => {
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries_abort_error_then_succeeds_without_falling_back_to_deeplink", async () => {
    // Two LNA stalls (AbortError) then a 200. Pre-fix the first
    // AbortError returned `null` and the caller fired the deeplink.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(abortError())
      .mockRejectedValueOnce(abortError())
      .mockResolvedValueOnce(okStart("req-retry-abc"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await startPreauthConnect({
      origin: "https://app.example.com",
      app: "TestApp",
      options: { bridgeBaseUrl: SAMPLE_BRIDGE_URL }
    });

    expect(result).not.toBeNull();
    expect(result?.requestId).toBe("req-retry-abc");
    expect(result?.pollUrl).toBe("/preauth-poll/req-retry-abc");
    // 2 rejected attempts + 1 successful attempt.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("honours_retry_after_ms_on_429_then_succeeds", async () => {
    // The wallet rate-limits `POST /preauth-connect` to 1 per origin
    // per 5 s and advertises `retryAfterMs` in the 429 body. An
    // immediate retry would 429 again, so the loop must WAIT.
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited(5000))
      .mockResolvedValueOnce(okStart("req-429-abc"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = startPreauthConnect({
      origin: "https://app.example.com",
      app: "TestApp",
      options: { bridgeBaseUrl: SAMPLE_BRIDGE_URL }
    });

    // Let the first attempt reject and the retry timer be scheduled.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Just short of retryAfterMs: the retry must NOT have fired.
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Crossing retryAfterMs: the retry fires.
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const result = await pending;
    expect(result?.requestId).toBe("req-429-abc");
  });

  it("returns_null_after_budget_exhausted_on_persistent_429", async () => {
    // Permanent rate limiting must degrade to `null` (the cold-start
    // deeplink fallback), NOT to an unbounded retry loop and NOT to a
    // thrown error.
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(rateLimited(5000));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = startPreauthConnect({
      origin: "https://app.example.com",
      app: "TestApp",
      options: {
        bridgeBaseUrl: SAMPLE_BRIDGE_URL,
        bridgePreauthStartTimeoutMs: 8000
      }
    });

    await vi.advanceTimersByTimeAsync(20000);
    expect(await pending).toBeNull();
    // 8 s budget / 5 s retryAfter → 2 attempts (t=0, t=5000); the third
    // would land at t=10000 which is past the deadline.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("typeerror_still_throws_bridge_private_network_blocked_with_zero_retries", async () => {
    // A `TypeError` is the user's explicit DENY of local-network
    // access — rc.18's actionable contract. Retrying it would bury the
    // error, so the loop must bail on the first attempt.
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let captured: unknown;
    try {
      await startPreauthConnect({
        origin: "https://app.example.com",
        app: "TestApp",
        options: {
          bridgeBaseUrl: SAMPLE_BRIDGE_URL,
          bridgePreauthStartTimeoutMs: 5000
        }
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(InferAdapterError);
    expect((captured as InferAdapterError).code).toBe(
      InferErrorCode.BridgePrivateNetworkBlocked
    );
    // ZERO retries — a single fetch attempt.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns_null_once_budget_exhausted_on_persistent_abort_error", async () => {
    // The user never answers the LNA prompt: the budget bounds the
    // loop and the legacy deeplink cold-start fallback is preserved.
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(abortError());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = startPreauthConnect({
      origin: "https://app.example.com",
      app: "TestApp",
      options: {
        bridgeBaseUrl: SAMPLE_BRIDGE_URL,
        bridgePreauthStartTimeoutMs: 2000
      }
    });

    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toBeNull();
    // 400 ms fixed backoff → roughly 5 attempts inside a 2 s budget.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetchMock.mock.calls.length).toBeLessThan(10);
  });

  it("per_attempt_timeout_is_far_above_the_1200ms_connect_probe", async () => {
    // The per-attempt ceiling must NOT be `bridgeConnectTimeoutMs`
    // (1200 ms) — that is the liveness probe, and it is what aborted
    // the LNA-held fetch in the first place.
    const delays: number[] = [];
    const originalSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      delay?: number,
      ...rest: unknown[]
    ) => {
      if (typeof delay === "number") delays.push(delay);
      return (originalSetTimeout as (...args: unknown[]) => number)(
        handler,
        delay,
        ...rest
      );
    }) as unknown as typeof window.setTimeout);

    const fetchMock = vi.fn().mockResolvedValue(okStart("req-timeout-abc"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await startPreauthConnect({
      origin: "https://app.example.com",
      app: "TestApp",
      options: { bridgeBaseUrl: SAMPLE_BRIDGE_URL }
    });

    expect(result?.requestId).toBe("req-timeout-abc");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The abort timer scheduled by `fetchJsonWithTimeout` is the
    // largest delay observed (the 400 ms retry backoff is the only
    // other one, and this happy path makes no retry).
    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeGreaterThanOrEqual(3000);
    expect(delays).not.toContain(1200);
  });

  it("403_and_404_are_non_retryable_and_return_null_immediately", async () => {
    // Genuine unavailability / origin mismatch must NOT burn the
    // whole budget — one attempt, then `null`.
    for (const status of [403, 404]) {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response("nope", { status })
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await startPreauthConnect({
        origin: "https://app.example.com",
        app: "TestApp",
        options: {
          bridgeBaseUrl: SAMPLE_BRIDGE_URL,
          bridgePreauthStartTimeoutMs: 5000
        }
      });

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
});
