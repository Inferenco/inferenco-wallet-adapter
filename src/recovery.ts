import type {
  CedraSignAndSubmitTransactionOutput,
  CedraSignMessageOutput,
  CedraSignTransactionOutputV1_1
} from "@cedra-labs/wallet-standard";
import { readExternalSession, readDesktopBridgeRequestOnce } from "./bridge";
import { archivePendingDesktopBridgeRequest, clearPendingDesktopBridgeRequest, desktopBridgeOrigin, readPendingDesktopBridgeRequests, type RecoverableMethod } from "./desktopRequests";
import {
  listDurableRequests, listDurableInvocations, saveDurableRequest, saveDurableFinal, serializeStoredFinal, transitionDurableRequest,
  type DurableRequest, type DurableInvocation, type StoredFinal
} from "./durableRecovery";
import { deserializeSignTransactionResult } from "./conversion";
import { InferAdapterError, InferErrorCode, isValidTransactionHash } from "./errors";
import { decodeMobileRelayResult, readMobileRelayRequestOnce } from "./mobileRelay";
import { archivePendingMobileRelayRequest, clearPendingMobileRelayRequest, readPendingMobileRelayRequests } from "./mobileRequests";
import { makeRecoveryArchive, type RecoveryArchive } from "./requestArchive";
import type { InferExternalSession, InferWalletOptions } from "./types";

export interface RecoverableRequest {
  /** Opaque, stable handle for this original invocation and session. */
  recoveryId: string;
  requestId: string;
  method: RecoverableMethod;
  transport: "mobile-relay" | "desktop-bridge";
  sessionId: string;
  address: string;
  network: string;
  chainId: number;
  invocationId?: string;
}

export interface ArchivedRecoverableRequest extends RecoverableRequest, RecoveryArchive {}
export interface RecoverableInvocation {
  invocationId: string;
  transport: "mobile-relay" | "desktop-bridge";
  sessionId: string;
  address: string;
  network: string;
  chainId: number;
  method: RecoverableMethod;
  /** Prepared means dispatch may be unknown after a crash; never infer no submission. */
  state: "prepared" | "created" | "unknown" | "not-invoked";
  requestId?: string;
}

export function invocationDescriptor(row: DurableInvocation): RecoverableInvocation {
  return {
    invocationId: row.id, transport: row.transport, sessionId: row.sessionId,
    address: row.address, network: row.network, chainId: row.chainId,
    method: row.method, state: row.state,
    ...(row.requestId ? { requestId: row.requestId } : {})
  };
}

export async function listRecoverableInvocations(): Promise<RecoverableInvocation[]> {
  if (typeof window === "undefined") return [];
  return (await listDurableInvocations()).map(invocationDescriptor);
}


export type RecoveredRequestOutcome =
  | (RecoverableRequest & { status: "pending" })
  | (RecoverableRequest & { status: "approved"; output:
      CedraSignMessageOutput | CedraSignTransactionOutputV1_1 | CedraSignAndSubmitTransactionOutput })
  | (RecoverableRequest & { status: "rejected" })
  | (RecoverableRequest & { status: "unknown"; reason: string });

const inFlight = new Map<string, Promise<RecoveredRequestOutcome>>();

function descriptor(row: DurableRequest): RecoverableRequest {
  return {
    recoveryId: row.id, requestId: row.requestId, method: row.method,
    transport: row.transport, sessionId: row.sessionId, address: row.address,
    network: row.network, chainId: row.chainId,
    ...(row.invocationId ? { invocationId: row.invocationId } : {})
  };
}

function matchingSession(row: DurableRequest, session: InferExternalSession | null, options: InferWalletOptions = {}): session is InferExternalSession {
  if (!session || session.transport !== row.transport || session.sessionId !== row.sessionId ||
      session.address !== row.address || session.network !== row.network ||
      session.chainId !== row.chainId) return false;
  if (row.transport === "mobile-relay") {
    return row.endpoint === session.relayBaseUrl &&
      typeof session.dappSessionToken === "string" && typeof session.sharedSecret === "string";
  }
  try {
    return desktopBridgeOrigin(session, options) === row.endpoint;
  } catch {
    return false;
  }
}

async function migrateCurrentTab(session: InferExternalSession | null, options: InferWalletOptions): Promise<void> {
  if (!session) return;
  let legacy: Array<DurableRequest["pending"]>;
  try {
    legacy = session.transport === "mobile-relay"
      ? readPendingMobileRelayRequests(session)
      : readPendingDesktopBridgeRequests(session, options);
  } catch (error) {
    // Existing durable records remain usable if old tab storage is unavailable.
    if (error instanceof InferAdapterError) return;
    throw error;
  }
  for (const pending of legacy) {
    await saveDurableRequest({ ...pending, origin: window.location.origin }, pending.invocationId);
  }
}

async function records(options: InferWalletOptions): Promise<DurableRequest[]> {
  if (typeof window === "undefined") return [];
  await migrateCurrentTab(readExternalSession(), options);
  return listDurableRequests();
}

function findExact(rows: DurableRequest[], id: string): DurableRequest {
  const matches = rows.filter((row) => row.id === id || row.requestId === id);
  if (matches.length !== 1) {
    throw new InferAdapterError(
      matches.length > 1 ? InferErrorCode.InvalidParams : InferErrorCode.Unauthorized,
      matches.length > 1
        ? "Request ID is ambiguous across wallet sessions; use its recoveryId"
        : "Request is not bound to this browser origin"
    );
  }
  return matches[0];
}

function replay(row: DurableRequest): RecoveredRequestOutcome | null {
  const final = row.final;
  if (!final) return null;
  const base = descriptor(row);
  if (final.status === "rejected") return { ...base, status: "rejected" };
  if (final.method !== row.method) {
    return { ...base, status: "unknown", reason: "Stored result method does not match its request" };
  }
  try {
    if (final.method === "signAndSubmitTransaction") {
      if (!isValidTransactionHash(final.hash)) throw new Error("Invalid saved transaction hash");
      return { ...base, status: "approved", output: { hash: final.hash } };
    }
    if (final.method === "signMessage") {
      if (typeof final.output.address !== "string" ||
          typeof final.output.signature !== "string" ||
          typeof final.output.fullMessage !== "string" ||
          typeof final.output.message !== "string") throw new Error("Invalid saved signed message");
      return { ...base, status: "approved",
        output: final.output as unknown as CedraSignMessageOutput };
    }
    return { ...base, status: "approved",
      output: deserializeSignTransactionResult({
        authenticatorHex: final.authenticatorHex,
        rawTransactionBcsHex: final.rawTransactionBcsHex
      }, row.pending.expectedTransactionBcsHex) };
  } catch {
    return { ...base, status: "unknown", reason: "Stored final outcome could not be validated" };
  }
}

/** List all active same-origin receipts, including those from an older wallet session. */
export async function listRecoverableRequests(options: InferWalletOptions = {}): Promise<RecoverableRequest[]> {
  return (await records(options)).filter((row) => row.state === "active").map(descriptor);
}

export async function listArchivedRecoverableRequests(
  options: InferWalletOptions = {}
): Promise<ArchivedRecoverableRequest[]> {
  return (await records(options)).flatMap((row) =>
    row.state === "archived" && row.archive ? [{ ...descriptor(row), ...row.archive }] : []);
}

/** Read only the original request. A locally verified final result replays without network access. */
export async function readRecoverableRequest(
  requestIdOrRecoveryId: string,
  options: InferWalletOptions = {}
): Promise<RecoveredRequestOutcome> {
  if (typeof window === "undefined") {
    throw new InferAdapterError(InferErrorCode.Unsupported, "Recovery requires a browser");
  }
  const row = findExact(await records(options), requestIdOrRecoveryId);
  const locallyVerified = replay(row);
  if (locallyVerified) return locallyVerified;
  const base = descriptor(row);
  const session = readExternalSession();
  if (!matchingSession(row, session, options)) {
    return { ...base, status: "unknown",
      reason: "Original wallet session cannot authenticate a remote read; reconnect or reconcile externally" };
  }
  const existing = inFlight.get(row.id);
  if (existing) return existing;
  const task = (async (): Promise<RecoveredRequestOutcome> => {
    let outcome: RecoveredRequestOutcome;
    try {
      if (row.transport === "mobile-relay") {
        const { pending, status } = await readMobileRelayRequestOnce(
          row.requestId, session, options, row.pending as Extract<DurableRequest["pending"], { version: 1 }>
        );
        if (status.status === "pending") return { ...base, status: "pending" };
        if (status.status !== "approved" && status.status !== "rejected") {
          return { ...base, status: "unknown", reason: "Relay returned " + status.status };
        }
        outcome = { ...base, status: "approved",
          output: decodeMobileRelayResult(status, pending, session) };
      } else {
        const result = await readDesktopBridgeRequestOnce(
          row.requestId, session, options, row.pending as Extract<DurableRequest["pending"], { version: 2 }>
        );
        if (result.status === "pending") return { ...base, status: "pending" };
        if (!result.output) return { ...base, status: "unknown", reason: "Missing approved output" };
        outcome = { ...base, status: "approved", output: result.output };
      }
    } catch (error) {
      if (error instanceof InferAdapterError && error.code === InferErrorCode.UserRejected) {
        outcome = { ...base, status: "rejected" };
      } else {
        return { ...base, status: "unknown", reason:
          error instanceof Error ? error.message : "Result could not be validated" };
      }
    }
    try {
      await saveDurableFinal(row.id, outcome.status === "rejected"
        ? { status: "rejected" }
        : serializeStoredFinal(row.method, outcome.output));
      return outcome;
    } catch {
      return { ...base, status: "unknown", reason: "Verified outcome could not be saved durably" };
    }
  })();
  inFlight.set(row.id, task);
  try { return await task; }
  finally { inFlight.delete(row.id); }
}

/** Acknowledgement is an awaitable exact-record CAS after durable app acceptance. */
export async function acknowledgeRecoverableRequest(
  requestIdOrRecoveryId: string,
  options: InferWalletOptions = {}
): Promise<void> {
  const row = findExact(await records(options), requestIdOrRecoveryId);
  if (!row.final) {
    throw new InferAdapterError(InferErrorCode.InternalError,
      "Read a verified final outcome before acknowledging this request");
  }
  await transitionDurableRequest(row.id, "acknowledge");
  if (matchingSession(row, readExternalSession(), options)) {
    try {
      if (row.transport === "mobile-relay") clearPendingMobileRelayRequest(row.requestId);
      else clearPendingDesktopBridgeRequest(row.requestId);
    } catch {
      // The committed IDB tombstone is authoritative.
    }
  }
}

/** Archive only after independent reconciliation; this never proves non-submission. */
export async function archiveRecoverableRequest(
  requestIdOrRecoveryId: string,
  reconciliationReference: string,
  options: InferWalletOptions = {}
): Promise<void> {
  const row = findExact(await records(options), requestIdOrRecoveryId);
  if (row.state !== "active") {
    throw new InferAdapterError(InferErrorCode.Unauthorized,
      "Request is not active in this browser origin");
  }
  if (row.final) {
    throw new InferAdapterError(InferErrorCode.InvalidParams,
      "Verified final outcomes must be acknowledged after durable acceptance");
  }
  const archive = makeRecoveryArchive(reconciliationReference);
  await transitionDurableRequest(row.id, "archive", archive);
  try {
    const session = readExternalSession()!;
    if (row.transport === "mobile-relay") {
      archivePendingMobileRelayRequest(row.requestId, session, archive);
    } else {
      archivePendingDesktopBridgeRequest(row.requestId, session, archive, options);
    }
  } catch {
    // The committed IndexedDB archive remains authoritative.
  }
}
