import { DEFAULT_DESKTOP_BRIDGE_URL } from "./constants";
import { InferAdapterError, InferErrorCode } from "./errors";
import type { InferExternalSession, InferWalletOptions } from "./types";

const STORAGE_PREFIX = "inferenco:infer-pending-desktop-request:";

export type RecoverableMethod =
  "signMessage" | "signTransaction" | "signAndSubmitTransaction";

export interface PendingDesktopBridgeRequest {
  version: 1;
  transport: "desktop-bridge";
  requestId: string;
  sessionId: string;
  address: string;
  network: string;
  chainId: number;
  origin: string;
  bridgeBaseUrl: string;
  method: RecoverableMethod;
  expectedTransactionBcsHex?: string;
}

/** The receipt contains no bridge token or signing material. */
export function storePendingDesktopBridgeRequest(request: PendingDesktopBridgeRequest): void {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + request.requestId, JSON.stringify(request));
  } catch (cause) {
    throw new InferAdapterError(
      InferErrorCode.InternalError,
      "Unable to save the Infer Desk request for recovery; approval remains unresolved",
      cause
    );
  }
}

export function readPendingDesktopBridgeRequests(
  session: InferExternalSession,
  options: InferWalletOptions = {}
): PendingDesktopBridgeRequest[] {
  const requests: PendingDesktopBridgeRequest[] = [];
  const bridgeBaseUrl = session.bridgeUrl ?? options.bridgeBaseUrl ?? DEFAULT_DESKTOP_BRIDGE_URL;
  try {
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      try {
        const item = JSON.parse(window.sessionStorage.getItem(key) ?? "null") as
          Partial<PendingDesktopBridgeRequest> | null;
        if (!item || item.version !== 1 || item.transport !== "desktop-bridge" ||
            typeof item.requestId !== "string" || key !== STORAGE_PREFIX + item.requestId ||
            item.sessionId !== session.sessionId || item.address !== session.address ||
            item.network !== session.network || item.chainId !== session.chainId ||
            item.origin !== window.location.origin || item.bridgeBaseUrl !== bridgeBaseUrl ||
            !["signMessage", "signTransaction", "signAndSubmitTransaction"].includes(item.method ?? "") ||
            (item.expectedTransactionBcsHex !== undefined &&
              typeof item.expectedTransactionBcsHex !== "string")) continue;
        requests.push(item as PendingDesktopBridgeRequest);
      } catch {
        // Invalid storage does not authorize a bridge read.
      }
    }
  } catch (cause) {
    throw new InferAdapterError(InferErrorCode.InternalError,
      "Unable to inspect saved Infer Desk requests; outcomes remain unresolved", cause);
  }
  return requests;
}

export function clearPendingDesktopBridgeRequest(requestId: string): void {
  window.sessionStorage.removeItem(STORAGE_PREFIX + requestId);
}
