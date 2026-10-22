import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { Account } from "@cedra-labs/ts-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInferNativeRecoveryFeatures,
  type InferNativeRecoveryFeatures
} from "../src/aip62";
import {
  canonicalAddress,
  normalizeSubmitInput,
  requestCommitment,
  type CanonicalTransactionInput
} from "../src/integrationContract";
import type { RecoverableInvocation } from "../src/recovery";

// This suite executes the actual wallet provider template and checked-in generated
// codec, read-only. It models only the React Native host response boundary; it does
// not claim to exercise the wallet storage/signing implementation or a physical APK.
const walletWorkspace = process.env.INFER_WALLET_WORKSPACE ?? "/home/james/nova-wallet";
const templatePath = resolve(walletWorkspace, "src/services/dapp-connection/provider-template.ts");
const codecPath = resolve(walletWorkspace, "src/services/dapp-connection/provider-codec.generated.ts");
const walletAvailable = existsSync(templatePath) && existsSync(codecPath);
if (!walletAvailable) {
  console.warn("Native registered-wallet conformance skipped: set INFER_WALLET_WORKSPACE to the completed wallet source checkout.");
}
const nativeConformance = walletAvailable ? describe : describe.skip;

type NativeFeatures = InferNativeRecoveryFeatures;
function createFeatures(wallet: unknown, isCurrent = () => true): NativeFeatures {
  const result = createInferNativeRecoveryFeatures(wallet, { isCurrent });
  if (!result) throw new Error("Actual registered wallet did not expose compatible native recovery");
  return result;
}
function compileExports(path: string, requireModule: (name: string) => unknown) {
  const javascript = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("exports", "require", javascript)(exports, requireModule);
  return exports;
}
function buildWalletScript(durableInvocationSubmission: boolean): string {
  const codec = compileExports(codecPath, () => { throw new Error("Unexpected codec import"); });
  const template = compileExports(templatePath, name => {
    if (name === "./provider-codec.generated") return codec;
    throw new Error("Unexpected provider template import");
  });
  return (template.buildInjectedProviderTemplate as (options: unknown) => string)({
    networkName: "testnet",
    chainId: 2,
    durableInvocationSubmission
  });
}

const signer = Account.generate();
const address = canonicalAddress(signer.accountAddress.toString());
const hash = "0x" + "a3".repeat(32);
const aliases = ["inferenco", "infer", "cedra", "nova", "aptos"] as const;
const liveFeatures: NativeFeatures[] = [];
type BridgeRequest = {
  id: string;
  method: string;
  params: {
    transaction?: CanonicalTransactionInput;
    invocation?: {
      contractVersion: 1;
      invocationId: string;
      requestCommitment: string;
      scope: { origin: string; accountAddress: string; network: string; chainId: number };
    };
    invocationId?: string;
    requestCommitment?: string;
  };
};
type Outcome = Record<string, unknown>;
type Receipt = { request: BridgeRequest; outcome: Outcome; acknowledged: boolean };

function providerHarness(options: {
  durable?: boolean;
  dropSubmitReply?: boolean;
  loseFirstAcknowledgement?: boolean;
  receipts?: Map<string, Receipt>;
} = {}) {
  const requests: BridgeRequest[] = [];
  const receipts = options.receipts ?? new Map<string, Receipt>();
  const handlers: Record<string, (event: { data: string }) => void> = {};
  let selected: any;
  let acknowledgementCount = 0;
  const response = (request: BridgeRequest, result: unknown) =>
    handlers.message({ data: JSON.stringify({ type: "infer:response", id: request.id, result }) });
  const windowObject: any = {
    location: { origin: window.location.origin },
    ReactNativeWebView: {
      postMessage(raw: string) {
        const request = JSON.parse(raw) as BridgeRequest;
        requests.push(request);
        queueMicrotask(() => {
          if (request.method === "connect") {
            response(request, {
              address,
              publicKey: signer.publicKey.toString(),
              network: "testnet",
              chainId: 2
            });
          } else if (request.method === "signAndSubmitTransaction") {
            const metadata = request.params.invocation!;
            receipts.set(metadata.invocationId, {
              request,
              outcome: {
                ...metadata,
                method: "signAndSubmitTransaction",
                status: "approved",
                payload: { hash },
                submissionAcceptance: "accepted",
                chainStatus: "unknown"
              },
              acknowledged: false
            });
            if (!options.dropSubmitReply) response(request, { hash });
          } else if (request.method === "readInvocation") {
            const receipt = receipts.get(request.params.invocationId!);
            if (!receipt) throw new Error("Test requested an unknown native receipt");
            response(request, receipt.outcome);
          } else if (request.method === "acknowledgeInvocation") {
            const receipt = receipts.get(request.params.invocationId!);
            if (!receipt) throw new Error("Test acknowledged an unknown native receipt");
            receipt.acknowledged = true;
            if (receipt.outcome.status === "unknown" &&
                (receipt.outcome.chainStatus === "confirmed" || receipt.outcome.chainStatus === "aborted")) {
              receipt.outcome = {
                ...receipt.outcome,
                status: "approved",
                payload: { hash: receipt.outcome.transactionHash },
                submissionAcceptance: "accepted"
              };
            }
            if (options.loseFirstAcknowledgement && ++acknowledgementCount === 1) {
              handlers.message({
                data: JSON.stringify({
                  type: "infer:response", id: request.id,
                  error: "Acknowledgement callback interrupted", errorCode: "native-response-interrupted"
                })
              });
              return;
            }
            response(request, {
              ...receipt.request.params.invocation,
              method: "signAndSubmitTransaction",
              requestId: receipt.request.id,
              status: "acknowledged"
            });
          } else {
            throw new Error("Unexpected native bridge method: " + request.method);
          }
        });
      }
    },
    addEventListener(name: string, handler: (event: { data: string }) => void) {
      handlers[name] = handler;
    },
    dispatchEvent(event: { detail: (context: unknown) => void }) {
      event.detail({ register(wallet: unknown) { selected = wallet; } });
    }
  };
  const documentObject = {
    title: "Native recovery conformance",
    querySelector: () => null,
    addEventListener: () => undefined
  };
  class BrowserEvent {
    readonly detail: unknown;
    constructor(_type: string, init: { detail: unknown }) { this.detail = init.detail; }
  }
  new Function("window", "document", "CustomEvent", buildWalletScript(options.durable !== false))(
    windowObject, documentObject, BrowserEvent
  );
  // The selected registered object must remain sufficient after direct injected
  // aliases disappear. No ambient provider may rescue adapter integration.
  for (const key of aliases) {
    delete windowObject[key];
    delete (window as any)[key];
  }
  return {
    selected,
    requests,
    receipts,
    async connect() {
      expect(await selected.features["cedra:connect"].connect()).toMatchObject({ status: "Approved" });
      expect(selected.accounts).toHaveLength(1);
    },
    submissionRequests() {
      return requests.filter(request => request.method === "signAndSubmitTransaction");
    },
    dropOperationReplyAsTransportError(request: BridgeRequest) {
      handlers.message({
        data: JSON.stringify({
          type: "infer:response",
          id: request.id,
          error: "Native callback was interrupted",
          errorCode: "native-submission-uncertain"
        })
      });
    }
  };
}
function wire(): CanonicalTransactionInput {
  return normalizeSubmitInput({
    sender: address,
    chainId: 2,
    data: {
      function: "0x1::poker::fixture",
      typeArguments: ["vector<u8>"],
      functionArguments: [new Uint8Array([2, 3, 5]), 23n]
    },
    options: {
      maxGasAmount: 1000n,
      gasUnitPrice: 2n,
      sequenceNumber: 7n,
      expireTimestamp: 4_000_000_000n
    }
  });
}
function track(features: NativeFeatures) {
  liveFeatures.push(features);
  return features;
}
afterEach(() => {
  for (const feature of liveFeatures.splice(0)) feature.dispose();
  for (const key of aliases) delete (window as any)[key];
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

nativeConformance("completed wallet registered native route conformance", () => {
  it("awaits protected preparation and commits the exact transaction compacted by the actual provider", async () => {
    const h = providerHarness();
    await h.connect();
    const features = track(createFeatures(h.selected));
    expect(features.canSubmit()).toBe(true);
    let descriptor: RecoverableInvocation | undefined;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const onInvocationPrepared = vi.fn(async (value: RecoverableInvocation) => {
      descriptor = value;
      await barrier;
    });
    const operation = features["inferenco:transactionSubmission"].signAndSubmitTransaction(wire(), {
      onInvocationPrepared
    });
    await vi.waitFor(() => expect(onInvocationPrepared).toHaveBeenCalledOnce());
    expect(h.submissionRequests()).toHaveLength(0);
    release();
    expect(await operation).toEqual({ status: "Approved", args: { hash } });
    expect(h.submissionRequests()).toHaveLength(1);
    const submitted = h.submissionRequests()[0]!;
    expect(submitted.params.transaction).toEqual(wire());
    expect(submitted.params.invocation).toMatchObject({
      contractVersion: 1,
      invocationId: descriptor!.invocationId,
      requestCommitment: descriptor!.requestCommitment,
      scope: { origin: window.location.origin, accountAddress: address, network: "testnet", chainId: 2 }
    });
    expect(requestCommitment(
      "signAndSubmitTransaction",
      submitted.params.invocation!.scope,
      submitted.params.transaction
    )).toBe(descriptor!.requestCommitment);
    expect(h.requests.filter(request => request.method === "acknowledgeInvocation")).toHaveLength(0);
  });

  it("recovers a truly dropped submit reply through a new consumer and acknowledges only explicitly", async () => {
    const h = providerHarness({ dropSubmitReply: true });
    await h.connect();
    const original = track(createFeatures(h.selected));
    let descriptor: RecoverableInvocation | undefined;
    const pending = original["inferenco:transactionSubmission"].signAndSubmitTransaction(wire(), {
      onInvocationPrepared: async value => { descriptor = value; }
    }).catch(error => error);
    await vi.waitFor(() => expect(h.submissionRequests()).toHaveLength(1));
    original.dispose();
    window.sessionStorage.clear();
    const reopened = providerHarness({ receipts: h.receipts });
    await reopened.connect();
    const renewed = track(createFeatures(reopened.selected));
    const id = "invocation:" + descriptor!.invocationId;
    const recovered = await renewed["inferenco:recoveredOutcomes"].read(id);
    expect(recovered).toMatchObject({
      status: "approved",
      invocationId: descriptor!.invocationId,
      requestCommitment: descriptor!.requestCommitment,
      output: { hash }
    });
    expect(h.receipts.get(descriptor!.invocationId)!.acknowledged).toBe(false);
    expect(reopened.requests.filter(request => request.method === "readInvocation")).toHaveLength(1);
    expect(reopened.requests.filter(request => request.method === "acknowledgeInvocation")).toHaveLength(0);
    expect(await renewed["inferenco:recoveredOutcomes"].read(id)).toMatchObject({
      status: "approved", output: { hash }
    });
    await renewed["inferenco:recoveredOutcomes"].acknowledge(id);
    await renewed["inferenco:recoveredOutcomes"].acknowledge(id);
    expect(h.receipts.get(descriptor!.invocationId)!.acknowledged).toBe(true);
    expect(reopened.submissionRequests()).toHaveLength(0);
    expect(h.submissionRequests()).toHaveLength(1);
    expect(h.requests.filter(request => request.method === "signTransaction")).toHaveLength(0);
    // Settle the retired callback after recovery. It cannot cause redispatch.
    h.dropOperationReplyAsTransportError(h.submissionRequests()[0]!);
    await pending;
    expect(h.submissionRequests()).toHaveLength(1);
    expect(await renewed["inferenco:recoveredOutcomes"].list()).toHaveLength(0);
  });

  it.each(["pending", "unknown"] as const)(
    "retains the wallet's top-level transactionHash for %s without acknowledgement or another submit",
    async status => {
      const h = providerHarness({ dropSubmitReply: true });
      await h.connect();
      const features = track(createFeatures(h.selected));
      let descriptor: RecoverableInvocation | undefined;
      const pending = features["inferenco:transactionSubmission"].signAndSubmitTransaction(wire(), {
        onInvocationPrepared: async value => { descriptor = value; }
      }).catch(error => error);
      await vi.waitFor(() => expect(h.submissionRequests()).toHaveLength(1));
      h.dropOperationReplyAsTransportError(h.submissionRequests()[0]!);
      await pending;
      const receipt = h.receipts.get(descriptor!.invocationId)!;
      receipt.outcome = {
        ...receipt.request.params.invocation,
        method: "signAndSubmitTransaction",
        status,
        transactionHash: hash,
        submissionAcceptance: "unknown",
        chainStatus: status === "pending" ? "pending" : "unknown"
      };
      expect(await features["inferenco:recoveredOutcomes"].read(
        "invocation:" + descriptor!.invocationId
      )).toMatchObject({ status, transactionHash: hash });
      expect(receipt.acknowledged).toBe(false);
      expect(h.submissionRequests()).toHaveLength(1);
      expect(h.requests.filter(request => request.method === "acknowledgeInvocation")).toHaveLength(0);
    }
  );

  it.each(["confirmed", "aborted"] as const)(
    "preserves unknown submission plus exact %s chain evidence until explicit acknowledgement",
    async chainStatus => {
      const h = providerHarness({ dropSubmitReply: true });
      await h.connect();
      const features = track(createFeatures(h.selected));
      let descriptor: RecoverableInvocation | undefined;
      const pending = features["inferenco:transactionSubmission"].signAndSubmitTransaction(wire(), {
        onInvocationPrepared: async value => { descriptor = value; }
      }).catch(error => error);
      await vi.waitFor(() => expect(h.submissionRequests()).toHaveLength(1));
      h.dropOperationReplyAsTransportError(h.submissionRequests()[0]!);
      await pending;
      const receipt = h.receipts.get(descriptor!.invocationId)!;
      receipt.outcome = {
        ...receipt.request.params.invocation,
        method: "signAndSubmitTransaction",
        status: "unknown",
        transactionHash: hash,
        submissionAcceptance: "unknown",
        chainStatus,
        chainVersion: "12345"
      };
      const id = "invocation:" + descriptor!.invocationId;
      for (let read = 0; read < 2; read++) {
        expect(await features["inferenco:recoveredOutcomes"].read(id)).toMatchObject({
          status: "unknown",
          transactionHash: hash,
          submissionAcceptance: "unknown",
          chainStatus,
          chainVersion: "12345"
        });
      }
      expect(receipt.acknowledged).toBe(false);
      expect(h.requests.filter(request => request.method === "acknowledgeInvocation")).toHaveLength(0);
      await features["inferenco:recoveredOutcomes"].acknowledge(id);
      expect(receipt.acknowledged).toBe(true);
      expect(await features["inferenco:recoveredOutcomes"].list()).toHaveLength(0);
      expect(h.submissionRequests()).toHaveLength(1);
      expect(h.requests.filter(request => request.method === "signTransaction")).toHaveLength(0);
    }
  );

  it.each([
    { name: "invalid canonical hash", patch: { transactionHash: "0x1234" } },
    { name: "conflicting hash aliases", patch: { transactionHash: hash, hash: "0x" + "b4".repeat(32) } },
    { name: "committed evidence without chain version", patch: { transactionHash: hash, chainStatus: "confirmed" } },
    { name: "contradictory pending and committed evidence", patch: {
      status: "pending", transactionHash: hash, chainStatus: "aborted", chainVersion: "12345"
    } },
    { name: "unresolved outcome carrying an approval payload", patch: {
      transactionHash: hash, payload: { hash }
    } },
    { name: "approved receipt conflicting with retained identity", patch: {
      status: "approved", transactionHash: "0x" + "b4".repeat(32), payload: { hash }
    } },
    { name: "approved receipt carrying private bytes", patch: {
      status: "approved", payload: { hash, signedBytes: "retained-private-material" }
    } }
  ])("rejects $name without saving or acknowledging malformed native evidence", async ({ patch }) => {
    const h = providerHarness({ dropSubmitReply: true });
    await h.connect();
    const features = track(createFeatures(h.selected));
    let descriptor: RecoverableInvocation | undefined;
    const pending = features["inferenco:transactionSubmission"].signAndSubmitTransaction(wire(), {
      onInvocationPrepared: async value => { descriptor = value; }
    }).catch(error => error);
    await vi.waitFor(() => expect(h.submissionRequests()).toHaveLength(1));
    h.dropOperationReplyAsTransportError(h.submissionRequests()[0]!);
    await pending;
    const receipt = h.receipts.get(descriptor!.invocationId)!;
    receipt.outcome = {
      ...receipt.request.params.invocation,
      method: "signAndSubmitTransaction",
      status: "unknown",
      ...patch
    };
    const id = "invocation:" + descriptor!.invocationId;
    const recovered = await features["inferenco:recoveredOutcomes"].read(id);
    expect(recovered.status).toBe("unknown");
    if (recovered.status !== "unknown") throw new Error("Malformed evidence became a resolved outcome");
    expect(recovered.transactionHash).toBeUndefined();
    expect("output" in recovered).toBe(false);
    expect(JSON.stringify(recovered)).not.toContain("retained-private-material");
    await expect(features["inferenco:recoveredOutcomes"].acknowledge(id)).rejects.toBeInstanceOf(Error);
    expect(receipt.acknowledged).toBe(false);
    expect(h.requests.filter(request => request.method === "acknowledgeInvocation")).toHaveLength(0);
    expect(h.submissionRequests()).toHaveLength(1);
  });

  it("blocks protected dispatch on an incapable runtime while preserving read-only recovery", async () => {
    const first = providerHarness({ dropSubmitReply: true });
    await first.connect();
    const original = track(createFeatures(first.selected));
    let descriptor: RecoverableInvocation | undefined;
    const pending = original["inferenco:transactionSubmission"].signAndSubmitTransaction(wire(), {
      onInvocationPrepared: async value => { descriptor = value; }
    }).catch(error => error);
    await vi.waitFor(() => expect(first.submissionRequests()).toHaveLength(1));
    original.dispose();
    first.dropOperationReplyAsTransportError(first.submissionRequests()[0]!);
    await pending;
    const replacement = providerHarness({ durable: false, receipts: first.receipts });
    await replacement.connect();
    const incapable = track(createFeatures(replacement.selected));
    expect(incapable.canSubmit()).toBe(false);
    const prepare = vi.fn();
    await expect(incapable["inferenco:transactionSubmission"].signAndSubmitTransaction(wire(), {
      onInvocationPrepared: prepare
    })).rejects.toBeInstanceOf(Error);
    expect(prepare).not.toHaveBeenCalled();
    expect(replacement.submissionRequests()).toHaveLength(0);
    expect(await incapable["inferenco:recoveredOutcomes"].read(
      "invocation:" + descriptor!.invocationId
    )).toMatchObject({ status: "approved", output: { hash } });
  });

  it("retries a lost acknowledgement without consuming evidence or repeating submission", async () => {
    const h = providerHarness({ loseFirstAcknowledgement: true });
    await h.connect();
    const features = track(createFeatures(h.selected));
    let descriptor: RecoverableInvocation | undefined;
    expect(await features["inferenco:transactionSubmission"].signAndSubmitTransaction(wire(), {
      onInvocationPrepared: async value => { descriptor = value; }
    })).toEqual({ status: "Approved", args: { hash } });
    const id = "invocation:" + descriptor!.invocationId;
    expect(await features["inferenco:recoveredOutcomes"].read(id)).toMatchObject({
      status: "approved", output: { hash }
    });
    await expect(features["inferenco:recoveredOutcomes"].acknowledge(id)).rejects.toBeInstanceOf(Error);
    expect(h.receipts.get(descriptor!.invocationId)!.acknowledged).toBe(true);
    expect(await features["inferenco:recoveredOutcomes"].list()).toHaveLength(1);
    expect(await features["inferenco:recoveredOutcomes"].read(id)).toMatchObject({
      status: "approved", output: { hash }
    });
    await features["inferenco:recoveredOutcomes"].acknowledge(id);
    expect(await features["inferenco:recoveredOutcomes"].list()).toHaveLength(0);
    expect(h.requests.filter(request => request.method === "acknowledgeInvocation")).toHaveLength(2);
    expect(h.submissionRequests()).toHaveLength(1);
  });

  it("fences a real registered wallet disconnect while protected preparation is waiting", async () => {
    const h = providerHarness();
    await h.connect();
    const features = track(createFeatures(h.selected));
    let descriptor: RecoverableInvocation | undefined;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const operation = features["inferenco:transactionSubmission"].signAndSubmitTransaction(wire(), {
      onInvocationPrepared: async value => {
        descriptor = value;
        await barrier;
      }
    }).catch(error => error);
    await vi.waitFor(() => expect(descriptor).toBeDefined());
    await h.selected.features["cedra:disconnect"].disconnect();
    release();
    const failure = await operation;
    expect(failure).toBeInstanceOf(Error);
    expect(features["inferenco:transactionSubmission"].isNotInvoked(failure, descriptor!)).toBe(true);
    expect(h.submissionRequests()).toHaveLength(0);
  });

  it("stops before raw native dispatch when the preparation callback fails", async () => {
    const h = providerHarness();
    await h.connect();
    const features = track(createFeatures(h.selected));
    let descriptor: RecoverableInvocation | undefined;
    let failure: unknown;
    try {
      await features["inferenco:transactionSubmission"].signAndSubmitTransaction(wire(), {
        onInvocationPrepared: async value => {
          descriptor = value;
          throw new Error("protected persistence failed");
        }
      });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(features["inferenco:transactionSubmission"].isNotInvoked(failure, descriptor!)).toBe(true);
    expect(h.submissionRequests()).toHaveLength(0);
  });
});
