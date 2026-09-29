import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tryLocalBridgeSignAndSubmit, tryLocalBridgeSignMessage, tryLocalBridgeSignTransaction } from "../../src/bridge";
import { _resetBridgeTokenForTesting } from "../../src/bridge/token";
import type { InferExternalSession } from "../../src/types";

// Per-session URL token fixture — 64 hex chars matches `BRIDGE_TOKEN_PATH_REGEX`.
const SAMPLE_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SAMPLE_BRIDGE_URL_HOST = "http://127.0.0.1:21984";
const SAMPLE_BRIDGE_URL_WITH_TOKEN = `${SAMPLE_BRIDGE_URL_HOST}/${SAMPLE_TOKEN}`;

function fixtureSession(bridgeUrl: string | undefined): InferExternalSession {
  return {
    transport: "desktop-bridge",
    address: "0xabc",
    publicKey: "0xdef",
    network: "testnet",
    chainId: 2,
    sessionId: "sess-token-graft-rc23",
    bridgeUrl,
    walletName: "Infer Connect"
  };
}

/**
 * Capture-URL mock. Returns a 200 with a requestId for POST (start),
 * and a 200 with `rejected` status for GET (poll). The poll's
 * rejected status propagates as UserRejected — fine for these
 * URL-only tests, since we assert on the captured POST URL
 * regardless of the eventual sign result.
 */
function captureMock() {
  const urls: string[] = [];
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") {
      return new Response(JSON.stringify({ requestId: "req-rc23-capture" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (method === "GET") {
      // Reject the poll — clean signal that we don't care about the
      // sign payload; we only want the POST URL.
      return new Response(
        JSON.stringify({
          status: "rejected",
          requestId: "req-rc23-capture",
          error: "user_cancelled"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error(`unexpected fetch method: ${method} ${url}`);
  });
  return { fetchSpy, urls };
}

describe("sign-path token graft — 0.2.0-rc.23 (rc.22 regression closed)", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Reset the bridge token so the test exercises the
    // bridgePathWithToken fallback (extract-from-base) path. This
    // mirrors the production case where the dapp is in an external
    // browser and the wallet's postMessage delivery channel never
    // fires — the only token source is `session.bridgeUrl`.
    _resetBridgeTokenForTesting();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetBridgeTokenForTesting();
    window.localStorage.clear();
  });

  it("tryLocalBridgeSignMessage_grafts_session_token_onto_bare_bridgeBaseUrl", async () => {
    // RC.22 regression: f6da44d flipped the precedence to
    // `options.bridgeBaseUrl ?? session.bridgeUrl`, which silently
    // dropped the per-session URL token when the dApp passes a
    // bare base (the production infer-ecosystem case). With the
    // rc.23 graft (`sessionBridgeBaseUrl(session, options)`), the
    // token from `session.bridgeUrl` is adopted as a path segment
    // on the dApp's trusted host.
    const { fetchSpy, urls } = captureMock();
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    await expect(
      tryLocalBridgeSignMessage(
        { message: "hello" } as never,
        fixtureSession(SAMPLE_BRIDGE_URL_WITH_TOKEN),
        { bridgeBaseUrl: SAMPLE_BRIDGE_URL_HOST }
      )
    ).rejects.toBeDefined(); // poll rejected; URL is what we care about

    const startUrl = urls.find((u) => u.endsWith("/sign-message"));
    expect(startUrl).toBe(`${SAMPLE_BRIDGE_URL_HOST}/${SAMPLE_TOKEN}/sign-message`);
    // Token is grafted onto the dApp's trusted host, not the
    // attacker's host (ND-WEB-001 preserved).
    expect(startUrl).not.toContain("attacker.example");
  });

  it("tryLocalBridgeSignTransaction_grafts_session_token_onto_bare_bridgeBaseUrl", async () => {
    const { fetchSpy, urls } = captureMock();
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    await expect(
      tryLocalBridgeSignTransaction(
        { rawTransactionBcsHex: "0x00" } as never,
        fixtureSession(SAMPLE_BRIDGE_URL_WITH_TOKEN),
        { bridgeBaseUrl: SAMPLE_BRIDGE_URL_HOST }
      )
    ).rejects.toBeDefined();

    const startUrl = urls.find((u) => u.endsWith("/sign-transaction"));
    expect(startUrl).toBe(`${SAMPLE_BRIDGE_URL_HOST}/${SAMPLE_TOKEN}/sign-transaction`);
    expect(startUrl).not.toContain("attacker.example");
  });

  it("tryLocalBridgeSignAndSubmit_grafts_session_token_onto_bare_bridgeBaseUrl", async () => {
    const { fetchSpy, urls } = captureMock();
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    await expect(
      tryLocalBridgeSignAndSubmit(
        {} as never,
        fixtureSession(SAMPLE_BRIDGE_URL_WITH_TOKEN),
        { bridgeBaseUrl: SAMPLE_BRIDGE_URL_HOST }
      )
    ).rejects.toBeDefined();

    const startUrl = urls.find((u) => u.endsWith("/transaction"));
    expect(startUrl).toBe(`${SAMPLE_BRIDGE_URL_HOST}/${SAMPLE_TOKEN}/transaction`);
    expect(startUrl).not.toContain("attacker.example");
  });

  it("does_not_double_graft_when_options_bridgeBaseUrl_already_has_token", async () => {
    // Regression-guard: when the dApp already passes a token in
    // `options.bridgeBaseUrl` (older Infer Desk builds that
    // exposed the URL on `preauth.bridgeUrl`), the rc.17 no-double
    // rule must still hold — no `/<token>/<token>/` path doubling.
    const token2 = "fedcba9876543210".repeat(4);
    const preTokenisedBase = `${SAMPLE_BRIDGE_URL_HOST}/${token2}`;
    const { fetchSpy, urls } = captureMock();
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    await expect(
      tryLocalBridgeSignMessage(
        { message: "hello" } as never,
        fixtureSession(SAMPLE_BRIDGE_URL_WITH_TOKEN),
        { bridgeBaseUrl: preTokenisedBase }
      )
    ).rejects.toBeDefined();

    const startUrl = urls.find((u) => u.endsWith("/sign-message")) ?? "";
    // token2 from options.bridgeBaseUrl, no SAMPLE_TOKEN prefix.
    expect(startUrl).toBe(`${SAMPLE_BRIDGE_URL_HOST}/${token2}/sign-message`);
    expect(startUrl).not.toContain(`/${SAMPLE_TOKEN}/`);
  });

  it("host_mismatch_session_keeps_dapp_host_only_token_segment_adopted_ND_WEB_001", async () => {
    // ND-WEB-001 invariant preserved: an attacker who controls
    // session.bridgeUrl (callback substitution) can inject a
    // forged token SEGMENT onto the dApp's trusted host — the
    // request goes to the dApp's server, where it 404s. No signed
    // messages leak to a hostile host.
    const { fetchSpy, urls } = captureMock();
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    await expect(
      tryLocalBridgeSignMessage(
        { message: "hello" } as never,
        fixtureSession(`https://attacker.example/${SAMPLE_TOKEN}`),
        { bridgeBaseUrl: SAMPLE_BRIDGE_URL_HOST }
      )
    ).rejects.toBeDefined();

    const startUrl = urls.find((u) => u.endsWith("/sign-message")) ?? "";
    expect(startUrl).not.toContain("attacker.example");
    expect(startUrl.startsWith(`${SAMPLE_BRIDGE_URL_HOST}/`)).toBe(true);
    // The forged token segment is grafted onto the dApp host —
    // the wallet's F-03 token gate will 404 it, no data leaks.
    expect(startUrl).toBe(`${SAMPLE_BRIDGE_URL_HOST}/${SAMPLE_TOKEN}/sign-message`);
  });

  it("falls_through_to_bare_host_when_session_has_no_token", async () => {
    // Mobile-relay sessions / older Infer Desk builds that omit
    // the per-session token: the graft helper must not invent a
    // token. The bare host is used (and the request fails at the
    // wallet's F-03 gate as expected for this transport) — what
    // we assert here is that the URL ends up at the bare host,
    // and that a MissingBridgeTokenError is raised (because no
    // token source exists), confirming the rc.22 fallback path.
    const { fetchSpy, urls } = captureMock();
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    let captured: unknown;
    try {
      await tryLocalBridgeSignMessage(
        { message: "hello" } as never,
        fixtureSession(SAMPLE_BRIDGE_URL_HOST), // no token in session
        { bridgeBaseUrl: SAMPLE_BRIDGE_URL_HOST }
      );
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeDefined();
    // Outer error is `unresolvedRequestError` ("Wallet request
    // creation may have reached Infer Desk; reconcile before
    // retrying") which wraps the underlying MissingBridgeTokenError
    // in `.cause`. Walking the chain verifies the rc.22 fallback
    // path: bare host + no token source = MissingBridgeTokenError.
    let cause: unknown = (captured as { cause?: unknown }).cause;
    let found = false;
    while (cause) {
      if (
        cause instanceof Error &&
        /bridge token not available/i.test(cause.message)
      ) {
        found = true;
        break;
      }
      cause = (cause as { cause?: unknown }).cause;
    }
    expect(found).toBe(true);

    // No fetch should have been made (the path builder throws
    // before any URL is constructed for the wire).
    expect(urls.length).toBe(0);
  });
});
