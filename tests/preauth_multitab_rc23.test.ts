import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../src/bridge";
import { INFER_EXTERNAL_SESSION_STORAGE_KEY } from "../src/constants";
import { InferClient } from "../src/InferClient";
import type { InferExternalSession } from "../src/types";

// Mirror of the bridge-private `INFER_SESSION_READY_MESSAGE_TYPE`
// constant in `bridge.ts:92`. Kept here as a literal so the test
// does not depend on the (non-exported) bridge constant and remains
// robust if the constant is renamed in future maintenance.
const SESSION_READY_EVENT_TYPE = "inferenco:infer-session-ready";

// Per-session URL token fixture — 64 hex chars matches `BRIDGE_TOKEN_PATH_REGEX`.
const SAMPLE_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SAMPLE_BRIDGE_URL_WITH_TOKEN = `http://127.0.0.1:21984/${SAMPLE_TOKEN}`;

// 64-hex-char (32-byte) ed25519 public key for the peer session — the
// SDK's `AccountAddress.fromString` and the normalizeProviderAccount
// validator reject non-hex / short hex strings.
const PEER_PUBLIC_KEY = "0x" + "11".repeat(32);
const PEER_ADDRESS = "0x" + "22".repeat(32);

const PEER_SESSION: InferExternalSession = {
  transport: "desktop-bridge",
  address: PEER_ADDRESS,
  publicKey: PEER_PUBLIC_KEY,
  network: "testnet",
  chainId: 2,
  sessionId: "sess-peer-tab",
  bridgeUrl: SAMPLE_BRIDGE_URL_WITH_TOKEN,
  walletName: "Infer Connect"
};

/**
 * v0.2.0-rc.23 multi-tab preauth waiter.
 *
 * Before rc.23 the pre-auth connect path polled its own request_id
 * via `pollPreauthConnect` until the wallet approved — but it never
 * registered with `waitForExternalSession`, so a peer-tab approval
 * (delivered via the `inferenco:infer-session-ready` CustomEvent
 * that the adapter already dispatches from `bridge.ts`
 * `syncReadySession`) did NOT wake the stuck connect. rc.23 races
 * the poll against `waitForExternalSession`; first settlement wins.
 *
 * These tests exercise the race end-to-end through
 * `InferClient.connect()`.
 */
describe("multi-tab preauth waiter — 0.2.0-rc.23", () => {
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
    bridge._resetExternalSessionResumeListenersForTesting();
  });

  it("resolves_connect_when_peer_tab_dispatches_session_ready_during_preauth_poll", async () => {
    // The own request_id poll is forced to return `pending`
    // forever — this guarantees the only path to a session is the
    // peer-tab wake.
    vi.spyOn(bridge, "pollPreauthConnect").mockResolvedValue({ status: "pending" });

    // Mock startPreauthConnect so the connect path enters the
    // pollPreauthUntilResolved branch (otherwise the flow falls
    // through to the deeplink / tryLocalBridgeConnect fallback).
    vi.spyOn(bridge, "startPreauthConnect").mockResolvedValue({
      requestId: "req-rc23-multitab",
      pollUrl: "/preauth-poll/req-rc23-multitab"
    });
    vi.spyOn(bridge, "tryLocalBridgeConnect").mockResolvedValue(null);
    vi.spyOn(bridge, "readValidatedExternalSession").mockResolvedValue(null);

    const client = new InferClient();
    const connectPromise = client.connect();

    // Give the preauth loop a tick to register both pollers
    // (pollPreauthConnect + waitForExternalSession).
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    // Simulate a peer-tab approval: write the session to
    // localStorage AND dispatch the CustomEvent (the CustomEvent
    // is the deterministic path — localStorage.setItem alone
    // would only fire a `storage` event in OTHER tabs, not in
    // the same window).
    window.localStorage.setItem(
      INFER_EXTERNAL_SESSION_STORAGE_KEY,
      JSON.stringify(PEER_SESSION)
    );
    window.dispatchEvent(
      new CustomEvent<InferExternalSession>(
        SESSION_READY_EVENT_TYPE,
        { detail: PEER_SESSION }
      )
    );

    const result = await connectPromise;

    // The connect must resolve with the peer session's identity
    // (account + network), not with the own request_id (which is
    // still pending in this test).
    expect(result.account.address.toString()).toBe(PEER_SESSION.address);
    expect(result.network?.name).toBe(PEER_SESSION.network);
    expect(result.network?.chainId).toBe(PEER_SESSION.chainId);
  });

  it("resolves_connect_when_peer_tab_storage_event_fires_during_preauth_poll", async () => {
    // Mirror of the previous test, but uses the storage event
    // path (which `installExternalSessionResumeListeners` wires
    // up automatically). Both delivery channels must work.
    vi.spyOn(bridge, "pollPreauthConnect").mockResolvedValue({ status: "pending" });
    vi.spyOn(bridge, "startPreauthConnect").mockResolvedValue({
      requestId: "req-rc23-multitab-storage",
      pollUrl: "/preauth-poll/req-rc23-multitab-storage"
    });
    vi.spyOn(bridge, "tryLocalBridgeConnect").mockResolvedValue(null);
    vi.spyOn(bridge, "readValidatedExternalSession").mockResolvedValue(null);

    const client = new InferClient();
    const connectPromise = client.connect();

    await new Promise((resolve) => window.setTimeout(resolve, 10));

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: INFER_EXTERNAL_SESSION_STORAGE_KEY,
        newValue: JSON.stringify(PEER_SESSION)
      })
    );

    const result = await connectPromise;
    expect(result.account.address.toString()).toBe(PEER_SESSION.address);
    expect(result.network?.name).toBe(PEER_SESSION.network);
  });

  it("own_request_id_approval_still_wins_when_poll_resolves_first", async () => {
    // Regression-guard: the rc.23 race must NOT regress the
    // single-tab case. If the own request_id poll resolves
    // first (with an approved session), the connect resolves
    // with THAT session, not a peer session that may have
    // arrived later.
    const ownSession: InferExternalSession = {
      ...PEER_SESSION,
      sessionId: "sess-own-request-id",
      address: "0x" + "33".repeat(32)
    };
    vi.spyOn(bridge, "pollPreauthConnect").mockResolvedValue({
      status: "approved",
      session: ownSession
    });
    vi.spyOn(bridge, "startPreauthConnect").mockResolvedValue({
      requestId: "req-rc23-own",
      pollUrl: "/preauth-poll/req-rc23-own"
    });
    vi.spyOn(bridge, "tryLocalBridgeConnect").mockResolvedValue(null);
    vi.spyOn(bridge, "readValidatedExternalSession").mockResolvedValue(null);

    const client = new InferClient();
    const connectPromise = client.connect();

    // Even if a peer-tab event arrives AFTER the own poll wins,
    // the connect must already have resolved with the own
    // session — a delayed peer event must not flip the result.
    await new Promise((resolve) => window.setTimeout(resolve, 5));
    window.dispatchEvent(
      new CustomEvent<InferExternalSession>(
        SESSION_READY_EVENT_TYPE,
        { detail: PEER_SESSION }
      )
    );

    const result = await connectPromise;
    expect(result.account.address.toString()).toBe(ownSession.address);
  });

  it("connect_does_not_double_resolve_when_two_parallel_connect_calls_share_peer_event", async () => {
    // Idempotency / no-double-resolve contract: two parallel
    // `connect()` calls each register their own waiter. A single
    // peer event must resolve BOTH, but each connect() must
    // settle exactly once (no double-emit of account info).
    vi.spyOn(bridge, "pollPreauthConnect").mockResolvedValue({ status: "pending" });
    vi.spyOn(bridge, "startPreauthConnect").mockResolvedValue({
      requestId: "req-rc23-parallel",
      pollUrl: "/preauth-poll/req-rc23-parallel"
    });
    vi.spyOn(bridge, "tryLocalBridgeConnect").mockResolvedValue(null);
    vi.spyOn(bridge, "readValidatedExternalSession").mockResolvedValue(null);

    const client = new InferClient();
    const p1 = client.connect();
    const p2 = client.connect();

    await new Promise((resolve) => window.setTimeout(resolve, 10));
    window.dispatchEvent(
      new CustomEvent<InferExternalSession>(
        SESSION_READY_EVENT_TYPE,
        { detail: PEER_SESSION }
      )
    );

    // Both connect calls must resolve cleanly with the peer
    // session — no double-resolve, no rejection.
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.account.address.toString()).toBe(PEER_SESSION.address);
    expect(r2.account.address.toString()).toBe(PEER_SESSION.address);
  });
});
