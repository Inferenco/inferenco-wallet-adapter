import {
  UserResponseStatus,
  type CedraSignAndSubmitTransactionInput
} from "@cedra-labs/wallet-standard";
import { createInferAIP62Wallet } from "../src/aip62";
import { tryLocalBridgeSignAndSubmit } from "../src/bridge";
import {
  INFER_CALLBACK_MARKER_STORAGE_KEY,
  INFER_EXTERNAL_SESSION_STORAGE_KEY
} from "../src/constants";
import {
  _resetBridgeTokenForTesting,
  _setBridgeTokenForTesting
} from "../src/bridge/token";
import { InferAdapterError, InferErrorCode } from "../src/errors";
import {
  createKeyPair,
  decryptJson,
  deriveSharedSecret,
  encryptJson
} from "../src/mobileCrypto";
import { signAndSubmitViaMobileRelay } from "../src/mobileRelay";
import { InferClient } from "../src/InferClient";
import type { InferExternalSession } from "../src/types";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const HASH = `0x${"ab".repeat(32)}`;
const GENERIC_AIP62_INPUT: CedraSignAndSubmitTransactionInput = {
  gasUnitPrice: 7,
  maxGasAmount: 50_000,
  payload: {
    function: "0x1::coin::transfer",
    typeArguments: ["0x1::cedra_coin::CedraCoin"],
    functionArguments: ["0x2", 42]
  }
};

function expectCode(promise: Promise<unknown>, code: InferErrorCode) {
  return expect(promise).rejects.toMatchObject({ code });
}

function signAndSubmitFeature() {
  const feature = createInferAIP62Wallet().features["cedra:signAndSubmitTransaction"];
  if (!feature) throw new Error("Missing cedra:signAndSubmitTransaction feature");
  return feature;
}

async function invokeProvider(result: unknown): Promise<unknown> {
  (window as any).inferenco = {
    isNovaWallet: true,
    signAndSubmitTransaction: vi.fn().mockResolvedValue(result)
  };
  return new InferClient().signAndSubmitTransaction({} as never);
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

  const session: InferExternalSession = {
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
    INFER_CALLBACK_MARKER_STORAGE_KEY,
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

  const session: InferExternalSession = {
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

async function invokeAip62Bridge(
  result: Record<string, unknown>,
  input: CedraSignAndSubmitTransactionInput = GENERIC_AIP62_INPUT,
  captureInput?: (input: unknown) => void
): Promise<unknown> {
  const session: InferExternalSession = {
    transport: "desktop-bridge",
    address: "0x1",
    publicKey: "0x2",
    network: "devnet",
    chainId: 3,
    sessionId: "aip62-bridge-session",
    bridgeUrl: "http://127.0.0.1:21984"
  };
  window.localStorage.setItem(INFER_EXTERNAL_SESSION_STORAGE_KEY, JSON.stringify(session));
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
      const body = JSON.parse(String(init.body)) as {
        transaction?: unknown;
      };
      captureInput?.(body.transaction);
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

  return signAndSubmitFeature().signAndSubmitTransaction(input);
}

async function invokeAip62Mobile(
  result: Record<string, unknown>,
  input: CedraSignAndSubmitTransactionInput = GENERIC_AIP62_INPUT,
  captureInput?: (input: unknown) => void
): Promise<unknown> {
  const dapp = createKeyPair();
  const wallet = createKeyPair();
  const sharedSecret = deriveSharedSecret(dapp.privateKey, wallet.publicKey);
  const session: InferExternalSession = {
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
  window.localStorage.setItem(INFER_EXTERNAL_SESSION_STORAGE_KEY, JSON.stringify(session));
  window.sessionStorage.setItem(
    INFER_CALLBACK_MARKER_STORAGE_KEY,
    JSON.stringify({ requestId: "aip62-mobile-request", status: "rejected" })
  );
  vi.stubGlobal("WebSocket", undefined);

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/v1/requests") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        encryptedRequest: string;
      };
      captureInput?.(decryptJson(body.encryptedRequest, sharedSecret));

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

  return signAndSubmitFeature().signAndSubmitTransaction(input);
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
        appName: "Infer Connect"
      },
      resultMetadata: null,
      errorCode: "user_cancelled",
      errorMessage: null,
      origin: window.location.origin,
      appName: "Infer Connect",
      accountAddress: null,
      network: null,
      chainId: null,
      walletName: null
    })]
  ])("%s maps only a clean explicit rejection to USER_REJECTED", async (_name, invoke) => {
    await expectCode(invoke(), InferErrorCode.UserRejected);
  });

  it("accepts a localized bridge rejection reason without reading its wording", async () => {
    await expectCode(
      invokeBridge({ status: "rejected", error: "utilisateur a annule la demande" }),
      InferErrorCode.UserRejected
    );
  });

  it("does not infer rejection from failed-status text", async () => {
    await expectCode(
      invokeBridge({ status: "failed", error: "transaction rejected upstream" }),
      InferErrorCode.InternalError
    );
  });

  it("fails closed when a bridge result is bound to another request", async () => {
    await expectCode(
      invokeBridge({
        status: "rejected",
        requestId: "stale-bridge-request",
        error: "user_cancelled"
      }),
      InferErrorCode.InternalError
    );
  });

  it.each([
    ["request ID", { requestId: "stale-mobile-request" }],
    ["session ID", { sessionId: "stale-mobile-session" }],
    ["method", { method: "signMessage" }]
  ])("fails closed for mobile %s mismatch", async (_name, identity) => {
    await expectCode(
      invokeMobile({ status: "rejected", ...identity }),
      InferErrorCode.InternalError
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
      InferErrorCode.InternalError
    );
  });

  it("accepts an approved bridge response only with a valid hash", async () => {
    await expect(invokeBridge({ status: "approved", hash: HASH })).resolves.toEqual({ hash: HASH });
    vi.restoreAllMocks();
    await expectCode(invokeBridge({ status: "approved" }), InferErrorCode.InternalError);
    vi.restoreAllMocks();
    await expectCode(invokeBridge({ status: "approved", hash: "0x1234" }), InferErrorCode.InternalError);
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
    await expectCode(invokeProvider(result), InferErrorCode.InternalError);
  });

  it.each([
    new Error("request rejected by upstream"),
    Object.assign(new Error("unauthorized"), { status: 401 }),
    new InferAdapterError(InferErrorCode.UserRejected, "forged provider rejection")
  ])("does not use thrown provider text or HTTP status as rejection proof", async (error) => {
    (window as any).inferenco = {
      isNovaWallet: true,
      signAndSubmitTransaction: vi.fn().mockRejectedValue(error)
    };
    await expectCode(
      new InferClient().signAndSubmitTransaction({} as never),
      InferErrorCode.InternalError
    );
  });

  it.each([
    ["accessor", () => {
      const result = {};
      Object.defineProperty(result, "status", {
        enumerable: true,
        get() {
          throw new InferAdapterError(InferErrorCode.UserRejected, "forged getter rejection");
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
        throw new InferAdapterError(InferErrorCode.UserRejected, "forged proxy rejection");
      }
    })]
  ])("fails closed for provider responses with an exotic %s", async (_name, makeResult) => {
    await expectCode(invokeProvider(makeResult()), InferErrorCode.InternalError);
  });

  it("accepts canonical provider records created in another browser realm", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    try {
      const foreignJson = (
        iframe.contentWindow as unknown as { JSON?: typeof JSON } | null
      )?.JSON;
      if (!foreignJson) throw new Error("Missing iframe JSON realm");

      const approved = foreignJson.parse(JSON.stringify({
        status: "Approved",
        args: { hash: HASH }
      })) as unknown;
      expect(Object.getPrototypeOf(approved)).not.toBe(Object.prototype);
      await expect(invokeProvider(approved)).resolves.toEqual({ hash: HASH });

      delete (window as any).inferenco;
      const rejected = foreignJson.parse(JSON.stringify({
        status: "Rejected"
      })) as unknown;
      await expectCode(
        invokeProvider(rejected),
        InferErrorCode.UserRejected
      );
    } finally {
      iframe.remove();
    }
  });

  it("invokes the provider exactly once for a terminal rejection", async () => {
    const signAndSubmitTransaction = vi.fn().mockResolvedValue({ status: "Rejected" });
    (window as any).inferenco = {
      isNovaWallet: true,
      signAndSubmitTransaction
    };

    await expectCode(
      new InferClient().signAndSubmitBCSTransaction({} as never, {}),
      InferErrorCode.UserRejected
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
      InferErrorCode.InternalError
    );
  });

  it("validates approved mobile decrypted hashes", async () => {
    const dapp = createKeyPair();
    const wallet = createKeyPair();
    const sharedSecret = deriveSharedSecret(dapp.privateKey, wallet.publicKey);

    const invokeApproved = async (payload: unknown) => {
      window.sessionStorage.setItem(
        INFER_CALLBACK_MARKER_STORAGE_KEY,
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
    await expectCode(invokeApproved({}), InferErrorCode.InternalError);
    vi.restoreAllMocks();
    await expectCode(invokeApproved({ hash: "0x1234" }), InferErrorCode.InternalError);
  });

  it("returns the exact AIP-62 Rejected shape and propagates ambiguity", async () => {
    (window as any).inferenco = {
      isNovaWallet: true,
      signAndSubmitTransaction: vi.fn().mockResolvedValue({ status: "Rejected" })
    };
    const wallet = createInferAIP62Wallet();
    const feature = wallet.features["cedra:signAndSubmitTransaction"];
    if (!feature) {
      throw new Error("Missing cedra:signAndSubmitTransaction feature");
    }
    const rejected = await feature.signAndSubmitTransaction(GENERIC_AIP62_INPUT);

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
    const ambiguousWallet = createInferAIP62Wallet();
    const ambiguousFeature = ambiguousWallet.features["cedra:signAndSubmitTransaction"];
    if (!ambiguousFeature) {
      throw new Error("Missing cedra:signAndSubmitTransaction feature");
    }
    await expect(
      ambiguousFeature.signAndSubmitTransaction(GENERIC_AIP62_INPUT)
    ).rejects.toMatchObject({ code: InferErrorCode.InternalError });
  });

  it("forwards a generic AIP-62 transaction unchanged to the injected provider", async () => {
    const signAndSubmitTransaction = vi.fn().mockResolvedValue({ status: "Rejected" });
    (window as any).inferenco = {
      isNovaWallet: true,
      signAndSubmitTransaction
    };

    const rejected = await signAndSubmitFeature().signAndSubmitTransaction(
      GENERIC_AIP62_INPUT
    );

    expect(rejected).toEqual({ status: UserResponseStatus.REJECTED });
    expect(signAndSubmitTransaction).toHaveBeenCalledTimes(1);
    expect(signAndSubmitTransaction.mock.calls[0]?.[0]).toBe(GENERIC_AIP62_INPUT);
    expect(signAndSubmitTransaction.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("preserves a generic AIP-62 transaction in the desktop bridge request", async () => {
    const captureInput = vi.fn();
    const rejected = await invokeAip62Bridge(
      { status: "rejected", error: "user_cancelled" },
      GENERIC_AIP62_INPUT,
      captureInput
    );

    expect(rejected).toEqual({ status: UserResponseStatus.REJECTED });
    expect(captureInput).toHaveBeenCalledOnce();
    expect(captureInput).toHaveBeenCalledWith(GENERIC_AIP62_INPUT);
  });

  it("preserves a generic AIP-62 transaction in the encrypted mobile request", async () => {
    const captureInput = vi.fn();
    const rejected = await invokeAip62Mobile(
      {
        status: "rejected",
        encryptedRequest: "encrypted-request",
        encryptedResult: null,
        requestMetadata: {
          origin: window.location.origin,
          appName: "Infer Connect"
        },
        resultMetadata: null,
        errorCode: "user_cancelled",
        errorMessage: null,
        origin: window.location.origin,
        appName: "Infer Connect",
        accountAddress: null,
        network: null,
        chainId: null,
        walletName: null
      },
      GENERIC_AIP62_INPUT,
      captureInput
    );

    expect(rejected).toEqual({ status: UserResponseStatus.REJECTED });
    expect(captureInput).toHaveBeenCalledOnce();
    expect(captureInput).toHaveBeenCalledWith(GENERIC_AIP62_INPUT);
  });

  it.each([
    ["desktop bridge", () => invokeAip62Bridge({ status: "rejected", error: "user_cancelled" })],
    ["mobile relay", () => invokeAip62Mobile({
      status: "rejected",
      encryptedRequest: "encrypted-request",
      encryptedResult: null,
      requestMetadata: { origin: window.location.origin, appName: "Infer Connect" },
      resultMetadata: null,
      errorCode: "user_cancelled",
      errorMessage: null,
      origin: window.location.origin,
      appName: "Infer Connect",
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
    await expectCode(invoke(), InferErrorCode.InternalError);
  });
});
