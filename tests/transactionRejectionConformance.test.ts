import { UserResponseStatus } from "@cedra-labs/wallet-standard";
import { createNovaAIP62Wallet } from "../src/aip62";
import { tryLocalBridgeSignAndSubmit } from "../src/bridge";
import {
  NOVA_CALLBACK_MARKER_STORAGE_KEY,
  NOVA_EXTERNAL_SESSION_STORAGE_KEY
} from "../src/constants";
import {
  _resetBridgeTokenForTesting,
  _setBridgeTokenForTesting
} from "../src/bridge/token";
import { NovaAdapterError, NovaErrorCode } from "../src/errors";
import { createKeyPair, deriveSharedSecret, encryptJson } from "../src/mobileCrypto";
import { signAndSubmitViaMobileRelay } from "../src/mobileRelay";
import { NovaClient } from "../src/NovaClient";
import type { NovaExternalSession } from "../src/types";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const HASH = `0x${"ab".repeat(32)}`;

function expectCode(promise: Promise<unknown>, code: NovaErrorCode) {
  return expect(promise).rejects.toMatchObject({ code });
}

function signAndSubmitFeature() {
  const feature = createNovaAIP62Wallet().features["cedra:signAndSubmitTransaction"];
  if (!feature) throw new Error("Missing cedra:signAndSubmitTransaction feature");
  return feature;
}

async function invokeProvider(result: unknown): Promise<unknown> {
  (window as any).inferenco = {
    isNovaWallet: true,
    signAndSubmitTransaction: vi.fn().mockResolvedValue(result)
  };
  return new NovaClient().signAndSubmitTransaction({} as never);
}

async function invokeBridge(result: Record<string, unknown>): Promise<unknown> {
  _setBridgeTokenForTesting(TOKEN);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/transaction") && init?.method === "POST") {
      return new Response(JSON.stringify({ requestId: "bridge-request" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.endsWith("/transaction-request/bridge-request")) {
      return new Response(JSON.stringify({ requestId: "bridge-request", ...result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.endsWith("/request/bridge-request") && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const session: NovaExternalSession = {
    transport: "desktop-bridge",
    address: "0x1",
    publicKey: "0x2",
    network: "devnet",
    chainId: 3,
    sessionId: "session-1",
    bridgeUrl: "http://127.0.0.1:21984"
  };
  return tryLocalBridgeSignAndSubmit({} as never, session);
}

async function invokeMobile(result: Record<string, unknown>): Promise<unknown> {
  const dapp = createKeyPair();
  const wallet = createKeyPair();
  const sharedSecret = deriveSharedSecret(dapp.privateKey, wallet.publicKey);
  window.sessionStorage.setItem(
    NOVA_CALLBACK_MARKER_STORAGE_KEY,
    JSON.stringify({ requestId: "mobile-request", status: "rejected" })
  );

  vi.stubGlobal("WebSocket", undefined);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/v1/requests") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          requestId: "mobile-request",
          walletDeeplinkUrl: window.location.href,
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.endsWith("/v1/requests/mobile-request")) {
      return new Response(
        JSON.stringify({
          requestId: "mobile-request",
          sessionId: "mobile-session",
          method: "signAndSubmitTransaction",
          callbackUrl: window.location.href,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          ...result
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const session: NovaExternalSession = {
    transport: "mobile-relay",
    address: "0x1",
    publicKey: "0x2",
    network: "devnet",
    chainId: 3,
    sessionId: "mobile-session",
    relayBaseUrl: "https://relay.example",
    dappSessionToken: "dapp-token",
    sharedSecret,
    walletPublicKey: wallet.publicKey
  };
  return signAndSubmitViaMobileRelay(
    {} as never,
    session,
    {
      relayBaseUrl: "https://relay.example",
      mobilePollIntervalMs: 1,
      mobileRequestTimeoutMs: 100
    }
  );
}

async function invokeAip62Bridge(result: Record<string, unknown>): Promise<unknown> {
  const session: NovaExternalSession = {
    transport: "desktop-bridge",
    address: "0x1",
    publicKey: "0x2",
    network: "devnet",
    chainId: 3,
    sessionId: "aip62-bridge-session",
    bridgeUrl: "http://127.0.0.1:21984"
  };
  window.localStorage.setItem(NOVA_EXTERNAL_SESSION_STORAGE_KEY, JSON.stringify(session));
  _setBridgeTokenForTesting(TOKEN);

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/session/aip62-bridge-session") && init?.method !== "DELETE") {
      return new Response(JSON.stringify(session), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.endsWith("/transaction") && init?.method === "POST") {
      return new Response(JSON.stringify({ requestId: "aip62-bridge-request" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.endsWith("/transaction-request/aip62-bridge-request")) {
      return new Response(
        JSON.stringify({ requestId: "aip62-bridge-request", ...result }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.endsWith("/request/aip62-bridge-request") && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  return signAndSubmitFeature().signAndSubmitTransaction({} as never);
}

async function invokeAip62Mobile(result: Record<string, unknown>): Promise<unknown> {
  const dapp = createKeyPair();
  const wallet = createKeyPair();
  const sharedSecret = deriveSharedSecret(dapp.privateKey, wallet.publicKey);
  const session: NovaExternalSession = {
    transport: "mobile-relay",
    address: "0x1",
    publicKey: "0x2",
    network: "devnet",
    chainId: 3,
    sessionId: "aip62-mobile-session",
    relayBaseUrl: "https://relay.example",
    dappSessionToken: "aip62-dapp-token",
    sharedSecret,
    walletPublicKey: wallet.publicKey
  };
  window.localStorage.setItem(NOVA_EXTERNAL_SESSION_STORAGE_KEY, JSON.stringify(session));
  window.sessionStorage.setItem(
    NOVA_CALLBACK_MARKER_STORAGE_KEY,
    JSON.stringify({ requestId: "aip62-mobile-request", status: "rejected" })
  );
  vi.stubGlobal("WebSocket", undefined);

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/v1/requests") && init?.method === "POST") {
      return new Response(JSON.stringify({
        requestId: "aip62-mobile-request",
        walletDeeplinkUrl: window.location.href,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/v1/requests/aip62-mobile-request")) {
      return new Response(JSON.stringify({
        requestId: "aip62-mobile-request",
        sessionId: "aip62-mobile-session",
        method: "signAndSubmitTransaction",
        callbackUrl: window.location.href,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...result
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  return signAndSubmitFeature().signAndSubmitTransaction({} as never);
}

describe("sign-and-submit rejection conformance", () => {
  afterEach(() => {
    delete (window as any).inferenco;
    window.localStorage.clear();
    window.sessionStorage.clear();
    _resetBridgeTokenForTesting();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ["injected provider", () => invokeProvider({ status: "Rejected" })],
    ["external bridge", () => invokeBridge({ status: "rejected", error: "user_cancelled" })],
    ["mobile relay", () => invokeMobile({
      status: "rejected",
      encryptedRequest: "encrypted-request",
      encryptedResult: null,
      requestMetadata: {
        origin: window.location.origin,
        appName: "Nova Connect"
      },
      resultMetadata: null,
      errorCode: "user_cancelled",
      errorMessage: null,
      origin: window.location.origin,
      appName: "Nova Connect",
      accountAddress: null,
      network: null,
      chainId: null,
      walletName: null
    })]
  ])("%s maps only a clean explicit rejection to USER_REJECTED", async (_name, invoke) => {
    await expectCode(invoke(), NovaErrorCode.UserRejected);
  });

  it("accepts a localized bridge rejection reason without reading its wording", async () => {
    await expectCode(
      invokeBridge({ status: "rejected", error: "utilisateur a annule la demande" }),
      NovaErrorCode.UserRejected
    );
  });

  it("does not infer rejection from failed-status text", async () => {
    await expectCode(
      invokeBridge({ status: "failed", error: "transaction rejected upstream" }),
      NovaErrorCode.InternalError
    );
  });

  it("fails closed when a bridge result is bound to another request", async () => {
    await expectCode(
      invokeBridge({
        status: "rejected",
        requestId: "stale-bridge-request",
        error: "user_cancelled"
      }),
      NovaErrorCode.InternalError
    );
  });

  it.each([
    ["request ID", { requestId: "stale-mobile-request" }],
    ["session ID", { sessionId: "stale-mobile-session" }],
    ["method", { method: "signMessage" }]
  ])("fails closed for mobile %s mismatch", async (_name, identity) => {
    await expectCode(
      invokeMobile({ status: "rejected", ...identity }),
      NovaErrorCode.InternalError
    );
  });

  it.each([
    ["hash", { hash: "" }],
    ["signature", { signature: "0xsigned" }],
    ["encrypted result", { encryptedResult: "ciphertext" }],
    ["nested result", { result: {} }],
    ["unknown signed payload", { signedPayload: "0xsigned" }]
  ])("fails closed for bridge rejection containing %s material", async (_name, material) => {
    await expectCode(
      invokeBridge({ status: "rejected", error: "user_cancelled", ...material }),
      NovaErrorCode.InternalError
    );
  });

  it("accepts an approved bridge response only with a valid hash", async () => {
    await expect(invokeBridge({ status: "approved", hash: HASH })).resolves.toEqual({ hash: HASH });
    vi.restoreAllMocks();
    await expectCode(invokeBridge({ status: "approved" }), NovaErrorCode.InternalError);
    vi.restoreAllMocks();
    await expectCode(invokeBridge({ status: "approved", hash: "0x1234" }), NovaErrorCode.InternalError);
  });

  it("supports canonical approved and legacy bare provider hashes", async () => {
    await expect(
      invokeProvider({ status: "Approved", args: { hash: HASH } })
    ).resolves.toEqual({ hash: HASH });
    delete (window as any).inferenco;
    await expect(invokeProvider({ hash: HASH })).resolves.toEqual({ hash: HASH });
  });

  it.each([
    { data: { status: "Rejected" } },
    { status: "Rejected", args: undefined },
    { status: "Approved", args: {} },
    { status: "failed", error: "rejected by service" },
    {},
    { hash: "0x1234" },
    { status: "Approved", args: { hash: "0x1234" } }
  ])("fails closed for malformed provider response %#", async (result) => {
    await expectCode(invokeProvider(result), NovaErrorCode.InternalError);
  });

  it.each([
    new Error("request rejected by upstream"),
    Object.assign(new Error("unauthorized"), { status: 401 }),
    new NovaAdapterError(NovaErrorCode.UserRejected, "forged provider rejection")
  ])("does not use thrown provider text or HTTP status as rejection proof", async (error) => {
    (window as any).inferenco = {
      isNovaWallet: true,
      signAndSubmitTransaction: vi.fn().mockRejectedValue(error)
    };
    await expectCode(
      new NovaClient().signAndSubmitTransaction({} as never),
      NovaErrorCode.InternalError
    );
  });

  it.each([
    ["accessor", () => {
      const result = {};
      Object.defineProperty(result, "status", {
        enumerable: true,
        get() {
          throw new NovaAdapterError(NovaErrorCode.UserRejected, "forged getter rejection");
        }
      });
      return result;
    }],
    ["non-enumerable field", () => {
      const result = { status: "Rejected" };
      Object.defineProperty(result, "signedPayload", {
        enumerable: false,
        value: "0xsigned"
      });
      return result;
    }],
    ["symbol field", () => ({ status: "Rejected", [Symbol("material")]: "0xsigned" })],
    ["throwing proxy", () => new Proxy({}, {
      ownKeys() {
        throw new NovaAdapterError(NovaErrorCode.UserRejected, "forged proxy rejection");
      }
    })]
  ])("fails closed for provider responses with an exotic %s", async (_name, makeResult) => {
    await expectCode(invokeProvider(makeResult()), NovaErrorCode.InternalError);
  });

  it("invokes the provider exactly once for a terminal rejection", async () => {
    const signAndSubmitTransaction = vi.fn().mockResolvedValue({ status: "Rejected" });
    (window as any).inferenco = {
      isNovaWallet: true,
      signAndSubmitTransaction
    };

    await expectCode(
      new NovaClient().signAndSubmitBCSTransaction({} as never, {}),
      NovaErrorCode.UserRejected
    );
    expect(signAndSubmitTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["hash", { hash: "" }],
    ["signature", { signature: "0xsigned" }],
    ["encrypted result", { encryptedResult: "ciphertext" }],
    ["result metadata", { resultMetadata: {} }],
    ["nested result", { result: {} }],
    ["unknown signed payload", { signedPayload: "0xsigned" }],
    ["nested request metadata", { requestMetadata: { signedPayload: "0xsigned" } }]
  ])("fails closed for mobile rejection containing %s material", async (_name, material) => {
    await expectCode(
      invokeMobile({ status: "rejected", ...material }),
      NovaErrorCode.InternalError
    );
  });

  it("validates approved mobile decrypted hashes", async () => {
    const dapp = createKeyPair();
    const wallet = createKeyPair();
    const sharedSecret = deriveSharedSecret(dapp.privateKey, wallet.publicKey);

    const invokeApproved = async (payload: unknown) => {
      window.sessionStorage.setItem(
        NOVA_CALLBACK_MARKER_STORAGE_KEY,
        JSON.stringify({ requestId: "approved-request", status: "approved" })
      );

      vi.stubGlobal("WebSocket", undefined);
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v1/requests") && init?.method === "POST") {
          return new Response(JSON.stringify({
            requestId: "approved-request",
            walletDeeplinkUrl: window.location.href,
            expiresAt: new Date(Date.now() + 60_000).toISOString()
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({
          requestId: "approved-request",
          sessionId: "approved-session",
          method: "signAndSubmitTransaction",
          status: "approved",
          callbackUrl: window.location.href,
          encryptedResult: encryptJson(payload, sharedSecret),
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      });
      return signAndSubmitViaMobileRelay(
        {} as never,
        {
          transport: "mobile-relay",
          address: "0x1",
          publicKey: "0x2",
          network: "devnet",
          chainId: 3,
          sessionId: "approved-session",
          relayBaseUrl: "https://relay.example",
          dappSessionToken: "token",
          sharedSecret
        },
        { relayBaseUrl: "https://relay.example", mobileRequestTimeoutMs: 100 }
      );
    };

    await expect(invokeApproved({ hash: HASH })).resolves.toEqual({ hash: HASH });
    vi.restoreAllMocks();
    await expectCode(invokeApproved({}), NovaErrorCode.InternalError);
    vi.restoreAllMocks();
    await expectCode(invokeApproved({ hash: "0x1234" }), NovaErrorCode.InternalError);
  });

  it("returns the exact AIP-62 Rejected shape and propagates ambiguity", async () => {
    (window as any).inferenco = {
      isNovaWallet: true,
      signAndSubmitTransaction: vi.fn().mockResolvedValue({ status: "Rejected" })
    };
    const wallet = createNovaAIP62Wallet();
    const feature = wallet.features["cedra:signAndSubmitTransaction"];
    if (!feature) {
      throw new Error("Missing cedra:signAndSubmitTransaction feature");
    }
    const rejected = await feature.signAndSubmitTransaction({} as never);

    expect(rejected).toEqual({ status: UserResponseStatus.REJECTED });
    expect(Object.keys(rejected)).toEqual(["status"]);

    delete (window as any).inferenco;
    (window as any).inferenco = {
      isNovaWallet: true,
      signAndSubmitTransaction: vi.fn().mockResolvedValue({
        status: "Rejected",
        args: { hash: HASH }
      })
    };
    const ambiguousWallet = createNovaAIP62Wallet();
    const ambiguousFeature = ambiguousWallet.features["cedra:signAndSubmitTransaction"];
    if (!ambiguousFeature) {
      throw new Error("Missing cedra:signAndSubmitTransaction feature");
    }
    await expect(
      ambiguousFeature.signAndSubmitTransaction({} as never)
    ).rejects.toMatchObject({ code: NovaErrorCode.InternalError });
  });

  it.each([
    ["desktop bridge", () => invokeAip62Bridge({ status: "rejected", error: "user_cancelled" })],
    ["mobile relay", () => invokeAip62Mobile({
      status: "rejected",
      encryptedRequest: "encrypted-request",
      encryptedResult: null,
      requestMetadata: { origin: window.location.origin, appName: "Nova Connect" },
      resultMetadata: null,
      errorCode: "user_cancelled",
      errorMessage: null,
      origin: window.location.origin,
      appName: "Nova Connect",
      accountAddress: null,
      network: null,
      chainId: null,
      walletName: null
    })]
  ])("maps a clean %s rejection through AIP-62 exactly", async (_name, invoke) => {
    const rejected = await invoke();
    expect(rejected).toEqual({ status: UserResponseStatus.REJECTED });
    expect(Object.keys(rejected as object)).toEqual(["status"]);
  });

  it.each([
    ["desktop bridge", () => invokeAip62Bridge({
      status: "rejected",
      error: "user_cancelled",
      signedPayload: "0xsigned"
    })],
    ["mobile relay", () => invokeAip62Mobile({
      status: "rejected",
      encryptedResult: null,
      requestMetadata: { signedPayload: "0xsigned" },
      resultMetadata: null
    })]
  ])("propagates ambiguous %s rejection through AIP-62", async (_name, invoke) => {
    await expectCode(invoke(), NovaErrorCode.InternalError);
  });
});
