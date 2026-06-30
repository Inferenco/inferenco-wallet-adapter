import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetBridgeTokenForTesting, _setBridgeTokenForTesting } from "../../src/bridge/token.js";
import { bridgePathWithToken, getBridgeBaseUrlWithToken } from "../../src/bridge/url.js";
import { DEFAULT_DESKTOP_BRIDGE_URL } from "../../src/constants.js";

const SAMPLE_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SAMPLE_TOKEN_2 = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

beforeEach(() => {
  _resetBridgeTokenForTesting();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { pathname: "/" }
  });
});

afterEach(() => {
  _resetBridgeTokenForTesting();
  vi.restoreAllMocks();
});

describe("bridge/url", () => {
  it("getBridgeBaseUrlWithToken_includes_token_prefix", () => {
    _setBridgeTokenForTesting(SAMPLE_TOKEN);
    const url = getBridgeBaseUrlWithToken();
    expect(url).toBe(`${DEFAULT_DESKTOP_BRIDGE_URL}/${SAMPLE_TOKEN}`);
  });

  it("getBridgeBaseUrlWithToken_uses_options_bridge_base_url", () => {
    _setBridgeTokenForTesting(SAMPLE_TOKEN);
    const customBase = "http://localhost:9999";
    const url = getBridgeBaseUrlWithToken({ bridgeBaseUrl: customBase });
    expect(url).toBe(`${customBase}/${SAMPLE_TOKEN}`);
  });

  it("getBridgeBaseUrlWithToken_propagates_to_session_poll_url", () => {
    _setBridgeTokenForTesting(SAMPLE_TOKEN);
    const sessionPath = bridgePathWithToken("/session/abc123");
    expect(sessionPath).toBe(`/${SAMPLE_TOKEN}/session/abc123`);
    const sessionUrl = new URL(sessionPath, DEFAULT_DESKTOP_BRIDGE_URL).toString();
    expect(sessionUrl).toBe(`${DEFAULT_DESKTOP_BRIDGE_URL}/${SAMPLE_TOKEN}/session/abc123`);
  });

  it("getBridgeBaseUrlWithToken_propagates_to_sign_request_url", () => {
    _setBridgeTokenForTesting(SAMPLE_TOKEN);
    const signPath = bridgePathWithToken("/sign-transaction");
    expect(signPath).toBe(`/${SAMPLE_TOKEN}/sign-transaction`);
    const signUrl = new URL(signPath, DEFAULT_DESKTOP_BRIDGE_URL).toString();
    expect(signUrl).toBe(`${DEFAULT_DESKTOP_BRIDGE_URL}/${SAMPLE_TOKEN}/sign-transaction`);
  });

  it("bridgePathWithToken_handles_route_without_leading_slash", () => {
    _setBridgeTokenForTesting(SAMPLE_TOKEN);
    expect(bridgePathWithToken("connect")).toBe(`/${SAMPLE_TOKEN}/connect`);
    expect(bridgePathWithToken("/sign-message")).toBe(`/${SAMPLE_TOKEN}/sign-message`);
  });

  it("back_compat_bridgeBaseUrl_returns_unprefixed_url", async () => {
    // The exported bridgeBaseUrl() helper is kept for back-compat with
    // external consumers; it returns the unprefixed host:port.
    const { bridgeBaseUrl } = await import("../../src/bridge.js");
    expect(bridgeBaseUrl()).toBe(DEFAULT_DESKTOP_BRIDGE_URL);
  });

  it("token_rotated_mid_session", () => {
    _setBridgeTokenForTesting(SAMPLE_TOKEN);
    const beforeRotation = bridgePathWithToken("/connect");
    expect(beforeRotation).toBe(`/${SAMPLE_TOKEN}/connect`);

    // Simulate wallet restart: pathname rewritten with the new token.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { pathname: `/${SAMPLE_TOKEN_2}/dapp` }
    });
    _resetBridgeTokenForTesting();

    const afterRotation = bridgePathWithToken("/connect");
    expect(afterRotation).toBe(`/${SAMPLE_TOKEN_2}/connect`);
  });

  it("throws_when_token_missing", () => {
    expect(() => getBridgeBaseUrlWithToken()).toThrow();
    expect(() => bridgePathWithToken("/connect")).toThrow();
  });

  it("every_url_constructor_call_re_reads_the_token", () => {
    // Snapshot the first URL with token A.
    _setBridgeTokenForTesting(SAMPLE_TOKEN);
    const urlA = new URL(bridgePathWithToken("/connect"), DEFAULT_DESKTOP_BRIDGE_URL).toString();
    expect(urlA).toContain(SAMPLE_TOKEN);

    // Rotate the token; the next URL construction uses token B without
    // requiring a new module load.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { pathname: `/${SAMPLE_TOKEN_2}/dapp` }
    });
    _resetBridgeTokenForTesting();

    const urlB = new URL(bridgePathWithToken("/connect"), DEFAULT_DESKTOP_BRIDGE_URL).toString();
    expect(urlB).toContain(SAMPLE_TOKEN_2);
    expect(urlA).not.toEqual(urlB);
  });

  it("bridgePathWithToken_falls_back_to_options_bridgeBaseUrl_token_when_module_scope_empty", async () => {
    // 0.2.0-rc.7: external browser scenario. The pathname/postMessage
    // delivery channels never fire; the token was delivered via the
    // wallet redirect's bridgeUrl. Reset module-scope state and confirm
    // the fallback extracts the token from options.bridgeBaseUrl.
    _resetBridgeTokenForTesting();
    const customBase = `http://127.0.0.1:21984/${SAMPLE_TOKEN}`;
    const path = bridgePathWithToken("/connect", { bridgeBaseUrl: customBase });
    expect(path).toBe(`/${SAMPLE_TOKEN}/connect`);
  });

  it("bridgePathWithToken_falls_back_to_default_bridge_url_token", () => {
    // 0.2.0-rc.7: when neither module-scope nor options.bridgeBaseUrl
    // carries a token, look for one in DEFAULT_DESKTOP_BRIDGE_URL.
    // (In practice this defaults to the bare host — no token. Test that
    // the function falls back to MissingBridgeTokenError cleanly.)
    _resetBridgeTokenForTesting();
    expect(() => bridgePathWithToken("/connect")).toThrow(
      /Nova Desk bridge token not available/
    );
  });

  it("extractBridgeTokenFromBaseUrl_recognises_token_segment", async () => {
    const { extractBridgeTokenFromBaseUrl } = await import("../../src/bridge/url.js");
    expect(extractBridgeTokenFromBaseUrl(`http://127.0.0.1:21984/${SAMPLE_TOKEN}`)).toBe(SAMPLE_TOKEN);
    expect(extractBridgeTokenFromBaseUrl(`http://127.0.0.1:21984/${SAMPLE_TOKEN}/foo`)).toBe(SAMPLE_TOKEN);
    expect(extractBridgeTokenFromBaseUrl("http://127.0.0.1:21984")).toBeNull();
    expect(extractBridgeTokenFromBaseUrl("not a url")).toBeNull();
    expect(extractBridgeTokenFromBaseUrl(null)).toBeNull();
    expect(extractBridgeTokenFromBaseUrl(undefined)).toBeNull();
  });
});
