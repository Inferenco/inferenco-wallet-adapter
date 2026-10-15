import { normalizeSignMessageOutput } from "./conversion";
import { canonicalAddress, requestCommitment } from "./integrationContract";
import type {
  CedraSignAndSubmitTransactionOutput,
  CedraSignMessageOutput,
  CedraSignTransactionOutputV1_1
} from "@cedra-labs/wallet-standard";
import { InferAdapterError, InferErrorCode, isValidTransactionHash } from "./errors";
import type { PendingDesktopBridgeRequest } from "./desktopRequests";
import type { PendingMobileRelayRequest } from "./mobileRequests";
import type { RecoveryArchive } from "./requestArchive";
import type { InferExternalSession } from "./types";

import { validateExternalTransactionRecovery, mergeExternalTransactionRecovery, type ExternalTransactionRecovery } from "./externalTransactionRecovery";

const DB_NAME = "inferenco:infer-recovery";
const DB_VERSION = 1;
const STORE = "requests";
const INVOCATIONS = "invocations";
export const RECOVERY_CHANNEL = "inferenco:infer-recovery-changed";

function announceRecordChange(): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(RECOVERY_CHANNEL);
    channel.postMessage({ origin: window.location.origin });
    channel.close();
  } catch {
    // A notification is advisory; the committed record remains readable.
  }
}
const ACK_TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;
const ARCHIVE_MS = 180 * 24 * 60 * 60 * 1000;

/** Immutable relay fields, saved before the first creation POST. The session token
 * remains in the existing session store and is never copied into this record. */
export interface DurableMobileRequestEnvelope {
  clientInvocationId: string;
  sessionId: string;
  method: "signMessage" | "signTransaction" | "signAndSubmitTransaction";
  callbackUrl: string;
  encryptedRequest: string;
  requestMetadata: { origin: string; appName: string; invocationId?: string; requestCommitment?: string };
}

export interface DurableInvocation {
  /** Absent on historical rows; false records an originally incapable peer. */
  remoteAcknowledgementRequired?: boolean;
  transactionHash?: string;
  requestCommitment?: string;
  requestPayload?: unknown;
  endpoint?: string;
  signerPublicKey?: string;
  updatedAt?: string;
  id: string;
  origin: string;
  transport: InferExternalSession["transport"] | "injected";
  sessionId: string;
  address: string;
  network: string;
  chainId: number;
  method: DurablePending["method"];
  state: "prepared" | "created" | "unknown" | "not-invoked";
  requestId?: string;
  createdAt: string;
  mobileRequest?: {
    relayBaseUrl: string;
    envelope: DurableMobileRequestEnvelope;
    expectedTransactionBcsHex?: string;
  };
  failureReason?: string;
  final?: StoredFinal;
  deliveryState?: "active" | "acknowledged" | "archived";
  archive?: RecoveryArchive;
}

export type DurablePending =
  | PendingDesktopBridgeRequest | PendingMobileRelayRequest;
export type StoredFinal =
  | { status: "rejected" }
  | { status: "approved"; method: "signAndSubmitTransaction"; hash: string }
  | { status: "approved"; method: "signMessage"; output: Record<string, unknown>;
    }
  | {
      status: "approved";
      method: "signTransaction";
      authenticatorHex: string;
      rawTransactionBcsHex: string;
    };

/** Store only validated, serializable final output before returning it to a dapp. */
export function serializeStoredFinal(
  method: DurablePending["method"],
  output:
    | CedraSignMessageOutput | CedraSignTransactionOutputV1_1 | CedraSignAndSubmitTransactionOutput
): StoredFinal {
  if (method === "signAndSubmitTransaction") {
    const hash = (output as CedraSignAndSubmitTransactionOutput).hash;
    if (!isValidTransactionHash(hash)) throw new Error("Invalid approved transaction hash");
    return { status: "approved", method, hash };
  }
  if (method === "signMessage") {
    const normalized = normalizeSignMessageOutput(output);
    const plain = {
      ...normalized,
      signature: normalized.signature.toString()
    } as unknown as Record<string, unknown>;
    return { status: "approved", method, output: plain };
  }
  const signed = output as CedraSignTransactionOutputV1_1 & {
    authenticatorHex?: string; rawTransactionBcsHex?: string;
  };
  if (typeof signed.authenticatorHex !== "string" ||
      typeof signed.rawTransactionBcsHex !== "string") {
    throw new Error("Signed transaction lacks canonical bytes for persistent recovery");
  }
  return { status: "approved", method, authenticatorHex: signed.authenticatorHex,
    rawTransactionBcsHex: signed.rawTransactionBcsHex };
}

export interface DurableRequest {
  externalTransactionRecovery?: ExternalTransactionRecovery;
  remoteAcknowledgementRequired?: boolean;
  transactionHash?: string;
  requestCommitment?: string;
  id: string;
  scopeKey: string;
  origin: string;
  transport: "desktop-bridge" | "mobile-relay";
  requestId: string;
  sessionId: string;
  address: string;
  network: string;
  chainId: number;
  method: DurablePending["method"];
  endpoint: string;
  pending: DurablePending;
  createdAt: string;
  updatedAt: string;
  revision: number;
  state: "active" | "archived" | "acknowledged";
  archive?: RecoveryArchive;
  final?: StoredFinal;
  invocationId?: string;
}

function failure(message: string, cause?: unknown): InferAdapterError {
  return new InferAdapterError(InferErrorCode.InternalError, message, cause);
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new InferAdapterError(InferErrorCode.Unsupported,
      "Persistent browser storage is required for recoverable wallet requests"));
  }
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (cause) {
      reject(failure("Unable to open persistent recovery storage", cause));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("scopeKey", "scopeKey", { unique: true });
        store.createIndex("origin", "origin", { unique: false });
      }
      if (!db.objectStoreNames.contains(INVOCATIONS)) {
        db.createObjectStore(INVOCATIONS, { keyPath: "id" });
      }
    };
    request.onerror = () => reject(failure("Unable to open persistent recovery storage", request.error));
    request.onblocked = () => reject(failure("Persistent recovery storage upgrade is blocked"));
    request.onsuccess = () => resolve(request.result);
  });
}

function randomId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomUuid(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20)].join("-");
}

function pendingEndpoint(pending: DurablePending): string {
  return pending.version === 2 ? pending.bridgeOrigin : pending.relayBaseUrl;
}

export function durableScopeKey(pending: DurablePending): string {
  return JSON.stringify([
    pending.origin ?? window.location.origin,
    pending.version === 2 ? "desktop-bridge" : "mobile-relay",
    pending.sessionId, pending.requestId
  ]);
}

function sameScope(record: DurableRequest, pending: DurablePending): boolean {
  return (
    record.transport === (pending.version === 2 ? "desktop-bridge" : "mobile-relay") &&
    record.origin === (pending.origin ?? window.location.origin) &&
    record.sessionId === pending.sessionId &&
    record.address === pending.address &&
    record.network === pending.network &&
    record.chainId === pending.chainId &&
    record.method === pending.method &&
    record.endpoint === pendingEndpoint(pending) &&
    record.requestId === pending.requestId &&
    record.requestCommitment === pending.requestCommitment
  );
}

function validStoredRecord(row: DurableRequest): boolean {
  try {
    if (!row || row.origin !== window.location.origin ||
        typeof row.id !== "string" || !row.id ||
        typeof row.requestId !== "string" || !row.requestId ||
        !row.pending || typeof row.pending !== "object" ||
        (row.pending.version !== 1 && row.pending.version !== 2) ||
        !["signMessage", "signTransaction", "signAndSubmitTransaction"].includes(row.method) ||
        typeof row.sessionId !== "string" || !row.sessionId ||
        typeof row.address !== "string" || !row.address ||
        typeof row.network !== "string" || !row.network ||
        !Number.isInteger(row.chainId) ||
        typeof row.endpoint !== "string" ||
        !["active", "archived", "acknowledged"].includes(row.state)) return false;
    const endpoint = new URL(row.endpoint);
    if (!["http:", "https:"].includes(endpoint.protocol) ||
        (row.transport === "desktop-bridge" && endpoint.origin !== row.endpoint)) return false;
    if (
      row.requestCommitment &&
      requestCommitment(
        row.method,
        {
          origin: row.origin,
          accountAddress: canonicalAddress(row.address),
          network: row.network,
          chainId: row.chainId
        },
        row.pending.requestPayload
      ) !== row.requestCommitment
    )
      return false;
    return (
      row.scopeKey === durableScopeKey(row.pending) &&
      sameScope(row, row.pending)
    );
  } catch {
    return false;
  }
}

export async function assertDurableRecoveryAvailable(): Promise<void> {
  const db = await openDatabase();
  db.close();
}

export async function saveDurableRequest(
  pending: DurablePending,
  invocationId?: string
): Promise<DurableRequest> {
  if ((pending.origin ?? window.location.origin) !== window.location.origin) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Recovery request origin changed");
  }
  const invocation = invocationId ? await getDurableInvocation(invocationId) : undefined;
  const boundInvocation = invocation &&
    invocation.origin === (pending.origin ?? window.location.origin) &&
    invocation.transport === (pending.version === 2 ? "desktop-bridge" : "mobile-relay") &&
    invocation.sessionId === pending.sessionId &&
    canonicalAddress(invocation.address) === canonicalAddress(pending.address) &&
    invocation.network === pending.network && invocation.chainId === pending.chainId &&
    invocation.method === pending.method && invocation.requestCommitment === pending.requestCommitment;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const scopeKey = durableScopeKey(pending);
    let result: DurableRequest | undefined;
    let changed = false;
    const lookup = store.index("scopeKey").get(scopeKey);
    lookup.onsuccess = () => {
      const existing = lookup.result as DurableRequest | undefined;
      if (existing) {
        if (!sameScope(existing, pending)) {
          tx.abort();
          return;
        }
        result = existing;
        return;
      }
      const now = new Date().toISOString();
      result = {
        id: randomId(), scopeKey, origin: window.location.origin,
        transport: pending.version === 2 ? "desktop-bridge" : "mobile-relay",
        requestId: pending.requestId, sessionId: pending.sessionId,
        address: pending.address, network: pending.network, chainId: pending.chainId,
        method: pending.method, endpoint: pendingEndpoint(pending),
        pending, createdAt: now, updatedAt: now, revision: 1, state: "active",
        ...(pending.archive ? { archive: pending.archive } : {}),
        ...(invocationId ? { invocationId } : {}),
        ...(boundInvocation && invocation.remoteAcknowledgementRequired !== undefined
          ? { remoteAcknowledgementRequired: invocation.remoteAcknowledgementRequired } : {}),
        ...(pending.requestCommitment
          ? { requestCommitment: pending.requestCommitment } : {})
      };
      if (pending.archive) result.state = "archived";
      store.add(result);
      changed = true;
    };
    tx.oncomplete = () => { db.close(); if (changed) announceRecordChange(); resolve(result!); };
    tx.onabort = () => { db.close(); reject(failure("Recovery record conflicts with the original request", tx.error)); };
    tx.onerror = () => { /* onabort rejects after rollback */ };
  });
}

export async function listDurableRequests(): Promise<DurableRequest[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).index("origin").getAll(window.location.origin);
    let rows: DurableRequest[] = [];
    request.onsuccess = () => {
      rows = (request.result as DurableRequest[]).filter(validStoredRecord);
    };
    tx.oncomplete = () => { db.close(); resolve(rows); };
    tx.onabort = () => { db.close(); reject(failure("Unable to inspect persistent recovery records", tx.error)); };
    tx.onerror = () => { /* onabort rejects */ };
  });
}

/** Use existing keys for opaque handles and linked invocations. Bare request IDs
 * retain a cursor fallback so duplicate IDs across sessions remain ambiguous. */
export async function findDurableRequests(
  id: string,
  invocation?: DurableInvocation
): Promise<DurableRequest[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly"), store = tx.objectStore(STORE);
    const matches: DurableRequest[] = [];
    const direct = store.get(id);
    direct.onsuccess = () => {
      if (!invocation && direct.result && validStoredRecord(direct.result)) {
        matches.push(direct.result);
        return;
      }
      if (invocation?.requestId === id) {
        const lookup = store.index("scopeKey").get(JSON.stringify([
          invocation.origin, invocation.transport, invocation.sessionId, id
        ]));
        lookup.onsuccess = () => {
          const row = lookup.result as DurableRequest | undefined;
          if (row && validStoredRecord(row) && row.method === invocation.method &&
              canonicalAddress(row.address) === canonicalAddress(invocation.address) &&
              row.network === invocation.network && row.chainId === invocation.chainId &&
              row.requestCommitment === invocation.requestCommitment &&
              (!row.invocationId || row.invocationId === invocation.id))
            matches.push(row);
        };
        return;
      }
      const cursor = store.index("origin").openCursor(window.location.origin);
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        const row = entry.value as DurableRequest;
        if (row.requestId === id && validStoredRecord(row)) matches.push(row);
        entry.continue();
      };
    };
    tx.oncomplete = () => { db.close(); resolve(matches); };
    tx.onabort = () => { db.close(); reject(failure("Unable to inspect the original recovery record", tx.error)); };
    tx.onerror = () => { /* onabort rejects */ };
  });
}

export async function saveDurableFinal(id: string, final: StoredFinal): Promise<DurableRequest> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    let result: DurableRequest | undefined;
    let changed = false;
    const lookup = store.get(id);
    lookup.onsuccess = () => {
      const row = lookup.result as DurableRequest | undefined;
      if (!row || row.origin !== window.location.origin || row.state !== "active" ||
          (row.externalTransactionRecovery?.status === "not-submitted") ||
          (row.final && JSON.stringify(row.final) !== JSON.stringify(final)) ||
          (row.transactionHash && (final.status !== "approved" ||
            final.method !== "signAndSubmitTransaction" ||
            final.hash.toLowerCase() !== row.transactionHash.toLowerCase()))) {
        tx.abort();
        return;
      }
      if (row.final) {
        result = row;
        return;
      }
      result = { ...row, final, updatedAt: new Date().toISOString(), revision: row.revision + 1 };
      store.put(result);
      changed = true;
    };
    tx.oncomplete = () => { db.close(); if (changed) announceRecordChange(); resolve(result!); };
    tx.onabort = () => { db.close(); reject(failure("Verified result could not be saved for this exact request", tx.error)); };
    tx.onerror = () => { /* onabort rejects */ };
  });
}

/** Atomically retain authenticated recovery evidence and any accepted result. */
export async function saveDurableExternalTransactionRecovery(id: string, value: unknown): Promise<DurableRequest> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    let result: DurableRequest | undefined;
    const lookup = store.get(id);
    lookup.onsuccess = () => {
      const row = lookup.result as DurableRequest | undefined;
      try {
        if (!row || row.origin !== window.location.origin || row.transport !== "mobile-relay" || row.state !== "active") throw new Error();
        const next = validateExternalTransactionRecovery(value, row);
        const previous = row.externalTransactionRecovery && validateExternalTransactionRecovery(row.externalTransactionRecovery, row);
        const evidence = mergeExternalTransactionRecovery(previous, next);
        if ((row.transactionHash && evidence.transactionHash !== row.transactionHash) ||
            (row.final && (row.final.status !== "approved" || row.final.method !== "signAndSubmitTransaction" || row.final.hash !== evidence.transactionHash))) throw new Error();
        const final: StoredFinal | undefined = evidence.status === "approved"
          ? { status: "approved", method: "signAndSubmitTransaction", hash: evidence.transactionHash! } : row.final;
        result = { ...row, externalTransactionRecovery: evidence,
          ...(evidence.transactionHash ? { transactionHash: evidence.transactionHash } : {}),
          ...(final ? { final } : {}), updatedAt: new Date().toISOString(), revision: row.revision + 1 };
        store.put(result);
      } catch { tx.abort(); }
    };
    tx.oncomplete = () => { db.close(); announceRecordChange(); resolve(result!); };
    tx.onabort = () => { db.close(); reject(failure("External recovery evidence conflicts with the original request", tx.error)); };
    tx.onerror = () => {};
  });
}

/** Persist scoped execution evidence without inventing a terminal outcome. */
export async function saveDurableTransactionHash(id: string, hash: string, injected = false): Promise<void> {
  if (!isValidTransactionHash(hash)) throw failure("Invalid transaction identity");
  hash = hash.toLowerCase();
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(injected ? INVOCATIONS : STORE, "readwrite");
    const store = tx.objectStore(injected ? INVOCATIONS : STORE);
    const lookup = store.get(id);
    let changed = false;
    lookup.onsuccess = () => {
      const row = lookup.result as DurableRequest | DurableInvocation | undefined;
      if (!row || row.origin !== window.location.origin || !row.requestCommitment ||
          row.method !== "signAndSubmitTransaction" ||
          (row.transactionHash && row.transactionHash.toLowerCase() !== hash) ||
          (row.final && (row.final.status !== "approved" ||
            row.final.method !== "signAndSubmitTransaction" || row.final.hash.toLowerCase() !== hash))) {
        tx.abort(); return;
      }
      try {
        if (requestCommitment(row.method, {
          origin: row.origin, accountAddress: canonicalAddress(row.address),
          network: row.network, chainId: row.chainId
        }, "pending" in row ? row.pending.requestPayload : row.requestPayload) !== row.requestCommitment) {
          tx.abort(); return;
        }
      } catch { tx.abort(); return; }
      if (row.transactionHash === hash) return;
      store.put({ ...row, transactionHash: hash, updatedAt: new Date().toISOString(),
        ...("revision" in row ? { revision: row.revision + 1 } : {}) });
      changed = true;
    };
    tx.oncomplete = () => { db.close(); if (changed) announceRecordChange(); resolve(); };
    tx.onabort = () => { db.close(); reject(failure("Transaction identity conflicts with the original request", tx.error)); };
    tx.onerror = () => {};
  });
}

export async function transitionDurableRequest(
  id: string,
  operation: "acknowledge" | "archive",
  archive?: RecoveryArchive
): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const lookup = store.get(id);
    lookup.onsuccess = () => {
      const row = lookup.result as DurableRequest | undefined;
      if (!row || row.origin !== window.location.origin ||
          (operation === "acknowledge" && (!row.final || row.state === "archived")) ||
          (operation === "archive" && (row.state === "acknowledged" || !!row.final))) {
        tx.abort();
        return;
      }
      if ((operation === "acknowledge" && row.state === "acknowledged") ||
          (operation === "archive" && row.state === "archived")) return;
      store.put({
        ...row, state: operation === "acknowledge" ? "acknowledged" : "archived",
        ...(archive ? { archive } : {}),
        updatedAt: new Date().toISOString(), revision: row.revision + 1
      });
    };
    tx.oncomplete = () => { db.close(); announceRecordChange(); resolve(); };
    tx.onabort = () => { db.close(); reject(failure("Recovery record changed before " + operation, tx.error)); };
    tx.onerror = () => { /* onabort rejects */ };
  });
}

/** Prune only consumer-acknowledged or explicitly archived records. Unknown work survives. */
export async function pruneDurableEvidence(now = Date.now()): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, INVOCATIONS], "readwrite");
    const store = tx.objectStore(STORE);
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      const row = entry.value as DurableRequest;
      const age = now - Date.parse(row.updatedAt);
      if (validStoredRecord(row) &&
          ((row.state === "acknowledged" && !!row.final && age > ACK_TOMBSTONE_MS) ||
           (row.state === "archived" && !!row.archive && age > ARCHIVE_MS))) {
        entry.delete();
        if (row.invocationId) {
          const lookup = tx.objectStore(INVOCATIONS).get(row.invocationId);
          lookup.onsuccess = () => {
            const invocation = lookup.result as DurableInvocation | undefined;
            // Only a linked completed delivery is eligible; orphan/uncertain work survives.
            if (invocation && validStoredInvocation(invocation) && invocation.origin === row.origin &&
                invocation.transport === row.transport && invocation.requestId === row.requestId &&
                invocation.sessionId === row.sessionId && invocation.method === row.method &&
                invocation.address === row.address && invocation.network === row.network &&
                invocation.chainId === row.chainId &&
                invocation.requestCommitment === row.requestCommitment)
              tx.objectStore(INVOCATIONS).delete(invocation.id);
          };
        }
      }
      entry.continue();
    };
    const invocations = tx.objectStore(INVOCATIONS).openCursor();
    invocations.onsuccess = () => {
      const entry = invocations.result;
      if (!entry) return;
      const row = entry.value as DurableInvocation;
      const age = now - Date.parse(row.updatedAt ?? row.createdAt);
      if (
        row.origin === window.location.origin && row.transport === "injected" &&
        ((row.deliveryState === "acknowledged" && age > ACK_TOMBSTONE_MS) ||
          (row.deliveryState === "archived" && age > ARCHIVE_MS))
      )
        entry.delete();
      entry.continue();
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = () => { db.close(); reject(failure("Unable to prune old recovery evidence", tx.error)); };
    tx.onerror = () => { /* onabort rejects */ };
  });
}

/** Persist an invocation identity before any request-creation POST. */
export async function prepareDurableInvocation(
  session: Pick<
    InferExternalSession,
    "sessionId" | "address" | "network" | "chainId"
  > & Pick<InferExternalSession, "integrationContractVersion" | "capabilities"> &
    { transport: DurableInvocation["transport"] },
  method: DurablePending["method"],
  binding?: {
    requestCommitment: string;
    requestPayload: unknown;
    endpoint: string;
    signerPublicKey?: string;
    remoteAcknowledgementRequired?: boolean;
  }
): Promise<DurableInvocation> {
  const db = await openDatabase();
  const record: DurableInvocation = {
    id: randomUuid(), origin: window.location.origin, transport: session.transport,
    sessionId: session.sessionId, address: session.address, network: session.network,
    chainId: session.chainId, method, state: "prepared",
    createdAt: new Date().toISOString(),
    ...(session.transport === "desktop-bridge" ? {
      remoteAcknowledgementRequired: session.integrationContractVersion === 1 &&
        session.capabilities?.durableInvocationLookup === true
    } : {}),
    ...(binding ?? {})
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INVOCATIONS, "readwrite");
    tx.objectStore(INVOCATIONS).add(record);
    tx.oncomplete = () => { db.close(); resolve(record); };
    tx.onabort = () => { db.close(); reject(failure("Unable to persist invocation before wallet dispatch", tx.error)); };
    tx.onerror = () => { /* onabort rejects */ };
  });
}

/** Save the exact immutable mobile request fields before any network dispatch. */
export async function saveDurableMobileInvocationEnvelope(
  id: string,
  relayBaseUrl: string,
  envelope: DurableMobileRequestEnvelope,
  expectedTransactionBcsHex?: string
): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INVOCATIONS, "readwrite");
    const store = tx.objectStore(INVOCATIONS);
    const lookup = store.get(id);
    lookup.onsuccess = () => {
      const row = lookup.result as DurableInvocation | undefined;
      if (!row || row.origin !== window.location.origin ||
          row.transport !== "mobile-relay" || row.state !== "prepared" ||
          row.mobileRequest || row.id !== envelope.clientInvocationId ||
          row.sessionId !== envelope.sessionId || row.method !== envelope.method ||
          envelope.requestMetadata.origin !== row.origin ||
          (envelope.requestMetadata.invocationId !== undefined && envelope.requestMetadata.invocationId !== row.id) ||
          (envelope.requestMetadata.requestCommitment !== undefined && envelope.requestMetadata.requestCommitment !== row.requestCommitment)) {
        tx.abort();
        return;
      }
      store.put({ ...row, mobileRequest: {
        relayBaseUrl, envelope,
        ...(expectedTransactionBcsHex ? { expectedTransactionBcsHex } : {})
      } });
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = () => { db.close(); reject(failure("Unable to persist the exact mobile invocation", tx.error)); };
    tx.onerror = () => { /* onabort rejects after rollback */ };
  });
}

export async function updateDurableInvocation(
  id: string,
  state: DurableInvocation["state"],
  requestId?: string,
  failureReason?: string
): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INVOCATIONS, "readwrite");
    const store = tx.objectStore(INVOCATIONS);
    const lookup = store.get(id);
    lookup.onsuccess = () => {
      const row = lookup.result as DurableInvocation | undefined;
      if (!row || row.origin !== window.location.origin ||
          (row.state !== "prepared" && row.state !== "unknown" && row.state !== state) ||
          (row.requestId && requestId && row.requestId !== requestId)) {
        tx.abort();
        return;
      }
      store.put({ ...row, state, ...(requestId ? { requestId } : {}),
        ...(failureReason ? { failureReason } : {}) });
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = () => { db.close(); reject(failure("Unable to update the original invocation", tx.error)); };
    tx.onerror = () => { /* onabort rejects */ };
  });
}

function validStoredInvocation(row: DurableInvocation): boolean {
  return !!(row && row.origin === window.location.origin && typeof row.id === "string" &&
          row.id.length > 0 &&
          ["mobile-relay", "desktop-bridge", "injected"].includes(
            row.transport
          ) &&
          [
            "signMessage",
            "signTransaction",
            "signAndSubmitTransaction"
          ].includes(row.method) &&
          ["prepared", "created", "unknown", "not-invoked"].includes(
            row.state
          ) &&
          typeof row.sessionId === "string" &&
          typeof row.address === "string" &&
          /^0x[0-9a-fA-F]{1,64}$/.test(row.address) &&
          typeof row.network === "string" &&
          Number.isInteger(row.chainId) &&
          row.chainId >= 0 &&
          row.chainId <= 255 &&
          (!row.requestCommitment ||
            /^[0-9a-f]{64}$/.test(row.requestCommitment)));
}

/** Exact-ID lookup keeps single-operation recovery independent of historical payload volume. */
export async function getDurableInvocation(id: string): Promise<DurableInvocation | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INVOCATIONS, "readonly");
    const request = tx.objectStore(INVOCATIONS).get(id);
    let row: DurableInvocation | undefined;
    request.onsuccess = () => {
      if (validStoredInvocation(request.result)) row = request.result;
    };
    tx.oncomplete = () => { db.close(); resolve(row); };
    tx.onabort = () => { db.close(); reject(failure("Unable to inspect the original invocation", tx.error)); };
    tx.onerror = () => { /* onabort rejects */ };
  });
}

export async function listDurableInvocations(): Promise<DurableInvocation[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INVOCATIONS, "readonly");
    const request = tx.objectStore(INVOCATIONS).getAll();
    let rows: DurableInvocation[] = [];
    request.onsuccess = () => {
      rows = (request.result as DurableInvocation[]).filter(validStoredInvocation);
    };
    tx.oncomplete = () => { db.close(); resolve(rows); };
    tx.onabort = () => { db.close(); reject(failure("Unable to inspect durable invocations", tx.error)); };
    tx.onerror = () => { /* onabort rejects */ };
  });
}

/** Reuse the existing invocation table for injected outcomes and delivery CAS. */
export async function updateInjectedInvocationEvidence(
  id: string,
  change: {
    final?: StoredFinal;
    deliveryState?: "acknowledged" | "archived";
    archive?: RecoveryArchive;
  }
): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INVOCATIONS, "readwrite"),
      store = tx.objectStore(INVOCATIONS),
      lookup = store.get(id);
    lookup.onsuccess = () => {
      const row = lookup.result as DurableInvocation | undefined;
      if (
        !row ||
        row.origin !== window.location.origin ||
        row.transport !== "injected" ||
        row.state === "not-invoked" ||
        (change.final && row.transactionHash &&
          (change.final.status !== "approved" || change.final.method !== "signAndSubmitTransaction" ||
            change.final.hash.toLowerCase() !== row.transactionHash.toLowerCase())) ||
        (change.final &&
          row.final &&
          JSON.stringify(change.final) !== JSON.stringify(row.final)) ||
        (change.final &&
          !row.final &&
          row.deliveryState &&
          row.deliveryState !== "active") ||
        (change.deliveryState === "acknowledged" && !row.final) ||
        (change.deliveryState === "archived" && row.final) ||
        (row.deliveryState &&
          row.deliveryState !== "active" &&
          row.deliveryState !== change.deliveryState)
      ) {
        tx.abort();
        return;
      }
      store.put({ ...row, ...change, updatedAt: new Date().toISOString() });
    };
    tx.oncomplete = () => {
      db.close();
      announceRecordChange();
      resolve();
    };
    tx.onabort = () => {
      db.close();
      reject(
        failure(
          "Injected invocation evidence changed or could not be saved",
          tx.error
        )
      );
    };
    tx.onerror = () => {};
  });
}
