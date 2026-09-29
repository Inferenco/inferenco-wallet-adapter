import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BRIDGE_TOKEN_PATH_REGEX,
  MissingBridgeTokenError,
  _resetBridgeTokenForTesting,
  _setBridgeTokenForTesting,
  ensureBridgeToken,
  readBridgeToken
} from "../../src/bridge/token.js";

const SAMPLE_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(() => {
  _resetBridgeTokenForTesting();
  // Reset window.location.pathname to a known state for each test.
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { pathname: "/" }
  });
});

afterEach(() => {
  _resetBridgeTokenForTesting();
});

describe("bridge/token", () => {
  it("rejects_when_no_source", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { pathname: "/" }
    });

    expect(() => readBridgeToken()).toThrow(MissingBridgeTokenError);

    await expect(ensureBridgeToken()).rejects.toBeInstanceOf(MissingBridgeTokenError);
  });

  it("does_not_emit_unhandled_rejection_when_read_arms_listener", async () => {
    // Regression: `readBridgeToken()` arms the postMessage listener and
    // creates a module-level `readyPromise` that rejects at +2 s. The
    // synchronous throw is caught at every call site, but the
    // orphaned Promise would previously escape as an unhandled
    // rejection logged to devtools as
    //   `Uncaught (in promise) MissingBridgeTokenError`
    // — confusing dapp devs and tripping Sentry-style monitors.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { pathname: "/" }
    });

    // Capture BOTH the window-level event (used by browser devtools)
    // AND any process-level unhandled rejection (used by Node/Vitest).
    // Either channel is sufficient to detect the regression.
    const seen: Error[] = [];
    const onWindowUnhandled = (event: PromiseRejectionEvent) => {
      if (event.reason instanceof Error) seen.push(event.reason);
    };
    const onProcessUnhandled = (reason: unknown) => {
      if (reason instanceof Error) seen.push(reason);
    };
    window.addEventListener("unhandledrejection", onWindowUnhandled);
    process.on("unhandledRejection", onProcessUnhandled);

    try {
      expect(() => readBridgeToken()).toThrow(MissingBridgeTokenError);
      // Wait past the 2 s timeout to give the orphan timer a chance
      // to fire. If the suppression fallback is missing, `seen` will
      // contain a `MissingBridgeTokenError` and the test fails.
      await new Promise((resolve) => setTimeout(resolve, 2400));
      expect(seen).toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", onWindowUnhandled);
      process.off("unhandledRejection", onProcessUnhandled);
    }
  });

  it("ensure_bridge_token_still_sees_rejection_after_suppression", async () => {
    // Counterpart: legitimate `ensureBridgeToken()` consumers must
    // still observe the `MissingBridgeTokenError` rejection. The
    // fallback catch only suppresses the unhandled-rejection event;
    // it does not consume the rejection for awaiting callers.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { pathname: "/" }
    });

    await expect(ensureBridgeToken()).rejects.toBeInstanceOf(MissingBridgeTokenError);
  });

  it("extracts_from_pathname", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { pathname: `/${SAMPLE_TOKEN}/some/dapp/path` }
    });

    expect(readBridgeToken()).toBe(SAMPLE_TOKEN);
  });

  it("ignores_pathname_segments_that_are_not_64_hex", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { pathname: "/not-a-token/some/dapp" }
    });

    expect(() => readBridgeToken()).toThrow(MissingBridgeTokenError);
  });

  it("extracts_from_postMessage", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { pathname: "/" }
    });

    const tokenPromise = ensureBridgeToken();
    // Dispatch the postMessage that the rebranded Infer Desk provider script posts.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "infer:bridge-token", token: SAMPLE_TOKEN }
      })
    );

    await expect(tokenPromise).resolves.toBe(SAMPLE_TOKEN);
    // Cached: subsequent synchronous calls return the same token.
    expect(readBridgeToken()).toBe(SAMPLE_TOKEN);
  });

  // v0.3.0 (rebrand): the listener accepts the canonical rebrand postMessage
  // type (`infer:bridge-token`, shipped by Infer Desk v0.6.0+) and the legacy
  // type (`nova:bridge-token`, shipped by pre-rebrand Infer Desk builds)
  // during the transition window. Remove this test in 0.4.0.
  it("dual_listen_accepts_legacy_nova_bridge_token_postMessage", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { pathname: "/" }
    });

    const tokenPromise = ensureBridgeToken();
    // A pre-rebrand Infer Desk build (or older "Nova Desk" build) posts the
    // legacy type — must still be recognised.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "nova:bridge-token", token: SAMPLE_TOKEN }
      })
    );

    await expect(tokenPromise).resolves.toBe(SAMPLE_TOKEN);
    expect(readBridgeToken()).toBe(SAMPLE_TOKEN);
  });

  it("ignores_postmessages_with_wrong_type", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { pathname: "/" }
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "something-else", token: SAMPLE_TOKEN }
      })
    );

    expect(() => readBridgeToken()).toThrow(MissingBridgeTokenError);
  });

  it("ignores_postmessages_with_invalid_token", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { pathname: "/" }
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "infer:bridge-token", token: "not-a-valid-token" }
      })
    );

    expect(() => readBridgeToken()).toThrow(MissingBridgeTokenError);
  });

  it("forward_token_on_retry", () => {
    // Initial: no token.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { pathname: "/" }
    });

    expect(() => readBridgeToken()).toThrow(MissingBridgeTokenError);

    // Token becomes available via pathname (simulating wallet rotation
    // mid-session — pathname is rewritten on every page load).
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { pathname: `/${SAMPLE_TOKEN}/dapp` }
    });
    _resetBridgeTokenForTesting();

    expect(readBridgeToken()).toBe(SAMPLE_TOKEN);
  });

  it("no_token_in_logs", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { pathname: "/" }
    });

    try {
      readBridgeToken();
    } catch {
      // expected
    }

    for (const call of [
      ...consoleSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls
    ]) {
      for (const arg of call) {
        const text = String(arg);
        expect(text).not.toContain(SAMPLE_TOKEN);
      }
    }

    consoleSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("no_persistence", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const cookieSpy = vi.spyOn(document, "cookie", "set");

    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { pathname: `/${SAMPLE_TOKEN}/dapp` }
    });

    // Trigger all known persistence paths.
    try {
      readBridgeToken();
      ensureBridgeToken();
    } catch {
      // ignore
    }

    for (const call of setItemSpy.mock.calls) {
      expect(String(call[0] ?? "")).not.toContain(SAMPLE_TOKEN);
      expect(String(call[1] ?? "")).not.toContain(SAMPLE_TOKEN);
    }
    for (const call of cookieSpy.mock.calls) {
      expect(String(call)).not.toContain(SAMPLE_TOKEN);
    }

    setItemSpy.mockRestore();
    cookieSpy.mockRestore();
  });

  it("pathname_regex_accepts_only_64_lowercase_hex", () => {
    expect(BRIDGE_TOKEN_PATH_REGEX.test(SAMPLE_TOKEN)).toBe(true);
    expect(BRIDGE_TOKEN_PATH_REGEX.test(SAMPLE_TOKEN.toUpperCase())).toBe(false);
    expect(BRIDGE_TOKEN_PATH_REGEX.test("a".repeat(63))).toBe(false);
    expect(BRIDGE_TOKEN_PATH_REGEX.test("a".repeat(65))).toBe(false);
    expect(BRIDGE_TOKEN_PATH_REGEX.test("")).toBe(false);
    expect(BRIDGE_TOKEN_PATH_REGEX.test("g".repeat(64))).toBe(false);
  });

  it("set_bridge_token_for_testing_rejects_invalid_token", () => {
    expect(() => _setBridgeTokenForTesting("not-hex")).toThrow();
  });

  it("set_bridge_token_for_testing_round_trips", () => {
    _setBridgeTokenForTesting(SAMPLE_TOKEN);
    expect(readBridgeToken()).toBe(SAMPLE_TOKEN);
    _setBridgeTokenForTesting(null);
    expect(() => readBridgeToken()).toThrow(MissingBridgeTokenError);
  });
});
