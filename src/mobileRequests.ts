import type { InferExternalSession } from "./types";
import { InferAdapterError, InferErrorCode } from "./errors";

const STORAGE_PREFIX = "inferenco:infer-pending-request:";

export interface PendingMobileRelayRequest {
  version: 1;
  requestId: string;
  sessionId: string;
  address: string;
  network: string;
  chainId: number;
  relayBaseUrl: string;
  method: "signMessage" | "signTransaction" | "signAndSubmitTransaction";
  expiresAt: string;
  expectedTransactionBcsHex?: string;
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
          !["signMessage", "signTransaction", "signAndSubmitTransaction"].includes(item.method ?? "") ||
          typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt)) ||
          (item.expectedTransactionBcsHex !== undefined && typeof item.expectedTransactionBcsHex !== "string")) continue;
      requests.push(item as PendingMobileRelayRequest);
    } catch {
      // An invalid record is never sufficient authority to issue a relay request.
    }
  }
  return requests;
}

/** Call after the dapp has durably recorded a recovered outcome. */
export function clearPendingMobileRelayRequest(requestId: string): void {
  window.sessionStorage.removeItem(STORAGE_PREFIX + requestId);
}
