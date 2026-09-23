import type { InferExternalSession } from "./types";
import { InferAdapterError, InferErrorCode } from "./errors";
import { isRecoveryArchive, type RecoveryArchive } from "./requestArchive";

const STORAGE_PREFIX = "inferenco:infer-pending-request:";

export interface PendingMobileRelayRequest {
  version: 1;
  requestId: string;
  sessionId: string;
  address: string;
  network: string;
  chainId: number;
  relayBaseUrl: string;
  /** Added to new receipts; old version-1 receipts remain origin-scoped by sessionStorage. */
  origin?: string;
  method: "signMessage" | "signTransaction" | "signAndSubmitTransaction";
  expiresAt: string;
  expectedTransactionBcsHex?: string;
  archive?: RecoveryArchive;
}

/** Persist before launching the wallet. No session token or encryption key is stored here. */
export function storePendingMobileRelayRequest(request: PendingMobileRelayRequest): void {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + request.requestId, JSON.stringify(request));
  } catch (cause) {
    throw new InferAdapterError(InferErrorCode.InternalError,
      "Unable to save the relay request for recovery; wallet approval was not opened", cause);
  }
}

/** Pending requests survive a same-tab reload and remain bound to the original session. */
export function readPendingMobileRelayRequests(session: InferExternalSession): PendingMobileRelayRequest[] {
  const requests: PendingMobileRelayRequest[] = [];
  try {
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      try {
        const value: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? "null");
        if (!value || typeof value !== "object") continue;
        const item = value as Partial<PendingMobileRelayRequest>;
        if (item.version !== 1 || typeof item.requestId !== "string" ||
            key !== STORAGE_PREFIX + item.requestId ||
            item.sessionId !== session.sessionId || item.address !== session.address ||
            item.network !== session.network || item.chainId !== session.chainId ||
            typeof item.relayBaseUrl !== "string" ||
            (item.origin !== undefined && item.origin !== window.location.origin) ||
            !["signMessage", "signTransaction", "signAndSubmitTransaction"].includes(item.method ?? "") ||
            typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt)) ||
            (item.expectedTransactionBcsHex !== undefined &&
              typeof item.expectedTransactionBcsHex !== "string") ||
            (item.archive !== undefined && !isRecoveryArchive(item.archive))) continue;
        requests.push(item as PendingMobileRelayRequest);
      } catch {
        // Invalid storage does not authorize a relay request.
      }
    }
  } catch (cause) {
    throw new InferAdapterError(InferErrorCode.InternalError,
      "Unable to inspect saved relay requests; outcomes remain unresolved", cause);
  }
  return requests;
}

/** Archive only after the application has durably reconciled this exact request elsewhere. */
export function archivePendingMobileRelayRequest(
  requestId: string,
  session: InferExternalSession,
  archive: RecoveryArchive
): void {
  const pending = readPendingMobileRelayRequests(session).find(
    (item) => item.requestId === requestId && !item.archive
  );
  if (!pending) {
    throw new InferAdapterError(InferErrorCode.Unauthorized,
      "Active relay request does not belong to this session");
  }
  storePendingMobileRelayRequest({ ...pending, archive });
}

/** Call after the dapp has durably recorded a recovered outcome. */
export function clearPendingMobileRelayRequest(requestId: string): void {
  window.sessionStorage.removeItem(STORAGE_PREFIX + requestId);
}
