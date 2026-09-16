import { Account, ChainId, EntryFunction, RawTransaction, SimpleTransaction, TransactionPayloadEntryFunction, parseTypeTag } from "@cedra-labs/ts-sdk";
import { revokeExternalSession } from "../src/bridge";
import { signAndSubmitViaMobileRelay, signTransactionViaMobileRelay, resumeMobileRelayRequest, revokeMobileRelaySession } from "../src/mobileRelay";
import { clearPendingMobileRelayRequest, readPendingMobileRelayRequests } from "../src/mobileRequests";
import { createKeyPair, deriveSharedSecret, encryptJson, decryptJson } from "../src/mobileCrypto";
import type { InferExternalSession } from "../src/types";

const hash = "0x" + "ab".repeat(32);
let session: InferExternalSession;
const options = { mobilePollIntervalMs: 2, mobileRequestTimeoutMs: 80, relayBaseUrl: "https://wrong-options.example" };
let reads = 0;
let posted: Record<string, unknown>[];
let status: Record<string, unknown>;
let expiresAt: string;

function response(body: unknown, code = 200) {
  return new Response(JSON.stringify(body), { status: code, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", undefined);
  const dapp = createKeyPair(), wallet = createKeyPair();
  session = { transport: "mobile-relay", address: "0x1", publicKey: "0x2", network: "testnet", chainId: 2,
    sessionId: "session-1", relayBaseUrl: "https://session-relay.example",
    dappSessionToken: "fixture-token", sharedSecret: deriveSharedSecret(dapp.privateKey, wallet.publicKey) };
  reads = 0;
  posted = [];
  expiresAt = new Date(Date.now() + 60000).toISOString();
  status = { status: "approved", encryptedResult: encryptJson({ hash }, session.sharedSecret!) };
});
afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mockRelay(read?: () => Response | Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    expect(url.startsWith(session.relayBaseUrl!)).toBe(true);
    if (init?.method === "POST") {
      expect(url.endsWith("/v1/requests")).toBe(true);
      posted.push(JSON.parse(String(init.body)));
      return response({ requestId: "request-1", walletDeeplinkUrl: window.location.href, expiresAt });
    }
    const headers = new Headers(init?.headers);
    expect(headers.get("x-infer-session-token")).toBe("fixture-token");
    expect(headers.has("x-nova-session-token")).toBe(false);
    if (init?.method === "DELETE") return response({ ok: true });
    expect(url.endsWith("/v1/requests/request-1")).toBe(true);
    reads++;
    if (read) return read();
    return outcome();
  });
}
function outcome(overrides: Record<string, unknown> = {}) {
  return response({ requestId: "request-1", sessionId: session.sessionId,
    method: posted[0]?.method ?? "signAndSubmitTransaction",
    callbackUrl: window.location.href, expiresAt, ...status, ...overrides });
}
const submit = () => signAndSubmitViaMobileRelay({ data: { function: "0x1::account::transfer", functionArguments: ["0x2", "7"] } }, session, options);

describe("transaction relay delivery and recovery", () => {
  it.each(["unavailable", "silent", "throws"])("polls with a %s WebSocket and no callback marker", async (mode) => {
    const close = vi.fn();
    if (mode !== "unavailable") {
      vi.stubGlobal("WebSocket", class {
        static CONNECTING = 0;
        readyState = 1;
        constructor() { if (mode === "throws") throw new Error("WebSocket blocked"); }
        addEventListener() {}
        close = close;
      });
    }
    mockRelay(() => reads === 1 ? outcome({ status: "pending", encryptedResult: null }) : outcome());
    await expect(submit()).resolves.toEqual({ hash });
    expect(reads).toBe(2);
    expect(posted).toHaveLength(1);
    expect(readPendingMobileRelayRequests(session)).toHaveLength(1);
    if (mode === "silent") expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(["network", "server"])("recovers a transient %s read without creating another request", async (kind) => {
    mockRelay(() => {
      if (reads === 1) {
        if (kind === "network") throw new TypeError("Failed to fetch");
        return response({ error: "unavailable" }, 503);
      }
      return outcome();
    });
    await expect(submit()).resolves.toEqual({ hash });
    expect(posted).toHaveLength(1);
    expect(reads).toBe(2);
  });

  it("wakes HTTP polling when the page regains focus", async () => {
    vi.useFakeTimers();
    mockRelay(() => reads === 1 ? outcome({ status: "pending", encryptedResult: null }) : outcome());
    const result = signAndSubmitViaMobileRelay({ data: { function: "0x1::account::transfer", functionArguments: [] } },
      session, { ...options, mobilePollIntervalMs: 10000, mobileRequestTimeoutMs: 20000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toEqual({ hash });
    expect(reads).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry an ambiguous creation failure", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(submit()).rejects.toThrow("Failed to fetch");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readPendingMobileRelayRequests(session)).toEqual([]);
  });

  it("does not open polling when request recovery storage is unavailable", async () => {
    mockRelay();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
    await expect(submit()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(posted).toHaveLength(1);
    expect(reads).toBe(0);
  });

  it("does not retry request creation or treat an HTTP 401 as rejection", async () => {
    const fetch = mockRelay(() => response({ error: "invalid_session_token" }, 401));
    await expect(submit()).rejects.toMatchObject({ status: 401 });
    expect(posted).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(readPendingMobileRelayRequests(session)).toHaveLength(1);
  });

  it("awaits the journal hook after saving the handle and before polling", async () => {
    mockRelay();
    const hook = vi.fn(async (pending) => {
      expect(readPendingMobileRelayRequests(session)).toHaveLength(1);
      expect(reads).toBe(0);
      expect(pending.requestId).toBe("request-1");
      expect(Object.isFrozen(pending)).toBe(true);
      await Promise.resolve();
    });
    await signAndSubmitViaMobileRelay({ data: { function: "0x1::account::transfer", functionArguments: [] } },
      session, { ...options, onMobileRequestCreated: hook });
    expect(hook).toHaveBeenCalledTimes(1);
    // Successful results are retained until the dapp acknowledges its journal.
    expect(readPendingMobileRelayRequests(session)).toHaveLength(1);
  });

  it("preserves the handle if journaling fails without starting another request", async () => {
    mockRelay();
    await expect(signAndSubmitViaMobileRelay({ data: { function: "0x1::account::transfer", functionArguments: [] } },
      session, { ...options, onMobileRequestCreated: () => { throw new Error("Journal unavailable"); } }))
      .rejects.toThrow("Journal unavailable");
    expect(posted).toHaveLength(1);
    expect(reads).toBe(0);
    expect(readPendingMobileRelayRequests(session)).toHaveLength(1);
  });

  it("preserves a request for reload recovery and reads it even after expiry", async () => {
    mockRelay(() => outcome({ status: "pending", encryptedResult: null }));
    await expect(submit()).rejects.toMatchObject({ code: "CONNECTION_TIMEOUT" });
    const pending = readPendingMobileRelayRequests(session);
    expect(pending).toHaveLength(1);
    expect(JSON.stringify(pending)).not.toContain("fixture-token");
    expect(JSON.stringify(pending)).not.toContain(session.sharedSecret!);
    // Simulate a fresh module instance after the original page's call has ended.
    vi.resetModules();
    const fresh = await import("../src/mobileRelay");
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      expect(init?.method).toBeUndefined();
      return outcome();
    });
    const resumed = await fresh.resumeMobileRelayRequest("request-1", session, options);
    expect(resumed.status).toBe("approved");
    expect(decryptJson(resumed.encryptedResult!, session.sharedSecret!)).toEqual({ hash });
    expect(posted).toHaveLength(1);
    expect(readPendingMobileRelayRequests(session)).toHaveLength(1);
    clearPendingMobileRelayRequest("request-1");
    expect(readPendingMobileRelayRequests(session)).toEqual([]);
  });

  it("reconciles a completed result after the server expiry deadline", async () => {
    expiresAt = new Date(Date.now() - 1000).toISOString();
    mockRelay(() => outcome({ status: "pending", encryptedResult: null }));
    await expect(submit()).rejects.toMatchObject({ code: "CONNECTION_TIMEOUT" });
    expect(reads).toBe(1);
    vi.mocked(globalThis.fetch).mockImplementation(async () => outcome());
    await expect(resumeMobileRelayRequest("request-1", session, options)).resolves.toMatchObject({ status: "approved" });
  });

  it.each(["sessionId", "address", "network", "relayBaseUrl"])("refuses recovery through a different %s", async (field) => {
    expiresAt = new Date(Date.now() - 1000).toISOString();
    const fetch = mockRelay(() => outcome({ status: "pending", encryptedResult: null }));
    await expect(submit()).rejects.toMatchObject({ code: "CONNECTION_TIMEOUT" });
    fetch.mockClear();
    await expect(resumeMobileRelayRequest("request-1", { ...session, [field]: "other" }, options))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["requestId", "sessionId", "method"])("rejects a response for another %s", async (field) => {
    mockRelay(() => outcome({ [field]: "other" }));
    await expect(submit()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(readPendingMobileRelayRequests(session)).toHaveLength(1);
  });

  it("uses only the canonical header for both revocation entry points", async () => {
    mockRelay();
    await expect(revokeMobileRelaySession(session, options)).resolves.toBeUndefined();
    await expect(revokeExternalSession(session, options)).resolves.toBeUndefined();
  });

  it.each(["rejected", "failed", "expired", "cancelled"])("keeps %s distinct from successful submission", async (kind) => {
    status = { status: kind, encryptedResult: null, errorCode: "USER_REJECTED", errorMessage: "Declined" };
    mockRelay();
    await expect(submit()).rejects.toMatchObject({ code: kind === "rejected" ? "USER_REJECTED" : "INTERNAL_ERROR" });
    expect(posted).toHaveLength(1);
  });

  it("round-trips prebuilt SimpleTransaction and authenticator BCS without submission", async () => {
    const signer = Account.generate();
    const tx = new SimpleTransaction(new RawTransaction(signer.accountAddress, 44n,
      new TransactionPayloadEntryFunction(EntryFunction.build("0x1::account", "transfer", [], [])),
      20000n, 7n, 1900000100n, new ChainId(2), parseTypeTag("0x1::cedra_coin::CedraCoin")));
    const auth = signer.signTransactionWithAuthenticator(tx);
    status = { status: "approved", encryptedResult: encryptJson({
      authenticatorHex: auth.toString(), rawTransactionBcsHex: tx.toString()
    }, session.sharedSecret!) };
    mockRelay();
    const input = { rawTransactionBcsHex: tx.toString(), bcsHex: tx.toString() };
    const result = await signTransactionViaMobileRelay(input, session, options);
    expect(decryptJson(posted[0].encryptedRequest as string, session.sharedSecret!)).toEqual(input);
    expect(posted[0].method).toBe("signTransaction");
    expect(result.rawTransaction.toString()).toBe(tx.toString());
    expect(result.authenticator.bcsToHex().toString()).toBe(auth.toString());
    expect(posted).toHaveLength(1);
  });

  it("does not accept signing material alongside a rejected status", async () => {
    status = { status: "rejected", encryptedResult: encryptJson({ hash }, session.sharedSecret!) };
    mockRelay();
    await expect(signTransactionViaMobileRelay({ rawTransactionBcsHex: "0x00" }, session, options))
      .rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
