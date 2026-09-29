/* ===================================================================
 * v0.2.0-rc.22 (Phase 2 / A1): authorized original-request read.
 *
 * 10 test cases covering the adapter's recovery path when:
 *   1. the original session is gone,
 *   2. a fresh session has matching (origin, transport, address,
 *      network, chainId) — i.e. the SAME wallet identity is alive on
 *      a new sessionId,
 *   3. the wallet / relay / Desk supports the new authorized-read
 *      endpoints (S1, D2).
 *
 * Fallback contract (rc.22): older relay/Desk without the new
 * endpoints → adapter returns the existing rc.21 `{status: "unknown"}`
 * payload (byte-identical to current rc.21 behavior).
 * =================================================================== */
import { storeExternalSession } from "../src/bridge";
import { _setBridgeTokenForTesting, _resetBridgeTokenForTesting } from "../src/bridge/token";
import { saveDurableRequest } from "../src/durableRecovery";
import { createKeyPair, deriveSharedSecret, encryptJson } from "../src/mobileCrypto";
import {
  _setReadGrantPollConfigForTesting,
  acknowledgeRecoverableRequest,
  listRecoverableRequests,
  readRecoverableRequest
} from "../src/recovery";
import type { PendingDesktopBridgeRequest } from "../src/desktopRequests";
import type { PendingMobileRelayRequest } from "../src/mobileRequests";
import type { InferExternalSession } from "../src/types";

const token = "0123456789abcdef".repeat(4);
const hash = "0x" + "ab".repeat(32);

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function notFound(body = ""): Response {
  return new Response(body, { status: 404 });
}

const desktopBridgeUrl = "http://127.0.0.1:21984";
const desktopOrigin = new URL(desktopBridgeUrl).origin;

const relayBaseUrl = "https://relay.example";

const desktop: InferExternalSession = {
  transport: "desktop-bridge",
  address: "0x1",
  publicKey: "0x2",
  network: "testnet",
  chainId: 2,
  sessionId: "new-desktop-session",
  bridgeUrl: desktopBridgeUrl
};

function makeMobileSession(
  sessionId: string,
  dapp: { privateKey: string; publicKey: string },
  wallet: { publicKey: string }
): InferExternalSession {
  return {
    transport: "mobile-relay",
    address: "0x1",
    publicKey: "0x2",
    network: "testnet",
    chainId: 2,
    sessionId,
    relayBaseUrl,
    dappSessionToken: `${sessionId}-token`,
    sharedSecret: deriveSharedSecret(dapp.privateKey, wallet.publicKey)
  };
}

/** Save a stale, OLD-session mobile-relay receipt straight into
 * IndexedDB (the durable store). The session-id mismatch with the
 * CURRENT session makes the legacy sessionStorage migration path a
 * no-op for this row, so we bypass it. */
async function seedOldMobileRow(
  requestId: string,
  oldSessionId: string,
  newSession: InferExternalSession
): Promise<void> {
  const pending: PendingMobileRelayRequest = {
    version: 1,
    requestId,
    sessionId: oldSessionId,
    address: newSession.address,
    network: newSession.network,
    chainId: newSession.chainId,
    relayBaseUrl,
    origin: window.location.origin,
    method: "signAndSubmitTransaction",
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  await saveDurableRequest(pending);
}

/** Save a stale, OLD-session desktop-bridge receipt straight into
 * IndexedDB. */
async function seedOldDesktopRow(
  requestId: string,
  oldSessionId: string,
  newSession: InferExternalSession
): Promise<void> {
  const pending: PendingDesktopBridgeRequest = {
    version: 2,
    transport: "desktop-bridge",
    requestId,
    sessionId: oldSessionId,
    address: newSession.address,
    network: newSession.network,
    chainId: newSession.chainId,
    origin: window.location.origin,
    bridgeOrigin: desktopOrigin,
    method: "signAndSubmitTransaction"
  };
  await saveDurableRequest(pending);
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetBridgeTokenForTesting();
  _setReadGrantPollConfigForTesting(1000, 30_000);
  vi.useRealTimers();
});

describe("authorized original-request read (rc.22 A1)", () => {
  it("falls back to rc.21 behavior when the relay lacks read-grant endpoints (404)", async () => {
    const dapp = createKeyPair();
    const newWallet = createKeyPair();
    const newSession = makeMobileSession("new-mobile-session", dapp, newWallet);
    storeExternalSession(newSession);
    await seedOldMobileRow("old-mobile-request", "old-mobile-session", newSession);

    let mintCalls = 0;
    let postToRequests = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/v1/requests")) {
        postToRequests++;
        throw new Error("Authorized-read must not POST a new request");
      }
      if (init?.method === "POST" && url.includes("/v1/requests/old-mobile-request/read-grant")) {
        mintCalls++;
        return notFound("Not Found");
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const outcome = await readRecoverableRequest("old-mobile-request");
    expect(outcome).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("Original wallet session cannot authenticate")
    });
    expect(mintCalls).toBe(1);
    expect(postToRequests).toBe(0);
    expect(fetchMock).toHaveBeenCalled();
    // The row remains active — falls back to byte-identical rc.21.
    expect(await listRecoverableRequests()).toMatchObject([
      { requestId: "old-mobile-request" }
    ]);
  });

  it("recovers the original result via the relay read-grant path on scope match", async () => {
    const dapp = createKeyPair();
    const newWallet = createKeyPair();
    const newSession = makeMobileSession("new-mobile-session", dapp, newWallet);
    storeExternalSession(newSession);
    await seedOldMobileRow("old-mobile-request", "old-mobile-session", newSession);

    // The wallet (W2) re-wraps the original { hash } under the NEW
    // session's sharedSecret and serves it via the read-grant poll.
    const redelivered = encryptJson({ hash }, newSession.sharedSecret!);

    let postToRequests = 0;
    let mintCalls = 0;
    let getCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/v1/requests")) {
        postToRequests++;
        throw new Error("Authorized-read must not POST a new request");
      }
      if (init?.method === "POST" && url.includes("/v1/requests/old-mobile-request/read-grant")) {
        mintCalls++;
        // Contract guard (S1): the relay REQUIRES scope.method and
        // authenticates via the new session's dappSessionToken (header
        // AND body). A body missing either is a wire-contract drift.
        const body = JSON.parse(String(init.body)) as {
          dappSessionToken?: string;
          scope?: { method?: string; origin?: string; accountAddress?: string };
        };
        expect(body.dappSessionToken).toBe(newSession.dappSessionToken);
        expect(body.scope?.method).toBe("signAndSubmitTransaction");
        expect(body.scope?.origin).toBe(window.location.origin);
        expect(body.scope?.accountAddress).toBe(newSession.address);
        return json({ grantId: "grant-1", expiresAt: new Date(Date.now() + 60_000).toISOString() });
      }
      if (init?.method === "GET" && url.includes("/v1/requests/old-mobile-request/read-grant")) {
        getCalls++;
        return json({
          grantId: "grant-1",
          requestId: "old-mobile-request",
          scope: {
            origin: window.location.origin,
            accountAddress: newSession.address,
            network: newSession.network,
            chainId: newSession.chainId,
            method: "signAndSubmitTransaction"
          },
          status: "fulfilled",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          fulfilledAt: new Date().toISOString(),
          redeliveredEncryptedResult: redelivered
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const outcome = await readRecoverableRequest("old-mobile-request");
    expect(outcome).toMatchObject({
      status: "approved",
      requestId: "old-mobile-request",
      output: { hash }
    });
    expect(mintCalls).toBe(1);
    expect(getCalls).toBeGreaterThanOrEqual(1);
    expect(postToRequests).toBe(0);
    expect(fetchMock).toHaveBeenCalled();

    // A second read locally replays without another mint/poll.
    const replay = await readRecoverableRequest("old-mobile-request");
    expect(replay).toMatchObject({
      status: "approved",
      output: { hash }
    });
    expect(mintCalls).toBe(1); // unchanged — idempotent recovery
    expect(getCalls).toBe(1); // unchanged — idempotent recovery
    await acknowledgeRecoverableRequest("old-mobile-request");
    expect(await listRecoverableRequests()).toEqual([]);
  });

  it("skips the authorized-read path entirely when the current session scope does not match the row", async () => {
    // The dapp has a NEW session but for a different account.
    const dapp = createKeyPair();
    const wallet = createKeyPair();
    const newSession: InferExternalSession = {
      ...makeMobileSession("new-mobile-session", dapp, wallet),
      address: "0xOTHER",
      network: "mainnet",
      chainId: 1
    };
    storeExternalSession(newSession);
    const oldSession: InferExternalSession = {
      ...newSession,
      address: "0xORIG",
      network: "testnet",
      chainId: 2,
      sessionId: "old-mobile-session"
    };
    await seedOldMobileRow("old-mobile-request", "old-mobile-session", oldSession);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("fetch must not be called when scopes do not match");
    });

    const outcome = await readRecoverableRequest("old-mobile-request");
    expect(outcome).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("Original wallet session cannot authenticate")
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recovers a desktop-bridge request via the D2 read_result_for_session endpoint", async () => {
    _setBridgeTokenForTesting(token);
    storeExternalSession(desktop);
    await seedOldDesktopRow("old-desktop-request", "old-desktop-session", desktop);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      // No POST to create a new request — only GET /read-result/<id>.
      if (init?.method === "POST") {
        throw new Error("Authorized-read must not POST a new request");
      }
      if (url.includes("/read-result/old-desktop-request")) {
        expect(url).toContain("newSessionId=" + desktop.sessionId);
        // Contract guard (D2): the Desk-side dispatch requires the
        // exact method in its ResultScope validation.
        expect(url).toContain("method=signAndSubmitTransaction");
        return json({
          requestId: "old-desktop-request",
          sessionId: desktop.sessionId,
          scope: {
            origin: window.location.origin,
            transport: "desktop-bridge",
            accountAddress: desktop.address,
            network: desktop.network,
            chainId: desktop.chainId,
            method: "signAndSubmitTransaction"
          },
          status: "approved",
          payload: { hash },
          hash,
          finalizedAt: new Date().toISOString()
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const outcome = await readRecoverableRequest("old-desktop-request");
    expect(outcome).toMatchObject({
      status: "approved",
      requestId: "old-desktop-request",
      transport: "desktop-bridge",
      output: { hash }
    });
    expect(fetchMock).toHaveBeenCalled();

    // A second read locally replays — no second IPC call.
    const replay = await readRecoverableRequest("old-desktop-request");
    expect(replay).toMatchObject({
      status: "approved",
      output: { hash }
    });
    await acknowledgeRecoverableRequest("old-desktop-request");
    expect(await listRecoverableRequests()).toEqual([]);
  });

  it("returns unknown when the D2 desktop read returns scope_mismatch", async () => {
    _setBridgeTokenForTesting(token);
    storeExternalSession(desktop);
    await seedOldDesktopRow("old-desktop-request", "old-desktop-session", desktop);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") throw new Error("Authorized-read must not POST a new request");
      if (url.includes("/read-result/old-desktop-request")) {
        return new Response(
          JSON.stringify({ error: "scope_mismatch" }),
          { status: 422, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const outcome = await readRecoverableRequest("old-desktop-request");
    expect(outcome).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("Original wallet session cannot authenticate")
    });
  });

  it("returns grant_pending_timeout when the wallet never fulfills the read-grant within the bound", async () => {
    // Shrink the poll bound so the test doesn't have to wait 30 s of
    // real time. Production default is 30 s.
    _setReadGrantPollConfigForTesting(10, 80);
    const dapp = createKeyPair();
    const newWallet = createKeyPair();
    const newSession = makeMobileSession("new-mobile-session", dapp, newWallet);
    storeExternalSession(newSession);
    await seedOldMobileRow("old-mobile-request", "old-mobile-session", newSession);

    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes("/v1/requests/old-mobile-request/read-grant")) {
        return json({ grantId: "grant-1", expiresAt });
      }
      if (init?.method === "GET" && url.includes("/v1/requests/old-mobile-request/read-grant")) {
        return json({
          grantId: "grant-1",
          requestId: "old-mobile-request",
          scope: {
            origin: window.location.origin,
            accountAddress: newSession.address,
            network: newSession.network,
            chainId: newSession.chainId,
            method: "signAndSubmitTransaction"
          },
          status: "pending_fulfillment",
          expiresAt
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const outcome = await readRecoverableRequest("old-mobile-request");
    expect(outcome).toMatchObject({
      status: "unknown",
      reason: "grant_pending_timeout"
    });
  });

  it("returns decrypt_failed when the wallet's W2 re-encryption cannot be decrypted with the new session's sharedSecret", async () => {
    const dapp = createKeyPair();
    const newWallet = createKeyPair();
    // A wallet different from `newWallet` produced the redelivery —
    // the new session's sharedSecret cannot decrypt it.
    const otherWallet = createKeyPair();
    const newSession = makeMobileSession("new-mobile-session", dapp, newWallet);
    storeExternalSession(newSession);
    await seedOldMobileRow("old-mobile-request", "old-mobile-session", newSession);

    const wrongSharedSecret = deriveSharedSecret(dapp.privateKey, otherWallet.publicKey);
    const redelivered = encryptJson({ hash }, wrongSharedSecret);

    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes("/v1/requests/old-mobile-request/read-grant")) {
        return json({ grantId: "grant-1", expiresAt });
      }
      if (init?.method === "GET" && url.includes("/v1/requests/old-mobile-request/read-grant")) {
        return json({
          grantId: "grant-1",
          requestId: "old-mobile-request",
          scope: {
            origin: window.location.origin,
            accountAddress: newSession.address,
            network: newSession.network,
            chainId: newSession.chainId,
            method: "signAndSubmitTransaction"
          },
          status: "fulfilled",
          expiresAt,
          fulfilledAt: new Date().toISOString(),
          redeliveredEncryptedResult: redelivered
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const outcome = await readRecoverableRequest("old-mobile-request");
    expect(outcome).toMatchObject({
      status: "unknown",
      reason: "decrypt_failed"
    });
  });

  it("idempotently replays a successful authorized read without re-issuing mint or poll", async () => {
    const dapp = createKeyPair();
    const newWallet = createKeyPair();
    const newSession = makeMobileSession("new-mobile-session", dapp, newWallet);
    storeExternalSession(newSession);
    await seedOldMobileRow("old-mobile-request", "old-mobile-session", newSession);

    const redelivered = encryptJson({ hash }, newSession.sharedSecret!);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    let mintCalls = 0;
    let getCalls = 0;
    let postToRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/v1/requests")) {
        postToRequests++;
        throw new Error("Authorized-read must not POST a new request");
      }
      if (init?.method === "POST" && url.includes("/v1/requests/old-mobile-request/read-grant")) {
        mintCalls++;
        return json({ grantId: "grant-1", expiresAt });
      }
      if (init?.method === "GET" && url.includes("/v1/requests/old-mobile-request/read-grant")) {
        getCalls++;
        return json({
          grantId: "grant-1",
          requestId: "old-mobile-request",
          scope: {
            origin: window.location.origin,
            accountAddress: newSession.address,
            network: newSession.network,
            chainId: newSession.chainId,
            method: "signAndSubmitTransaction"
          },
          status: "fulfilled",
          expiresAt,
          fulfilledAt: new Date().toISOString(),
          redeliveredEncryptedResult: redelivered
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const first = await readRecoverableRequest("old-mobile-request");
    expect(first).toMatchObject({ status: "approved", output: { hash } });
    expect(mintCalls).toBe(1);
    expect(getCalls).toBeGreaterThanOrEqual(1);
    expect(postToRequests).toBe(0);

    const second = await readRecoverableRequest("old-mobile-request");
    expect(second).toMatchObject({ status: "approved", output: { hash } });
    // Local replay: no second mint, no second poll.
    expect(mintCalls).toBe(1);
    expect(getCalls).toBe(1); // unchanged from the first successful read
    expect(postToRequests).toBe(0);
  });

  it("never POSTs a new request during the authorized-read path", async () => {
    const dapp = createKeyPair();
    const newWallet = createKeyPair();
    const newSession = makeMobileSession("new-mobile-session", dapp, newWallet);
    storeExternalSession(newSession);
    await seedOldMobileRow("old-mobile-request", "old-mobile-session", newSession);

    const redelivered = encryptJson({ hash }, newSession.sharedSecret!);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/v1/requests")) {
        throw new Error("Authorized-read path must not POST a new request");
      }
      if (init?.method === "POST" && url.includes("/v1/requests/old-mobile-request/read-grant")) {
        return json({ grantId: "grant-1", expiresAt });
      }
      if (init?.method === "GET" && url.includes("/v1/requests/old-mobile-request/read-grant")) {
        return json({
          grantId: "grant-1",
          requestId: "old-mobile-request",
          scope: {
            origin: window.location.origin,
            accountAddress: newSession.address,
            network: newSession.network,
            chainId: newSession.chainId,
            method: "signAndSubmitTransaction"
          },
          status: "fulfilled",
          expiresAt,
          fulfilledAt: new Date().toISOString(),
          redeliveredEncryptedResult: redelivered
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await readRecoverableRequest("old-mobile-request");

    // Inspect all fetch calls: the only POSTs allowed are
    // mint-read-grant; never POST /v1/requests (which creates a new request).
    const calls = fetchMock.mock.calls;
    for (const [input, init] of calls) {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      if (method === "POST") {
        expect(url).not.toMatch(/\/v1\/requests$/);
        expect(url).toMatch(/\/v1\/requests\/[^/]+\/read-grant$/);
      }
    }
  });

  it("falls back to byte-identical rc.21 behavior across every missing-endpoint path", async () => {
    // Sub-test A: relay GET returns 404 (older relay).
    {
      const dapp = createKeyPair();
      const newWallet = createKeyPair();
      const newSession = makeMobileSession("new-mobile-session", dapp, newWallet);
      storeExternalSession(newSession);
      await seedOldMobileRow("old-mobile-request-A", "old-mobile-session", newSession);
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (init?.method === "POST" && url.includes("/v1/requests/old-mobile-request-A/read-grant")) {
          return json({ grantId: "grant-1", expiresAt });
        }
        if (init?.method === "GET" && url.includes("/v1/requests/old-mobile-request-A/read-grant")) {
          return notFound("Not Found");
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });
      const outcome = await readRecoverableRequest("old-mobile-request-A");
      expect(outcome).toMatchObject({
        status: "unknown",
        reason: expect.stringContaining("Original wallet session cannot authenticate")
      });
    }

    // Sub-test B: Desktop IPC returns 404 (older Desk).
    {
      window.sessionStorage.clear();
      window.localStorage.clear();
      _resetBridgeTokenForTesting();
      _setBridgeTokenForTesting(token);
      storeExternalSession(desktop);
      await seedOldDesktopRow("old-desktop-request-B", "old-desktop-session", desktop);
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/read-result/old-desktop-request-B")) return notFound("Not Found");
        throw new Error(`Unexpected fetch: ${url}`);
      });
      const outcome = await readRecoverableRequest("old-desktop-request-B");
      expect(outcome).toMatchObject({
        status: "unknown",
        reason: expect.stringContaining("Original wallet session cannot authenticate")
      });
    }

    // Sub-test C: relay mint returns 404 (older relay that has GET but not POST).
    {
      window.sessionStorage.clear();
      window.localStorage.clear();
      _resetBridgeTokenForTesting();
      const dapp = createKeyPair();
      const newWallet = createKeyPair();
      const newSession = makeMobileSession("new-mobile-session", dapp, newWallet);
      storeExternalSession(newSession);
      await seedOldMobileRow("old-mobile-request-C", "old-mobile-session", newSession);
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (init?.method === "POST" && url.includes("/v1/requests/old-mobile-request-C/read-grant")) {
          return notFound("Not Found");
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });
      const outcome = await readRecoverableRequest("old-mobile-request-C");
      expect(outcome).toMatchObject({
        status: "unknown",
        reason: expect.stringContaining("Original wallet session cannot authenticate")
      });
    }
  });
});