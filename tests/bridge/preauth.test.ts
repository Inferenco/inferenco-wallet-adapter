import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bridge from "../../src/bridge";
import {
  buildDesktopOrMobileConnectUrlWithRequest,
  pollPreauthConnect,
  startPreauthConnect
} from "../../src/bridge";
import { _resetBridgeTokenForTesting } from "../../src/bridge/token";
import { InferClient } from "../../src/InferClient";

describe("bridge pre-auth flow (no-new-tab)", () => {
  beforeEach(() => {
    _resetBridgeTokenForTesting();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    _resetBridgeTokenForTesting();
  });

  it("startPreauthConnect posts to /preauth-connect and parses requestId", async () => {
    // ND-WEB-001 (audit-08): Nova Desk no longer returns
    // `bridgeUrl` in the preauth start response (the global
    // token must never leak to a dapp before approval). The
    // adapter parses `requestId` + `pollUrl` and falls back
    // to its configured `bridgeBaseUrl` for sign operations.
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        requestId: "00000000-0000-0000-0000-000000000001",
        pollUrl: "/preauth-poll/00000000000000000000000000000001",
        status: "pending",
      }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fakeFetch);

    const result = await startPreauthConnect({
      origin: "https://app.example.com",
      app: "MyDapp",
    });

    expect(result).not.toBeNull();
    expect(result?.requestId).toBe("00000000-0000-0000-0000-000000000001");
    expect(result?.pollUrl).toBe("/preauth-poll/00000000000000000000000000000001");
    // The field is absent on modern Nova Desk builds. Direct
    // API consumers must rely on their configured
    // `bridgeBaseUrl` for sign operations.
    expect(result?.bridgeUrl).toBeUndefined();
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:21984/preauth-connect");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    expect(body.origin).toBe("https://app.example.com");
    expect(body.app).toBe("MyDapp");
  });

  it("startPreauthConnect preserves bridgeUrl when present (older wallet)", async () => {
    // Backwards-compat: pre-ND-WEB-001 wallet builds still
    // include `bridgeUrl` in the response. The adapter must
    // parse it verbatim — production code does not depend on
    // the value (session.bridgeUrl from the approval response
    // is advisory), but direct API consumers might.
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        requestId: "00000000-0000-0000-0000-000000000002",
        pollUrl: "/preauth-poll/00000000000000000000000000000002",
        bridgeUrl: "http://127.0.0.1:21984/abc123token",
        status: "pending",
      }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fakeFetch);

    const result = await startPreauthConnect({
      origin: "https://app.example.com",
      app: "MyDapp",
    });

    expect(result).not.toBeNull();
    expect(result?.bridgeUrl).toBe("http://127.0.0.1:21984/abc123token");
  });

  it("startPreauthConnect returns null when the bridge is unreachable", async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", fakeFetch);
    const result = await startPreauthConnect({
      origin: "https://app.example.com",
      app: "MyDapp",
    });
    expect(result).toBeNull();
  });

  it("pollPreauthConnect returns pending status while waiting", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "pending", requestId: "x" }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fakeFetch);
    const result = await pollPreauthConnect({
      requestId: "00000000-0000-0000-0000-000000000001",
    });
    expect(result).not.toBeNull();
    expect(result?.status).toBe("pending");
  });

  it("pollPreauthConnect returns the session on approval", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: "approved",
        requestId: "00000000-0000-0000-0000-000000000001",
        address: "0xabc",
        publicKey: "0xdef",
        network: "testnet",
        chainId: 2,
        sessionId: "s1",
        bridgeUrl: "http://127.0.0.1:21984/<token>",
        walletName: "Nova Desk",
      }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fakeFetch);
    const result = await pollPreauthConnect({
      requestId: "00000000-0000-0000-0000-000000000001",
    });
    expect(result?.status).toBe("approved");
    expect(result?.session?.address).toBe("0xabc");
    expect(result?.session?.sessionId).toBe("s1");
  });

  it("pollPreauthConnect returns rejected status on user reject", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: "rejected",
        requestId: "00000000-0000-0000-0000-000000000001",
        error: "user_cancelled",
      }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fakeFetch);
    const result = await pollPreauthConnect({
      requestId: "00000000-0000-0000-0000-000000000001",
    });
    expect(result?.status).toBe("rejected");
    expect(result?.error).toBe("user_cancelled");
  });

  it("pollPreauthConnect treats 404 as a rejected request_not_found", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "request_not_found" }),
      text: async () => '{"error":"request_not_found"}',
    });
    vi.stubGlobal("fetch", fakeFetch);
    const result = await pollPreauthConnect({
      requestId: "00000000-0000-0000-0000-000000000001",
    });
    expect(result?.status).toBe("rejected");
    expect(result?.error).toBe("request_not_found");
  });

  it("buildDesktopOrMobileConnectUrlWithRequest emits inferenco:// with request param", () => {
    const url = buildDesktopOrMobileConnectUrlWithRequest(
      "00000000-0000-0000-0000-000000000001",
      "MyDapp",
    );
    expect(url).toContain("inferenco://login?");
    expect(url).toContain("request=00000000-0000-0000-0000-000000000001");
    expect(url).toContain("app=MyDapp");
    expect(url).not.toContain("redirect=");
  });

  it("startPreauthConnect strips the bridge token from the base URL", async () => {
    // Verify the dapp can configure a token-prefixed bridge URL
    // (e.g., from a previous-session cached value) and the
    // pre-auth path still works against the unprefixed route.
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        requestId: "00000000-0000-0000-0000-000000000001",
        pollUrl: "/preauth-poll/00000000000000000000000000000001",
        status: "pending",
      }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fakeFetch);
    const result = await startPreauthConnect({
      origin: "https://app.example.com",
      app: "MyDapp",
      options: {
        bridgeBaseUrl: "http://127.0.0.1:21984/abcdefabcdefabcdefabcdefabcdefabcdef",
      },
    });
    expect(result).not.toBeNull();
    const [url] = fakeFetch.mock.calls[0];
    // Token must be stripped — pre-auth is unauthenticated.
    expect(url).toBe("http://127.0.0.1:21984/preauth-connect");
  });
});

// v0.2.0-rc.10 (no-deeplink primary path): the dapp's
// InferClient.connect() must NOT set `window.location.href` to an
// `inferenco://` URL when the pre-auth POST succeeds. The wallet
// auto-shows the approval sheet from the bridge queue, so firing
// the deeplink triggers Chrome's external-protocol handler dialog.
describe("connect() does not fire deeplink when preauth succeeds", () => {
  it("buildDesktopOrMobileConnectUrlWithRequest emits a deprecation warning", () => {
    const warn = vi.fn();
    const originalWarn = console.warn;
    console.warn = warn;
    try {
      const url = buildDesktopOrMobileConnectUrlWithRequest(
        "00000000-0000-0000-0000-000000000001",
        "Ecosystem dApp",
      );
      expect(url).toBe(
        "inferenco://login?request=00000000-0000-0000-0000-000000000001&app=Ecosystem+dApp",
      );
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = warn.mock.calls[0][0] as string;
      expect(msg).toContain("buildDesktopOrMobileConnectUrlWithRequest is deprecated");
      expect(msg).toContain("0.2.0-rc.10");
    } finally {
      console.warn = originalWarn;
    }
  });

  it("InferClient source does NOT assign window.location.href to a deeplink URL", () => {
    // Document the v0.2.0-rc.10 contract via static analysis: a
    // successful `startPreauthConnect` means the wallet is
    // running. Firing an `inferenco://` deeplink after that point
    // triggers the browser's external-protocol handler dialog
    // (Chrome on Linux) and is forbidden.
    //
    // We allow the deeplink URL to be CONSTRUCTED (the deprecated
    // `buildDesktopOrMobileConnectUrlWithRequest` helper), but
    // not assigned to `window.location.href`.
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "../../src/InferClient.ts"),
      "utf8",
    );
    const lines = src.split("\n");
    for (const line of lines) {
      if (
        line.includes("window.location.href") &&
        line.includes("buildDesktopOrMobileConnectUrlWithRequest")
      ) {
        throw new Error(
          "InferClient.connect() must not assign window.location.href to a buildDesktopOrMobileConnectUrlWithRequest result: " +
            line,
        );
      }
    }
  });

  it("InferClient source does NOT call launchDesktopOrMobileConnect inside the preauth success branch", () => {
    // v0.2.0-rc.10: the deeplink fallback (`launchDesktopOrMobileConnect`)
    // fires only when `startPreauthConnect` returns null (wallet
    // not reachable). Inside the success branch (between
    // `if (preauth) {` and the matching `}`) the deeplink must
    // NOT fire.
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "../../src/InferClient.ts"),
      "utf8",
    );
    // Slice the success branch: between `if (preauth) {` and the
    // next `}` at the same indentation.
    const startMarker = "if (preauth) {";
    const startIdx = src.indexOf(startMarker);
    if (startIdx === -1) {
      throw new Error("could not find `if (preauth) {` block");
    }
    // Find the matching close: search forward for a line that is
    // exactly the close brace at the same indent level as the
    // `if`.
    const before = src.slice(0, startIdx);
    const startLine = before.split("\n").length - 1;
    const startIndent = src.split("\n")[startLine].match(/^(\s*)/)?.[1].length ?? 0;
    const lines = src.split("\n");
    let endLine = lines.length - 1;
    for (let i = startLine + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() === "}" && (line.match(/^(\s*)/)?.[1].length ?? 0) === startIndent) {
        endLine = i;
        break;
      }
    }
    const block = lines.slice(startLine + 1, endLine).join("\n");
    if (block.includes("launchDesktopOrMobileConnect")) {
      throw new Error(
        "preauth success branch must not call launchDesktopOrMobileConnect — the deeplink fires only on fallback",
      );
    }
    if (block.includes("window.location.href")) {
      throw new Error(
        "preauth success branch must not assign window.location.href",
      );
    }
  });

  it("buildDesktopOrMobileConnectUrlWithRequest still produces the legacy URL shape for callers that need it", () => {
    // The helper remains exported for dapps that call it directly
    // (e.g., a dapp's own custom connect UI). Verify the URL
    // shape is unchanged from rc.9 so existing callers don't
    // break.
    const url = buildDesktopOrMobileConnectUrlWithRequest(
      "abc-123",
      "Ecosystem",
    );
    expect(url.startsWith("inferenco://login?")).toBe(true);
    expect(url).toContain("request=abc-123");
    expect(url).toContain("app=Ecosystem");
  });
});
/**
 * v0.2.1-rc.1 — first-time connect / no-new-tab, at the `connect()` level.
 *
 * The whole regression chain is exercised here end to end:
 *
 *  1. `POST /preauth-connect` is held past the 1200 ms
 *     `bridgeConnectTimeoutMs` liveness probe by Chrome >=142's Local
 *     Network Access prompt. The probe aborts → `DOMException`
 *     `AbortError`.
 *  2. PRE-FIX: `startPreauthConnect` returned `null`, `connect()` fell
 *     through to `launchDesktopOrMobileConnect()`, and
 *     `window.location.href = "inferenco://login?redirect=…"` fired.
 *     The WALLET's no-new-tab arm cannot match that deeplink (it has no
 *     `request=` param), so it took the legacy fallback and
 *     `xdg-open`'d the bare dApp URL → NEW TAB, no session params,
 *     while this tab polled localStorage forever.
 *  3. POST-FIX: the retry loop survives the abort (the user answers
 *     the LNA prompt), the preauth POST succeeds, and the session
 *     arrives through the `GET /preauth-poll/<id>` poll — no deeplink,
 *     no new tab, the CURRENT tab connects.
 */
describe("connect() does not open a new tab on a first-time LNA-stalled connect", () => {
  const APPROVED_ADDRESS = "0x" + "22".repeat(32);
  const APPROVED_PUBLIC_KEY = "0x" + "11".repeat(32);
  const SAMPLE_TOKEN =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const SAMPLE_BRIDGE_URL = `http://127.0.0.1:21984/${SAMPLE_TOKEN}`;

  beforeEach(() => {
    bridge._resetExternalSessionResumeListenersForTesting();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    bridge._resetExternalSessionResumeListenersForTesting();
  });

  it("resolves_via_preauth_poll_and_never_launches_the_deeplink", async () => {
    let preauthAttempts = 0;

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);

      if (target.endsWith("/preauth-connect")) {
        preauthAttempts += 1;
        if (preauthAttempts === 1) {
          // The LNA prompt is on screen: the browser holds the
          // loopback fetch and the 1200 ms probe aborts it. The
          // rejection is a `DOMException`, NOT a `TypeError`.
          expect(init?.signal).toBeDefined();
          throw new DOMException(
            "The user aborted a request.",
            "AbortError",
          );
        }
        // User answered the prompt — the retry now reaches the wallet.
        return new Response(
          JSON.stringify({
            requestId: "req-lna-first-connect",
            pollUrl: "/preauth-poll/req-lna-first-connect",
            bridgeUrl: SAMPLE_BRIDGE_URL,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (target.includes("/preauth-poll/")) {
        return new Response(
          JSON.stringify({
            status: "approved",
            requestId: "req-lna-first-connect",
            address: APPROVED_ADDRESS,
            publicKey: APPROVED_PUBLIC_KEY,
            network: "testnet",
            chainId: 2,
            sessionId: "sess-lna-first-connect",
            bridgeUrl: SAMPLE_BRIDGE_URL,
            walletName: "Infer Desk",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`unexpected fetch to ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const launchSpy = vi
      .spyOn(bridge, "launchDesktopOrMobileConnect")
      .mockReturnValue("inferenco://login?redirect=https%3A%2F%2Fapp.example.com");

    const hrefBefore = window.location.href;

    const client = new InferClient({ bridgeBaseUrl: SAMPLE_BRIDGE_URL });
    const result = await client.connect();

    // The CURRENT tab connected via the preauth poll.
    expect(result.account.address.toString()).toBe(APPROVED_ADDRESS);
    expect(result.network?.name).toBe("testnet");

    // The first attempt was aborted by the LNA stall and retried.
    expect(preauthAttempts).toBeGreaterThanOrEqual(2);

    // The legacy deeplink fallback was never reached.
    expect(launchSpy).not.toHaveBeenCalled();
    expect(window.location.href).toBe(hrefBefore);
    expect(window.location.href.startsWith("inferenco://")).toBe(false);
  });
});
