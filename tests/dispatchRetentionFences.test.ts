import { Account, ChainId, EntryFunction, Network, RawTransaction, SimpleTransaction, TransactionPayloadEntryFunction, parseTypeTag } from "@cedra-labs/ts-sdk";
import { IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InferClient } from "../src/InferClient";
import { createInferAIP62Wallet } from "../src/aip62";
import {
  findDurableRequests, getDurableInvocation, listDurableInvocations,
  listDurableRequests, prepareDurableInvocation, pruneDurableEvidence,
  saveDurableFinal, saveDurableRequest, transitionDurableRequest,
  updateDurableInvocation, updateInjectedInvocationEvidence
} from "../src/durableRecovery";
import { canonicalAddress, normalizeSubmitInput, requestCommitment } from "../src/integrationContract";
import { acknowledgeRecoverableRequest, readRecoverableRequest, reconcileRecoverableInvocation, type RecoverableInvocation } from "../src/recovery";
import type { PendingDesktopBridgeRequest } from "../src/desktopRequests";
import type { InferExternalSession, InferProvider } from "../src/types";
const signer = Account.generate();
const other = Account.generate();
const hash = "0x" + "ab".repeat(32);
const address = canonicalAddress(signer.accountAddress.toString());
const endpoint = "http://127.0.0.1:21984";
const payload = () => normalizeSubmitInput({ data: {
  function: "0x1::fixture::run", typeArguments: [], functionArguments: []
}});
const account = () => ({ address, publicKey: signer.publicKey.toUint8Array() });
const session = (): InferExternalSession => ({
  transport: "desktop-bridge", sessionId: "original", address,
  publicKey: signer.publicKey.toString(), network: "testnet", chainId: 2,
  bridgeUrl: endpoint, integrationContractVersion: 1, capabilities: { durableInvocationLookup: true }
});
const scope = () => ({ origin: window.location.origin, accountAddress: address, network: "testnet", chainId: 2 });
afterEach(() => {
  delete (window as any).inferenco;
  window.localStorage.clear(); window.sessionStorage.clear();
  vi.restoreAllMocks();
});
describe("live injected dispatch fences", () => {
  for (const legacy of [false, true]) {
    it.each(["account", "key", "network", "provider", "missing", "version"])(
      (legacy ? "legacy" : "v1") + ": stops before dispatch if %s changes during awaited preparation",
      async (change) => {
        const submit = vi.fn(async () => ({ hash }));
        const provider: InferProvider = {
          isInferWallet: true,
          ...(legacy ? {} : { integrationContractVersion: 1 as const, capabilities: { transactionRestrictions: true } }),
          account: async () => account(),
          network: async () => ({ name: Network.TESTNET, chainId: 2 }),
          signAndSubmitTransaction: submit
        };
        (window as any).inferenco = provider;
        let invocation: Readonly<RecoverableInvocation> | undefined;
        const client = new InferClient({
          networkOverride: Network.TESTNET,
          onInvocationPrepared: async (value) => {
            invocation = value;
            await Promise.resolve();
            if (change === "account") provider.account = async () => ({ address: other.accountAddress.toString(), publicKey: other.publicKey.toUint8Array() });
            if (change === "key") provider.account = async () => ({ address, publicKey: other.publicKey.toUint8Array() });
            if (change === "network") provider.network = async () => ({ name: Network.MAINNET, chainId: 1 });
            if (change === "provider") (window as any).inferenco = { ...provider };
            if (change === "missing") delete (window as any).inferenco;
            if (change === "version") provider.integrationContractVersion = legacy ? 1 : undefined;
          }
        });
        try {
          await client.getAccount(); await client.getNetwork();
          const error = await client.signAndSubmitTransaction({ data: payload().data } as any).catch((error) => error);
          expect(error.code).toBe("REQUEST_NOT_INVOKED");
          expect(createInferAIP62Wallet().features["inferenco:transactionSubmission"].isNotInvoked(error, invocation!)).toBe(true);
          expect(submit).not.toHaveBeenCalled();
          expect(await getDurableInvocation(invocation!.invocationId)).toMatchObject({ state: "not-invoked" });
        } finally { client.dispose(); }
      }
    );
  }
  it.each(["signMessage", "signTransaction"] as const)("fences %s using the same live scope check", async (method) => {
    const dispatch = vi.fn();
    const provider: InferProvider = {
      isInferWallet: true, integrationContractVersion: 1,
      account: async () => account(), network: async () => ({ name: Network.TESTNET, chainId: 2 }),
      [method]: dispatch
    };
    (window as any).inferenco = provider;
    const client = new InferClient({ onInvocationPrepared: async () => {
      provider.network = async () => ({ name: Network.MAINNET, chainId: 1 });
    } });
    try {
      const call = method === "signMessage" ? client.signMessage({ message: "challenge", nonce: "nonce" })
        : client.signTransaction(new SimpleTransaction(new RawTransaction(
          signer.accountAddress, 1n, new TransactionPayloadEntryFunction(EntryFunction.build("0x1::account", "transfer", [], [])),
          25000n, 7n, 1900000123n, new ChainId(2), parseTypeTag("0x1::cedra_coin::CedraCoin")
        )));
      await expect(call).rejects.toMatchObject({ code: "REQUEST_NOT_INVOKED" });
      expect(dispatch).not.toHaveBeenCalled();
    } finally { client.dispose(); }
  });
  it("fences an account event arriving between the two awaited live scope reads", async () => {
    let accountEvent: ((value: any) => void) | undefined;
    let liveReads = false;
    const submit = vi.fn(async () => ({ hash }));
    (window as any).inferenco = {
      isInferWallet: true, account: async () => account(),
      network: async () => {
        if (liveReads) accountEvent?.({ address: other.accountAddress.toString(), publicKey: other.publicKey.toUint8Array() });
        return { name: "testnet", chainId: 2 };
      },
      onAccountChange: (callback: (value: any) => void) => { accountEvent = callback; },
      signAndSubmitTransaction: submit
    };
    const client = new InferClient({ onInvocationPrepared: () => { liveReads = true; } });
    try {
      await client.subscribe();
      await expect(client.signAndSubmitTransaction({ data: payload().data } as any)).rejects.toMatchObject({ code: "REQUEST_NOT_INVOKED" });
      expect(submit).not.toHaveBeenCalled();
    } finally { client.dispose(); }
  });
  it.each(["network", "provider", "missing", "version", "network event"])(
    "legacy sign-only rejects %s drift across its awaited live network read",
    async (change) => {
      let release!: () => void, started!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const reading = new Promise<void>((resolve) => { started = resolve; });
      let networkEvent: ((value: any) => void) | undefined;
      let reads = 0;
      const dispatch = vi.fn();
      const provider: InferProvider = {
        isInferWallet: true,
        network: async () => {
          if (++reads === 1) return { name: Network.TESTNET, chainId: 2 };
          started();
          await barrier;
          return change === "network"
            ? { name: Network.MAINNET, chainId: 1 }
            : { name: Network.TESTNET, chainId: 2 };
        },
        onNetworkChange: (callback) => { networkEvent = callback; },
        signTransaction: dispatch
      };
      (window as any).inferenco = provider;
      const client = new InferClient({ networkOverride: Network.TESTNET });
      try {
        await client.getNetwork();
        await client.subscribe();
        const outcome = client.signTransaction({ payload: payload().data } as any)
          .catch((error: unknown) => error);
        await reading;
        if (change === "provider") (window as any).inferenco = { ...provider };
        if (change === "missing") delete (window as any).inferenco;
        if (change === "version") provider.integrationContractVersion = 1;
        if (change === "network event") networkEvent?.({ name: Network.MAINNET, chainId: 1 });
        release();
        expect(await outcome).toMatchObject({
          code: change === "network" ? "INVALID_NETWORK" : "UNAUTHORIZED"
        });
        expect(reads).toBe(2);
        expect(dispatch).not.toHaveBeenCalled();
      } finally { release(); client.dispose(); }
    }
  );
  it("legacy sign-only refuses a disappeared network method despite cached scope", async () => {
    const dispatch = vi.fn();
    const provider: InferProvider = {
      isInferWallet: true, network: async () => ({ name: Network.TESTNET, chainId: 2 }),
      signTransaction: dispatch
    };
    (window as any).inferenco = provider;
    const client = new InferClient({ networkOverride: Network.TESTNET });
    try {
      await client.getNetwork();
      delete provider.network;
      await expect(client.signTransaction({ payload: payload().data } as any))
        .rejects.toMatchObject({ code: "INVALID_NETWORK" });
      expect(dispatch).not.toHaveBeenCalled();
    } finally { client.dispose(); }
  });
  it("preserves legacy authenticator-only signing after a matching live network check without requiring account()", async () => {
    const raw = new SimpleTransaction(new RawTransaction(
      signer.accountAddress, 1n, new TransactionPayloadEntryFunction(EntryFunction.build("0x1::account", "transfer", [], [])),
      25000n, 7n, 1900000123n, new ChainId(2), parseTypeTag("0x1::cedra_coin::CedraCoin")
    ));
    const authenticator = signer.signTransactionWithAuthenticator(raw);
    const dispatch = vi.fn(async () => authenticator);
    const network = vi.fn(async () => ({ name: Network.TESTNET, chainId: 2 }));
    (window as any).inferenco = { isInferWallet: true, network, signTransaction: dispatch };
    const client = new InferClient({ networkOverride: Network.TESTNET });
    const input = { payload: payload().data };
    try {
      await client.getNetwork();
      expect(await client.signTransaction(input as any)).toBe(authenticator);
      expect(network).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(input, undefined);
    } finally { client.dispose(); }
  });
  it("persists native acknowledgement support at original public dispatch", async () => {
    const ack = vi.fn();
    (window as any).inferenco = {
      isInferWallet: true, integrationContractVersion: 1,
      account: async () => account(), network: async () => ({ name: "testnet", chainId: 2 }),
      acknowledgeInvocation: ack, signAndSubmitTransaction: async () => ({ hash })
    };
    const client = new InferClient();
    try {
      await client.signAndSubmitTransaction({ data: payload().data } as any);
      const [row] = await listDurableInvocations();
      expect(row?.remoteAcknowledgementRequired).toBe(true);
      delete (window as any).inferenco;
      await expect(acknowledgeRecoverableRequest("invocation:" + row!.id)).rejects.toThrow();
      expect((await getDurableInvocation(row!.id))?.deliveryState).toBeUndefined();
      expect(ack).not.toHaveBeenCalled();
    } finally { client.dispose(); }
  });
});
async function linked(id: string, sessionId = "original", state: "created" | "unknown" = "created") {
  const original = { ...session(), sessionId };
  const wire = payload();
  const invocation = await prepareDurableInvocation(original, "signAndSubmitTransaction", {
    requestCommitment: requestCommitment("signAndSubmitTransaction", scope(), wire),
    requestPayload: wire, endpoint
  });
  const pending: PendingDesktopBridgeRequest = {
    version: 2, transport: "desktop-bridge", requestId: id, invocationId: invocation.id,
    requestCommitment: invocation.requestCommitment, requestPayload: wire,
    origin: window.location.origin, sessionId, address, network: "testnet", chainId: 2,
    bridgeOrigin: endpoint, method: "signAndSubmitTransaction"
  };
  const row = await saveDurableRequest(pending, invocation.id);
  await updateDurableInvocation(invocation.id, state, id);
  return { row, invocation };
}
describe("bounded durable lookup and eligible linked retention", () => {
  it("prunes only linked acknowledged/archived invocations and preserves unresolved/orphaned work", async () => {
    const done = await linked("done"), archived = await linked("archived"), active = await linked("active");
    await saveDurableFinal(done.row.id, { status: "approved", method: "signAndSubmitTransaction", hash });
    await transitionDurableRequest(done.row.id, "acknowledge");
    await transitionDurableRequest(archived.row.id, "archive", {
      archivedAt: new Date().toISOString(), reconciliationReference: "verified:original"
    });
    const orphan = await prepareDurableInvocation(session(), "signAndSubmitTransaction");
    await updateDurableInvocation(orphan.id, "unknown");
    await pruneDurableEvidence(Date.now() + 31 * 86400000);
    expect(await getDurableInvocation(done.invocation.id)).toBeUndefined();
    expect(await getDurableInvocation(archived.invocation.id)).toBeDefined();
    await pruneDurableEvidence(Date.now() + 181 * 86400000);
    expect(await getDurableInvocation(archived.invocation.id)).toBeUndefined();
    expect(await getDurableInvocation(active.invocation.id)).toBeDefined();
    expect(await getDurableInvocation(orphan.id)).toBeDefined();
    expect((await listDurableRequests()).map((row) => row.id)).toEqual([active.row.id]);
  });
  it("prunes acknowledged final evidence even when the linked invocation retains an earlier unknown state", async () => {
    const saved = await linked("late-final", "original", "unknown");
    await saveDurableFinal(saved.row.id, { status: "approved", method: "signAndSubmitTransaction", hash });
    await transitionDurableRequest(saved.row.id, "acknowledge");
    expect((await getDurableInvocation(saved.invocation.id))?.state).toBe("unknown");
    await pruneDurableEvidence(Date.now() + 31 * 86400000);
    expect(await getDurableInvocation(saved.invocation.id)).toBeUndefined();
    expect(await findDurableRequests(saved.row.id)).toHaveLength(0);
  });
  it("keeps a substituted invocation link instead of pruning unrelated unresolved evidence", async () => {
    const original = await linked("original"), unrelated = await linked("unrelated");
    await saveDurableFinal(original.row.id, { status: "rejected" });
    await transitionDurableRequest(original.row.id, "acknowledge");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("inferenco:infer-recovery"); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("requests", "readwrite");
      tx.objectStore("requests").put({ ...original.row, state: "acknowledged", final: { status: "rejected" }, invocationId: unrelated.invocation.id });
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    db.close();
    await pruneDurableEvidence(Date.now() + 31 * 86400000);
    expect(await getDurableInvocation(unrelated.invocation.id)).toBeDefined();
    expect(await getDurableInvocation(original.invocation.id)).toBeDefined();
  });
  it("uses direct keyed reads for native/external recovery while preserving requestId ambiguity", async () => {
    const one = await linked("shared-request", "session-one");
    const two = await linked("shared-request", "session-two");
    for (const { row } of [one, two]) await saveDurableFinal(row.id, { status: "rejected" });
    const native = await prepareDurableInvocation({ ...session(), transport: "injected" }, "signAndSubmitTransaction", {
      requestCommitment: requestCommitment("signAndSubmitTransaction", scope(), payload()), requestPayload: payload(), endpoint: scope().origin
    });
    await updateInjectedInvocationEvidence(native.id, { final: { status: "approved", method: "signAndSubmitTransaction", hash } });
    expect(await reconcileRecoverableInvocation(one.invocation.id)).toMatchObject({ status: "rejected", recoveryId: one.row.id });
    const all = vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(() => { throw new Error("Single recovery must not clone all historical payloads"); });
    expect(await readRecoverableRequest(one.row.id)).toMatchObject({ status: "rejected" });
    expect(await reconcileRecoverableInvocation(native.id)).toMatchObject({ status: "approved", output: { hash } });
    await expect(readRecoverableRequest("shared-request")).rejects.toThrow("ambiguous");
    expect(all).not.toHaveBeenCalled();
  });
  it("keeps historical v1 storage and old-tab database access compatible", async () => {
    const pending: PendingDesktopBridgeRequest = {
      version: 2, transport: "desktop-bridge", requestId: "historical-request", origin: window.location.origin,
      sessionId: "old-session", address, network: "testnet", chainId: 2,
      bridgeOrigin: endpoint, method: "signAndSubmitTransaction"
    };
    const oldRow = {
      id: "historical-id", scopeKey: JSON.stringify([window.location.origin, "desktop-bridge", pending.sessionId, pending.requestId]),
      origin: window.location.origin, transport: "desktop-bridge", requestId: pending.requestId,
      sessionId: pending.sessionId, address, network: "testnet", chainId: 2, method: pending.method,
      endpoint, pending, state: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 1
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("inferenco:infer-recovery", 1);
      open.onupgradeneeded = () => {
        const store = open.result.createObjectStore("requests", { keyPath: "id" });
        store.createIndex("scopeKey", "scopeKey", { unique: true }); store.createIndex("origin", "origin");
        open.result.createObjectStore("invocations", { keyPath: "id" });
      };
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("requests", "readwrite"); tx.objectStore("requests").add(oldRow);
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    db.close();
    expect(await findDurableRequests("historical-request")).toEqual([oldRow]);
    expect(await findDurableRequests("historical-id")).toEqual([oldRow]);
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("inferenco:infer-recovery", 1);
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    expect(legacy.version).toBe(1);
    legacy.close();
  });
});
