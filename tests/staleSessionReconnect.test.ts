import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bridge from "../src/bridge";
import { INFER_EXTERNAL_SESSION_STORAGE_KEY } from "../src/constants";
import { InferClient } from "../src/InferClient";
import type { InferExternalSession } from "../src/types";

const BASE = "http://127.0.0.1:21984";
const OLD: InferExternalSession = {
  transport: "desktop-bridge",
  address: "0x" + "12".repeat(32),
  publicKey: "0x" + "ab".repeat(32),
  network: "testnet", chainId: 2,
  sessionId: "fixture-old-session",
  bridgeUrl: BASE + "/" + "a".repeat(64)
};
const FRESH: InferExternalSession = {
  ...OLD, sessionId: "fixture-approved-session",
  bridgeUrl: BASE + "/" + "b".repeat(64)
};
const clients: InferClient[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" }
});

function fixture(mode: "cors" | "404" | "clean" = "cors") {
  if (mode !== "clean") bridge.storeExternalSession(OLD);
  let approve!: (response: Response) => void;
  const approval = new Promise<Response>((resolve) => { approve = resolve; });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/preauth-connect"))
      return json({ requestId: "fixture-preauth", pollUrl: "/preauth-poll/fixture-preauth" });
    if (url.pathname.endsWith("/preauth-poll/fixture-preauth")) return approval;
    if (url.pathname.endsWith("/session/" + OLD.sessionId)) {
      if (mode === "404") return json({ error: "not found" }, 404);
      throw new TypeError("Failed to fetch"); // browser-hidden stale-token 404
    }
    if (url.pathname.endsWith("/session/" + FRESH.sessionId)) return json(FRESH);
    if (init?.method === "DELETE" && url.pathname === "/" + "b".repeat(64) + "/connection")
      return json({ ok: true });
    throw new Error("Unexpected fixture request: " + url.pathname);
  });
  vi.stubGlobal("fetch", fetch);
  const launch = vi.spyOn(bridge, "launchDesktopOrMobileConnect").mockReturnValue("inferenco://fixture");
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const client = new InferClient({ bridgeBaseUrl: BASE, bridgePollTimeoutMs: 300, bridgePollIntervalMs: 5 });
  clients.push(client);
  return { client, fetch, launch, open, approve: () => approve(json({ status: "approved", ...FRESH })) };
}

beforeEach(() => {
  bridge._resetExternalSessionResumeListenersForTesting();
  // Peer delivery is driven explicitly by StorageEvent in this fixture.
  vi.stubGlobal("BroadcastChannel", undefined);
  window.localStorage.clear(); window.sessionStorage.clear();
});
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  bridge._resetExternalSessionResumeListenersForTesting();
  window.localStorage.clear(); window.sessionStorage.clear();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("retained stale session during desktop reconnect", () => {
  it.each(["cors", "404", "clean"] as const)("waits for approval with %s state and revokes the fresh Desk connection", async (mode) => {
    const { client, fetch, launch, open, approve } = fixture(mode);
    const href = window.location.href;
    let connected = false;
    const connecting = client.connect().then((result) => { connected = true; return result; });
    await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes("/preauth-poll/"))).toBe(true));
    // Allow the cached-session waiter to run while approval is still held.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(connected).toBe(false);
    expect(client.account).toBeNull();
    if (mode === "cors") expect(bridge.readExternalSession()).toEqual(OLD);
    else expect(bridge.readExternalSession()).toBeNull();
    approve();
    await connecting;
    expect(bridge.readExternalSession()?.sessionId).toBe(FRESH.sessionId);
    expect((await client.checkConnectionHealth()).state).toBe("connected");
    expect(launch).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    const disconnected = vi.fn(); client.on("disconnect", disconnected);
    await client.disconnect();
    const revocations = fetch.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(revocations).toHaveLength(1);
    const revoked = new URL(String(revocations[0][0]));
    expect(revoked.pathname).toBe("/" + "b".repeat(64) + "/connection");
    expect(revoked.searchParams.get("origin")).toBe(window.location.origin);
    expect(revoked.searchParams.get("address")).toBe(FRESH.address);
    expect(revoked.searchParams.get("network")).toBe(FRESH.network);
    expect(disconnected).toHaveBeenCalledOnce();
    expect(client.account).toBeNull(); expect(bridge.readExternalSession()).toBeNull();
  });

  it("still accepts a fresh peer-tab approval while the old session is retained", async () => {
    const { client, fetch, launch } = fixture();
    let connected = false;
    const connecting = client.connect().then((result) => { connected = true; return result; });
    await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes("/preauth-poll/"))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connected).toBe(false);
    window.localStorage.setItem(INFER_EXTERNAL_SESSION_STORAGE_KEY, JSON.stringify(FRESH));
    window.dispatchEvent(new StorageEvent("storage", {
      key: INFER_EXTERNAL_SESSION_STORAGE_KEY, newValue: JSON.stringify(FRESH)
    }));
    await connecting;
    expect(bridge.readExternalSession()?.sessionId).toBe(FRESH.sessionId);
    expect(launch).not.toHaveBeenCalled();
    expect((await client.checkConnectionHealth()).state).toBe("connected");
  });

  it("does not treat re-emitted stale metadata or timeout as approval", async () => {
    vi.useFakeTimers();
    try {
      bridge.storeExternalSession(OLD);
      let settled = false;
      const waiting = bridge.waitForExternalSession({ bridgePollTimeoutMs: 100, bridgePollIntervalMs: 10 }, OLD)
        .then((session) => { settled = true; return session; });
      bridge.storeExternalSession({ ...OLD, walletName: "Infer Desk" });
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(50);
      expect(await waiting).toBeNull();
      expect(bridge.readExternalSession()?.sessionId).toBe(OLD.sessionId);
    } finally { vi.useRealTimers(); }
  });

  it("preserves ordinary cached-session reuse after successful health validation", async () => {
    const { client, fetch, launch, open } = fixture("clean");
    bridge.storeExternalSession(FRESH);
    await client.connect();
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/preauth-"))).toBe(false);
    expect(client.account?.address.toString()).toBe(FRESH.address);
    expect(launch).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    await client.disconnect();
  });
});
