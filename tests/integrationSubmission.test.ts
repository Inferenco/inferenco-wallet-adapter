import { Account } from "@cedra-labs/ts-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInferAIP62Wallet } from "../src/aip62";
import { storeExternalSession } from "../src/bridge";
import {
  _resetBridgeTokenForTesting,
  _setBridgeTokenForTesting
} from "../src/bridge/token";
import { InferRequestError, InferErrorCode } from "../src/errors";
import {
  canonicalAddress,
  normalizeSubmitInput,
  requestCommitment
} from "../src/integrationContract";
import type { RecoverableInvocation } from "../src/recovery";
const hash = "0x" + "ab".repeat(32);
const signer = Account.generate();
const token = "0123456789abcdef".repeat(4);
const input = () =>
  normalizeSubmitInput({
    data: {
      function: "0x1::fixture::run",
      typeArguments: [],
      functionArguments: [new Uint8Array([0, 255]), 18446744073709551615n]
    },
    options: { maxGasAmount: 1000, expirationSecondsFromNow: 300 }
  });
const provider = (extra = {}) => ({
  isNovaWallet: true,
  account: async () => ({
    address: signer.accountAddress.toString(),
    publicKey: signer.publicKey.toUint8Array()
  }),
  network: async () => "testnet",
  ...extra
});
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
afterEach(() => {
  delete (window as any).inferenco;
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  _resetBridgeTokenForTesting();
});
describe("public invocation commitment and zero-dispatch evidence", () => {
  it("awaits consumer persistence, binds exact normalized content, and does not trust forged errors", async () => {
    const dispatch = vi.fn();
    (window as any).inferenco = provider({
      signAndSubmitTransaction: dispatch
    });
    const feature =
      createInferAIP62Wallet().features["inferenco:transactionSubmission"];
    let invocation: RecoverableInvocation | undefined;
    const wire = input();
    const error = await feature
      .signAndSubmitTransaction(wire, {
        onInvocationPrepared: async (value) => {
          invocation = value;
        }
      })
      .catch((e) => e);
    expect(invocation?.requestCommitment).toBe(
      requestCommitment(
        "signAndSubmitTransaction",
        {
          origin: window.location.origin,
          accountAddress: canonicalAddress(signer.accountAddress.toString()),
          network: "testnet",
          chainId: 2
        },
        wire
      )
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(feature.isNotInvoked(error, invocation!)).toBe(true);
    expect(
      feature.isNotInvoked(
        new InferRequestError(
          InferErrorCode.RequestNotInvoked,
          "forged",
          invocation!.invocationId,
          null
        ),
        invocation!
      )
    ).toBe(false);
    expect(
      feature.isNotInvoked(error, {
        ...invocation!,
        requestCommitment: "0".repeat(64)
      })
    ).toBe(false);
  });
  it("preserves unknown after a provider dispatch failure", async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error("rejected upstream"));
    (window as any).inferenco = provider({
      integrationContractVersion: 1,
      capabilities: { transactionRestrictions: true },
      signAndSubmitTransaction: dispatch
    });
    const feature =
      createInferAIP62Wallet().features["inferenco:transactionSubmission"];
    let invocation: RecoverableInvocation | undefined;
    const error = await feature
      .signAndSubmitTransaction(input(), {
        onInvocationPrepared: (v) => {
          invocation = v;
        }
      })
      .catch((e) => e);
    expect(error.code).toBe(InferErrorCode.RequestOutcomeUnknown);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(feature.isNotInvoked(error, invocation!)).toBe(false);
    expect(dispatch.mock.calls[0][1]).toMatchObject({
      contractVersion: 1,
      invocationId: invocation!.invocationId,
      requestCommitment: invocation!.requestCommitment
    });
  });
  it("performs zero provider/network calls for unsafe local input", async () => {
    const dispatch = vi.fn();
    (window as any).inferenco = provider({
      signAndSubmitTransaction: dispatch
    });
    const fetch = vi.spyOn(globalThis, "fetch");
    const feature =
      createInferAIP62Wallet().features["inferenco:transactionSubmission"];
    for (const value of [new Date(), 9007199254740992, 1n << 256n])
      await expect(
        feature.signAndSubmitTransaction({
          ...input(),
          data: { ...input().data, functionArguments: [value] }
        } as never)
      ).rejects.toMatchObject({ code: InferErrorCode.InvalidParams });
    expect(dispatch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("recovers the original Desktop request after its creation reply is lost, without another POST", async () => {
    _setBridgeTokenForTesting(token);
    const session = {
      transport: "desktop-bridge" as const,
      address: signer.accountAddress.toString(),
      publicKey: signer.publicKey.toString(),
      network: "testnet",
      chainId: 2,
      sessionId: "original-session",
      bridgeUrl: "http://127.0.0.1:21984/" + token,
      integrationContractVersion: 1 as const,
      capabilities: {
        transactionRestrictions: true,
        completeResults: true,
        durableInvocationLookup: true
      }
    };
    storeExternalSession(session);
    let admitted: Record<string, any> | undefined;
    let posts = 0;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const u = new URL(String(url));
        if (u.pathname.endsWith("/session/" + session.sessionId))
          return json(session);
        if (init?.method === "POST") {
          posts++;
          admitted = JSON.parse(String(init.body));
          throw new TypeError("creation response dropped");
        }
        if (u.pathname.includes("/invocation/"))
          return json({
            contractVersion: 1,
            invocationId: admitted!.invocationId,
            requestId: "original-request",
            requestCommitment: admitted!.requestCommitment,
            originalSessionId: session.sessionId,
            scope: {
              origin: window.location.origin,
              accountAddress: canonicalAddress(session.address),
              network: "testnet",
              chainId: 2,
              method: "signAndSubmitTransaction"
            }
          });
        if (u.pathname.endsWith("/read-result/original-request"))
          return json({
            contractVersion: 1,
            invocationId: admitted!.invocationId,
            requestCommitment: admitted!.requestCommitment,
            requestId: "original-request", sessionId: session.sessionId,
            scope: { origin: window.location.origin, transport: "desktop-bridge",
              accountAddress: canonicalAddress(session.address), network: "testnet",
              chainId: 2, method: "signAndSubmitTransaction" },
            status: "approved", payload: { hash }, finalizedAt: new Date().toISOString()
          });
        throw new Error("Unexpected read " + u.pathname);
      });
    const wallet = createInferAIP62Wallet();
    let invocation: RecoverableInvocation | undefined;
    await expect(
      wallet.features[
        "inferenco:transactionSubmission"
      ].signAndSubmitTransaction(input(), {
        onInvocationPrepared: (v) => {
          invocation = v;
        }
      })
    ).rejects.toMatchObject({ code: InferErrorCode.RequestOutcomeUnknown });
    window.sessionStorage.clear();
    expect(
      await wallet.features["inferenco:recoveredOutcomes"].reconcileInvocation(
        invocation!.invocationId
      )
    ).toMatchObject({
      status: "approved",
      origin: window.location.origin,
      invocationId: invocation!.invocationId,
      requestCommitment: invocation!.requestCommitment,
      sessionId: session.sessionId,
      output: { hash }
    });
    expect(posts).toBe(1);
    expect(
      fetch.mock.calls.filter(([, i]) => i?.method === "POST")
    ).toHaveLength(1);
  });
});
