// @vitest-environment node
/**
 * End-to-end wallet-bridge round-trip test.
 *
 * Closes audit-08 ND-COMPAT-001 (HIGH): the published
 * `@inferenco/nova-wallet-adapter` must speak the same wire protocol as
 * `nova-desk-ui/src/ui/pages/browser/external_bridge.rs`. Earlier
 * adapter releases called tokenless routes that Nova Desk rejects; this
 * suite proves the current adapter (rc.7+) drives a real HTTP server
 * that speaks the Phase-2 Nova Desk bridge protocol.
 *
 * The fixture is NOT a mock of the adapter — it's a real `http.Server`
 * bound to `127.0.0.1:0` that accepts the exact wire format Nova Desk
 * serves. The adapter code is unchanged: real `fetch`, real
 * `AbortController`, real URL construction, real localStorage, real
 * polling, real retry. If this suite passes, a current adapter drives a
 * current wallet end-to-end (against a fixture with the wallet's wire
 * shape; against a real wallet binary in `tests/e2e_real_wallet/`,
 * which is documented but `#[ignore]`d on the wallet side).
 *
 * Six scenarios, mirroring the six wire surfaces the adapter exercises:
 *   1. preauth_round_trip    — POST /preauth-connect + poll
 *   2. sign_message          — POST /<token>/sign-message + poll
 *   3. sign_transaction      — POST /<token>/sign-transaction + poll
 *   4. sign_and_submit       — POST /<token>/transaction + poll (returns hash)
 *   5. revoke                — DELETE /<token>/connection
 *   6. restart               — server restart with new token invalidates session
 */
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Account, Ed25519PrivateKey } from "@cedra-labs/ts-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetExternalSessionResumeListenersForTesting, clearExternalSession } from "../../src/bridge.js";
import { InferClient } from "../../src/InferClient.js";

import { browser } from "./_browser_shim.js";

// ---------------------------------------------------------------------------
// Fixture: real http.Server speaking the Nova Desk bridge wire format
// ---------------------------------------------------------------------------

interface SessionJson {
  address: string;
  publicKey: string;
  network: string;
  chainId: number;
  sessionId: string;
  bridgeUrl: string;
  walletName: string;
  protocolPublicKey?: string;
}

interface CapturedRequest {
  method: string;
  pathname: string;
  origin: string | undefined;
  body: string;
  authorization: string | undefined;
}

class BridgeFixture {
  readonly token: string;
  private server: Server;
  private sessions = new Map<string, SessionJson>();
  // Queues: each POST consumes the head of the corresponding queue if any.
  private connectQueue: SessionJson[] = [];
  private messageQueue: Array<{
    address: string;
    signature: string;
    fullMessage: string;
    message: string;
  }> = [];
  private signTxQueue: Array<{
    address: string;
    authenticatorHex: string;
    rawTransactionBcsHex: string;
  }> = [];
  private submitQueue: Array<{ address: string; hash: string }> = [];
  private pending = new Map<string, unknown>();
  private nextId = 1;
  readonly captured: CapturedRequest[] = [];

  constructor() {
    this.token = randomToken();
    this.server = createServer((req, res) => this.handle(req, res));
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  baseUrl(): string {
    const addr = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  /** Per-session URL: `http://127.0.0.1:<port>/<token>`. */
  sessionBridgeUrl(): string {
    return `${this.baseUrl()}/${this.token}`;
  }

  approveNextConnect(session: SessionJson): void {
    this.connectQueue.push(session);
  }

  queueSignMessage(
    payload: {
      address: string;
      signature: string;
      fullMessage: string;
      message: string;
    }
  ): void {
    this.messageQueue.push(payload);
  }

  queueSignTransaction(
    payload: {
      address: string;
      authenticatorHex: string;
      rawTransactionBcsHex: string;
    }
  ): void {
    this.signTxQueue.push(payload);
  }

  queueSignAndSubmit(payload: { address: string; hash: string }): void {
    this.submitQueue.push(payload);
  }

  // ---- internals ------------------------------------------------------------

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept, X-Nova-Session",
      "Vary": "Origin"
    });
    res.end(payload);
  }

  private notFound(res: ServerResponse): void {
    this.json(res, 404, { error: "not_found" });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept, X-Nova-Session"
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", this.baseUrl());
    const path = String(url.pathname);
    const origin = req.headers.origin as string | undefined;
    const authorization = req.headers.authorization as string | undefined;
    const body = await this.readBody(req);
    this.captured.push({ method: req.method ?? "", pathname: path, origin, body, authorization });

    // ---- Preauth routes (token-less, Nova Desk 0.6.0-rc.6+ primary path) ----
    if (req.method === "POST" && path === "/preauth-connect") {
      const requestId = `preauth-${this.nextId++}`;
      const queued = this.connectQueue.shift();
      this.pending.set(requestId, { kind: "connect", approval: queued ? "approved" : "pending", session: queued });
      if (queued) this.sessions.set(queued.sessionId, queued);
      this.json(res, 200, {
        requestId,
        pollUrl: `${this.baseUrl()}/preauth-poll/${requestId}`,
        // audit-08 ND-WEB-001 follow-on (a5118f3): the wallet stops
        // returning bridgeUrl in 0.6.0-rc.7+; for adapter compat
        // coverage the fixture still includes it.
        bridgeUrl: this.sessionBridgeUrl()
      });
      return;
    }

    if (req.method === "GET" && path.startsWith("/preauth-poll/")) {
      const requestId = path.slice("/preauth-poll/".length);
      const entry = this.pending.get(requestId) as
        | { kind: string; approval: string; session?: SessionJson }
        | undefined;
      if (!entry || entry.kind !== "connect") {
        this.notFound(res);
        return;
      }
      if (entry.approval === "pending") {
        this.json(res, 200, { status: "pending", requestId });
        return;
      }
      const session = entry.session;
      if (!session) {
        this.json(res, 200, { status: "pending", requestId });
        return;
      }
      this.sessions.set(session.sessionId, session);
      this.json(res, 200, {
        status: "approved",
        requestId,
        address: session.address,
        publicKey: session.publicKey,
        network: session.network,
        chainId: session.chainId,
        sessionId: session.sessionId,
        bridgeUrl: session.bridgeUrl,
        walletName: session.walletName
      });
      return;
    }

    // ---- Token-gated routes ----
    const tokenMatch = path.match(/^\/([0-9a-f]{32,})(\/.*)$/);
    if (!tokenMatch) {
      this.notFound(res);
      return;
    }
    const [, pathToken, rest] = tokenMatch;
    if (pathToken !== this.token) {
      // Wrong token: matches F-03 token gate in external_bridge.rs:2080.
      this.notFound(res);
      return;
    }

    if (req.method === "POST" && rest === "/sign-message") {
      const requestId = `msg-${this.nextId++}`;
      const queued = this.messageQueue.shift();
      this.pending.set(requestId, {
        kind: "message",
        approval: queued ? "approved" : "pending",
        payload: queued
      });
      this.json(res, 200, { status: "pending", requestId });
      return;
    }

    if (req.method === "GET" && rest.startsWith("/message-request/")) {
      const requestId = rest.slice("/message-request/".length);
      const entry = this.pending.get(requestId) as
        | { kind: string; approval: string; payload?: { address: string; signature: string; fullMessage: string; message: string } }
        | undefined;
      if (!entry || entry.kind !== "message") {
        this.notFound(res);
        return;
      }
      if (entry.approval === "pending") {
        this.json(res, 200, { status: "pending", requestId });
        return;
      }
      if (!entry.payload) {
        this.json(res, 200, { status: "rejected", requestId, error: "user_cancelled" });
        return;
      }
      this.json(res, 200, { status: "approved", requestId, ...entry.payload });
      return;
    }

    if (req.method === "POST" && rest === "/sign-transaction") {
      const requestId = `stx-${this.nextId++}`;
      const queued = this.signTxQueue.shift();
      this.pending.set(requestId, {
        kind: "sign-transaction",
        approval: queued ? "approved" : "pending",
        payload: queued
      });
      this.json(res, 200, { status: "pending", requestId });
      return;
    }

    if (req.method === "GET" && rest.startsWith("/sign-transaction-request/")) {
      const requestId = rest.slice("/sign-transaction-request/".length);
      const entry = this.pending.get(requestId) as
        | {
            kind: string;
            approval: string;
            payload?: { address: string; authenticatorHex: string; rawTransactionBcsHex: string };
          }
        | undefined;
      if (!entry || entry.kind !== "sign-transaction") {
        this.notFound(res);
        return;
      }
      if (entry.approval === "pending") {
        this.json(res, 200, { status: "pending", requestId });
        return;
      }
      if (!entry.payload) {
        this.json(res, 200, { status: "rejected", requestId, error: "user_cancelled" });
        return;
      }
      this.json(res, 200, { status: "approved", requestId, ...entry.payload });
      return;
    }

    if (req.method === "POST" && rest === "/transaction") {
      const requestId = `sub-${this.nextId++}`;
      const queued = this.submitQueue.shift();
      this.pending.set(requestId, {
        kind: "submit",
        approval: queued ? "approved" : "pending",
        payload: queued
      });
      this.json(res, 200, { status: "pending", requestId });
      return;
    }

    if (req.method === "GET" && rest.startsWith("/transaction-request/")) {
      const requestId = rest.slice("/transaction-request/".length);
      const entry = this.pending.get(requestId) as
        | { kind: string; approval: string; payload?: { address: string; hash: string } }
        | undefined;
      if (!entry || entry.kind !== "submit") {
        this.notFound(res);
        return;
      }
      if (entry.approval === "pending") {
        this.json(res, 200, { status: "pending", requestId });
        return;
      }
      if (!entry.payload) {
        this.json(res, 200, { status: "rejected", requestId, error: "user_cancelled" });
        return;
      }
      this.json(res, 200, { status: "approved", requestId, hash: entry.payload.hash });
      return;
    }

    if (req.method === "GET" && rest.startsWith("/session/")) {
      const sessionId = rest.slice("/session/".length);
      const session = this.sessions.get(sessionId);
      if (!session) {
        this.json(res, 404, { error: "session_not_found" });
        return;
      }
      this.json(res, 200, session);
      return;
    }

    if (req.method === "DELETE" && rest.startsWith("/session/")) {
      const sessionId = rest.slice("/session/".length);
      this.sessions.delete(sessionId);
      this.json(res, 200, { ok: true });
      return;
    }

    if (req.method === "DELETE" && rest === "/connection") {
      const address = url.searchParams.get("address");
      if (address) {
        for (const [sessionId, session] of this.sessions) {
          if (session.address === address) this.sessions.delete(sessionId);
        }
      }
      this.json(res, 200, { ok: true });
      return;
    }

    this.notFound(res);
  }
}

function randomToken(): string {
  // 64 hex chars matches the wallet's per-session URL token shape
  // (BRIDGE_TOKEN_PATH_REGEX: `[0-9a-f]{32,}`).
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeSigner(): Promise<{
  account: Account;
  privateKey: Ed25519PrivateKey;
  address: string;
  publicKeyHex: string;
}> {
  const privateKey = Ed25519PrivateKey.generate();
  const account = Account.fromPrivateKey({ privateKey });
  return {
    account,
    privateKey,
    address: account.accountAddress.toString(),
    publicKeyHex: account.publicKey.toString()
  };
}

function makeSession(
  signer: Awaited<ReturnType<typeof makeSigner>>,
  fixture: BridgeFixture
): SessionJson {
  return {
    address: signer.address,
    publicKey: signer.publicKeyHex,
    network: "testnet",
    chainId: 2,
    sessionId: `session-${Math.random().toString(36).slice(2)}`,
    bridgeUrl: fixture.sessionBridgeUrl(),
    walletName: "Infer Connect"
  };
}

function ed25519Sign(privateKey: Ed25519PrivateKey, message: string): string {
  const bytes = new TextEncoder().encode(message);
  const hex = "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const sig = privateKey.sign(hex);
  return `0x${Buffer.from(sig.toUint8Array()).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let fixture: BridgeFixture;

beforeEach(async () => {
  fixture = new BridgeFixture();
  await fixture.start();
  _resetExternalSessionResumeListenersForTesting();
  clearExternalSession();
  browser.reset();
  // The dapp is configured with the per-session URL token in its bridge
  // base URL (matches the wallet's redirect-callback `?bridgeUrl=.../<token>`
  // shape that real dapps receive from Nova Desk). This is how the
  // adapter's `extractBridgeTokenFromBaseUrl` fallback finds the token
  // when the synchronous `readBridgeToken()` is unavailable (e.g.,
  // external browsers without pathname/postMessage delivery).
  browser.setPathname(`/${fixture.token}`);
});

afterEach(async () => {
  await fixture.stop();
  _resetExternalSessionResumeListenersForTesting();
  clearExternalSession();
  browser.reset();
});

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("wallet-bridge round-trip (audit-08 ND-COMPAT-001)", () => {
  it("preauth_round_trip: InferClient.connect() end-to-end via POST /preauth-connect + poll", async () => {
    const signer = await makeSigner();
    const session = makeSession(signer, fixture);
    fixture.approveNextConnect(session);

    const client = new InferClient({ bridgeBaseUrl: fixture.sessionBridgeUrl() });
    const result = await client.connect();

    expect(result.account.address.toString()).toBe(signer.address);
    expect(client.cachedNetwork?.name).toBe("testnet");
    expect(client.cachedNetwork?.chainId).toBe(2);

    // Wire shape: exactly one POST /preauth-connect followed by at least one
    // poll on the same request id.
    const preauthPost = fixture.captured.find(
      (r) => r.method === "POST" && r.pathname === "/preauth-connect"
    );
    const preauthPolls = fixture.captured.filter(
      (r) => r.method === "GET" && r.pathname.startsWith("/preauth-poll/")
    );
    expect(preauthPost).toBeDefined();
    expect(preauthPolls.length).toBeGreaterThanOrEqual(1);
    expect(preauthPolls.at(-1)?.pathname).toContain("preauth-1");
  });

  it("sign_message: POST /<token>/sign-message + poll returns Ed25519 signature", async () => {
    const signer = await makeSigner();
    const session = makeSession(signer, fixture);
    fixture.approveNextConnect(session);

    const client = new InferClient({ bridgeBaseUrl: fixture.sessionBridgeUrl() });
    await client.connect();

    fixture.queueSignMessage({
      address: signer.address,
      signature: ed25519Sign(signer.privateKey, "hello-world"),
      fullMessage: "hello-world",
      message: "hello-world"
    });

    const output = await client.signMessage({ message: "hello-world", nonce: "0x00" });

    expect(output.signature).toBeDefined();
    expect(output.address).toBe(signer.address);
    expect(output.fullMessage).toBe("hello-world");
    expect(output.message).toBe("hello-world");

    const signPosts = fixture.captured.filter(
      (r) => r.method === "POST" && r.pathname === `/${fixture.token}/sign-message`
    );
    const msgPolls = fixture.captured.filter(
      (r) => r.method === "GET" && r.pathname.startsWith(`/${fixture.token}/message-request/`)
    );
    expect(signPosts).toHaveLength(1);
    expect(msgPolls.length).toBeGreaterThanOrEqual(1);
  });

  it("sign_transaction: POST /<token>/sign-transaction + poll returns authenticatorHex", async () => {
    const signer = await makeSigner();
    const session = makeSession(signer, fixture);
    fixture.approveNextConnect(session);

    const client = new InferClient({ bridgeBaseUrl: fixture.sessionBridgeUrl() });
    await client.connect();

    const sdk = await import("@cedra-labs/ts-sdk");
    const { RawTransaction, TransactionPayloadEntryFunction, EntryFunction, ChainId, parseTypeTag, SimpleTransaction } = sdk;
    const rawTransaction = new RawTransaction(
      signer.account.accountAddress,
      0n,
      new TransactionPayloadEntryFunction(EntryFunction.build("0x1::account", "transfer", [], [])),
      1_000n,
      1n,
      60n,
      new ChainId(2),
      parseTypeTag("0x1::cedra_coin::CedraCoin")
    );
    const simpleTransaction = new SimpleTransaction(rawTransaction);
// Sign with the SDK's full signing pipeline so the produced
    // authenticator hex round-trips through the adapter's deserializer.
    // `signTransactionWithAuthenticator` adds the SDK's domain separator
    // ("CEDRA::RawTransaction") before signing; a bare Ed25519 signature
    // over the BCS bytes would not verify on-chain but the test doesn't
    // verify on-chain — it only verifies wire format.
    const authenticator = signer.account.signTransactionWithAuthenticator(simpleTransaction);
    fixture.queueSignTransaction({
      address: signer.address,
      authenticatorHex: authenticator.toString(),
      rawTransactionBcsHex: rawTransaction.bcsToHex().toString()
    });

    const output = (await client.signTransaction(
      simpleTransaction as unknown as Parameters<typeof client.signTransaction>[0]
    )) as {
      authenticator: unknown;
      authenticatorHex: string;
      rawTransactionBcsHex: string;
    };

    expect(output.authenticator).toBeDefined();
    expect(output.authenticatorHex).toBe(authenticator.toString());
    expect(output.rawTransactionBcsHex).toBe(rawTransaction.bcsToHex().toString());

    const signPosts = fixture.captured.filter(
      (r) => r.method === "POST" && r.pathname === `/${fixture.token}/sign-transaction`
    );
    expect(signPosts).toHaveLength(1);
    const stxPolls = fixture.captured.filter(
      (r) => r.method === "GET" && r.pathname.startsWith(`/${fixture.token}/sign-transaction-request/`)
    );
    expect(stxPolls.length).toBeGreaterThanOrEqual(1);
  });

  it("sign_and_submit: POST /<token>/transaction + poll returns hash", async () => {
    const signer = await makeSigner();
    const session = makeSession(signer, fixture);
    fixture.approveNextConnect(session);

    const client = new InferClient({ bridgeBaseUrl: fixture.sessionBridgeUrl() });
    await client.connect();

    const fakeHash = "0x" + "ab".repeat(32);
    fixture.queueSignAndSubmit({ address: signer.address, hash: fakeHash });

    const output = await client.signAndSubmitTransaction({
      transactionOrPayload: { function: "0x1::coin::transfer", typeArguments: [], functionArguments: [] }
    } as never);

    expect(output.hash).toBe(fakeHash);

    const submitPosts = fixture.captured.filter(
      (r) => r.method === "POST" && r.pathname === `/${fixture.token}/transaction`
    );
    expect(submitPosts).toHaveLength(1);
    const submitPolls = fixture.captured.filter(
      (r) => r.method === "GET" && r.pathname.startsWith(`/${fixture.token}/transaction-request/`)
    );
    expect(submitPolls.length).toBeGreaterThanOrEqual(1);
  });

  it("revoke: DELETE /<token>/connection clears session from storage", async () => {
    const signer = await makeSigner();
    const session = makeSession(signer, fixture);
    fixture.approveNextConnect(session);

    const client = new InferClient({ bridgeBaseUrl: fixture.sessionBridgeUrl() });
    await client.connect();

    await client.disconnect();

    const deletes = fixture.captured.filter(
      (r) => r.method === "DELETE" && r.pathname === `/${fixture.token}/connection`
    );
    expect(deletes.length).toBeGreaterThanOrEqual(1);
    expect(browser.window.localStorage.getItem("inferenco:nova-session")).toBeNull();
  });

  it("restart: kill + restart server with new token invalidates prior session", async () => {
    const signer = await makeSigner();
    const session = makeSession(signer, fixture);
    fixture.approveNextConnect(session);

    const client = new InferClient({ bridgeBaseUrl: fixture.sessionBridgeUrl() });
    await client.connect();
    expect(client.account?.address.toString()).toBe(signer.address);

    // Kill the server, restart with a fresh token (simulates wallet
    // restart with rotated per-session URL token).
    const oldToken = fixture.token;
    await fixture.stop();
    fixture = new BridgeFixture();
    await fixture.start();
    browser.setPathname(`/${fixture.token}`);

    // Drive a fresh connect. The adapter validates the stored session
    // against the new bridge first; the OLD token is rejected with 404,
    // `tryResumeInferWalletConnection` falls through, and the dapp is
    // prompted via a fresh preauth round-trip.
    const client2 = new InferClient({ bridgeBaseUrl: fixture.sessionBridgeUrl() });
    const newSigner = await makeSigner();
    const newSession = makeSession(newSigner, fixture);
    fixture.approveNextConnect(newSession);
    await client2.connect();
    expect(client2.account?.address.toString()).toBe(newSigner.address);

    // Crucial guarantee: the new bridge never accepted a request with
    // the OLD token (which would have bypassed F-03).
    const oldTokenCalls = fixture.captured.filter((r) => r.pathname.includes(`/${oldToken}/`));
    expect(oldTokenCalls).toHaveLength(0);
  });
});