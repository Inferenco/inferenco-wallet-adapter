import type {
  CedraSignAndSubmitTransactionOutput,
  CedraSignMessageOutput,
  CedraSignTransactionOutputV1_1
} from "@cedra-labs/wallet-standard";
import { readExternalSession, readDesktopBridgeRequestOnce } from "./bridge";
import {
  archivePendingDesktopBridgeRequest,
  clearPendingDesktopBridgeRequest,
  desktopBridgeOrigin,
  readPendingDesktopBridgeRequests,
  type RecoverableMethod
} from "./desktopRequests";
import { InferAdapterError, InferErrorCode } from "./errors";
import { decodeMobileRelayResult, readMobileRelayRequestOnce } from "./mobileRelay";
import {
  archivePendingMobileRelayRequest,
  clearPendingMobileRelayRequest,
  readPendingMobileRelayRequests
} from "./mobileRequests";
import { makeRecoveryArchive, type RecoveryArchive } from "./requestArchive";
import type { InferExternalSession, InferWalletOptions } from "./types";

export interface RecoverableRequest {
  requestId: string;
  method: RecoverableMethod;
  transport: "mobile-relay" | "desktop-bridge";
}

export interface ArchivedRecoverableRequest extends RecoverableRequest, RecoveryArchive {}

export type RecoveredRequestOutcome =
  | (RecoverableRequest & { status: "pending" })
  | (RecoverableRequest & { status: "approved"; output:
      CedraSignMessageOutput | CedraSignTransactionOutputV1_1 | CedraSignAndSubmitTransactionOutput })
  | (RecoverableRequest & { status: "rejected" })
  | (RecoverableRequest & { status: "unknown"; reason: string });

type BoundReceipt = RecoverableRequest & { archive?: RecoveryArchive };

function receipts(session: InferExternalSession, options: InferWalletOptions): BoundReceipt[] {
  return session.transport === "mobile-relay"
    ? readPendingMobileRelayRequests(session).map(({ requestId, method, archive }) =>
        ({ requestId, method, transport: "mobile-relay" as const, archive }))
    : readPendingDesktopBridgeRequests(session, options).map(({ requestId, method, archive }) =>
        ({ requestId, method, transport: "desktop-bridge" as const, archive }));
}

function sessionKey(session: InferExternalSession, options: InferWalletOptions): string {
  return JSON.stringify([
    window.location.origin, session.transport, session.sessionId, session.address,
    session.network, session.chainId,
    session.transport === "desktop-bridge"
      ? desktopBridgeOrigin(session, options)
      : session.relayBaseUrl ?? options.relayBaseUrl
  ]);
}

function receiptKey(session: InferExternalSession, request: RecoverableRequest, options: InferWalletOptions): string {
  return sessionKey(session, options) + ":" + request.transport + ":" + request.requestId;
}

/** Active receipts bound to the current session and browser origin. */
export async function listRecoverableRequests(options: InferWalletOptions = {}): Promise<RecoverableRequest[]> {
  if (typeof window === "undefined") return [];
  const session = readExternalSession();
  return session ? receipts(session, options).filter((item) => !item.archive)
    .map(({ requestId, method, transport }) => ({ requestId, method, transport })) : [];
}

/** Inspect archived evidence without restarting automatic recovery. */
export async function listArchivedRecoverableRequests(
  options: InferWalletOptions = {}
): Promise<ArchivedRecoverableRequest[]> {
  if (typeof window === "undefined") return [];
  const session = readExternalSession();
  return session ? receipts(session, options).flatMap(({ requestId, method, transport, archive }) =>
    archive ? [{ requestId, method, transport, ...archive }] : []) : [];
}

const inFlight = new Map<string, Promise<RecoveredRequestOutcome>>();
const verifiedFinal = new Set<string>();

/** One authenticated read of an existing request; it never signs, submits, or cancels. */
export async function readRecoverableRequest(
  requestId: string,
  options: InferWalletOptions = {}
): Promise<RecoveredRequestOutcome> {
  if (typeof window === "undefined") {
    throw new InferAdapterError(InferErrorCode.Unsupported, "Recovery requires a browser");
  }
  const session = readExternalSession();
  if (!session) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "No current wallet session for recovery");
  }
  const descriptor = receipts(session, options).find((request) => request.requestId === requestId);
  if (!descriptor) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Request is not bound to this wallet session");
  }
  const key = receiptKey(session, descriptor, options);
  const publicDescriptor: RecoverableRequest = {
    requestId: descriptor.requestId, method: descriptor.method, transport: descriptor.transport
  };
  const existing = inFlight.get(key);
  if (existing) return existing;
  const task = (async (): Promise<RecoveredRequestOutcome> => {
    try {
      if (descriptor.transport === "mobile-relay") {
        const { pending, status } = await readMobileRelayRequestOnce(requestId, session, options);
        if (status.status === "pending") return { ...publicDescriptor, status: "pending" };
        if (status.status !== "approved" && status.status !== "rejected") {
          return { ...publicDescriptor, status: "unknown", reason: "Relay returned " + status.status };
        }
        return { ...publicDescriptor, status: "approved",
          output: decodeMobileRelayResult(status, pending, session) };
      }
      const result = await readDesktopBridgeRequestOnce(requestId, session, options);
      if (result.status === "pending") return { ...publicDescriptor, status: "pending" };
      if (!result.output) return { ...publicDescriptor, status: "unknown", reason: "Missing approved output" };
      return { ...publicDescriptor, status: "approved", output: result.output };
    } catch (error) {
      if (error instanceof InferAdapterError && error.code === InferErrorCode.UserRejected) {
        return { ...publicDescriptor, status: "rejected" };
      }
      return { ...publicDescriptor, status: "unknown", reason:
        error instanceof Error ? error.message : "Result could not be validated" };
    }
  })();
  inFlight.set(key, task);
  try {
    const outcome = await task;
    const currentSession = readExternalSession();
    const currentReceipt = currentSession && sessionKey(currentSession, options) === sessionKey(session, options)
      ? receipts(currentSession, options).find((item) =>
          item.requestId === requestId && item.transport === descriptor.transport &&
          item.method === descriptor.method)
      : undefined;
    if (!currentReceipt || Boolean(currentReceipt.archive) !== Boolean(descriptor.archive)) {
      return { requestId, method: descriptor.method, transport: descriptor.transport,
        status: "unknown", reason: "Wallet session or request receipt changed during recovery" };
    }
    if (outcome.status === "approved" || outcome.status === "rejected") verifiedFinal.add(key);
    return outcome;
  } finally {
    inFlight.delete(key);
  }
}

/** Call after the application has durably recorded a verified final outcome. */
export function acknowledgeRecoverableRequest(
  requestId: string,
  options: InferWalletOptions = {}
): void {
  if (typeof window === "undefined") return;
  const session = readExternalSession();
  if (!session) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "No current wallet session for acknowledgement");
  }
  const descriptor = receipts(session, options).find((request) => request.requestId === requestId && !request.archive);
  if (!descriptor) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Active request is not bound to this wallet session");
  }
  const key = receiptKey(session, descriptor, options);
  if (!verifiedFinal.has(key)) {
    throw new InferAdapterError(InferErrorCode.InternalError,
      "Read a verified final outcome before acknowledging this request");
  }
  if (descriptor.transport === "mobile-relay") clearPendingMobileRelayRequest(requestId);
  else clearPendingDesktopBridgeRequest(requestId);
  verifiedFinal.delete(key);
}

/**
 * Archive a receipt only after the application has durably reconciled the
 * outcome elsewhere. The reference is an application assertion, not proof
 * of failure or permission to retry.
 */
export function archiveRecoverableRequest(
  requestId: string,
  reconciliationReference: string,
  options: InferWalletOptions = {}
): void {
  if (typeof window === "undefined") {
    throw new InferAdapterError(InferErrorCode.Unsupported, "Archiving requires a browser");
  }
  const session = readExternalSession();
  if (!session) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "No current wallet session for archiving");
  }
  const descriptor = receipts(session, options).find((request) => request.requestId === requestId && !request.archive);
  if (!descriptor) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Active request is not bound to this wallet session");
  }
  const archive = makeRecoveryArchive(reconciliationReference);
  if (descriptor.transport === "mobile-relay") {
    archivePendingMobileRelayRequest(requestId, session, archive);
  } else {
    archivePendingDesktopBridgeRequest(requestId, session, archive, options);
  }
  verifiedFinal.delete(receiptKey(session, descriptor, options));
}
