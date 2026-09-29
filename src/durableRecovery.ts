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
  requestMetadata: { origin: string; appName: string };
}

export interface DurableInvocation {
  id: string;
  origin: string;
  transport: InferExternalSession["transport"];
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
}

export type DurablePending = PendingDesktopBridgeRequest | PendingMobileRelayRequest;
export type StoredFinal =
  | { status: "rejected" }
  | { status: "approved"; method: "signAndSubmitTransaction"; hash: string }
  | { status: "approved"; method: "signMessage"; output: Record<string, unknown> }
  | { status: "approved"; method: "signTransaction"; authenticatorHex: string; rawTransactionBcsHex: string };

/** Store only validated, serializable final output before returning it to a dapp. */
export function serializeStoredFinal(
  method: DurablePending["method"],
  output: CedraSignMessageOutput | CedraSignTransactionOutputV1_1 | CedraSignAndSubmitTransactionOutput
): StoredFinal {
  if (method === "signAndSubmitTransaction") {
    const hash = (output as CedraSignAndSubmitTransactionOutput).hash;
    if (!isValidTransactionHash(hash)) throw new Error("Invalid approved transaction hash");
    return { status: "approved", method, hash };
  }
  if (method === "signMessage") {
    const plain = JSON.parse(JSON.stringify(output)) as Record<string, unknown>;
    if (typeof plain.address !== "string" || typeof plain.signature !== "string" ||
        typeof plain.fullMessage !== "string" || typeof plain.message !== "string") {
      throw new Error("Invalid signed message for persistent recovery");
    }
    return { status: "approved", method, output: plain };
  }
  const signed = output as CedraSignTransactionOutputV1_1 & {
    authenticatorHex?: string; rawTransactionBcsHex?: string
  };
  if (typeof signed.authenticatorHex !== "string" ||
      typeof signed.rawTransactionBcsHex !== "string") {
    throw new Error("Signed transaction lacks canonical bytes for persistent recovery");
  }
  return { status: "approved", method, authenticatorHex: signed.authenticatorHex,
    rawTransactionBcsHex: signed.rawTransactionBcsHex };
}

export interface DurableRequest {
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
  return record.transport === (pending.version === 2 ? "desktop-bridge" : "mobile-relay") &&
    record.origin === (pending.origin ?? window.location.origin) &&
    record.sessionId === pending.sessionId &&
    record.address === pending.address &&
    record.network === pending.network &&
    record.chainId === pending.chainId &&
    record.method === pending.method &&
    record.endpoint === pendingEndpoint(pending) &&
    record.requestId === pending.requestId;
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
    return row.scopeKey === durableScopeKey(row.pending) && sameScope(row, row.pending);
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
        ...(invocationId ? { invocationId } : {})
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
          (row.final && JSON.stringify(row.final) !== JSON.stringify(final))) {
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
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      const row = entry.value as DurableRequest;
      const age = now - Date.parse(row.updatedAt);
      if ((row.state === "acknowledged" && age > ACK_TOMBSTONE_MS) ||
          (row.state === "archived" && age > ARCHIVE_MS)) entry.delete();
      entry.continue();
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = () => { db.close(); reject(failure("Unable to prune old recovery evidence", tx.error)); };
    tx.onerror = () => { /* onabort rejects */ };
  });
}

/** Persist an invocation identity before any request-creation POST. */
export async function prepareDurableInvocation(
  session: InferExternalSession,
  method: DurablePending["method"]
): Promise<DurableInvocation> {
  const db = await openDatabase();
  const record: DurableInvocation = {
    id: randomUuid(), origin: window.location.origin, transport: session.transport,
    sessionId: session.sessionId, address: session.address, network: session.network,
    chainId: session.chainId, method, state: "prepared",
    createdAt: new Date().toISOString()
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
          envelope.requestMetadata.origin !== row.origin) {
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

export async function listDurableInvocations(): Promise<DurableInvocation[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INVOCATIONS, "readonly");
    const request = tx.objectStore(INVOCATIONS).getAll();
    let rows: DurableInvocation[] = [];
    request.onsuccess = () => {
      rows = (request.result as DurableInvocation[]).filter((row) =>
        row && row.origin === window.location.origin && typeof row.id === "string"
      );
    };
    tx.oncomplete = () => { db.close(); resolve(rows); };
    tx.onabort = () => { db.close(); reject(failure("Unable to inspect durable invocations", tx.error)); };
    tx.onerror = () => { /* onabort rejects */ };
  });
}
