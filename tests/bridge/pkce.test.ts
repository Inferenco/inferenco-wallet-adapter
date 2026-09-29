import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PkceVerificationFailed,
  appendCodeChallengeToDeeplink,
  exchangeCodeForSession,
  generatePkcePair
} from "../../src/bridge/pkce.js";
import {
  _resetBridgeTokenForTesting,
  _setBridgeTokenForTesting
} from "../../src/bridge/token.js";
import {
  buildDesktopOrMobileConnectUrl
} from "../../src/bridge.js";

const SAMPLE_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(() => {
  _resetBridgeTokenForTesting();
  _setBridgeTokenForTesting(SAMPLE_TOKEN);
  // jsdom defaults to a non-mobile UA.
  Object.defineProperty(window, "navigator", {
    configurable: true,
    value: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/120" }
  });
  if (typeof globalThis.fetch === "function") {
    vi.restoreAllMocks();
  }
});

afterEach(() => {
  _resetBridgeTokenForTesting();
  vi.restoreAllMocks();
});

describe("PKCE pair generation", () => {
  it("generates_64_char_hex_code_verifier_and_43_char_base64url_challenge", async () => {
    const pair = await generatePkcePair();
    expect(pair.codeVerifier).toMatch(/^[0-9a-f]{64}$/);
    // SHA-256 of 32 bytes is 32 bytes; base64url of 32 bytes is 43 chars
    // (no padding).
    expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("challenge_is_url_safe_base64_no_padding", async () => {
    const pair = await generatePkcePair();
    expect(pair.codeChallenge).not.toMatch(/=+$/);
    expect(pair.codeChallenge).not.toMatch(/[+/]/);
  });

  it("challenge_is_SHA256_of_code_verifier", async () => {
    const pair = await generatePkcePair();
    // Verify SHA-256 inline.
    const bytes = new TextEncoder().encode(pair.codeVerifier);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(pair.codeChallenge).toBe(expected);
  });
});

describe("appendCodeChallengeToDeeplink", () => {
  it("appends_to_url_with_existing_query_params", () => {
    const url = appendCodeChallengeToDeeplink(
      "inferenco://login?redirect=https%3A%2F%2Fdapp.example%2Fcb&app=Dapp",
      "E9Melhoa2OwvFrEMTJguCHaumKETi2E9Xnz9Sd6V8SE"
    );
    expect(url).toBe(
      "inferenco://login?redirect=https%3A%2F%2Fdapp.example%2Fcb&app=Dapp&code_challenge=E9Melhoa2OwvFrEMTJguCHaumKETi2E9Xnz9Sd6V8SE"
    );
  });

  it("returns_input_unchanged_when_url_is_empty", () => {
    expect(appendCodeChallengeToDeeplink("", "challenge")).toBe("");
  });
});

describe("buildDesktopOrMobileConnectUrl with codeChallenge", () => {
  it("appends_code_challenge_when_set_in_options", () => {
    const url = buildDesktopOrMobileConnectUrl(
      { codeChallenge: "E9Melhoa2OwvFrEMTJguCHaumKETi2E9Xnz9Sd6V8SE" } as any,
      "https://dapp.example/cb"
    );
    expect(url).toContain("code_challenge=E9Melhoa2OwvFrEMTJguCHaumKETi2E9Xnz9Sd6V8SE");
    expect(url).toContain("redirect=https%3A%2F%2Fdapp.example%2Fcb");
  });

  it("does_not_append_when_code_challenge_absent", () => {
    const url = buildDesktopOrMobileConnectUrl({}, "https://dapp.example/cb");
    expect(url).not.toContain("code_challenge");
  });
});

describe("exchangeCodeForSession", () => {
  it("posts_to_bridgeUrlWithToken_exchange_route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          address: "0xabc",
          publicKey: "0xpub",
          network: "testnet",
          chainId: 2,
          sessionId: "session-1"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const code =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const codeVerifier =
      "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    const session = await exchangeCodeForSession({ code, codeVerifier });

    expect(session.address).toBe("0xabc");
    expect(session.sessionId).toBe("session-1");
    expect(session.transport).toBe("desktop-bridge");

    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toContain("/exchange");
    expect(String(calledUrl)).toContain(SAMPLE_TOKEN);
    expect(calledInit.method).toBe("POST");
    const body = JSON.parse(calledInit.body);
    expect(body.code).toBe(code);
    expect(body.code_verifier).toBe(codeVerifier);
  });

  it("rejects_when_token_missing", async () => {
    _resetBridgeTokenForTesting();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { pathname: "/" }
    });
    // The sync readBridgeToken() will throw because no postMessage
    // and no pathname match; the helper surfaces a PkceVerificationFailed
    // with a clear message.
    await expect(
      exchangeCodeForSession({
        code: "a".repeat(32),
        codeVerifier: "b".repeat(64)
      })
    ).rejects.toThrow(PkceVerificationFailed);
  });

  it("rejects_when_wallet_returns_400", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("bad verifier", { status: 400 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      exchangeCodeForSession({
        code: "a".repeat(32),
        codeVerifier: "b".repeat(64)
      })
    ).rejects.toThrow(PkceVerificationFailed);
  });

  it("rejects_malformed_code_at_sync_boundary", async () => {
    await expect(
      exchangeCodeForSession({ code: "too short", codeVerifier: "b".repeat(64) })
    ).rejects.toThrow(PkceVerificationFailed);
  });

  it("rejects_malformed_code_verifier_at_sync_boundary", async () => {
    await expect(
      exchangeCodeForSession({ code: "a".repeat(32), codeVerifier: "bad" })
    ).rejects.toThrow(PkceVerificationFailed);
  });
});
