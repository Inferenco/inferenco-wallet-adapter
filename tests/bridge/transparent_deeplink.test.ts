import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetBridgeTokenForTesting,
  _setBridgeTokenForTesting
} from "../../src/bridge/token.js";
import {
  consumeExternalCallbackIfPresent,
  readExternalSession
} from "../../src/bridge.js";
import { PKCE_VERIFIER_STORAGE_KEY } from "../../src/constants.js";

const SAMPLE_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SAMPLE_TOKEN_2 = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

beforeEach(() => {
  _resetBridgeTokenForTesting();
  _setBridgeTokenForTesting(SAMPLE_TOKEN);
  // jsdom's default `location` does not have a writable `href`.
  // Define a full `Location`-like value so `new URL(window.location.href)`
  // and `window.history.replaceState` work as expected.
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      href: "https://dapp.example/callback",
      origin: "https://dapp.example",
      pathname: "/callback",
      search: "",
      hash: "",
      protocol: "https:",
      host: "dapp.example",
      hostname: "dapp.example",
      port: ""
    }
  });
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  _resetBridgeTokenForTesting();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("consumeExternalCallbackIfPresent", () => {
  it("no_op_when_url_has_no_callback_params", async () => {
    const before = readExternalSession();
    await consumeExternalCallbackIfPresent();
    const after = readExternalSession();
    expect(after).toBe(before);
    expect(window.location.search).toBe("");
  });

  it("consumes_legacy_callback_address_param_into_localStorage", async () => {
    // Simulate Nova Desk's legacy callback URL after approval.
    const callbackUrl = new URL("https://dapp.example/callback");
    callbackUrl.searchParams.set("address", "0xabc");
    callbackUrl.searchParams.set("publicKey", "0xpub");
    callbackUrl.searchParams.set("network", "testnet");
    callbackUrl.searchParams.set("chainId", "2");
    callbackUrl.searchParams.set("sessionId", "session-1");
    callbackUrl.searchParams.set("bridgeUrl", "http://127.0.0.1:21984/abc");
    callbackUrl.searchParams.set("walletName", "Infer Connect");
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        href: callbackUrl.toString(),
        origin: "https://dapp.example",
        pathname: "/callback",
        search: callbackUrl.search,
        hash: "",
        protocol: "https:",
        host: "dapp.example",
        hostname: "dapp.example",
        port: ""
      }
    });

    await consumeExternalCallbackIfPresent();

    const stored = readExternalSession();
    expect(stored).not.toBeNull();
    expect(stored?.address).toBe("0xabc");
    expect(stored?.sessionId).toBe("session-1");
  });

  it("consumes_pkce_callback_code_param_into_localStorage", async () => {
    const verifier =
      "0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff";
    window.sessionStorage.setItem(PKCE_VERIFIER_STORAGE_KEY, verifier);

    // Simulate the PKCE callback URL.
    const callbackUrl = new URL("https://dapp.example/callback");
    callbackUrl.searchParams.set("code", "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        href: callbackUrl.toString(),
        origin: "https://dapp.example",
        pathname: "/callback",
        search: callbackUrl.search,
        hash: "",
        protocol: "https:",
        host: "dapp.example",
        hostname: "dapp.example",
        port: ""
      }
    });

    // Mock the wallet's /exchange endpoint to return a valid session.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          address: "0xabc",
          publicKey: "0xpub",
          network: "testnet",
          chainId: 2,
          sessionId: "session-1",
          walletName: "Infer Connect"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await consumeExternalCallbackIfPresent();

    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/exchange");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.code).toBe("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");
    expect(body.code_verifier).toBe(verifier);
  });

  it("tolerates_malformed_url_without_throwing", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { href: undefined, origin: "https://dapp.example" }
    });

    // 0.2.0-rc.7: returns false (no consumption) instead of throwing;
    // the resume flow falls through to the localStorage read.
    await expect(consumeExternalCallbackIfPresent()).resolves.toBe(false);
  });

  it("prefers_pkce_over_legacy_when_both_are_present", async () => {
    // If both code and address are present (shouldn't happen in
    // practice), the PKCE path wins. The legacy path requires
    // multiple params; the PKCE path needs only the verifier.
    const verifier =
      "0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff";
    window.sessionStorage.setItem(PKCE_VERIFIER_STORAGE_KEY, verifier);

    const callbackUrl = new URL("https://dapp.example/callback");
    callbackUrl.searchParams.set("code", "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");
    callbackUrl.searchParams.set("address", "0xabc");
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        href: callbackUrl.toString(),
        origin: "https://dapp.example",
        pathname: "/callback",
        search: callbackUrl.search,
        hash: "",
        protocol: "https:",
        host: "dapp.example",
        hostname: "dapp.example",
        port: ""
      }
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 400 })
    );
    await consumeExternalCallbackIfPresent();
    // PKCE path was taken — fetch was called (even though the
    // mock returns 400, the URL contains /exchange).
    expect(fetchSpy).toHaveBeenCalled();
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/exchange");
  });

  it("consumes_callback_with_legacy_nova_callback_params", async () => {
    // v0.3.0 (rebrand): a pre-rebrand Infer Desk build sends the legacy
    // callback URL params `novaRequestId`/`novaStatus` instead of
    // `inferRequestId`/`inferStatus`. The dual-read logic must accept
    // the legacy names during the transition window so a dapp that
    // was approved in a pre-rebuild session still resumes.
    const callbackUrl = new URL("https://dapp.example/callback");
    callbackUrl.searchParams.set("address", "0xabc");
    callbackUrl.searchParams.set("publicKey", "0xpub");
    callbackUrl.searchParams.set("network", "testnet");
    callbackUrl.searchParams.set("chainId", "2");
    callbackUrl.searchParams.set("sessionId", "session-legacy-1");
    callbackUrl.searchParams.set("bridgeUrl", "http://127.0.0.1:21984/abc");
    callbackUrl.searchParams.set("walletName", "Infer Connect");
    callbackUrl.searchParams.set("novaRequestId", "legacy-req-id");
    callbackUrl.searchParams.set("novaStatus", "approved");
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        href: callbackUrl.toString(),
        origin: "https://dapp.example",
        pathname: "/callback",
        search: callbackUrl.search,
        hash: "",
        protocol: "https:",
        host: "dapp.example",
        hostname: "dapp.example",
        port: ""
      }
    });

    await consumeExternalCallbackIfPresent();

    const stored = readExternalSession();
    expect(stored).not.toBeNull();
    expect(stored?.address).toBe("0xabc");
    expect(stored?.sessionId).toBe("session-legacy-1");
  });

  it("prefers_canonical_inferRequestId_when_both_legacy_and_canonical_are_present", async () => {
    // v0.3.0 (rebrand): when both legacy and canonical params are present
    // (caller retained a stale redirect for some reason), the canonical
    // rebrand param wins. This keeps behaviour deterministic when a dapp
    // upgrade races a browser-cached redirect.
    const callbackUrl = new URL("https://dapp.example/callback");
    callbackUrl.searchParams.set("address", "0xabc");
    callbackUrl.searchParams.set("publicKey", "0xpub");
    callbackUrl.searchParams.set("network", "testnet");
    callbackUrl.searchParams.set("chainId", "2");
    callbackUrl.searchParams.set("sessionId", "session-both-1");
    callbackUrl.searchParams.set("bridgeUrl", "http://127.0.0.1:21984/abc");
    callbackUrl.searchParams.set("walletName", "Infer Connect");
    callbackUrl.searchParams.set("novaRequestId", "legacy-id");
    callbackUrl.searchParams.set("novaStatus", "approved");
    callbackUrl.searchParams.set("inferRequestId", "canonical-id");
    callbackUrl.searchParams.set("inferStatus", "approved");
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        href: callbackUrl.toString(),
        origin: "https://dapp.example",
        pathname: "/callback",
        search: callbackUrl.search,
        hash: "",
        protocol: "https:",
        host: "dapp.example",
        hostname: "dapp.example",
        port: ""
      }
    });

    await consumeExternalCallbackIfPresent();

    const stored = readExternalSession();
    expect(stored).not.toBeNull();
    expect(stored?.sessionId).toBe("session-both-1");
  });
});

describe("tryLocalBridgeConnect fallback on MissingBridgeTokenError", () => {
  it("returns_null_when_readBridgeToken_throws_MissingBridgeTokenError", async () => {
    // 0.2.0-rc.5 regression: tryLocalBridgeConnect used to throw
    // MissingBridgeTokenError synchronously when bridgePathWithToken
    // was constructed without a token. The dapp in an external
    // browser was stuck on the error. Now the function catches
    // the synchronous throw and returns null, so the dapp's
    // connect flow can fall through to the deeplink.
    const { tryLocalBridgeConnect } = await import("../../src/bridge.js");
    _resetBridgeTokenForTesting();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        href: "https://dapp.example/",
        origin: "https://dapp.example",
        pathname: "/"
      }
    });

    // The function must not throw; it returns null because the
    // bridge is unreachable without a token.
    const result = await tryLocalBridgeConnect();
    expect(result).toBeNull();
  });
});
